import { createHash } from "node:crypto";
import { chmod, lstat, open, rm, type FileHandle } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  gpuSceneImageAssetRef,
  OutputDirectoryReservation,
  resolvePackageAsset,
  type GpuScene2dVideoResource,
  type MotionPackage
} from "@shellx-motion/core";
import type { RetainedDirectoryAuthority } from "@shellx-motion/core";
import type { GpuDecodedVideoFrame, GpuVideoFrameProvider, GpuVideoFrameProviderEvidence } from "@shellx-motion/renderer-browser";
import { inspectSelfContainedFfmpegMediaInput, snapshotSelfContainedFfmpegMediaInput, trackingFfmpegMediaInputArgs, type FfmpegMediaInputInspection, type FfmpegMediaInputSnapshot } from "./ffmpeg-media-input-fence.js";
import { MAX_GPU_VIDEO_DIMENSION, probeImmutableGpuVideoSnapshot, type ProbedGpuVideoMedia } from "./gpu-video-media-probe.js";
import { gpuVideoFrameSchedules, resolveGpuVideoFrameSchedules, type GpuVideoDecodeSegment, type GpuVideoFrameSchedule } from "./gpu-video-frame-schedule.js";
import { planGpuVideoSourceSnapshotBudget, planGpuVideoStagingBudget, plannedPcmBytesForDuration, type GpuVideoStagingLedger } from "./gpu-video-staging-budget.js";
import { resolveFfmpegExecutable, type FfmpegCommand, type FfmpegRunner } from "./index.js";

const MAX_GPU_VIDEO_LAYERS = 8;

/** Optional expected facts used only by tests; production always derives these from snapshots. */
export interface GpuVideoStagingMedia {
  assetRef: string;
  width: number;
  height: number;
  durationMs?: number;
}

/** Caller-owned private operation root. Media facts are never accepted from command arguments. */
export interface GpuVideoStagingPreflight {
  stagingRoot: string;
  /** Internal caller-held authority for this exact root. It is never a public command argument. */
  authority?: RetainedDirectoryAuthority;
  /** Test/host lowering only; the production ceiling remains 16 GiB. */
  maxBytes?: number;
  /** Test-only immutable-probe expectation; it cannot supply dimensions to production staging. */
  media?: readonly GpuVideoStagingMedia[];
}

export interface PreparedGpuVideoFrameStaging {
  readonly inputHashes: Readonly<Record<string, string>>;
  readonly videos: ReadonlyMap<string, GpuScene2dVideoResource>;
  readonly mediaSnapshots: ReadonlyMap<string, FfmpegMediaInputSnapshot>;
  readonly audioSnapshots: ReadonlyMap<string, { sourcePath: string; path: string; sha256: string; root: string }>;
  readonly ledger: GpuVideoStagingLedger;
  /** The operation owner must remove this now-empty caller-owned root after release. */
  readonly stagingRoot: string;
  openProvider(): Promise<GpuVideoFrameProvider>;
  release(): Promise<void>;
}

/**
 * Select only the declared package-video sources that the resolved final audio mix actually
 * requests. This deliberately does not consult visual visibility or GPU frame schedules:
 * `visible: false` suppresses pixels, while an explicit `includeAudio` remains an audio request.
 *
 * The final-audio resolver already owns track mute/solo and group-timing semantics. Its selected
 * paths arrive here as `audioSourcePaths`; this helper only correlates those paths back to the
 * same safe package asset resolver used by the GPU scene compiler.
 */
export function requestedGpuVideoAudioAssetRefs(pkg: MotionPackage, audioSourcePaths: readonly string[]): string[] {
  return videoAudioAssetRefs(pkg, new Set(audioSourcePaths.map((path) => resolve(path))));
}

