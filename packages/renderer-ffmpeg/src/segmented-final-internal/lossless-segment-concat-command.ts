/**
 * Internal command authority for resumable FFmpeg segments.
 *
 * One PNG image2pipe stdin becomes a deterministic FFV1 Matroska segment. Final concat replaces
 * only the verified canonical frame input, preserving its delivery policy byte-for-byte.
 * This module is intentionally not exported by renderer-ffmpeg's package entry.
 */
import { assertLocalMotionFrameCountBudget } from "@shellx-motion/core";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ffmpegPresetOutputPathError, resolveFfmpegExecutable, resolveExportPreset, type FfmpegCommand, type FfmpegExportPreset } from "../index.js";
import { selfContainedFfmpegMediaInputArgs } from "../ffmpeg-media-input-fence.js";
import { isCanonicalRawVideoFrameInput, losslessSegmentFrameInput } from "./lossless-segment-raw-input.js";

const SEGMENT_FILENAME_PREFIX = "segment-";
const SEGMENT_FILENAME_WIDTH = 6;
const SEGMENT_LIST_FILENAME = "segments.ffconcat";
const LOSSLESS_SEGMENT_PIXEL_FORMAT = "bgra";

export interface LosslessSegmentIntermediateCommandInput {
  /** Trusted, owned absolute directory for this render's FFV1 intermediates. */
  segmentDirectory: string;
  /** Zero-based deterministic segment position. */
  segmentIndex: number;
  /** Exact number of source PNG frames sent to this one image2pipe input. */
  frameCount: number;
  /** Exact source cadence, carried into the Matroska timestamps. */
  fps: number;
  /** GPU segments use the same lossless FFV1 checkpoint format, fed by raw RGBA instead of PNG. */
  frameFormat?: "png" | "rgba";
  /** Required only for the tightly packed raw RGBA input. */
  width?: number;
  /** Required only for the tightly packed raw RGBA input. */
  height?: number;
  /**
   * Optional exact store-owned partial target. The checkpoint store alone promotes this to the
   * canonical final segment name after readback verification.
   */
  temporaryOutputPath?: string;
}

export interface LosslessSegmentIntermediateCommandPlan {
  command: FfmpegCommand;
  /** Path-free facts suitable for later receipt evidence. */
  segment: {
    filename: string;
    frameCount: number;
    fps: number;
    codec: "ffv1";
    container: "matroska";
    pixelFormat: "bgra";
    colorRange: "pc";
    alpha: "preserved";
    intraOnly: true;
  };
}

export interface SegmentConcatFinalCommandInput {
  /** A command made by the existing canonical final image-sequence or image2pipe policy. */
  canonicalCommand: FfmpegCommand;
  preset: FfmpegExportPreset;
  /** Trusted, owned absolute directory which contains both segments and its concat list. */
  segmentDirectory: string;
  /** Must be the owned `segments.ffconcat` file directly inside segmentDirectory. */
  concatListPath: string;
  /** Verified segment artifacts, in deterministic render order. */
  segmentFilenames: readonly string[];
  /** Exact total delivered video frame count, which must equal the canonical command's cap. */
  frameCount: number;
}

export interface SegmentConcatFinalCommandPlan {
  command: FfmpegCommand;
  /** Path-free owned-list facts; command execution writes this exact content at concatListPath. */
  concatList: {
    filename: "segments.ffconcat";
    contents: string;
    segmentFilenames: string[];
  };
}

/** Deterministic relative filename for a zero-based segment index. */
export function losslessSegmentFilename(segmentIndex: number): string {
  assertSegmentIndex(segmentIndex);
  return `${SEGMENT_FILENAME_PREFIX}${String(segmentIndex + 1).padStart(SEGMENT_FILENAME_WIDTH, "0")}.mkv`;
}

