import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  completeTrackingAnalysis,
  createTrackingAnalysisLifecycle,
  createTrackingOperationReceipt,
  hashFile,
  invalidateTrackingAnalysis,
  assertTrackingAnalysisLifecycle,
  assertTrackingAnalysisRequest,
  retryTrackingAnalysis,
  solveFixedTrackingAnalysis,
  startTrackingAnalysis,
  stopTrackingAnalysis,
  type LocalMotionJobEvidence,
  type OperationReceipt,
  type TrackingAnalysis,
  type TrackingAnalysisLifecycle,
  type TrackingAnalysisSettings,
  type TrackingLumaFrame,
  type TrackingSourceIdentity,
  type TrackingTransformModel,
} from "@shellx-motion/core";
import {
  createGovernedFfmpegRunner,
  resolveFfmpegExecutable,
  resolveFfprobeExecutable,
  type FfmpegCommand,
  type FfmpegProcessResult,
} from "@shellx-motion/renderer-ffmpeg";

const MAX_DECODED_LUMA_BYTES = 200_000_000;
export const MAX_TRACKING_MEDIA_BYTES = 64 * 1024 * 1024 * 1024;

export interface TrackingMediaCommandContext {
  operation: "analysis.media.probe" | "analysis.media.decode";
  scratchRoot: string;
  signal?: AbortSignal;
}

export type TrackingMediaCommandRunner = (
  command: FfmpegCommand,
  context: TrackingMediaCommandContext
) => Promise<FfmpegProcessResult>;

export interface AnalyzeTrackingMediaInput {
  id: string;
  assetId: string;
  sourcePath: string;
  mode: "point" | "planar";
  model: TrackingTransformModel;
  reference: TrackingAnalysis["reference"];
  settings: TrackingAnalysisSettings;
  scratchRoot: string;
  packageId: string;
  createdAt?: string;
  signal?: AbortSignal;
  runCommand?: TrackingMediaCommandRunner;
  /** A persisted final lifecycle enables explicit retries without discarding lastGood. */
  existingLifecycle?: TrackingAnalysisLifecycle;
}

export type AnalyzeTrackingMediaResult =
  | {
      ok: true;
      source: TrackingSourceIdentity;
      analysis: TrackingAnalysis;
      lifecycle: TrackingAnalysisLifecycle;
      receipt: OperationReceipt;
      resources: LocalMotionJobEvidence[];
    }
  | {
      ok: false;
      source?: TrackingSourceIdentity;
      lifecycle?: TrackingAnalysisLifecycle;
      receipt?: OperationReceipt;
      error: { code: "tracking_cancelled" | "tracking_probe_failed" | "tracking_request_invalid" | "tracking_decode_failed" | "tracking_solve_failed"; message: string };
      resources: LocalMotionJobEvidence[];
    };

