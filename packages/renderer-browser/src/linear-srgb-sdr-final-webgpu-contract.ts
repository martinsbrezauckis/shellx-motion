import { canonicalJsonSha256 } from "@shellx-motion/core";

/**
 * Fixed, route-private GPU contract for the static linear-sRGB SDR final
 * producer. It intentionally has no relationship to the generic GPU catalog.
 */
export const LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE_SCHEMA = "shellx-motion/linear-srgb-sdr-final-webgpu-pipeline@1" as const;
export const LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER_SCHEMA = "shellx-motion/linear-srgb-sdr-final-publication-dither@1" as const;

export const LINEAR_SRGB_SDR_FINAL_WEBGPU_LIMITS = Object.freeze({
  maxWidth: 1920,
  maxHeight: 1080,
  maxRects: 64,
  maxTightRgba8Bytes: 1920 * 1080 * 4,
  maxPaddedRgba8Bytes: 1920 * 1080 * 4,
  uniformBytes: 32,
  workingBytesPerPixel: 8,
  publicationBytesPerPixel: 4,
  referenceWorkingBytesPerPixel: 16,
  maxReferenceWorkingBytes: 1920 * 1080 * 16,
  readbackAlignment: 256,
});

/**
 * The final publication step is the only quantization boundary in this route.
 * A static coordinate hash decorrelates the 8-bit rounding error, but only
 * where a smooth gradient still makes a visible normal-or-screen compositing
 * contribution.
 * Flat source/background pixels, zero alpha, and exact black/white endpoints
 * remain byte-exact.
 */
export const LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER = Object.freeze({
  schema: LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER_SCHEMA,
  domain: "straight-srgb-before-rgba8unorm-quantization",
  distribution: "deterministic-static-spatial-u32-hash-16bit",
  coverage: "visible-gradient-normal-screen-compositing",
  coverageThreshold: "strict-positive",
  smoothness: {
    domain: "local-straight-srgb-working-texture-delta",
    minimum: 1 / 65_535,
    maximum: 1 / 16,
  },
  application: "one-shared-rgb-scalar",
  maxRgbOffsetLsb: 0.5,
  endpointMarginLsb: 0.5,
  clamping: "excluded-by-safe-interior-gate",
  alpha: "exact-unmodified",
  endpoints: "exact-black-and-white-unmodified",
  zeroAlpha: "exact-transparent-black-unmodified",
});

export interface LinearSrgbSdrPublicationDitherEligibility {
  /** Premultiplied visible contribution from admitted gradient source-over draws. */
  readonly gradientCoverage: number;
  readonly encodedRgb: readonly [number, number, number];
  readonly alpha: number;
  readonly neighbouringEncodedRgb: readonly (readonly [number, number, number])[];
}