/** Build the one permitted full-range, alpha-capable FFV1 range-to-intermediate command. */
export function buildLosslessSegmentIntermediateCommand(
  input: LosslessSegmentIntermediateCommandInput
): LosslessSegmentIntermediateCommandPlan {
  assertOwnedAbsoluteDirectory(input.segmentDirectory);
  assertFrameCount(input.frameCount);
  assertFps(input.fps);
  const frameInput = losslessSegmentFrameInput(input);
  const filename = losslessSegmentFilename(input.segmentIndex);
  const outputPath = input.temporaryOutputPath ?? join(input.segmentDirectory, filename);
  assertSafeFileOperand(outputPath, "segment output");
  assertOwnedSegmentOutputPath(outputPath, input.segmentDirectory, input.segmentIndex, Boolean(input.temporaryOutputPath));
  return {
    command: {
      executable: resolveFfmpegExecutable(),
      args: [
        "-y",
        ...frameInput,
        "-frames:v", String(input.frameCount),
        "-c:v", "ffv1",
        // FFV1 is intra-only by design; this one-frame GOP keeps the recovery contract explicit.
        // Do not force an FFV1 level here: the measured FFmpeg 6.1.1 build accepted level 3 but
        // decoded its otherwise-successful RGBA ranges as zero pixels.
        "-g", "1",
        // BGRA preserves renderer RGB; a YUV checkpoint adds a round trip and breaks image2pipe parity.
        "-pix_fmt", LOSSLESS_SEGMENT_PIXEL_FORMAT,
        "-color_range", "pc",
        "-an",
        // A store-owned partial ends in `.mkv.partial`, so FFmpeg cannot infer the container
        // from its extension. Pin the muxer for both names to make the command unambiguous.
        "-f", "matroska",
        outputPath
      ],
      shell: false
    },
    segment: {
      filename,
      frameCount: input.frameCount,
      fps: input.fps,
      codec: "ffv1",
      container: "matroska",
      pixelFormat: LOSSLESS_SEGMENT_PIXEL_FORMAT,
      colorRange: "pc",
      alpha: "preserved",
      intraOnly: true
    }
  };
}

/** Replace only a canonical command's frame input with a safe concat demuxer input. */
export function buildSegmentConcatFinalCommand(input: SegmentConcatFinalCommandInput): SegmentConcatFinalCommandPlan {
  if (input.preset === "gif") {
    throw new Error("GIF final delivery is not supported for exact segment concat because palette generation is not segment-exact.");
  }
  assertOwnedAbsoluteDirectory(input.segmentDirectory);
  assertOwnedConcatListPath(input.concatListPath, input.segmentDirectory);
  assertFrameCount(input.frameCount);
  const segmentFilenames = assertDeterministicSegmentFilenames(input.segmentFilenames);
  const frameInput = assertCanonicalFinalCommand(input.canonicalCommand, input.preset, input.frameCount);
  const args = input.canonicalCommand.args;
  const replacement = [
    "-safe", "1",
    "-f", "concat",
    "-protocol_whitelist", "file",
    "-i", input.concatListPath
  ];
  return {
    command: {
      executable: input.canonicalCommand.executable,
      args: [...args.slice(0, frameInput.start), ...replacement, ...args.slice(frameInput.endExclusive)],
      shell: false
    },
    concatList: {
      filename: SEGMENT_LIST_FILENAME,
      contents: segmentFilenames.map((filename) => `file ${filename}`).join("\n") + "\n",
      segmentFilenames
    }
  };
}

interface CanonicalFrameInput {
  start: number;
  endExclusive: number;
  source: "image-sequence" | "image2pipe" | "rawvideo";
}

