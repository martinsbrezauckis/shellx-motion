import { canonicalJsonSha256 } from "@shellx-motion/core";
import {
  LINEAR_SRGB_SDR_FINAL_MAX_HEIGHT,
  LINEAR_SRGB_SDR_FINAL_MAX_WIDTH,
} from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import {
  checkFfmpeg,
  createGovernedFfmpegRunner,
  motionToolIdentityFor,
  probeMotionTool,
  resolveFfmpegExecutable,
  type MotionToolIdentity,
  type FfmpegCommand,
  type FfmpegRunner,
} from "./index.js";
import { extname } from "node:path";

export const LINEAR_SRGB_SDR_FINAL_FFMPEG_SCHEMA = "shellx-motion/linear-srgb-sdr-final-ffmpeg@1" as const;
export const LINEAR_SRGB_SDR_FINAL_FFMPEG_PREFLIGHT_SCHEMA = "shellx-motion/linear-srgb-sdr-final-ffmpeg-preflight@1" as const;
export const LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const LINEAR_SRGB_SDR_FINAL_OUTPUT_TOKEN = "__shellx_motion_managed_linear_srgb_sdr_output__.mp4" as const;
export const LINEAR_SRGB_SDR_FINAL_DECODE_TOKEN = "__shellx_motion_private_linear_srgb_sdr_frame__.rgba" as const;

/** Exact sRGB-full-RGB to BT.709-transfer/matrix limited-YUV conversion. */
export const LINEAR_SRGB_SDR_FINAL_FORWARD_FILTER = "zscale=primariesin=bt709:transferin=iec61966-2-1:matrixin=gbr:rangein=full:primaries=bt709:transfer=bt709:matrix=bt709:range=limited:dither=none,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
/** Exact first-frame inverse used only for post-encode comparison with retained producer RGBA8. */
export const LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER = "select=eq(n\\,0),zscale=primariesin=bt709:transferin=bt709:matrixin=bt709:rangein=limited:primaries=bt709:transfer=iec61966-2-1:matrix=gbr:range=full:dither=none,format=gbrp,format=rgba";

export const LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT = freeze({
  schema: LINEAR_SRGB_SDR_FINAL_FFMPEG_SCHEMA,
  source: { pixelFormat: "rgba", alpha: "straight-opaque", transfer: "iec61966-2-1", primaries: "bt709", matrix: "gbr", range: "full" },
  forward: { filter: LINEAR_SRGB_SDR_FINAL_FORWARD_FILTER, dither: "none" },
  encode: { codec: "libx264", crf: 18, preset: "medium", pixelFormat: "yuv420p", hardware: "refused" },
  signal: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" },
  inverse: { filter: LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER, frameIndex: 0, intermediatePixelFormat: "gbrp", outputPixelFormat: "rgba" },
  delivery: { container: "mp4", fastStart: true, maxOutputBytes: LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES },
});
export const LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT_SHA256 = canonicalJsonSha256(LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT);

export interface LinearSrgbSdrFinalTimeline {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frameCount: number;
}

export interface LinearSrgbSdrFinalFfmpegPreflightEvidence {
  readonly schema: typeof LINEAR_SRGB_SDR_FINAL_FFMPEG_PREFLIGHT_SCHEMA;
  readonly status: "available";
  readonly tools: {
    readonly ffmpeg: MotionToolIdentity;
    readonly ffprobe: MotionToolIdentity;
  };
  readonly contractSha256: string;
  readonly commandSha256: string;
  readonly fingerprint: string;
}

/** Pure, output-free command that exercises the exact strict filter and software encoder. */
export function linearSrgbSdrFinalFfmpegPreflightCommand(): FfmpegCommand {
  return {
    executable: resolveFfmpegExecutable(),
    shell: false,
    args: [
      "-hide_banner", "-v", "error", "-nostdin",
      "-f", "lavfi", "-i", "color=c=black:s=2x2:r=1:d=1,format=rgba",
      "-frames:v", "1", "-vf", LINEAR_SRGB_SDR_FINAL_FORWARD_FILTER,
      ...encodeArgs(), "-f", "null", "-",
    ],
  };
}

/**
 * Checks identity and the exact output-free conversion before any GPU, output,
 * receipt, or decoded-frame allocation. Production creates its governed runner;
 * the optional runner is a relative-module qualification seam only.
 */
