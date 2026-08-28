/** Immutable, file-only FFprobe/FFmpeg admission for tracking media. */
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  hashFile,
  type LocalMotionJobEvidence,
  type TrackingAnalysisSettings,
  type TrackingLumaFrame,
  type TrackingSourceIdentity,
} from "@shellx-motion/core";
import {
  createGovernedFfmpegRunner,
  MAX_TRACKING_VIDEO_INPUT_SNAPSHOT_BYTES,
  resolveFfmpegExecutable,
  resolveFfprobeExecutable,
  snapshotSelfContainedFfmpegMediaInput,
  trackingFfmpegMediaInputArgs,
  type FfmpegCommand,
  type FfmpegMediaInputSnapshot,
  type FfmpegProcessResult,
} from "@shellx-motion/renderer-ffmpeg";

const MAX_DECODED_LUMA_BYTES = 200_000_000;
export const MAX_TRACKING_MEDIA_BYTES = MAX_TRACKING_VIDEO_INPUT_SNAPSHOT_BYTES;

export interface TrackingMediaCommandContext {
  operation: "analysis.media.probe" | "analysis.media.decode";
  scratchRoot: string;
  signal?: AbortSignal;
}

export type TrackingMediaCommandRunner = (
  command: FfmpegCommand,
  context: TrackingMediaCommandContext
) => Promise<FfmpegProcessResult>;

export async function retainTrackingMediaInput(sourcePath: string, inputRoot: string): Promise<FfmpegMediaInputSnapshot> {
  return await snapshotSelfContainedFfmpegMediaInput(sourcePath, [inputRoot], "tracking-video");
}

export async function inspectTrackingMediaSource(input: {
  assetId: string;
  sourcePath: string;
  inputRoot: string;
  scratchRoot: string;
  signal?: AbortSignal;
  runCommand?: TrackingMediaCommandRunner;
  resources?: LocalMotionJobEvidence[];
}): Promise<TrackingSourceIdentity> {
  const snapshot = await retainTrackingMediaInput(input.sourcePath, input.inputRoot);
  try {
    return await inspectTrackingMediaSnapshot({ ...input, snapshot });
  } finally {
    await snapshot.release().catch(() => undefined);
  }
}

export async function inspectTrackingMediaSnapshot(input: {
  assetId: string;
  snapshot: FfmpegMediaInputSnapshot;
  scratchRoot: string;
  signal?: AbortSignal;
  runCommand?: TrackingMediaCommandRunner;
  resources?: LocalMotionJobEvidence[];
}): Promise<TrackingSourceIdentity> {
  const runner = input.runCommand ?? defaultTrackingMediaCommandRunner;
  const probe = await runner({
    executable: resolveFfprobeExecutable(),
    args: [
      "-v", "error",
      ...trackingFfmpegMediaInputArgs(input.snapshot.path),
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration",
      "-of", "json",
    ],
    shell: false,
  }, { operation: "analysis.media.probe", scratchRoot: input.scratchRoot, signal: input.signal });
  if (probe.resources) input.resources?.push(probe.resources);
  if (probe.exitCode !== 0) throw new Error(`Tracking media probe failed: ${boundedDiagnostic(probe.stderr)}`);
  const facts = parseMediaProbe(probe.stdout);
  return {
    assetId: input.assetId,
    sha256: input.snapshot.sha256,
    byteLength: input.snapshot.byteLength,
    width: facts.width,
    height: facts.height,
    durationMs: facts.durationMs,
  };
}

export async function decodeTrackingLumaFrames(input: {
  source: TrackingSourceIdentity;
  sourcePath: string;
  inputRoot: string;
  settings: TrackingAnalysisSettings;
  referenceAtMs: number;
  scratchRoot: string;
  signal?: AbortSignal;
  runCommand?: TrackingMediaCommandRunner;
  resources?: LocalMotionJobEvidence[];
}): Promise<TrackingLumaFrame[]> {
  const snapshot = await retainTrackingMediaInput(input.sourcePath, input.inputRoot);
  try {
    return await decodeTrackingLumaSnapshot({ ...input, snapshot });
  } finally {
    await snapshot.release().catch(() => undefined);
  }
}

