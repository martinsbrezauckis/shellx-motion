import { trackingFfmpegMediaInputArgs, type FfmpegMediaInputSnapshot } from "./ffmpeg-media-input-fence.js";
import { resolveFfprobeExecutable, type FfmpegCommand, type FfmpegRunner } from "./index.js";

export const MAX_GPU_VIDEO_DIMENSION = 4_096;
export const MAX_GPU_VIDEO_DURATION_MS = 86_400_000;
const MAX_GPU_VIDEO_PROBE_JSON_BYTES = 512 * 1024;

export interface ProbedGpuVideoMedia {
  width: number;
  height: number;
  durationMs: number;
}

/**
 * Read the sole media identity that drives GPU staging from its immutable snapshot. The fixed
 * demuxer and dref switches are shared with the decoder, so neither process is ever pointed at
 * the mutable package asset.
 */
export async function probeImmutableGpuVideoSnapshot(
  snapshot: FfmpegMediaInputSnapshot,
  runner: FfmpegRunner
): Promise<ProbedGpuVideoMedia> {
  const command: FfmpegCommand = {
    executable: resolveFfprobeExecutable(),
    shell: false,
    args: ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", ...trackingFfmpegMediaInputArgs(snapshot.path)]
  };
  const result = await runner(command);
  if (result.exitCode !== 0) throw new Error("GPU video immutable-source probe failed.");
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_GPU_VIDEO_PROBE_JSON_BYTES) {
    throw new Error("GPU video immutable-source probe returned too much JSON.");
  }
  let parsed: { streams?: unknown; format?: { duration?: unknown } };
  try {
    parsed = JSON.parse(result.stdout) as { streams?: unknown; format?: { duration?: unknown } };
  } catch {
    throw new Error("GPU video immutable-source probe returned invalid JSON.");
  }
  if (!Array.isArray(parsed.streams)) throw new Error("GPU video immutable-source probe did not report streams.");
  const stream = parsed.streams.find(isVideoStream);
  if (!stream) throw new Error("GPU video immutable-source probe did not report a video stream.");
  const width = boundedDimension(stream.width, "width");
  const height = boundedDimension(stream.height, "height");
  const durationMs = boundedDurationMs(stream.duration ?? parsed.format?.duration);
  return { width, height, durationMs };
}

function isVideoStream(value: unknown): value is { codec_type?: unknown; width?: unknown; height?: unknown; duration?: unknown } {
  return typeof value === "object" && value !== null
    && (value as { codec_type?: unknown }).codec_type === "video";
}

function boundedDimension(value: unknown, label: "width" | "height"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_GPU_VIDEO_DIMENSION) {
    throw new Error(`GPU video immutable-source probe ${label} must be an integer within 1..${MAX_GPU_VIDEO_DIMENSION}.`);
  }
  return value;
}

function boundedDurationMs(value: unknown): number {
  const seconds = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)
      ? Number(value)
      : Number.NaN;
  const durationMs = seconds * 1_000;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_GPU_VIDEO_DURATION_MS) {
    throw new Error(`GPU video immutable-source probe duration must be within 0..${MAX_GPU_VIDEO_DURATION_MS} milliseconds.`);
  }
  return durationMs;
}