/** CPU/reference seam for the exact bounded static spatial publication policy. */
export function linearSrgbSdrPublicationDitherOffset(x: number, y: number): number {
  if (!Number.isSafeInteger(x) || x < 0 || !Number.isSafeInteger(y) || y < 0) throw new Error("Publication dither requires non-negative integer pixel coordinates.");
  let value = (Math.imul(x >>> 0, 0x9e3779b9) ^ Math.imul(y >>> 0, 0x85ebca6b)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  return ((((value & 0xffff) + 0.5) / 65_536) - 0.5) / 255;
}

/** Flat, endpoint, transparent, and sharp-transition samples deliberately opt out. */
export function linearSrgbSdrPublicationDitherEligible(value: LinearSrgbSdrPublicationDitherEligibility): boolean {
  if (!finite(value.gradientCoverage) || value.gradientCoverage <= 0 || value.gradientCoverage > 1 || !finite(value.alpha) || value.alpha <= 0 || value.alpha > 1 || !rgb(value.encodedRgb)) return false;
  const endpointMargin = LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER.endpointMarginLsb / 255;
  if (value.encodedRgb.some((channel) => channel <= endpointMargin || channel >= 1 - endpointMargin)) return false;
  let maximumDelta = 0;
  for (const neighbour of value.neighbouringEncodedRgb) {
    if (!rgb(neighbour)) return false;
    const delta = Math.max(
      Math.abs(value.encodedRgb[0] - neighbour[0]),
      Math.abs(value.encodedRgb[1] - neighbour[1]),
      Math.abs(value.encodedRgb[2] - neighbour[2]),
    );
    maximumDelta = Math.max(maximumDelta, delta);
  }
  return maximumDelta >= LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER.smoothness.minimum
    && maximumDelta <= LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER.smoothness.maximum;
}

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function rgb(value: readonly number[]): value is readonly [number, number, number] {
  return value.length === 3 && value.every((channel) => finite(channel) && channel >= 0 && channel <= 1);
}

/** Authored straight sRGB is decoded and premultiplied before float blending. */
export const LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL = /* wgsl */ `
struct Layer {
  encodedRgb: vec4<f32>,
  rect: vec4<f32>,
};

@group(0) @binding(0) var<uniform> layer: Layer;

fn srgbDecode(encoded: f32) -> f32 {
  if (encoded <= 0.04045) {
    return encoded / 12.92;
  }
  return pow((encoded + 0.055) / 1.055, 2.4);
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(positions[index], 0.0, 1.0);
}

struct CompositeOutput {
  @location(0) working: vec4<f32>,
  @location(1) ditherMask: vec4<f32>,
};

@fragment
fn compositeMain(@builtin(position) position: vec4<f32>) -> CompositeOutput {
  if (position.x < layer.rect.x || position.y < layer.rect.y
      || position.x >= layer.rect.x + layer.rect.z || position.y >= layer.rect.y + layer.rect.w) {
    discard;
  }
  let alpha = layer.encodedRgb.a;
  let linear = vec3<f32>(
    srgbDecode(layer.encodedRgb.r),
    srgbDecode(layer.encodedRgb.g),
    srgbDecode(layer.encodedRgb.b)
  );
  // R carries gradient/normal coverage. A carries the minimum per-channel
  // screen occlusion, so black and non-white screen flats retain a visible
  // underlying gradient while white screen can fully hide it.
  let screenOcclusion = min(min(linear.r, linear.g), linear.b) * alpha;
  return CompositeOutput(vec4<f32>(linear * alpha, alpha), vec4<f32>(alpha, 0.0, 0.0, screenOcclusion));
}`;

/** Float working pixels are unpremultiplied and explicitly encoded at publication. */
export const LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL = /* wgsl */ `
@group(0) @binding(0) var working: texture_2d<f32>;
@group(0) @binding(1) var ditherMask: texture_2d<f32>;

const DITHER_MIN_SMOOTH_DELTA: f32 = 0.0000152590218967;
const DITHER_MAX_SMOOTH_DELTA: f32 = 0.0625;
const DITHER_SAFE_ENDPOINT_MARGIN: f32 = 0.00196078431372549;

fn srgbEncode(linear: f32) -> f32 {
  if (linear <= 0.0031308) {
    return linear * 12.92;
  }
  return 1.055 * pow(linear, 1.0 / 2.4) - 0.055;
}

fn straightEncoded(premultiplied: vec4<f32>) -> vec4<f32> {
  if (premultiplied.a <= 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let straightLinear = premultiplied.rgb / premultiplied.a;
  return vec4<f32>(
    srgbEncode(straightLinear.r), srgbEncode(straightLinear.g), srgbEncode(straightLinear.b), premultiplied.a
  );
}

fn channelDelta(left: vec3<f32>, right: vec3<f32>) -> f32 {
  return max(max(abs(left.r - right.r), abs(left.g - right.g)), abs(left.b - right.b));
}

fn smoothTransition(position: vec2<i32>, encoded: vec3<f32>) -> bool {
  let dimensions = textureDimensions(working, 0);
  let maximum = vec2<i32>(i32(dimensions.x) - 1, i32(dimensions.y) - 1);
  let left = straightEncoded(textureLoad(working, vec2<i32>(max(position.x - 1, 0), position.y), 0));
  let right = straightEncoded(textureLoad(working, vec2<i32>(min(position.x + 1, maximum.x), position.y), 0));
  let up = straightEncoded(textureLoad(working, vec2<i32>(position.x, max(position.y - 1, 0)), 0));
  let down = straightEncoded(textureLoad(working, vec2<i32>(position.x, min(position.y + 1, maximum.y)), 0));
  let delta = max(max(channelDelta(encoded, left.rgb), channelDelta(encoded, right.rgb)), max(channelDelta(encoded, up.rgb), channelDelta(encoded, down.rgb)));
  return delta >= DITHER_MIN_SMOOTH_DELTA && delta <= DITHER_MAX_SMOOTH_DELTA;
}

fn staticSpatialDither(position: vec2<i32>) -> f32 {
  var value = (u32(position.x) * 0x9e3779b9u) ^ (u32(position.y) * 0x85ebca6bu);
  value = (value ^ (value >> 16u)) * 0x7feb352du;
  value = (value ^ (value >> 15u)) * 0x846ca68bu;
  value = value ^ (value >> 16u);
  return ((f32(value & 65535u) + 0.5) / 65536.0 - 0.5) / 255.0;
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(positions[index], 0.0, 1.0);
}

@fragment
fn encodeMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let premultiplied = textureLoad(working, vec2<i32>(position.xy), 0);
  if (premultiplied.a <= 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  let encoded = straightEncoded(premultiplied);
  let pixel = vec2<i32>(position.xy);
  let gradientCoverage = textureLoad(ditherMask, pixel, 0).r > 0.0;
  let insideEndpoints = all(encoded.rgb > vec3<f32>(DITHER_SAFE_ENDPOINT_MARGIN)) && all(encoded.rgb < vec3<f32>(1.0 - DITHER_SAFE_ENDPOINT_MARGIN));
  if (!gradientCoverage || !insideEndpoints || !smoothTransition(pixel, encoded.rgb)) {
    return encoded;
  }
  let offset = staticSpatialDither(pixel);
  return vec4<f32>(clamp(encoded.rgb + vec3<f32>(offset), vec3<f32>(0.0), vec3<f32>(1.0)), encoded.a);
}`;

const implementation = {
  schema: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE_SCHEMA,
  workingTarget: {
    format: "rgba16float",
    usage: ["RENDER_ATTACHMENT", "TEXTURE_BINDING"],
    blend: {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    },
  },
  publicationTarget: {
    format: "rgba8unorm",
    usage: ["RENDER_ATTACHMENT", "COPY_SRC"],
  },
  ditherCoverageTarget: {
    format: "r8unorm",
    usage: ["RENDER_ATTACHMENT", "TEXTURE_BINDING"],
    composition: "visible-gradient-normal-screen-compositing",
    signal: { red: "normal-gradient-opacity-or-screen-gradient-maximum-premultiplied-linear-rgb", alpha: "screen-minimum-premultiplied-linear-rgb" },
    normalFlatBlend: {
      color: { srcFactor: "zero", dstFactor: "one-minus-src", operation: "add" },
      alpha: { srcFactor: "zero", dstFactor: "one-minus-src", operation: "add" },
    },
    normalGradientBlend: {
      color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" },
    },
    screenFlatBlend: {
      color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
    },
    screenGradientBlend: {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    },
  },
  publicationDither: LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER,
  readback: {
    source: "rgba8unorm",
    requiredUsage: "COPY_SRC",
    bufferUsage: ["COPY_DST", "MAP_READ"],
    rowAlignment: LINEAR_SRGB_SDR_FINAL_WEBGPU_LIMITS.readbackAlignment,
  },
  compositeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL,
  encodeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL,
} as const;

export const LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE = Object.freeze({
  ...implementation,
  shaderSourceSha256: canonicalJsonSha256({ compositeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL, encodeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL }),
  implementationSha256: canonicalJsonSha256(implementation),
});
