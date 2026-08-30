import { canonicalJsonSha256 } from "@shellx-motion/core";

/**
 * Fixed, route-private GPU contract for the static linear-sRGB SDR final
 * producer. It intentionally has no relationship to the generic GPU catalog.
 */
export const LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE_SCHEMA = "shellx-motion/linear-srgb-sdr-final-webgpu-pipeline@1" as const;

export const LINEAR_SRGB_SDR_FINAL_WEBGPU_LIMITS = Object.freeze({
  maxWidth: 1920,
  maxHeight: 1080,
  maxRects: 64,
  maxTightRgba8Bytes: 1920 * 1080 * 4,
  maxPaddedRgba8Bytes: 1920 * 1080 * 4,
  uniformBytes: 32,
  workingBytesPerPixel: 8,
  publicationBytesPerPixel: 4,
  readbackAlignment: 256,
});

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

@fragment
fn compositeMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
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
  return vec4<f32>(linear * alpha, alpha);
}`;

/** Float working pixels are unpremultiplied and explicitly encoded at publication. */
export const LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL = /* wgsl */ `
@group(0) @binding(0) var working: texture_2d<f32>;

fn srgbEncode(linear: f32) -> f32 {
  if (linear <= 0.0031308) {
    return linear * 12.92;
  }
  return 1.055 * pow(linear, 1.0 / 2.4) - 0.055;
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
  let straightLinear = premultiplied.rgb / premultiplied.a;
  return vec4<f32>(
    srgbEncode(straightLinear.r), srgbEncode(straightLinear.g), srgbEncode(straightLinear.b), premultiplied.a
  );
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
