import { canonicalJsonSha256 } from "@shellx-motion/core";

/** Route-private gradient draw contract. It is deliberately separate from the flat-only pipeline. */
export const LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE_SCHEMA = "shellx-motion/linear-srgb-sdr-final-f2a-gradient-webgpu-pipeline@1" as const;

export const LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_LIMITS = Object.freeze({
  maxGradientStops: 16,
  gradientUniformBytes: 512,
});

/**
 * `colors` remain encoded only at the authored boundary. Every selected stop is
 * decoded before interpolation, so a 50% black-to-white stop sample is the
 * linear-light value encoded back to sRGB, never encoded-domain 0.5 grey.
 */
export const LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL = /* wgsl */ `
struct GradientLayer {
  header: vec4<f32>,
  rect: vec4<f32>,
  center: vec4<f32>,
  offsets: array<vec4<f32>, 4>,
  colors: array<vec4<f32>, 16>,
};

@group(0) @binding(0) var<uniform> layer: GradientLayer;

fn srgbDecode(encoded: f32) -> f32 {
  if (encoded <= 0.04045) {
    return encoded / 12.92;
  }
  return pow((encoded + 0.055) / 1.055, 2.4);
}

fn offsetAt(index: u32) -> f32 {
  return layer.offsets[index / 4u][index % 4u];
}

fn decodedColor(index: u32) -> vec3<f32> {
  let encoded = layer.colors[index];
  return vec3<f32>(srgbDecode(encoded.r), srgbDecode(encoded.g), srgbDecode(encoded.b));
}

fn stopColor(value: f32) -> vec3<f32> {
  let t = clamp(value, 0.0, 1.0);
  let count = u32(layer.header.w);
  var priorOffset = offsetAt(0u);
  var priorColor = decodedColor(0u);
  if (t <= priorOffset) {
    return priorColor;
  }
  for (var index: u32 = 1u; index < 16u; index = index + 1u) {
    if (index >= count) {
      return priorColor;
    }
    let nextOffset = offsetAt(index);
    let nextColor = decodedColor(index);
    if (t <= nextOffset) {
      let span = max(nextOffset - priorOffset, 0.000001);
      return mix(priorColor, nextColor, clamp((t - priorOffset) / span, 0.0, 1.0));
    }
    priorOffset = nextOffset;
    priorColor = nextColor;
  }
  return priorColor;
}

fn gradientPosition(local: vec2<f32>) -> f32 {
  if (layer.header.x < 1.5) {
    let direction = vec2<f32>(sin(layer.header.z), -cos(layer.header.z));
    let extent = max(0.000001, 0.5 * (abs(direction.x) + abs(direction.y)));
    return dot(local - vec2<f32>(0.5, 0.5), direction) / (2.0 * extent) + 0.5;
  }
  let center = layer.center.xy;
  let radius = max(max(distance(center, vec2<f32>(0.0, 0.0)), distance(center, vec2<f32>(1.0, 0.0))), max(distance(center, vec2<f32>(0.0, 1.0)), distance(center, vec2<f32>(1.0, 1.0))));
  return distance(local, center) / max(radius, 0.000001);
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(positions[index], 0.0, 1.0);
}

@fragment
fn gradientMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  if (position.x < layer.rect.x || position.y < layer.rect.y
      || position.x >= layer.rect.x + layer.rect.z || position.y >= layer.rect.y + layer.rect.w) {
    discard;
  }
  let local = (position.xy - layer.rect.xy) / layer.rect.zw;
  let alpha = layer.header.y;
  let linear = stopColor(gradientPosition(local));
  return vec4<f32>(linear * alpha, alpha);
}`;

const implementation = {
  schema: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE_SCHEMA,
  workingTarget: "rgba16float",
  blend: {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  },
  gradientUniformBytes: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_LIMITS.gradientUniformBytes,
  gradientWgsl: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL,
} as const;

export const LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE = Object.freeze({
  ...implementation,
  shaderSourceSha256: canonicalJsonSha256({ gradientWgsl: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL }),
  implementationSha256: canonicalJsonSha256(implementation),
});
