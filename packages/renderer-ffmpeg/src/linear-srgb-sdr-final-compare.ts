import { createHash } from "node:crypto";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import {
  LINEAR_SRGB_SDR_FINAL_MAX_HEIGHT,
  LINEAR_SRGB_SDR_FINAL_MAX_WIDTH,
} from "@shellx-motion/core/internal/linear-srgb-sdr-final";

export const LINEAR_SRGB_SDR_FINAL_COMPARISON_SCHEMA = "shellx-motion/linear-srgb-sdr-final-comparison@1" as const;
export const LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY_SCHEMA = "shellx-motion/linear-srgb-sdr-final-comparison-policy@1" as const;

/**
 * Initial fixed acceptance envelope for the lossy yuv420p boundary. The public
 * route binds this policy identity and refuses delivery outside it; native-host
 * qualification remains a separate proof of the exact candidate and host.
 */
export const LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY = freeze({
  schema: LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY_SCHEMA,
  source: "retained-straight-srgb-rgba8",
  decoded: "bt709-limited-yuv420p-inverse-to-straight-srgb-rgba8",
  alpha: { expected: 255, maximumMismatchedPixels: 0 },
  rgb: { maximumChannelDelta: 160, maximumMeanAbsoluteChannelDelta: 8, materialDelta: 32, maximumMaterialDeltaSampleRatio: 0.05 },
});
export const LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY_SHA256 = canonicalJsonSha256(LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY);

export interface LinearSrgbSdrFinalComparison {
  readonly schema: typeof LINEAR_SRGB_SDR_FINAL_COMPARISON_SCHEMA;
  readonly width: number;
  readonly height: number;
  readonly sourceSha256: string;
  readonly decodedSha256: string;
  readonly policySha256: string;
  readonly rgb: {
    readonly sampleCount: number;
    readonly maximumChannelDelta: number;
    readonly meanAbsoluteChannelDelta: number;
    readonly materialDeltaSampleCount: number;
    readonly materialDeltaSampleRatio: number;
  };
  readonly alpha: { readonly mismatchedPixelCount: number };
  readonly accepted: boolean;
  readonly fingerprint: string;
}

/** Compare exactly one tightly packed opaque RGBA8 producer/decode pair. */
export function compareLinearSrgbSdrFinalFrames(input: {
  readonly width: number;
  readonly height: number;
  readonly source: Buffer;
  readonly decoded: Buffer;
}): LinearSrgbSdrFinalComparison {
  const bytes = assertFrames(input);
  let maximumChannelDelta = 0;
  let absoluteDeltaSum = 0;
  let materialDeltaSampleCount = 0;
  let mismatchedPixelCount = 0;
  for (let offset = 0; offset < bytes; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(input.source[offset + channel]! - input.decoded[offset + channel]!);
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      absoluteDeltaSum += delta;
      if (delta > LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY.rgb.materialDelta) materialDeltaSampleCount += 1;
    }
    if (input.source[offset + 3] !== 255 || input.decoded[offset + 3] !== 255) mismatchedPixelCount += 1;
  }
  const sampleCount = input.width * input.height * 3;
  const meanAbsoluteChannelDelta = absoluteDeltaSum / sampleCount;
  const materialDeltaSampleRatio = materialDeltaSampleCount / sampleCount;
  const accepted = mismatchedPixelCount <= LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY.alpha.maximumMismatchedPixels
    && maximumChannelDelta <= LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY.rgb.maximumChannelDelta
    && meanAbsoluteChannelDelta <= LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY.rgb.maximumMeanAbsoluteChannelDelta
    && materialDeltaSampleRatio <= LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY.rgb.maximumMaterialDeltaSampleRatio;
  const base = {
    schema: LINEAR_SRGB_SDR_FINAL_COMPARISON_SCHEMA,
    width: input.width,
    height: input.height,
    sourceSha256: sha256(input.source),
    decodedSha256: sha256(input.decoded),
    policySha256: LINEAR_SRGB_SDR_FINAL_COMPARISON_POLICY_SHA256,
    rgb: { sampleCount, maximumChannelDelta, meanAbsoluteChannelDelta, materialDeltaSampleCount, materialDeltaSampleRatio },
    alpha: { mismatchedPixelCount },
    accepted,
  };
  return freeze({ ...base, fingerprint: canonicalJsonSha256(base) });
}

function assertFrames(input: { width: number; height: number; source: Buffer; decoded: Buffer }): number {
  if (!Number.isSafeInteger(input.width) || input.width < 1 || input.width > LINEAR_SRGB_SDR_FINAL_MAX_WIDTH
    || !Number.isSafeInteger(input.height) || input.height < 1 || input.height > LINEAR_SRGB_SDR_FINAL_MAX_HEIGHT) {
    throw new Error("Strict SDR comparison requires bounded positive dimensions.");
  }
  const bytes = input.width * input.height * 4;
  if (input.source.byteLength !== bytes || input.decoded.byteLength !== bytes) {
    throw new Error("Strict SDR comparison requires exactly one tightly packed RGBA8 frame on both sides.");
  }
  return bytes;
}

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