/** Reject anything outside the exact command shapes our own builders create. */
function assertCanonicalFinalCommand(command: FfmpegCommand, preset: FfmpegExportPreset, frameCount: number): CanonicalFrameInput {
  if (command.shell !== false || typeof command.executable !== "string" || command.executable.trim().length === 0) {
    throw new Error("Segment concat requires a shell-free canonical FFmpeg command.");
  }
  const args = command.args;
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string") || args[0] !== "-y") {
    throw new Error("Segment concat requires the canonical final FFmpeg argv shape.");
  }
  const frameInput = canonicalFrameInput(args);
  const frameLimitIndexes = args.flatMap((value, index) => value === "-frames:v" ? [index] : []);
  if (frameLimitIndexes.length !== 1 || args[frameLimitIndexes[0] + 1] !== String(frameCount)) {
    throw new Error("Segment concat requires exactly one canonical -frames:v cap matching the requested frame count.");
  }
  const frameLimit = frameLimitIndexes[0];
  if (frameLimit < frameInput.endExclusive || frameLimit + 2 >= args.length) {
    throw new Error("Segment concat requires canonical inputs followed by final output arguments.");
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-protocol_whitelist" && args[index + 1] !== "file") {
      throw new Error("Segment concat permits only the local file protocol whitelist.");
    }
    if (args[index] === "-filter_script" || args[index] === "-filter_complex_script") {
      throw new Error("Segment concat refuses file-backed FFmpeg filter scripts.");
    }
    if (args[index] !== "-i") continue;
    if (index === frameInput.endExclusive - 2) continue;
    if (args[index - 4] !== "-protocol_whitelist" || args[index - 3] !== "file" || args[index - 2] !== "-format_whitelist") {
      throw new Error("Segment concat requires canonical local-file audio inputs before the final frame cap.");
    }
    const expected = selfContainedFfmpegMediaInputArgs(args[index + 1] ?? "");
    const start = index - expected.length + 2;
    if (index >= frameLimit || start < frameInput.endExclusive || !expected.every((value, offset) => args[start + offset] === value)) {
      throw new Error("Segment concat requires canonical local-file audio inputs before the final frame cap.");
    }
    assertSafeFileOperand(args[index + 1], "canonical audio input");
  }
  const stdinIndexes = args.flatMap((value, index) => isStdinToken(value) ? [index] : []);
  const canonicalPipeIndex = frameInput.endExclusive - 1;
  if (frameInput.source === "image-sequence") {
    if (stdinIndexes.length !== 0) {
      throw new Error("Segment concat refuses stdin in an image-sequence canonical command.");
    }
  } else if (stdinIndexes.length !== 1 || stdinIndexes[0] !== canonicalPipeIndex) {
    throw new Error("Segment concat requires at most the one canonical streamed-frame stdin input.");
  }
  const outputPath = args.at(-1);
  assertSafeFileOperand(outputPath, "final output");
  const outputPathError = ffmpegPresetOutputPathError(preset, outputPath);
  if (outputPathError) throw new Error(outputPathError);
  // Resolving the preset is intentional: it rejects a cast/unknown value before a command reaches
  // FFmpeg, even though the extension check above is all the transformation itself needs.
  resolveExportPreset(preset);
  return frameInput;
}

function canonicalFrameInput(args: readonly string[]): CanonicalFrameInput {
  const imageSequence = args[1] === "-framerate"
    && validFpsOperand(args[2])
    && args[3] === "-start_number"
    && args[4] === "1"
    && args[5] === "-protocol_whitelist"
    && args[6] === "file"
    && args[7] === "-i"
    && isCanonicalFramePattern(args[8]);
  if (imageSequence) return { start: 1, endExclusive: 9, source: "image-sequence" };

  // Existing image2pipe conversion keeps -framerate; concat replaces it with segment timestamps.
  const image2PipeOffset = args[1] === "-framerate" && validFpsOperand(args[2]) ? 3 : 1;
  const image2Pipe = args[image2PipeOffset] === "-f"
    && args[image2PipeOffset + 1] === "image2pipe"
    && args[image2PipeOffset + 2] === "-vcodec"
    && args[image2PipeOffset + 3] === "png"
    && args[image2PipeOffset + 4] === "-i"
    && args[image2PipeOffset + 5] === "pipe:0";
  if (image2Pipe) return { start: 1, endExclusive: image2PipeOffset + 6, source: "image2pipe" };
  if (isCanonicalRawVideoFrameInput(args)) return { start: 1, endExclusive: 13, source: "rawvideo" };
  throw new Error("Segment concat requires the canonical image-sequence or image2pipe frame input.");
}

