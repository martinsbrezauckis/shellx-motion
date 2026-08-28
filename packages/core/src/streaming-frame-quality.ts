/**
 * Bounded quality and identity evidence for frames that are consumed immediately by an encoder.
 *
 * The accumulator deliberately keeps no frame paths, frame payloads, or one-result-per-frame
 * array. It holds only the current decoded frame while inspecting it, the motion accumulator's
 * two plane sets, and the small number of hashes needed to prove the configured unique-frame gate.
 */
import { createHash } from "node:crypto";
import {
  motionDensityAdvisoryIsResolvable,
  type FrameSequenceQualityPolicy,
  type PngQualityResult
} from "./quality";
import { createMotionDensityAccumulator, type MotionDensityReport } from "./motion-density";
import { motionDensityWarnings } from "./motion-density-warnings";
import {
  decodePngRgba,
  MAX_MOTION_PNG_FRAME_DIMENSION,
  MAX_MOTION_PNG_FRAME_PIXELS
} from "./png-rgba-decode";
import { inspectRgba } from "./png-quality-stats";
import { hashBuffer } from "./receipts";

/** A fixed ceiling prevents a caller-controlled unique-frame policy from becoming retained state. */
export const MAX_STREAMING_UNIQUE_FRAME_HASHES = 64;

/** The fixed hash evidence window used even when a caller supplied a refused larger threshold. */
export function streamingFrameQualityHashRetentionCapacity(policy: FrameSequenceQualityPolicy | undefined): number {
  const requested = policy?.minUniqueFrameHashes;
  const boundedRequested = typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0 ? requested : 0;
  return Math.max(2, Math.min(MAX_STREAMING_UNIQUE_FRAME_HASHES, boundedRequested));
}

/** Refuse a stream identity that the shared decoder could never inspect safely. */
export function streamingFrameDimensionsRefusal(width: number, height: number): string | undefined {
  if (
    !Number.isSafeInteger(width)
    || width <= 0
    || !Number.isSafeInteger(height)
    || height <= 0
    || width > MAX_MOTION_PNG_FRAME_DIMENSION
    || height > MAX_MOTION_PNG_FRAME_DIMENSION
    || width * height > MAX_MOTION_PNG_FRAME_PIXELS
  ) {
    return `Streaming dimensions must fit the ${MAX_MOTION_PNG_FRAME_PIXELS}-pixel PNG inspection budget.`;
  }
  return undefined;
}

export type StreamingFrameQualityResult =
  | {
      ok: true;
      warnings: string[];
      identity: { schema: "shellx-motion/streamed-frame-sequence@1"; sha256: string };
      summary: {
        frameCount: number;
        blankFrames: number;
        /** Exact below the cap; otherwise this is a verified lower bound. */
        uniqueFrameHashes: number;
        uniqueFrameHashesExact: boolean;
        durationMs: number;
        motion: MotionDensityReport;
      };
    }
  | {
      ok: false;
      code: "blank_frames" | "frame_count_mismatch" | "invalid_frame" | "no_frames" | "static_frames" | "streaming_quality_policy_unsupported";
      message: string;
      warnings: string[];
    };

export interface StreamingFrameQualityAccumulator {
  /** Inspect and hash one frame payload. Calls must be in exact frame-index order. */
  observe(input: StreamingFrameQualityInput): PngQualityResult | { ok: false; code: "invalid_frame"; message: string };
  /** Produce the final quality decision after the encoder input has been fully produced. */
  finish(): StreamingFrameQualityResult;
}

export type StreamingFrameQualityInput =
  | { index: number; atMs: number; png: Buffer; format?: "png" }
  | {
      index: number;
      atMs: number;
      format: "rgba";
      rgba: Buffer;
      width: number;
      height: number;
      strideBytes: number;
      colorSpace: "srgb";
      alphaMode: "straight";
    };

/** Pure preflight so a final-render caller can refuse an unstreamable policy before it starts FFmpeg. */
export function streamingFrameQualityPolicyRefusal(policy: FrameSequenceQualityPolicy | undefined): {
  code: "streaming_quality_policy_unsupported";
  message: string;
} | undefined {
  const minUniqueFrameHashes = policy?.minUniqueFrameHashes ?? 0;
  if (Number.isSafeInteger(minUniqueFrameHashes) && minUniqueFrameHashes >= 0 && minUniqueFrameHashes <= MAX_STREAMING_UNIQUE_FRAME_HASHES) {
    return undefined;
  }
  return {
    code: "streaming_quality_policy_unsupported",
    message: `Streaming final delivery supports minUniqueFrameHashes through ${MAX_STREAMING_UNIQUE_FRAME_HASHES}; requested ${minUniqueFrameHashes}.`
  };
}

/**
 * Incremental equivalent of the existing full frame-sequence gate for streamable delivery.
 *
 * This intentionally refuses a unique-frame threshold above the small fixed evidence window.
 * A caller must not turn a quality knob into unbounded retained state, and silently dropping that
 * gate would be worse than an explicit capability refusal.
 */
