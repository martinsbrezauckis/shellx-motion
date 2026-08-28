import type { LosslessSegmentIntermediateCommandInput } from "./lossless-segment-concat-command.js";

/** The only raw input admitted for GPU-owned FFV1 checkpoints. */
export function losslessSegmentFrameInput(input: LosslessSegmentIntermediateCommandInput): string[] {
  if ((input.frameFormat ?? "png") === "png") {
    return ["-f", "image2pipe", "-vcodec", "png", "-framerate", String(input.fps), "-i", "pipe:0"];
  }
  const { width, height } = input;
  if (typeof width !== "number" || !Number.isSafeInteger(width) || width <= 0
    || typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error("Raw GPU segment input requires positive integer dimensions.");
  }
  return [
    "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`,
    "-framerate", String(input.fps), "-i", "pipe:0"
  ];
}

/** Exact rawvideo argv shape emitted by the final command planner. */
export function isCanonicalRawVideoFrameInput(args: readonly string[]): boolean {
  return args[1] === "-framerate" && validFps(args[2])
    && args[3] === "-f" && args[4] === "rawvideo"
    && args[5] === "-pixel_format" && args[6] === "rgba"
    && args[7] === "-video_size" && validVideoSize(args[8])
    && args[9] === "-framerate" && validFps(args[10])
    && args[11] === "-i" && args[12] === "pipe:0";
}

function validFps(value: string | undefined): boolean {
  return value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}

function validVideoSize(value: string | undefined): boolean {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  return match !== null && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0
    && Number.isSafeInteger(Number(match[2])) && Number(match[2]) > 0;
}