function assertDeterministicSegmentFilenames(filenames: readonly string[]): string[] {
  if (!Array.isArray(filenames) || filenames.length === 0) {
    throw new Error("Segment concat requires one or more deterministic segment filenames.");
  }
  const copied = [...filenames];
  for (const [index, filename] of copied.entries()) {
    if (filename !== losslessSegmentFilename(index)) {
      throw new Error("Segment filenames must be deterministic segment filenames: simple relative segment-000001.mkv names without traversal or aliases.");
    }
  }
  return copied;
}

function assertOwnedConcatListPath(concatListPath: string, segmentDirectory: string): void {
  assertSafeFileOperand(concatListPath, "concat list");
  if (!isAbsolute(concatListPath) || relative(resolve(segmentDirectory), resolve(concatListPath)) !== SEGMENT_LIST_FILENAME) {
    throw new Error("Segment concat requires its owned segments.ffconcat list directly inside the segment directory.");
  }
  if (dirname(resolve(concatListPath)) !== resolve(segmentDirectory)) {
    throw new Error("Segment concat requires an owned same-directory concat list.");
  }
}

function assertOwnedSegmentOutputPath(outputPath: string, segmentDirectory: string, segmentIndex: number, partial: boolean): void {
  if (!isAbsolute(outputPath) || dirname(resolve(outputPath)) !== resolve(segmentDirectory)) {
    throw new Error("Lossless segment output must be an owned same-directory path.");
  }
  const expected = partial
    ? `.${losslessSegmentFilename(segmentIndex)}.partial`
    : losslessSegmentFilename(segmentIndex);
  if (basename(outputPath) !== expected) {
    throw new Error("Lossless segment output must use the deterministic canonical or temporary segment filename.");
  }
}

function assertOwnedAbsoluteDirectory(path: string): void {
  assertSafeFileOperand(path, "segment directory");
  if (!isAbsolute(path)) {
    throw new Error("Lossless segment commands require an owned absolute segment directory.");
  }
}

function assertSegmentIndex(segmentIndex: number): void {
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= (10 ** SEGMENT_FILENAME_WIDTH) - 1) {
    throw new Error("Segment index must be a non-negative safe integer representable by the deterministic segment filename.");
  }
}

function assertFrameCount(frameCount: number): void {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new Error("Segment frame count must be a positive safe integer.");
  }
  assertLocalMotionFrameCountBudget(frameCount);
}

function assertFps(fps: number): void {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error("Segment FPS must be finite and positive.");
  }
}

function validFpsOperand(value: string | undefined): boolean {
  return value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}

function isCanonicalFramePattern(value: string | undefined): boolean {
  if (!value || !value.endsWith("%06d.png")) return false;
  try {
    assertSafeFileOperand(value, "canonical frame input");
    return true;
  } catch {
    return false;
  }
}

function assertSafeFileOperand(value: string | undefined, role: string): asserts value is string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed.startsWith("-") || hasProtocolScheme(trimmed)) {
    throw new Error(`Segment concat refuses an unsafe ${role} path.`);
  }
}

function hasProtocolScheme(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(path)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path);
}

function isStdinToken(value: string): boolean {
  const normalized = value.toLowerCase();
  return value === "-"
    || normalized === "pipe:"
    || normalized.includes("pipe:0")
    || normalized.includes("fd:0")
    || normalized === "/dev/stdin"
    || /^\/dev\/fd\/0+$/.test(normalized)
    || /^\/proc\/(?:self|thread-self)\/fd\/0+$/.test(normalized);
}
