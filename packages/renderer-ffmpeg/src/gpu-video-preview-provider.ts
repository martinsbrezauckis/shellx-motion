import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  compareCodeUnits, compileGpuSceneStaticPlan,
  OutputDirectoryReservation,
  resolvePackageAsset,
  type GpuScene2dVideoResource,
  type GpuVideoFrameRequest,
  type GpuVideoSourceSnapshot,
  type MotionPackage,
  type RetainedDirectoryAuthority
} from "@shellx-motion/core";
import type {
  GpuPreviewDecodedVideoFrame,
  GpuPreviewDecodedVideoFrameBatch,
  GpuPreviewVideoFrameProvider,
  GpuPreviewVideoFrameProviderEvidence,
  GpuPreviewVideoProviderCleanupEvidence,
  GpuPreviewVideoProviderProbe,
  GpuPreviewVideoTextureSlot
} from "@shellx-motion/renderer-browser";
import {
  inspectSelfContainedFfmpegMediaInput,
  snapshotSelfContainedFfmpegMediaInput,
  type FfmpegMediaInputInspection,
  type FfmpegMediaInputSnapshot
} from "./ffmpeg-media-input-fence.js";
import {
  MAX_GPU_PREVIEW_VIDEO_CACHE_BYTES,
  MAX_GPU_PREVIEW_VIDEO_CACHE_ENTRIES,
  MAX_GPU_PREVIEW_VIDEO_DURATION_US,
  MAX_GPU_PREVIEW_VIDEO_SNAPSHOT_BYTES,
  MAX_GPU_PREVIEW_VIDEO_SOURCE_COUNT,
  abortReason,
  assertRequestMatchesSource,
  frameKey,
  makePreviewSource,
  probePreviewSource,
  probePreviewToolIdentity,
  rationalDecimal,
  rationalText,
  selectCfrFrame,
  throwIfAborted,
  type GpuPreviewFfmpegRunner,
  type PreviewSource
} from "./gpu-video-preview-provider-primitives.js";
import { GpuPreviewVideoFrameCache } from "./gpu-video-preview-provider-cache.js";
import { GpuPreviewVideoProviderEvidenceLedger } from "./gpu-video-preview-provider-evidence.js";
import type {
  CreateGpuPreviewVideoFrameProviderOptions,
  FfmpegGpuPreviewVideoFrameProvider,
  GpuPreviewVideoCacheStats,
  GpuPreviewVideoDecodedFrameEvidence,
  GpuPreviewVideoProviderDetailedEvidence
} from "./gpu-video-preview-provider-contracts.js";
export type {
  CreateGpuPreviewVideoFrameProviderOptions,
  FfmpegGpuPreviewVideoFrameProvider,
  GpuPreviewVideoDecodedFrameEvidence,
  GpuPreviewVideoProviderDetailedEvidence
} from "./gpu-video-preview-provider-contracts.js";
export {
  MAX_GPU_PREVIEW_VIDEO_CACHE_BYTES,
  MAX_GPU_PREVIEW_VIDEO_CACHE_ENTRIES,
  MAX_GPU_PREVIEW_VIDEO_DURATION_US,
  MAX_GPU_PREVIEW_VIDEO_IN_FLIGHT_RGBA_BYTES,
  MAX_GPU_PREVIEW_VIDEO_RECENT_FRAME_EVIDENCE,
  MAX_GPU_PREVIEW_VIDEO_SNAPSHOT_BYTES,
  MAX_GPU_PREVIEW_VIDEO_SOURCE_COUNT
} from "./gpu-video-preview-provider-primitives.js";
export type { GpuPreviewFfmpegRunner } from "./gpu-video-preview-provider-primitives.js";
/**
 * Creates ownership only. `probe()` does the snapshot and subprocess work under the caller's
 * cancellation signal, before Chromium opens. `framesFor()` accepts only Core-issued requests.
 */
export function createGpuPreviewVideoFrameProvider(
  input: CreateGpuPreviewVideoFrameProviderOptions
): FfmpegGpuPreviewVideoFrameProvider {
  return new FfmpegGpuPreviewVideoFrameProviderImpl(input);
}