export async function preflightLinearSrgbSdrFinalFfmpeg(input: { readonly runner?: FfmpegRunner } = {}): Promise<LinearSrgbSdrFinalFfmpegPreflightEvidence> {
  const runner = input.runner ?? createGovernedFfmpegRunner({ operation: "ffmpeg.linear-srgb-sdr-preflight" });
  const health = await checkFfmpeg({ runner });
  if (!health.ok) throw new Error("The strict linear-sRGB SDR route requires a working FFmpeg installation.");
  const ffprobe = await probeMotionTool("ffprobe", runner);
  if (ffprobe.status !== "ready") throw new Error("The strict linear-sRGB SDR route requires a working FFprobe installation.");
  const command = linearSrgbSdrFinalFfmpegPreflightCommand();
  const result = await runner(command);
  if (result.exitCode !== 0) throw new Error("FFmpeg does not support the exact strict linear-sRGB SDR zscale and libx264 contract.");
  const base = {
    schema: LINEAR_SRGB_SDR_FINAL_FFMPEG_PREFLIGHT_SCHEMA,
    status: "available" as const,
    tools: {
      ffmpeg: motionToolIdentityFor("ffmpeg", health.version),
      ffprobe: motionToolIdentityFor("ffprobe", ffprobe.version),
    },
    contractSha256: LINEAR_SRGB_SDR_FINAL_FFMPEG_CONTRACT_SHA256,
    commandSha256: canonicalJsonSha256(command),
  };
  return freeze({ ...base, fingerprint: canonicalJsonSha256(base) });
}

/** Fixed software-H.264 streaming command; no generic SDR tail or preset helper participates. */
export function linearSrgbSdrFinalEncodeCommand(timeline: LinearSrgbSdrFinalTimeline, outputPath: string): FfmpegCommand {
  assertTimeline(timeline);
  assertPrivatePath(outputPath, "output");
  if (extname(outputPath).toLowerCase() !== ".mp4") throw new Error("Strict SDR FFmpeg output path must use the .mp4 extension.");
  return {
    executable: resolveFfmpegExecutable(),
    shell: false,
    args: [
      "-hide_banner", "-v", "error", "-nostdin", "-n",
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${timeline.width}x${timeline.height}`,
      "-framerate", String(timeline.fps), "-i", "pipe:0",
      "-map", "0:v:0", "-an", "-frames:v", String(timeline.frameCount),
      "-vf", LINEAR_SRGB_SDR_FINAL_FORWARD_FILTER,
      ...encodeArgs(), "-movflags", "+faststart", "-fs", String(LINEAR_SRGB_SDR_FINAL_MAX_OUTPUT_BYTES), outputPath,
    ],
  };
}

/** Fixed inverse into one exclusive private raw-RGBA file; binary stdout is deliberately forbidden. */
export function linearSrgbSdrFinalInverseDecodeCommand(encodedPath: string, decodedPath: string): FfmpegCommand {
  assertPrivatePath(encodedPath, "encoded input");
  assertPrivatePath(decodedPath, "decoded output");
  if (extname(encodedPath).toLowerCase() !== ".mp4") throw new Error("Strict SDR FFmpeg encoded input path must use the .mp4 extension.");
  if (encodedPath === decodedPath) throw new Error("Strict SDR inverse decode requires distinct input and output paths.");
  return {
    executable: resolveFfmpegExecutable(),
    shell: false,
    args: [
      "-hide_banner", "-v", "error", "-nostdin", "-n", "-i", encodedPath,
      "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER,
      "-fps_mode", "passthrough", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", decodedPath,
    ],
  };
}

function encodeArgs(): string[] {
  return [
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
  ];
}

function assertTimeline(value: LinearSrgbSdrFinalTimeline): void {
  if (!Number.isSafeInteger(value.width) || value.width < 1 || value.width > LINEAR_SRGB_SDR_FINAL_MAX_WIDTH
    || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > LINEAR_SRGB_SDR_FINAL_MAX_HEIGHT
    || !Number.isFinite(value.fps) || value.fps <= 0
    || !Number.isSafeInteger(value.frameCount) || value.frameCount < 1) {
    throw new Error("Strict SDR FFmpeg requires bounded positive dimensions, cadence, and frame count.");
  }
}

function assertPrivatePath(value: string, label: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 32_768 || /[\u0000\r\n]/u.test(value) || value === "-" || value.toLowerCase().startsWith("pipe:")) {
    throw new Error(`Strict SDR FFmpeg ${label} path is invalid.`);
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
