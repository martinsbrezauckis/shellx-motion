import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageBlurPipelineOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

/** Installs the fixed separable nine-tap blur used by bounded layer effects. */
export async function installWebGpuPageSessionBlurPipeline(): Promise<GpuPageBlurPipelineOutput> {
  type Device = { createRenderPipeline(value: unknown): unknown; createRenderPipelineAsync?(value: unknown): Promise<unknown>; createShaderModule(value: { code: string }): unknown };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; blurPipeline?: unknown } | undefined;
  if (!state) return { ok: false, failure: { code: "gpu_device_unavailable", message: "The persistent GPU page session is unavailable for blur setup." } };
  const wgsl = `
struct VertexOut { @builtin(position) position: vec4<f32> }
struct BlurState { direction: vec2<f32>, radius: f32, padding: f32 }
@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> blur: BlurState;
@vertex fn vs(@builtin(vertex_index) index:u32)->VertexOut { let positions=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));var o:VertexOut;o.position=vec4<f32>(positions[index],0.0,1.0);return o; }
@fragment fn fs(input:VertexOut)->@location(0) vec4<f32> {
  let dimensions=vec2<f32>(textureDimensions(inputTexture));let uv=input.position.xy/dimensions;let step=blur.direction*(blur.radius/4.0)/dimensions;
  var color=textureSampleLevel(inputTexture,linearSampler,uv,0.0)*0.227027;
  color+=textureSampleLevel(inputTexture,linearSampler,uv+step,0.0)*0.1945946;color+=textureSampleLevel(inputTexture,linearSampler,uv-step,0.0)*0.1945946;
  color+=textureSampleLevel(inputTexture,linearSampler,uv+step*2.0,0.0)*0.1216216;color+=textureSampleLevel(inputTexture,linearSampler,uv-step*2.0,0.0)*0.1216216;
  color+=textureSampleLevel(inputTexture,linearSampler,uv+step*3.0,0.0)*0.054054;color+=textureSampleLevel(inputTexture,linearSampler,uv-step*3.0,0.0)*0.054054;
  color+=textureSampleLevel(inputTexture,linearSampler,uv+step*4.0,0.0)*0.016216;color+=textureSampleLevel(inputTexture,linearSampler,uv-step*4.0,0.0)*0.016216;return color;
}`;
  try {
    const module = state.device.createShaderModule({ code: wgsl });
    state.blurPipeline = state.device.createRenderPipelineAsync
      ? await state.device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } })
      : state.device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    return { ok: true };
  } catch { return { ok: false, failure: { code: "gpu_render_failed", message: "Persistent WebGPU blur pipeline creation failed." } }; }
}