export function createStreamingFrameQualityAccumulator(input: {
  frameCount: number;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  quality?: FrameSequenceQualityPolicy;
}): StreamingFrameQualityAccumulator {
  const warnings: string[] = [];
  const minDurationMs = input.quality?.minDurationMs ?? 1500;
  const minUniqueFrameHashes = input.quality?.minUniqueFrameHashes ?? 0;
  const policyRefusal = streamingFrameQualityPolicyRefusal(input.quality);
  const requiredHashCount = streamingFrameQualityHashRetentionCapacity(input.quality);
  const uniqueFrameHashes = new Set<string>();
  const motion = createMotionDensityAccumulator(input.quality?.motion);
  const identity = createHash("sha256");
  identity.update(JSON.stringify({
    schema: "shellx-motion/streamed-frame-sequence@1",
    frameCount: input.frameCount,
    durationMs: input.durationMs,
    fps: input.fps,
    width: input.width,
    height: input.height
  }));
  identity.update("\n");
  let nextIndex = 0;
  let blankFrames = 0;
  let invalid: string | undefined;
  let uniqueHashOverflow = false;

  if (input.durationMs < minDurationMs) {
    warnings.push(`Rendered video is ${input.durationMs}ms; product review clips should be at least ${minDurationMs}ms.`);
  }

  return {
    observe(frame) {
      if (frame.index !== nextIndex) {
        const message = `Streamed frame index ${frame.index} arrived out of order; expected ${nextIndex}.`;
        invalid ??= message;
        motion.fail(message);
        return { ok: false, code: "invalid_frame", message };
      }
      nextIndex += 1;
      const expectedAtMs = streamingFrameTimestampMs(frame.index, input.fps, input.durationMs);
      if (!Number.isFinite(frame.atMs) || frame.atMs !== expectedAtMs) {
        const message = `Streamed frame ${frame.index} has timestamp ${frame.atMs}; expected canonical ${expectedAtMs}ms.`;
        invalid ??= message;
        motion.fail(message);
        return { ok: false, code: "invalid_frame", message };
      }
      try {
        const decoded = "png" in frame ? decodePngRgba(frame.png) : admittedRgbaFrame(frame);
        if (decoded.width !== input.width || decoded.height !== input.height) {
          const message = `Streamed frame ${frame.index} is ${decoded.width}x${decoded.height}; expected ${input.width}x${input.height}.`;
          invalid ??= message;
          motion.fail(message);
          return { ok: false, code: "invalid_frame", message };
        }
        const sha256 = hashBuffer("png" in frame ? frame.png : frame.rgba);
        const quality = inspectRgba(decoded, sha256);
        if (quality.blank) blankFrames += 1;
        if (!uniqueFrameHashes.has(sha256)) {
          if (uniqueFrameHashes.size < requiredHashCount) uniqueFrameHashes.add(sha256);
          else uniqueHashOverflow = true;
        }
        identity.update(`${frame.index}:${frame.atMs}:${sha256}\n`);
        motion.observe(decoded, frame.atMs);
        return quality;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        invalid ??= message;
        motion.fail(message);
        return { ok: false, code: "png" in frame ? "invalid_png" : "invalid_frame", message };
      }
    },
    finish() {
      if (policyRefusal) {
        return {
          ok: false,
          code: policyRefusal.code,
          message: policyRefusal.message,
          warnings
        };
      }
      if (invalid) return { ok: false, code: "invalid_frame", message: invalid, warnings };
      if (nextIndex === 0) {
        return { ok: false, code: "no_frames", message: "Rendered frame sequence has no sampled frames.", warnings };
      }
      if (nextIndex !== input.frameCount) {
        return {
          ok: false,
          code: "frame_count_mismatch",
          message: `Streamed frame sequence produced ${nextIndex} frames; expected ${input.frameCount}.`,
          warnings
        };
      }
      if (blankFrames === nextIndex) {
        return { ok: false, code: "blank_frames", message: "Rendered frame sequence is blank or visually empty.", warnings };
      }
      const report = motion.finish({ durationMs: input.durationMs, coverage: "complete" });
      if (uniqueFrameHashes.size === 1 && nextIndex > 1) {
        warnings.push("Rendered frame sequence is static; verify this is intentional before using it as product output.");
      }
      if (motionDensityAdvisoryIsResolvable(report)) warnings.push(...motionDensityWarnings(report));
      if (minUniqueFrameHashes > 0 && uniqueFrameHashes.size < minUniqueFrameHashes) {
        return {
          ok: false,
          code: "static_frames",
          message: `Rendered frame sequence has ${uniqueFrameHashes.size} unique frame${uniqueFrameHashes.size === 1 ? "" : "s"}; expected at least ${minUniqueFrameHashes}.`,
          warnings
        };
      }
      return {
        ok: true,
        warnings,
        identity: { schema: "shellx-motion/streamed-frame-sequence@1", sha256: identity.digest("hex") },
        summary: {
          frameCount: nextIndex,
          blankFrames,
          uniqueFrameHashes: uniqueFrameHashes.size,
          uniqueFrameHashesExact: !uniqueHashOverflow,
          durationMs: input.durationMs,
          motion: report
        }
      };
    }
  };
}

function admittedRgbaFrame(frame: Extract<StreamingFrameQualityInput, { format: "rgba" }>): { width: number; height: number; rgba: Buffer } {
  if (
    !Buffer.isBuffer(frame.rgba)
    || !Number.isSafeInteger(frame.width)
    || !Number.isSafeInteger(frame.height)
    || frame.width <= 0
    || frame.height <= 0
    || frame.strideBytes !== frame.width * 4
    || frame.rgba.byteLength !== frame.strideBytes * frame.height
    || frame.colorSpace !== "srgb"
    || frame.alphaMode !== "straight"
  ) {
    throw new Error("Raw streamed RGBA must be tightly packed straight-alpha sRGB matching its declared dimensions.");
  }
  return { width: frame.width, height: frame.height, rgba: frame.rgba };
}

/** The final-render timeline authority: round frame clock positions and clamp to the last millisecond. */
export function streamingFrameTimestampMs(frameIndex: number, fps: number, durationMs: number): number {
  const atMs = Math.round((frameIndex * 1000) / fps);
  return Math.max(0, Math.min(atMs, Math.max(0, durationMs - 1)));
}