/** Probe, decode, and solve package-local media without exposing executable media data to packages. */
export async function analyzeTrackingMedia(input: AnalyzeTrackingMediaInput): Promise<AnalyzeTrackingMediaResult> {
  const resources: LocalMotionJobEvidence[] = [];
  const runCommand = input.runCommand ?? defaultTrackingMediaCommandRunner;
  let source: TrackingSourceIdentity | undefined;
  let lifecycle: TrackingAnalysisLifecycle | undefined;
  let phase: "probe" | "validate" | "decode" | "solve" = "probe";
  try {
    source = await inspectTrackingMediaSource({
      assetId: input.assetId,
      sourcePath: input.sourcePath,
      scratchRoot: input.scratchRoot,
      signal: input.signal,
      runCommand,
      resources,
    });
    phase = "validate";
    assertTrackingAnalysisRequest({
      id: input.id,
      source,
      mode: input.mode,
      model: input.model,
      reference: input.reference,
      settings: input.settings,
    });
    if (input.existingLifecycle) {
      assertTrackingAnalysisLifecycle(input.existingLifecycle);
      if (input.existingLifecycle.id !== input.id) throw new Error("Existing tracking lifecycle id does not match the request.");
      const current = invalidateTrackingAnalysis(input.existingLifecycle, source, input.createdAt);
      lifecycle = startTrackingAnalysis(retryTrackingAnalysis(current, { source, now: input.createdAt }), input.createdAt);
    } else {
      lifecycle = startTrackingAnalysis(createTrackingAnalysisLifecycle({
        id: input.id,
        source,
        now: input.createdAt,
      }), input.createdAt);
    }
    phase = "decode";
    const frames = await decodeTrackingLumaFrames({
      source,
      sourcePath: input.sourcePath,
      settings: input.settings,
      referenceAtMs: input.reference.atMs,
      scratchRoot: input.scratchRoot,
      signal: input.signal,
      runCommand,
      resources,
    });
    phase = "solve";
    const analysis = solveFixedTrackingAnalysis({
      id: input.id,
      source,
      mode: input.mode,
      model: input.model,
      reference: input.reference,
      settings: input.settings,
      frames,
      createdAt: input.createdAt,
      signal: input.signal,
    });
    lifecycle = completeTrackingAnalysis(lifecycle, analysis, input.createdAt);
    const receipt = createTrackingOperationReceipt({
      operation: "analysis.tracking.request",
      packageId: input.packageId,
      lifecycle,
      output: {
        analysis,
        resources,
        media: { path: "package-local-redacted", sourceSha256: source.sha256 },
      },
      now: input.createdAt,
    });
    return { ok: true, source, analysis, lifecycle, receipt, resources };
  } catch (error) {
    const cancelled = input.signal?.aborted === true;
    if (lifecycle?.state === "running") {
      lifecycle = stopTrackingAnalysis(lifecycle, {
        state: cancelled ? "cancelled" : "failed",
        code: cancelled ? "tracking_cancelled" : source ? "tracking_analysis_failed" : "tracking_probe_failed",
        message: safeMessage(error),
        now: input.createdAt,
      });
    }
    const code = cancelled
      ? "tracking_cancelled"
      : phase === "probe"
        ? "tracking_probe_failed"
        : phase === "validate"
          ? "tracking_request_invalid"
        : phase === "decode"
          ? "tracking_decode_failed"
          : "tracking_solve_failed";
    const receipt = lifecycle ? createTrackingOperationReceipt({
      operation: "analysis.tracking.request",
      packageId: input.packageId,
      lifecycle,
      output: { error: { code, message: safeMessage(error) }, resources },
      now: input.createdAt,
    }) : undefined;
    return {
      ok: false,
      ...(source ? { source } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      ...(receipt ? { receipt } : {}),
      error: { code, message: safeMessage(error) },
      resources,
    };
  }
}

export async function inspectTrackingMediaSource(input: {
  assetId: string;
  sourcePath: string;
  scratchRoot: string;
  signal?: AbortSignal;
  runCommand?: TrackingMediaCommandRunner;
  resources?: LocalMotionJobEvidence[];
}): Promise<TrackingSourceIdentity> {
  const canonical = await canonicalRegularMediaPath(input.sourcePath);
  const before = await lstat(canonical);
  if (before.size < 1 || before.size > MAX_TRACKING_MEDIA_BYTES) {
    throw new Error(`Tracking media must contain 1..${MAX_TRACKING_MEDIA_BYTES} bytes.`);
  }
  const runner = input.runCommand ?? defaultTrackingMediaCommandRunner;
  const probe = await runner({
    executable: resolveFfprobeExecutable(),
    args: [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration",
      "-of", "json",
      canonical,
    ],
    shell: false,
  }, { operation: "analysis.media.probe", scratchRoot: input.scratchRoot, signal: input.signal });
  if (probe.resources) input.resources?.push(probe.resources);
  if (probe.exitCode !== 0) throw new Error(`Tracking media probe failed: ${boundedDiagnostic(probe.stderr)}`);
  const facts = parseMediaProbe(probe.stdout);
  const sha256 = await hashFile(canonical);
  const after = await lstat(canonical);
  if (!sameFileFacts(before, after)) throw new Error("Tracking media changed while its identity was being established.");
  return {
    assetId: input.assetId,
    sha256,
    byteLength: after.size,
    width: facts.width,
    height: facts.height,
    durationMs: facts.durationMs,
  };
}

export async function decodeTrackingLumaFrames(input: {
  source: TrackingSourceIdentity;
  sourcePath: string;
  settings: TrackingAnalysisSettings;
  referenceAtMs: number;
  scratchRoot: string;
  signal?: AbortSignal;
  runCommand?: TrackingMediaCommandRunner;
  resources?: LocalMotionJobEvidence[];
}): Promise<TrackingLumaFrame[]> {
  const canonical = await canonicalRegularMediaPath(input.sourcePath);
  const initialHash = await hashFile(canonical);
  if (initialHash !== input.source.sha256) throw new Error("Tracking source identity is stale before decode.");
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
        "-i", canonical,
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
    if (await hashFile(canonical) !== input.source.sha256) throw new Error("Tracking source identity changed during decode.");
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

async function canonicalRegularMediaPath(path: string): Promise<string> {
  const requested = resolve(path);
  const facts = await lstat(requested);
  if (!facts.isFile() || facts.isSymbolicLink()) throw new Error("Tracking media must be a regular non-symlink file.");
  const canonical = await realpath(requested);
  if (canonical !== requested) throw new Error("Tracking media path must already be canonical.");
  return canonical;
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

function sameFileFacts(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(6);
}

function boundedDiagnostic(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) || "unknown error";
}

function safeMessage(error: unknown): string {
  return boundedDiagnostic(error instanceof Error ? error.message : String(error));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