export async function decodeTrackingLumaSnapshot(input: {
  source: TrackingSourceIdentity;
  snapshot: FfmpegMediaInputSnapshot;
  settings: TrackingAnalysisSettings;
  referenceAtMs: number;
  scratchRoot: string;
  signal?: AbortSignal;
  runCommand?: TrackingMediaCommandRunner;
  resources?: LocalMotionJobEvidence[];
}): Promise<TrackingLumaFrame[]> {
  if (input.snapshot.sha256 !== input.source.sha256 || input.snapshot.byteLength !== input.source.byteLength) {
    throw new Error("Tracking source identity is stale before decode.");
  }
  const decodeStartMs = input.settings.direction === "forward"
    ? Math.max(input.settings.startMs, input.referenceAtMs)
    : input.settings.startMs;
  const decodeEndMs = input.settings.direction === "backward"
    ? Math.min(input.settings.endMs, input.referenceAtMs)
    : input.settings.endMs;
  const frameCount = Math.floor((decodeEndMs - decodeStartMs) / input.settings.stepMs) + 1;
  const expectedBytes = frameCount * input.source.width * input.source.height;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_DECODED_LUMA_BYTES) {
    throw new Error(`Tracking decode exceeds the ${MAX_DECODED_LUMA_BYTES}-byte luma budget.`);
  }
  if ((decodeEndMs - decodeStartMs) % input.settings.stepMs !== 0) {
    throw new Error("Tracking decode range must be exactly divisible by stepMs.");
  }
  const outputPath = resolve(input.scratchRoot, `tracking-${randomUUID()}.gray`);
  const runner = input.runCommand ?? defaultTrackingMediaCommandRunner;
  try {
    const decode = await runner({
      executable: resolveFfmpegExecutable(),
      args: [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-ss", seconds(decodeStartMs),
        ...trackingFfmpegMediaInputArgs(input.snapshot.path),
        "-an", "-sn", "-dn",
        "-vf", `fps=1000/${input.settings.stepMs}`,
        "-frames:v", String(frameCount),
        "-pix_fmt", "gray",
        "-f", "rawvideo",
        "-y", outputPath,
      ],
      shell: false,
    }, { operation: "analysis.media.decode", scratchRoot: input.scratchRoot, signal: input.signal });
    if (decode.resources) input.resources?.push(decode.resources);
    if (decode.exitCode !== 0) throw new Error(`Tracking media decode failed: ${boundedDiagnostic(decode.stderr)}`);
    const raw = await readFile(outputPath);
    if (raw.byteLength !== expectedBytes) {
      throw new Error(`Tracking media decode returned ${raw.byteLength} bytes; expected ${expectedBytes}.`);
    }
    if (await hashFile(input.snapshot.path) !== input.source.sha256) throw new Error("Tracking source snapshot changed during decode.");
    const frameBytes = input.source.width * input.source.height;
    return Array.from({ length: frameCount }, (_, index) => ({
      atMs: decodeStartMs + index * input.settings.stepMs,
      width: input.source.width,
      height: input.source.height,
      luma: new Uint8Array(raw.buffer, raw.byteOffset + index * frameBytes, frameBytes).slice(),
    }));
  } finally {
    await rm(outputPath, { force: true }).catch(() => undefined);
  }
}

async function defaultTrackingMediaCommandRunner(command: FfmpegCommand, context: TrackingMediaCommandContext): Promise<FfmpegProcessResult> {
  return createGovernedFfmpegRunner({
    scratchRoot: context.scratchRoot,
    lane: "analysis",
    operation: context.operation,
    signal: context.signal,
  })(command);
}

function parseMediaProbe(raw: string): { width: number; height: number; durationMs: number } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Tracking media probe returned invalid JSON."); }
  const root = record(value);
  const stream = Array.isArray(root?.streams) ? record(root.streams[0]) : null;
  const format = record(root?.format);
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const durationMs = Number(format?.duration) * 1_000;
  if (!Number.isSafeInteger(width) || width < 1 || width > 7_680 || !Number.isSafeInteger(height) || height < 1 || height > 7_680) {
    throw new Error("Tracking media dimensions are invalid or exceed bounds.");
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 86_400_000) {
    throw new Error("Tracking media duration is invalid or exceeds bounds.");
  }
  return { width, height, durationMs: Math.round(durationMs) };
}

function seconds(milliseconds: number): string { return (milliseconds / 1_000).toFixed(6); }
function boundedDiagnostic(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) || "unknown error";
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
