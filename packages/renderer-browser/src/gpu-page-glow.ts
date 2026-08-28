import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageGlowPipelineOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

/** Installs the fixed layer-plus-colored-alpha glow grouping pipeline. */
export async function installWebGpuPageSessionGlowPipeline(): Promise<GpuPageGlowPipelineOutput> {
  type Device = { createRenderPipeline(value: unknown): unknown; createRenderPipelineAsync?(value: unknown): Promise<unknown>; createShaderModule(value: { code: string }): unknown };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; glowPipeline?: unknown } | undefined;
  if (!state) return { ok: false, failure: { code: "gpu_device_unavailable", message: "The persistent GPU page session is unavailable for glow setup." } };
  const wgsl = `
struct VertexOut { @builtin(position) position: vec4<f32> }
struct GlowState { color: vec4<f32>, effects: vec4<f32> }
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var blurredAlphaTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> glow: GlowState;
@vertex fn vs(@builtin(vertex_index) index:u32)->VertexOut { let positions=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));var o:VertexOut;o.position=vec4<f32>(positions[index],0.0,1.0);return o; }
fn apply_color_effects(input:vec3<f32>,effect:vec4<f32>)->vec3<f32> { var c=input*effect.x;c=(c-vec3<f32>(0.5))*effect.y+vec3<f32>(0.5);let sl=dot(c,vec3<f32>(0.2126,0.7152,0.0722));c=vec3<f32>(sl)+(c-vec3<f32>(sl))*effect.z;let gl=dot(c,vec3<f32>(0.2126,0.7152,0.0722));return clamp(mix(c,vec3<f32>(gl),effect.w),vec3<f32>(0.0),vec3<f32>(1.0)); }
@fragment fn fs(input:VertexOut)->@location(0) vec4<f32> { let p=vec2<i32>(input.position.xy);let source=textureLoad(sourceTexture,p,0);let straight=source.rgb/max(source.a,0.000001);let adjusted=vec4<f32>(apply_color_effects(straight,glow.effects)*source.a,source.a);let haloAlpha=textureLoad(blurredAlphaTexture,p,0).a*glow.color.a;let halo=vec4<f32>(glow.color.rgb*haloAlpha,haloAlpha);return adjusted+halo*(1.0-adjusted.a); }
`;
  try {
    const module = state.device.createShaderModule({ code: wgsl });
    state.glowPipeline = state.device.createRenderPipelineAsync
      ? await state.device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } })
      : state.device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    return { ok: true };
  } catch { return { ok: false, failure: { code: "gpu_render_failed", message: "Persistent WebGPU glow pipeline creation failed." } }; }
}
