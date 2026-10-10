import { canonicalJsonSha256 } from "@shellx-motion/core";

/**
 * Route-private F2b blend contract. The submitted fragment remains premultiplied
 * linear RGB; WebGPU's component-wise `one-minus-src` destination factor yields
 * `Sp + Dp - Sp*Dp`, the premultiplied screen result.
 */
export const LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PIPELINE_SCHEMA = "shellx-motion/linear-srgb-sdr-final-f2b-screen-webgpu-pipeline@1" as const;

export const LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_LIMITS = Object.freeze({
  maxScreenRects: 64,
  workingTarget: "rgba16float",
});

const implementation = {
  schema: LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PIPELINE_SCHEMA,
  workingTarget: "rgba16float",
  flatBlend: {
    color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  },
  gradientBlend: {
    color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  },
  ditherCoverageBlend: {
    signal: { red: "normal-gradient-opacity-or-screen-gradient-maximum-premultiplied-linear-rgb", alpha: "screen-minimum-premultiplied-linear-rgb" },
    flat: {
      color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
    },
    gradient: {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    },
  },
} as const;

export const LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PIPELINE = Object.freeze({
  ...implementation,
  implementationSha256: canonicalJsonSha256(implementation),
});