interface StagedLayer {
  layerId: string;
  assetRef: string;
  sourceSha256: string;
  width: number;
  height: number;
  frameBytes: number;
  atMsToOrdinal: ReadonlyMap<number, number>;
  sourceAtMs: readonly number[];
  parts: readonly StagedPart[];
}
interface StagedPart extends GpuVideoDecodeSegment { rawPath: string }
interface SourceFact { inspection: FfmpegMediaInputInspection }
interface ResolvedSourceFact extends SourceFact { media: ProbedGpuVideoMedia }
interface AudioPlan { sourceKey: string; sourcePath: string; durationMs: number; maxBytes: number }

/**
 * Stage exact GPU video frames only after a structural aggregate budget preflight. The caller
 * supplies an empty, private, per-operation root under admitted scratch; it remains caller-owned
 * and is deliberately never recursively removed here.
 */
export async function prepareGpuVideoFrameStaging(input: {
  pkg: MotionPackage;
  runner: FfmpegRunner;
  preflight?: GpuVideoStagingPreflight;
  /** Exact encoder-requested source paths; omitted only by direct staging tests. */
  audioSourcePaths?: readonly string[];
  /** Forwarded by the admitted renderer; checked between every staging phase. */
  signal?: AbortSignal;
}): Promise<PreparedGpuVideoFrameStaging | undefined> {
  input.signal?.throwIfAborted();
  const requestedAudioSources = input.audioSourcePaths === undefined
    ? undefined
    : new Set(input.audioSourcePaths.map((path) => resolve(path)));
  let schedules = gpuVideoFrameSchedules(input.pkg);
  const audioAssetRefs = videoAudioAssetRefs(input.pkg, requestedAudioSources);
  if (schedules.length === 0 && audioAssetRefs.length === 0) return undefined;
  if (schedules.length > MAX_GPU_VIDEO_LAYERS) throw new Error(`GPU final video accepts at most ${MAX_GPU_VIDEO_LAYERS} visible video layers.`);
  if (!input.preflight) throw new Error("GPU video staging requires an admitted operation staging root before decoding.");
  // Keep visual RGBA and optional PCM extraction pinned to the same authoritative tool selection
  // as the final encoder. Resolving only once prevents an environment change mid-operation from
  // splitting staging across two binaries.
  const ffmpegExecutable = resolveFfmpegExecutable();
  const authority = input.preflight.authority ?? await OutputDirectoryReservation.acquire(input.preflight.stagingRoot, {
    requireExisting: true, requirePrivate: true, requireExclusiveChildAuthority: true, allowExistingContents: false
  });
  const root = authority.path;
  if (root !== input.preflight.stagingRoot) throw new Error("GPU video staging authority does not match its caller-supplied operation root.");
  const expectedMedia = mediaByAssetRef(input.preflight.media ?? []);
  const sourceFacts = await inspectSources(input.pkg, [...new Set([...schedules.map((schedule) => schedule.assetRef), ...audioAssetRefs])]);
  planGpuVideoSourceSnapshotBudget([...uniqueSourceFacts(sourceFacts)].map(([key, fact]) => ({ sourceKey: key, sourceBytes: fact.inspection.byteLength })), input.preflight.maxBytes);
  const snapshots = new Map<string, FfmpegMediaInputSnapshot>();
  const staged: StagedLayer[] = [];
  const ownedPaths = new Set<string>();
  const audioSnapshots = new Map<string, { sourcePath: string; path: string; sha256: string; root: string }>();
  let released = false;
  try {
    for (const [key, fact] of uniqueSourceFacts(sourceFacts)) {
      input.signal?.throwIfAborted();
      await authority.assertCurrent();
      const snapshot = await snapshotSelfContainedFfmpegMediaInput(fact.inspection.sourcePath, [input.pkg.root], "tracking-video", {
        stagingRoot: root, stagingAuthority: authority, maxBytes: fact.inspection.byteLength, expected: fact.inspection
      });
      snapshots.set(key, snapshot);
    }
    input.signal?.throwIfAborted();
    const resolvedSourceFacts = await probeSources(sourceFacts, snapshots, expectedMedia, input.runner);
    input.signal?.throwIfAborted();
    schedules = resolveGpuVideoFrameSchedules(schedules, (assetRef) => resolvedSourceFacts.get(assetRef)!.media.durationMs);
    const audioPlans = audioPlansFor(audioAssetRefs, resolvedSourceFacts);
    const ledgerEntries = [...uniqueSourceFacts(resolvedSourceFacts)].map(([key, fact]) => {
      const rgba = schedules.filter((schedule) => sourceKey(resolvedSourceFacts.get(schedule.assetRef)!.inspection) === key)
        .reduce((total, schedule) => total + rgbaBytes(resolvedSourceFacts.get(schedule.assetRef)!.media, schedule.atMs.length), 0);
      const pcmDurationMs = audioPlans.get(key)?.durationMs;
      return { sourceKey: key, sourceBytes: fact.inspection.byteLength, rgbaBytes: rgba, ...(pcmDurationMs === undefined ? {} : { pcmDurationMs }) };
    });
    const ledger = planGpuVideoStagingBudget(ledgerEntries, input.preflight.maxBytes);
    for (const schedule of schedules) {
      input.signal?.throwIfAborted();
      const fact = resolvedSourceFacts.get(schedule.assetRef)!;
      const snapshot = snapshots.get(sourceKey(fact.inspection))!;
      const frameBytes = rgbaBytes(fact.media, 1);
      const parts: StagedPart[] = [];
      for (const [partIndex, segment] of schedule.segments.entries()) {
        const rawPath = stagedPath(root, `${hash(schedule.layer.id)}-${snapshot.sha256.slice(0, 16)}-${partIndex}.rgba`);
        ownedPaths.add(rawPath);
        await authority.assertCurrent();
        const result = await input.runner(decodeCommand({ executable: ffmpegExecutable, snapshot, rawPath, schedule, segment, fps: input.pkg.motion.fps }));
        if (result.exitCode !== 0) throw new Error(`GPU video decoder failed for layer ${schedule.layer.id}.`);
        const info = await lstat(rawPath).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink() || info.size !== frameBytes * segment.frameCount) throw new Error(`GPU video decoder produced an incomplete frame stream for layer ${schedule.layer.id}.`);
        await chmod(rawPath, 0o400);
        parts.push({ ...segment, rawPath });
      }
      staged.push({ layerId: schedule.layer.id, assetRef: schedule.assetRef, sourceSha256: snapshot.sha256, width: fact.media.width, height: fact.media.height, frameBytes, atMsToOrdinal: new Map(schedule.atMs.map((atMs, ordinal) => [atMs, ordinal])), sourceAtMs: schedule.sourceAtMs, parts });
    }
    for (const audio of audioPlans.values()) {
      input.signal?.throwIfAborted();
      const snapshot = snapshots.get(audio.sourceKey)!;
      const audioPath = stagedPath(root, `audio-${hash(audio.sourceKey).slice(0, 16)}-${snapshot.sha256.slice(0, 16)}.wav`);
      ownedPaths.add(audioPath);
      await authority.assertCurrent();
      // This is deliberately a complete immutable source PCM, not the visible video interval.
      // `packageAudioEncodeInput` retains each layer's own trim, tempo, fade, and timeline delay;
      // the final FFmpeg filter must apply those exactly once after this path substitution.
      const result = await input.runner({ executable: ffmpegExecutable, shell: false, args: ["-v", "error", "-nostdin", "-y", ...trackingFfmpegMediaInputArgs(snapshot.path), "-map", "0:a:0", "-vn", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", audioPath] });
      if (result.exitCode !== 0) throw new Error("GPU video source requested audio, but its immutable source could not produce the planned PCM master.");
      const info = await lstat(audioPath).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > audio.maxBytes) throw new Error("GPU video audio staging is missing or exceeds the aggregate operation budget.");
      await chmod(audioPath, 0o400);
      audioSnapshots.set(audio.sourcePath, { sourcePath: audio.sourcePath, path: audioPath, sha256: await fileHash(audioPath), root });
    }
    const byAsset = new Map([...resolvedSourceFacts].map(([assetRef, fact]) => [assetRef, snapshots.get(sourceKey(fact.inspection))!]));
    const inputHashes = Object.freeze(Object.fromEntries([...byAsset].map(([assetRef, snapshot]) => [assetRef, snapshot.sha256])));
    const videos = new Map(staged.map((layer) => [layer.layerId, { layerId: layer.layerId, resourceId: `video-${hash(`${layer.layerId}\0${layer.sourceSha256}`).slice(0, 24)}`, assetRef: layer.assetRef, width: layer.width, height: layer.height, sha256: layer.sourceSha256, sourceAtMs: layer.sourceAtMs[0]! }]));
    return {
      inputHashes, videos, mediaSnapshots: byAsset, audioSnapshots, ledger, stagingRoot: root,
      openProvider: async () => await openStagedProvider(staged, inputHashes, ledger.plannedRgbaBytes),
      release: async () => {
        if (released) return;
        released = true;
        await cleanupStaging(authority, snapshots.values(), ownedPaths);
      }
    };
  } catch (error) {
    await cleanupStaging(authority, snapshots.values(), ownedPaths).catch(() => undefined);
    throw error;
  }
}

function mediaByAssetRef(media: readonly GpuVideoStagingMedia[]): Map<string, GpuVideoStagingMedia> {
  const result = new Map<string, GpuVideoStagingMedia>();
  for (const item of media) {
    if (!item || typeof item.assetRef !== "string" || !item.assetRef || !Number.isInteger(item.width) || !Number.isInteger(item.height) || item.width < 1 || item.height < 1 || item.width > MAX_GPU_VIDEO_DIMENSION || item.height > MAX_GPU_VIDEO_DIMENSION) throw new Error("GPU video test media facts must provide each asset with dimensions within 1..4096.");
    if (result.has(item.assetRef)) throw new Error(`GPU video test media facts repeat ${item.assetRef}.`);
    result.set(item.assetRef, item);
  }
  return result;
}
async function inspectSources(pkg: MotionPackage, assetRefs: readonly string[]): Promise<Map<string, SourceFact>> {
  const facts = new Map<string, SourceFact>();
  for (const assetRef of assetRefs) {
    if (facts.has(assetRef)) continue;
    const sourcePath = resolvePackageAsset(pkg, assetRef);
    facts.set(assetRef, { inspection: await inspectSelfContainedFfmpegMediaInput(sourcePath, [pkg.root], "tracking-video") });
  }
  return facts;
}
async function probeSources(
  facts: ReadonlyMap<string, SourceFact>,
  snapshots: ReadonlyMap<string, FfmpegMediaInputSnapshot>,
  expectedMedia: ReadonlyMap<string, GpuVideoStagingMedia>,
  runner: FfmpegRunner
): Promise<Map<string, ResolvedSourceFact>> {
  const probedBySource = new Map<string, ProbedGpuVideoMedia>();
  const resolved = new Map<string, ResolvedSourceFact>();
  for (const [assetRef, fact] of facts) {
    const key = sourceKey(fact.inspection);
    let media = probedBySource.get(key);
    if (!media) {
      const snapshot = snapshots.get(key);
      if (!snapshot) throw new Error("GPU video immutable-source snapshot is unavailable for probing.");
      media = await probeImmutableGpuVideoSnapshot(snapshot, runner);
      probedBySource.set(key, media);
    }
    assertExpectedMedia(assetRef, media, expectedMedia.get(assetRef));
    resolved.set(assetRef, { ...fact, media });
  }
  return resolved;
}
function assertExpectedMedia(assetRef: string, actual: ProbedGpuVideoMedia, expected: GpuVideoStagingMedia | undefined): void {
  if (!expected) return;
  if (expected.width !== actual.width || expected.height !== actual.height || (expected.durationMs !== undefined && expected.durationMs !== actual.durationMs)) {
    throw new Error(`GPU video immutable-source probe does not match test media facts for ${assetRef}.`);
  }
}
function uniqueSourceFacts(facts: ReadonlyMap<string, SourceFact>): Map<string, SourceFact> {
  const result = new Map<string, SourceFact>();
  for (const fact of facts.values()) result.set(sourceKey(fact.inspection), fact);
  return result;
}
/**
 * Deduplicate at the immutable source boundary, but retain the entire PCM source.  The final
 * encoder applies every layer's original audio filter chain (trim, tempo, fades and timeline
 * start) against this PCM, so staging must never pre-apply a union interval that changes it.
 */
function audioPlansFor(assetRefs: readonly string[], facts: ReadonlyMap<string, ResolvedSourceFact>): Map<string, AudioPlan> {
  const plans = new Map<string, AudioPlan>();
  for (const assetRef of assetRefs) {
    const fact = facts.get(assetRef)!;
    const key = sourceKey(fact.inspection);
    if (plans.has(key)) continue;
    const durationMs = fact.media.durationMs;
    plans.set(key, { sourceKey: key, sourcePath: fact.inspection.sourcePath, durationMs, maxBytes: plannedPcmBytesForDuration(durationMs) });
  }
  return plans;
}

function videoAudioAssetRefs(pkg: MotionPackage, requestedSources?: ReadonlySet<string>): string[] {
  const refs = new Set<string>();
  for (const layer of pkg.motion.layers) {
    if (layer.type !== "video" || layer.includeAudio !== true) continue;
    const assetRef = gpuSceneImageAssetRef(pkg.motion, layer);
    if (!assetRef || !pkg.manifest.assets.includes(assetRef)) continue;
    const sourcePath = resolve(resolvePackageAsset(pkg, assetRef));
    if (!requestedSources || requestedSources.has(sourcePath)) refs.add(assetRef);
  }
  return [...refs];
}
async function cleanupStaging(authority: RetainedDirectoryAuthority, snapshots: Iterable<FfmpegMediaInputSnapshot>, paths: Iterable<string>): Promise<void> {
  await authority.assertCurrent();
  const results = await Promise.allSettled([...snapshots].map(async (snapshot) => await snapshot.release()));
  await Promise.allSettled([...paths].map(async (path) => await rm(path, { force: true })));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw new Error("GPU video staging cleanup failed.", { cause: failure.reason });
}

function rgbaBytes(media: Pick<GpuVideoStagingMedia, "width" | "height">, frames: number): number {
  const bytes = media.width * media.height * 4 * frames;
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("GPU video planned RGBA bytes exceed safe integer precision.");
  return bytes;
}
function decodeCommand(input: { executable: string; snapshot: FfmpegMediaInputSnapshot; rawPath: string; schedule: GpuVideoFrameSchedule; segment: GpuVideoDecodeSegment; fps: number }): FfmpegCommand {
  const playbackRate = input.schedule.layer.playbackRate ?? 1;
  const tailPadMs = (input.segment.frameCount * 1_000) / input.fps;
  return { executable: input.executable, shell: false, args: ["-v", "error", "-nostdin", "-y", "-ss", seconds(input.segment.sourceStartMs), ...trackingFfmpegMediaInputArgs(input.snapshot.path), "-an", "-vf", `setpts=(PTS-STARTPTS)/${playbackRate},tpad=stop_mode=clone:stop_duration=${seconds(tailPadMs)},fps=${input.fps},format=rgba`, "-frames:v", String(input.segment.frameCount), "-pix_fmt", "rgba", "-f", "rawvideo", input.rawPath] };
}
async function openStagedProvider(staged: readonly StagedLayer[], inputHashes: Readonly<Record<string, string>>, stagedDecodedBytes: number): Promise<GpuVideoFrameProvider> {
  const handles = new Map<string, FileHandle>();
  try { for (const layer of staged) for (const part of layer.parts) handles.set(part.rawPath, await open(part.rawPath, "r")); }
  catch (error) { await Promise.allSettled([...handles.values()].map(async (handle) => await handle.close())); throw error; }
  let decodedFrameCount = 0; let peakInMemoryFrames = 0; let closed = false;
  const evidence: GpuVideoFrameProviderEvidence = { schema: "shellx-motion/gpu-video-frame-provider@1", mode: "immutable-ffmpeg-rgba-stream", sourceCount: staged.length, decodedFrameCount, peakInMemoryFrames, stagedDecodedBytes, stagedFrameCount: staged.reduce((sum, layer) => sum + layer.atMsToOrdinal.size, 0), sources: staged.map((layer) => ({ layerId: layer.layerId, assetRef: layer.assetRef, sha256: layer.sourceSha256, width: layer.width, height: layer.height })) };
  return { inputHashes, get evidence() { return evidence; }, async frameAt(atMs, signal) {
    if (closed) throw new Error("GPU video frame provider is closed."); if (signal.aborted) throw signal.reason;
    const frames: GpuDecodedVideoFrame[] = [];
    for (const layer of staged) {
      const ordinal = layer.atMsToOrdinal.get(atMs); if (ordinal === undefined) continue;
      const part = layer.parts.find((candidate) => ordinal >= candidate.startOrdinal && ordinal < candidate.startOrdinal + candidate.frameCount);
      const rgba = Buffer.allocUnsafe(layer.frameBytes); const handle = part && handles.get(part.rawPath); if (!part || !handle) throw new Error(`GPU video frame handle for ${layer.layerId} is unavailable.`);
      const read = await handle.read(rgba, 0, rgba.byteLength, (ordinal - part.startOrdinal) * layer.frameBytes); if (read.bytesRead !== rgba.byteLength) throw new Error(`GPU video frame ${ordinal} for ${layer.layerId} is incomplete.`);
      const sha256 = hash(rgba); const resourceId = `video-${hash(`${layer.layerId}\0${layer.sourceSha256}`).slice(0, 24)}`;
      frames.push({ layerId: layer.layerId, assetRef: layer.assetRef, sourceAtMs: layer.sourceAtMs[ordinal]!, resource: { layerId: layer.layerId, resourceId, assetRef: layer.assetRef, width: layer.width, height: layer.height, sha256, sourceAtMs: layer.sourceAtMs[ordinal]! }, upload: { id: resourceId, width: layer.width, height: layer.height, rgba, sha256, decodedSha256: sha256 } });
    }
    decodedFrameCount += frames.length; peakInMemoryFrames = Math.max(peakInMemoryFrames, frames.length); evidence.decodedFrameCount = decodedFrameCount; evidence.peakInMemoryFrames = peakInMemoryFrames;
    return { atMs, frames };
  }, async close() { if (closed) return; closed = true; await Promise.all([...handles.values()].map(async (handle) => await handle.close())); } };
}
function stagedPath(root: string, name: string): string {
  const path = resolve(root, name); const relation = relative(root, path);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) throw new Error("GPU video staging path escaped its operation root.");
  return path;
}
async function fileHash(path: string): Promise<string> { const handle = await open(path, "r"); try { const digest = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); for (let position = 0;;) { const read = await handle.read(buffer, 0, buffer.length, position); if (!read.bytesRead) break; position += read.bytesRead; digest.update(buffer.subarray(0, read.bytesRead)); } return digest.digest("hex"); } finally { await handle.close(); } }
function sourceKey(inspection: FfmpegMediaInputInspection): string { return `${inspection.device}:${inspection.inode}`; }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function seconds(value: number): string { return (value / 1_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); }
