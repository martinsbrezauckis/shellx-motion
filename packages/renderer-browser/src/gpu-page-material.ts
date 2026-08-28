import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageMaterialPipelineOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

/** Installs the four fixed Motion-owned procedural material presets once per session. */
export async function installWebGpuPageSessionMaterialPipeline(): Promise<GpuPageMaterialPipelineOutput> {
  type Device = { createRenderPipeline(value: unknown): unknown; createRenderPipelineAsync?(value: unknown): Promise<unknown>; createShaderModule(value: { code: string }): unknown };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; materialPipeline?: unknown } | undefined;
  if (!state) return { ok: false, failure: { code: "gpu_device_unavailable", message: "The persistent GPU page session is unavailable for material setup." } };
  const wgsl = `
struct MaterialUniform {
  frame: vec4<f32>, box: vec4<f32>, transform: vec4<f32>, header: vec4<f32>,
  color0: vec4<f32>, color1: vec4<f32>, color2: vec4<f32>, param0: vec4<f32>, param1: vec4<f32>
}
struct VertexOut { @builtin(position) position: vec4<f32> }
@group(0) @binding(0) var<uniform> material: MaterialUniform;
@vertex fn vs(@builtin(vertex_index) vertex: u32) -> VertexOut {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var output: VertexOut; output.position = vec4<f32>(p[vertex], 0.0, 1.0); return output;
}
fn hash21(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7)) + material.frame.w * 31.17) * 43758.5453); }
fn noise(p: vec2<f32>) -> f32 {
  let cell = floor(p); let local = fract(p); let curve = local * local * (vec2<f32>(3.0) - 2.0 * local);
  return mix(mix(hash21(cell), hash21(cell + vec2<f32>(1.0, 0.0)), curve.x), mix(hash21(cell + vec2<f32>(0.0, 1.0)), hash21(cell + vec2<f32>(1.0, 1.0)), curve.x), curve.y);
}
fn fbm(source: vec2<f32>, detail: f32) -> f32 {
  var p = source; var amplitude = 0.5; var value = 0.0;
  for (var index = 0; index < 4; index = index + 1) {
    if (f32(index) >= detail) { break; }
    value += noise(p) * amplitude; p = p * 2.03 + vec2<f32>(13.7, 7.9); amplitude *= 0.5;
  }
  return value;
}
fn palette(value: f32) -> vec3<f32> { return mix(mix(material.color0.rgb, material.color1.rgb, clamp(value * 1.35, 0.0, 1.0)), material.color2.rgb, smoothstep(0.68, 1.0, value)); }
@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> {
  let pivot = material.transform.yz; let cosine = cos(-material.transform.x); let sine = sin(-material.transform.x);
  let delta = input.position.xy - pivot; let rotated = vec2<f32>(delta.x * cosine - delta.y * sine, delta.x * sine + delta.y * cosine) + pivot;
  let uv = (rotated - material.box.xy) / material.box.zw;
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { discard; }
  let time = material.frame.z * material.param0.x + material.param1.w;
  let scale = material.param0.y; let intensity = material.param0.z; let detail = material.param0.w;
  let warped = uv * scale + vec2<f32>(sin(time * 0.31 + uv.y * 7.0), cos(time * 0.27 + uv.x * 9.0)) * material.param1.x;
  let plasma = 0.5 + 0.5 * sin((warped.x + warped.y + fbm(warped + time * 0.1, detail)) * 6.28318 + time);
  let scanlines = 0.5 + 0.5 * sin((uv.y * 420.0 + time * 9.0) * max(0.01, material.param1.z));
  let hologram = clamp(fbm(warped * 1.6 + vec2<f32>(0.0, time * 0.08), detail) * 0.68 + scanlines * 0.42, 0.0, 1.0);
  let energy = clamp(1.0 - length(uv - vec2<f32>(0.5)) * 2.0 + sin((length(uv - vec2<f32>(0.5)) * scale - time) * 12.0) * 0.16 + fbm(warped, detail) * 0.25, 0.0, 1.0);
  let grain = fbm(warped * 2.4 + vec2<f32>(time * 0.16, -time * 0.11), detail);
  var value = plasma;
  if (material.header.x > 0.5) { value = hologram; }
  if (material.header.x > 1.5) { value = energy; }
  if (material.header.x > 2.5) { value = grain; }
  let accent = smoothstep(0.72, 1.0, value) * material.param1.y;
  let alpha = clamp(max(material.color0.a, max(material.color1.a, material.color2.a)) * intensity * material.transform.w, 0.0, 1.0);
  let rgb = clamp(palette(value) * intensity + material.color2.rgb * accent, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(rgb * alpha, alpha);
}`;
  try {
    const module = state.device.createShaderModule({ code: wgsl });
    state.materialPipeline = state.device.createRenderPipelineAsync
      ? await state.device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } })
      : state.device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    return { ok: true };
  } catch {
    return { ok: false, failure: { code: "gpu_render_failed", message: "Persistent WebGPU material pipeline creation failed." } };
  }
}