class FfmpegGpuPreviewVideoFrameProviderImpl implements FfmpegGpuPreviewVideoFrameProvider {
  readonly #pkg: MotionPackage;
  readonly #scratchRoot: string;
  readonly #scratchAuthority: RetainedDirectoryAuthority | undefined;
  readonly #runner: GpuPreviewFfmpegRunner;
  readonly #cache: GpuPreviewVideoFrameCache;
  readonly #sourcesByAsset = new Map<string, PreviewSource>();
  /** Every physical snapshot is owned from acquisition, even if a later probe fails. */
  readonly #ownedSnapshots = new Map<string, FfmpegMediaInputSnapshot>();
  readonly #snapshotsByLayer = new Map<string, GpuVideoSourceSnapshot>();
  readonly #slotsByLayer = new Map<string, GpuPreviewVideoTextureSlot>();
  readonly #receipt = new GpuPreviewVideoProviderEvidenceLedger();
  #privateRoot: string | undefined;
  #privateAuthority: RetainedDirectoryAuthority | undefined;
  #probePromise: Promise<GpuPreviewVideoProviderProbe> | undefined;
  #probeController: AbortController | undefined;
  #probeWaiters = 0;
  #closed = false;
  #closePromise: Promise<GpuPreviewVideoProviderCleanupEvidence> | undefined;
  constructor(input: CreateGpuPreviewVideoFrameProviderOptions) {
    this.#pkg = input.pkg;
    this.#scratchRoot = resolve(input.scratchRoot);
    this.#scratchAuthority = input.scratchAuthority;
    this.#runner = input.runner;
    this.#cache = new GpuPreviewVideoFrameCache({
      runner: this.#runner,
      privateRoot: () => this.#privateRoot,
      privateAuthority: () => this.#privateAuthority,
      onStats: (stats) => this.#receipt.syncCache(stats)
    });
  }

  get inputHashes(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries([...this.#sourcesByAsset].map(([assetRef, source]) => [assetRef, source.snapshot.sha256])));
  }

  get evidence(): Readonly<GpuPreviewVideoFrameProviderEvidence> { return this.#receipt.base; } get detailedEvidence(): Readonly<GpuPreviewVideoProviderDetailedEvidence> { return this.#receipt.detailed; }

  async probe(signal: AbortSignal): Promise<GpuPreviewVideoProviderProbe> {
    this.#assertOpen();
    if (!this.#probePromise) {
      this.#probeController = new AbortController();
      this.#probePromise = this.#probeSources(this.#probeController.signal);
      // A final probe waiter may leave before a subprocess starts. Keep the promise observed so a
      // cancellation cannot become an unhandled rejection while close reaps the work.
      void this.#probePromise.catch(() => undefined);
    }
    return await this.#waitForProbe(signal);
  }

  async framesFor(requests: readonly GpuVideoFrameRequest[], signal: AbortSignal): Promise<GpuPreviewDecodedVideoFrameBatch> {
    this.#assertOpen();
    if (!this.#probePromise) throw new Error("GPU preview video provider must probe immutable sources before decoding.");
    if (signal.aborted) throw abortReason(signal);
    if (requests.length === 0) return { atUs: 0, frames: [] };
    const atUs = requests[0]?.atUs;
    if (typeof atUs !== "number" || !requests.every((request) => request.atUs === atUs)) {
      throw new Error("GPU preview video provider accepts one Core playhead per frame batch.");
    }
    await this.#probePromise;
    const frames = await Promise.all(requests.map(async (request) => await this.#frameFor(request, signal)));
    this.#receipt.base.decodedFrameCount += frames.length;
    return { atUs, frames };
  }

  async close(): Promise<GpuPreviewVideoProviderCleanupEvidence> {
    if (this.#closePromise) return await this.#closePromise;
    this.#closed = true;
    this.#probeController?.abort(new Error("GPU preview video provider closed."));
    this.#cache.abort(new Error("GPU preview video provider closed."));
    this.#closePromise = this.#close();
    return await this.#closePromise;
  }

  async #close(): Promise<GpuPreviewVideoProviderCleanupEvidence> {
    const cacheCleanup = this.#cache.close();
    await Promise.allSettled([
      ...(this.#probePromise ? [this.#probePromise] : []),
      cacheCleanup
    ]);
    const releasedFrames = await cacheCleanup;
    const snapshots = [...this.#ownedSnapshots.values()], releasedSources = this.#sourcesByAsset.size;
    const released = await Promise.allSettled(snapshots.map(async (snapshot) => await snapshot.release()));
    const releaseFailure = released.find((result) => result.status === "rejected");
    if (releaseFailure?.status === "rejected") throw new Error("GPU preview video provider could not release an immutable source snapshot.", { cause: releaseFailure.reason });
    this.#ownedSnapshots.clear();
    let removed = false;
    if (this.#privateRoot) {
      await this.#privateAuthority?.assertCurrent();
      await rmdir(this.#privateRoot);
      removed = true;
    }
    const cleanup = { closed: true as const, releasedFrames, releasedSources, privateScratchReleased: true as const };
    this.#receipt.detailed.cleanup = { ...cleanup, snapshotsReleased: snapshots.length, privateRootRemoved: removed };
    return cleanup;
  }

  async #probeSources(signal: AbortSignal): Promise<GpuPreviewVideoProviderProbe> {
    try {
      throwIfAborted(signal);
      const staticPlan = compileGpuSceneStaticPlan(this.#pkg.motion);
      if (!staticPlan.ok) throw new Error(staticPlan.failure.message);
      const videoResources = staticPlan.plan.resources.filter((resource) => resource.kind === "video");
      if (videoResources.length > MAX_GPU_PREVIEW_VIDEO_SOURCE_COUNT || staticPlan.plan.maxima.maxVideoCount > MAX_GPU_PREVIEW_VIDEO_SOURCE_COUNT) {
        throw new Error(`GPU preview video accepts at most ${MAX_GPU_PREVIEW_VIDEO_SOURCE_COUNT} visible video layers and sources.`);
      }
      const byAsset = new Map<string, { layerIds: string[]; inspection: FfmpegMediaInputInspection }>();
      for (const resource of videoResources) {
        throwIfAborted(signal);
        const layerIds = resource.consumers.map((consumer) => consumer.layerId);
        const sourcePath = resolvePackageAsset(this.#pkg, resource.assetRef);
        const inspection = await inspectSelfContainedFfmpegMediaInput(sourcePath, [this.#pkg.root], "tracking-video");
        if (inspection.byteLength > MAX_GPU_PREVIEW_VIDEO_SNAPSHOT_BYTES) {
          throw new Error(`GPU preview video source ${resource.assetRef} exceeds the ${MAX_GPU_PREVIEW_VIDEO_SNAPSHOT_BYTES}-byte snapshot limit.`);
        }
        byAsset.set(resource.assetRef, { layerIds, inspection });
      }
      const physical = new Map<string, { inspection: FfmpegMediaInputInspection; assetRefs: string[] }>();
      for (const [assetRef, source] of byAsset) {
        const key = `${source.inspection.device}:${source.inspection.inode}`;
        const current = physical.get(key) ?? { inspection: source.inspection, assetRefs: [] };
        current.assetRefs.push(assetRef); physical.set(key, current);
      }
      if (physical.size > MAX_GPU_PREVIEW_VIDEO_SOURCE_COUNT) throw new Error(`GPU preview video accepts at most ${MAX_GPU_PREVIEW_VIDEO_SOURCE_COUNT} immutable sources.`);
      const totalBytes = [...physical.values()].reduce((sum, source) => sum + source.inspection.byteLength, 0);
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_GPU_PREVIEW_VIDEO_SNAPSHOT_BYTES) {
        throw new Error(`GPU preview video snapshots exceed the ${MAX_GPU_PREVIEW_VIDEO_SNAPSHOT_BYTES}-byte aggregate limit.`);
      }
      await this.#acquirePrivateChild();
      const tooling = await probePreviewToolIdentity(this.#runner, signal);
      const snapshotByPhysical = new Map<string, FfmpegMediaInputSnapshot>();
      for (const [key, source] of physical) {
        throwIfAborted(signal); await this.#privateAuthority?.assertCurrent();
        const snapshot = await snapshotSelfContainedFfmpegMediaInput(source.inspection.sourcePath, [this.#pkg.root], "tracking-video", {
          stagingRoot: this.#privateRoot,
          stagingAuthority: this.#privateAuthority,
          maxBytes: MAX_GPU_PREVIEW_VIDEO_SNAPSHOT_BYTES,
          expected: source.inspection
        });
        snapshotByPhysical.set(key, snapshot); this.#ownedSnapshots.set(key, snapshot);
      }
      for (const [assetRef, planned] of byAsset) {
        throwIfAborted(signal);
        const snapshot = snapshotByPhysical.get(`${planned.inspection.device}:${planned.inspection.inode}`);
        if (!snapshot) throw new Error("GPU preview immutable source snapshot is unavailable.");
        const facts = await probePreviewSource(snapshot, this.#runner, signal);
        const source = makePreviewSource(assetRef, planned.inspection, snapshot, facts, planned.layerIds, tooling);
        this.#sourcesByAsset.set(assetRef, source);
        for (const slot of source.slots) {
          this.#slotsByLayer.set(slot.layerId, slot);
          this.#snapshotsByLayer.set(slot.layerId, Object.freeze({
            assetRef, sourceSnapshotSha256: snapshot.sha256, durationUs: source.durationUs,
            width: source.width, height: source.height, decodeContractSha256: source.decodeContractSha256
          }));
        }
        this.#receipt.detailed.snapshots.push({
          assetRef, sourceSnapshotSha256: snapshot.sha256, byteLength: snapshot.byteLength,
          width: source.width, height: source.height, durationUs: source.durationUs,
          fps: rationalText(source.fps), frameDuration: `${source.frameDurationPts.toString()}/${source.timeBase.denominator.toString()}*${source.timeBase.numerator.toString()}s`,
          ffmpegIdentity: tooling.ffmpeg, ffprobeIdentity: tooling.ffprobe,
          decodeContractSha256: source.decodeContractSha256
        });
      }
      this.#receipt.base.sourceCount = this.#sourcesByAsset.size;
      return {
        snapshots: new Map(this.#snapshotsByLayer),
        slots: [...this.#slotsByLayer.values()].sort((left, right) => compareCodeUnits(left.layerId, right.layerId))
      };
    } catch (error) {
      await this.#releaseProbeFailure();
      throw error;
    }
  }

  async #frameFor(request: GpuVideoFrameRequest, signal: AbortSignal): Promise<GpuPreviewDecodedVideoFrame> {
    const source = this.#sourcesByAsset.get(request.assetRef);
    const slot = this.#slotsByLayer.get(request.layerId);
    if (!source || !slot) throw new Error(`GPU preview video request ${request.layerId} does not name a probed static-plan source.`);
    assertRequestMatchesSource(request, source, slot);
    const decodedPts = selectCfrFrame(source, request.sourceAtUs);
    const { entry, cache } = await this.#cache.get(frameKey(source, decodedPts), source, decodedPts, signal);
    const resource: GpuScene2dVideoResource = {
      layerId: request.layerId, resourceId: slot.resourceId, assetRef: request.assetRef,
      width: source.width, height: source.height, sha256: entry.sha256, sourceAtMs: request.sourceAtMs,
      sourceAtUs: request.sourceAtUs, sourceSnapshotSha256: request.sourceSnapshotSha256,
      decodedRgbaSha256: entry.sha256, decodeContractSha256: request.decodeContractSha256,
      requestFingerprint: request.requestFingerprint
    };
    this.#receipt.record({
      layerId: request.layerId, assetRef: request.assetRef, requestFingerprint: request.requestFingerprint,
      requestedSourceAtUs: request.sourceAtUs, decodedPts: { value: entry.decodedPts.toString(), timeBase: rationalText(source.timeBase) },
      decodedPtsUs: rationalDecimal(entry.decodedPts * source.timeBase.numerator * 1_000_000n, source.timeBase.denominator),
      sourceSnapshotSha256: request.sourceSnapshotSha256, decodedRgbaSha256: entry.sha256,
      decodeContractSha256: request.decodeContractSha256, cache
    });
    return {
      request, resource,
      // Page-slot identity remains the immutable source hash; decodedSha256 separately proves the
      // mutable texture bytes.  Do not overload this with final-staging source/PCM semantics.
      selection: {
        policy: "cfr-floor-request-sourceAtUs-to-stream-pts",
        decodedPts: entry.decodedPts.toString(), timeBase: rationalText(source.timeBase),
        decodedPtsUs: rationalDecimal(entry.decodedPts * source.timeBase.numerator * 1_000_000n, source.timeBase.denominator),
        frameDurationPts: source.frameDurationPts.toString()
      },
      upload: { id: slot.resourceId, width: source.width, height: source.height, rgba: entry.rgba, sha256: request.sourceSnapshotSha256, decodedSha256: entry.sha256 }
    };
  }

  async #waitForProbe(signal: AbortSignal): Promise<GpuPreviewVideoProviderProbe> {
    const promise = this.#probePromise;
    if (!promise) throw new Error("GPU preview video provider probe was not initialized.");
    if (signal.aborted) throw abortReason(signal);
    this.#probeWaiters += 1;
    return await new Promise<GpuPreviewVideoProviderProbe>((resolveWaiter, rejectWaiter) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true; this.#probeWaiters -= 1; signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        finish();
        if (this.#probeWaiters === 0) this.#probeController?.abort(abortReason(signal));
        rejectWaiter(abortReason(signal));
      };
      signal.addEventListener("abort", abort, { once: true });
      promise.then((value) => { if (done) return; finish(); resolveWaiter(value); }, (error) => { if (done) return; finish(); rejectWaiter(error); });
      if (signal.aborted) abort();
    });
  }

  async #acquirePrivateChild(): Promise<void> {
    const parent = this.#scratchAuthority ?? await OutputDirectoryReservation.acquire(this.#scratchRoot, {
      requireExisting: true, requirePrivate: true, requireExclusiveChildAuthority: true, allowExistingContents: true
    });
    if (resolve(parent.path) !== this.#scratchRoot) throw new Error("GPU preview video scratch authority does not match the host scratch root.");
    await parent.assertCurrent();
    const child = join(parent.path, `.gpu-preview-video-${randomUUID()}`);
    await mkdir(child, { mode: 0o700 });
    const canonical = await realpath(child);
    const initial = await lstat(canonical);
    if (canonical !== child || !initial.isDirectory() || initial.isSymbolicLink()) throw new Error("GPU preview video private scratch child was replaced while it was created.");
    this.#privateRoot = canonical;
    this.#privateAuthority = {
      path: canonical,
      assertCurrent: async () => {
        await parent.assertCurrent();
        const current = await lstat(canonical);
        if (!current.isDirectory() || current.isSymbolicLink()) throw new Error("GPU preview video private scratch child changed while retained.");
      }
    };
  }

  async #releaseProbeFailure(): Promise<void> {
    const released = await Promise.allSettled([...this.#ownedSnapshots.values()].map(async (snapshot) => await snapshot.release()));
    const releaseFailure = released.find((result) => result.status === "rejected");
    if (releaseFailure?.status === "rejected") throw new Error("GPU preview video provider could not release an immutable source snapshot after probe failure.", { cause: releaseFailure.reason });
    this.#ownedSnapshots.clear();
    this.#sourcesByAsset.clear(); this.#snapshotsByLayer.clear(); this.#slotsByLayer.clear();
    if (this.#privateRoot) {
      await this.#privateAuthority?.assertCurrent();
      await rmdir(this.#privateRoot);
      this.#privateRoot = undefined; this.#privateAuthority = undefined;
    }
  }

  #assertOpen(): void { if (this.#closed) throw new Error("GPU preview video provider is closed."); }
}
