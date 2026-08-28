/**
 * Pre-admitted FFprobe readback for a lossless segment. It deliberately uses the same contained
 * process seam as the encoder, rather than `probeMedia`'s ordinary standalone spawn, so one spool
 * stays inside its one existing governor lease.
 */
import type { LocalMotionJobContext, LocalMotionProcessContainmentEvidence } from "@shellx-motion/core";
import { resolveFfprobeExecutable, type FfmpegCommand } from "../index.js";
import type {
  RenderSegmentReadbackVerificationInput,
  RenderSegmentReadbackVerificationResult
} from "./render-segment-store-types.js";
import type { StreamingFfmpegProcessFactory } from "../streaming-process.js";

export interface PreAdmittedSegmentReadbackInput extends RenderSegmentReadbackVerificationInput {
  job: LocalMotionJobContext;
  processFactory: StreamingFfmpegProcessFactory;
  reportProcessContainment(evidence: LocalMotionProcessContainmentEvidence): void;
}

/** Keeps an abort-cleanup failure distinct from the frozen or otherwise immutable primary error. */
export class PreAdmittedSegmentReadbackCleanupError extends Error {
  constructor(readonly primaryCause: unknown, readonly cleanupCause: unknown) {
    super("Pre-admitted FFprobe readback cleanup failed.", { cause: primaryCause });
    this.name = "PreAdmittedSegmentReadbackCleanupError";
    Object.setPrototypeOf(this, PreAdmittedSegmentReadbackCleanupError.prototype);
  }
}

/** Run FFprobe under the already-held segment-spool job and return only observed facts. */
export async function verifyPreAdmittedLosslessSegment(
  input: PreAdmittedSegmentReadbackInput
): Promise<RenderSegmentReadbackVerificationResult> {
  let process: Awaited<ReturnType<StreamingFfmpegProcessFactory>> | undefined;
  try {
    process = await input.processFactory({
      command: ffprobeCommand(input.artifactPath),
      signal: input.job.signal,
      watchProcess: input.job.watchProcess,
      reportProcessContainment: input.reportProcessContainment
    });
    const result = await process.end();
    if (result.exitCode !== 0) return failure("FFprobe did not successfully read the lossless segment.");
    return readbackFromFfprobeJson(result.stdout, input);
  } catch (error) {
    try {
      await process?.abort(error instanceof Error ? error : new Error("FFprobe readback failed."));
    } catch (cleanupError) {
      throw new PreAdmittedSegmentReadbackCleanupError(error, cleanupError);
    }
    throw error;
  }
}

function ffprobeCommand(artifactPath: string): FfmpegCommand {
  return {
    executable: resolveFfprobeExecutable(),
    args: [
      "-v", "error",
      "-count_frames",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      "-protocol_whitelist", "file",
      artifactPath
    ],
    shell: false
  };
}

function readbackFromFfprobeJson(
  stdout: string,
  input: Pick<PreAdmittedSegmentReadbackInput, "range" | "expected">
): RenderSegmentReadbackVerificationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return failure("FFprobe returned invalid segment readback data.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failure("FFprobe returned invalid segment readback data.");
  }
  const streams = ownValue(parsed, "streams");
  if (!Array.isArray(streams)) return failure("FFprobe returned invalid segment readback data.");
  const video = streams.find((stream) => stream !== null
    && typeof stream === "object"
    && !Array.isArray(stream)
    && ownValue(stream, "codec_type") === "video");
  if (!video) return failure("FFprobe did not report a video stream for the lossless segment.");
  const format = ownValue(parsed, "format");
  if (format !== undefined && (format === null || typeof format !== "object" || Array.isArray(format))) {
    return failure("FFprobe returned invalid segment readback data.");
  }
  const frameCount = parseFrameCount(ownValue(video, "nb_read_frames") ?? ownValue(video, "nb_frames"));
  const fps = parseFps(ownValue(video, "avg_frame_rate"));
  const durationMs = parseDurationMs(ownValue(video, "duration") ?? (format === undefined ? undefined : ownValue(format, "duration")));
  const formatName = format === undefined ? undefined : ownValue(format, "format_name");
  const containerNames = (typeof formatName === "string" ? formatName : "").split(",").map((name) => name.trim());
  const codecName = ownValue(video, "codec_name");
  const pixelFormat = ownValue(video, "pix_fmt");
  const colorRange = ownValue(video, "color_range");
  const width = positiveSafeInteger(ownValue(video, "width"));
  const height = positiveSafeInteger(ownValue(video, "height"));
  const expected = input.expected;
  if (codecName !== expected.intermediate.codec || codecName !== "ffv1") {
    return failure("Lossless segment codec does not match required FFV1.");
  }
  if (expected.intermediate.container !== "matroska" || !containerNames.includes("matroska")) {
    return failure("Lossless segment container does not match required Matroska.");
  }
  if (pixelFormat !== "bgra" || colorRange !== "pc") {
    return failure("Lossless segment does not preserve required full-range BGRA pixels.");
  }
  if (width !== expected.timeline.width || height !== expected.timeline.height) {
    return failure("Lossless segment dimensions do not match the canonical timeline.");
  }
  if (frameCount !== input.range.frameCount) {
    return failure("Lossless segment frame count does not match its canonical range.");
  }
  if (!sameFps(fps, expected.timeline.fps)) {
    return failure("Lossless segment FPS does not match the canonical timeline.");
  }
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) {
    return failure("Lossless segment duration could not be read from FFprobe.");
  }
  const expectedDurationMs = input.range.frameCount * (1_000 / expected.timeline.fps);
  if (Math.abs(durationMs - expectedDurationMs) > durationToleranceMs(expected.timeline.fps)) {
    return failure("Lossless segment duration does not match its canonical frame range.");
  }
  return {
    ok: true,
    readback: {
      verified: true,
      frameCount,
      width,
      height,
      fps,
      durationMs
    }
  };
}

function failure(message: string): RenderSegmentReadbackVerificationResult {
  return { ok: false, message };
}

function parseFrameCount(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseFps(value: unknown): number {
  if (typeof value !== "string") return 0;
  const [numerator, denominator] = value.split("/").map(Number);
  const fps = denominator === undefined ? numerator : denominator > 0 ? numerator / denominator : 0;
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

function parseDurationMs(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1_000) : null;
}

function sameFps(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(0.0001, expected * 0.00001);
}

function durationToleranceMs(fps: number): number {
  return Math.max(10, (1_000 / fps) + 1);
}

function ownValue(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
