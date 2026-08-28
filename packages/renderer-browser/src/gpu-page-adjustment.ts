import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageAdjustmentPipelineOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

/** Installs deterministic full-frame vignette and film-grain processing. */
export async function installWebGpuPageSessionAdjustmentPipeline(): Promise<GpuPageAdjustmentPipelineOutput> {
  type Device = { createRenderPipeline(value: unknown): unknown; createRenderPipelineAsync?(value: unknown): Promise<unknown>; createShaderModule(value: { code: string }): unknown };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; adjustmentPipeline?: unknown } | undefined;
  if (!state) return { ok: false, failure: { code: "gpu_device_unavailable", message: "The persistent GPU page session is unavailable for adjustment setup." } };
  const wgsl = `
struct VertexOut { @builtin(position) position: vec4<f32> }
struct AdjustmentState { vignetteColor: vec4<f32>, vignette: vec4<f32>, grainAmount: f32, grainSize: f32, grainSeed: u32, grainEnabled: u32 }
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> adjustment: AdjustmentState;
@vertex fn vs(@builtin(vertex_index) index:u32)->VertexOut { let positions=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));var o:VertexOut;o.position=vec4<f32>(positions[index],0.0,1.0);return o; }
fn random01(seed:u32,index:u32,channel:u32)->f32 { var value=seed^((index+1u)*0x9e3779b1u)^((channel+1u)*0x85ebca6bu);value=value^(value>>16u);value=value*0x7feb352du;value=value^(value>>15u);value=value*0x846ca68bu;value=value^(value>>16u);return f32(value)/4294967296.0; }
fn soft_light_channel(b:f32,s:f32)->f32 { let d=select(((16.0*b-12.0)*b+4.0)*b,sqrt(b),b>0.25);return select(b-(1.0-2.0*s)*b*(1.0-b),b+(2.0*s-1.0)*(d-b),s>0.5); }
fn soft_light(b:vec3<f32>,s:f32)->vec3<f32> { return vec3<f32>(soft_light_channel(b.r,s),soft_light_channel(b.g,s),soft_light_channel(b.b,s)); }
@fragment fn fs(input:VertexOut)->@location(0) vec4<f32> { let pixel=vec2<i32>(input.position.xy);var current=textureLoad(sourceTexture,pixel,0);if(adjustment.vignette.z>0.5){let dimensions=vec2<f32>(textureDimensions(sourceTexture));let distance=length(input.position.xy-dimensions*0.5)/length(dimensions*0.5);let edge=smoothstep(0.7-adjustment.vignette.y*0.5,1.0,distance);let alpha=adjustment.vignette.x*edge*adjustment.vignetteColor.a;let overlay=vec4<f32>(adjustment.vignetteColor.rgb*alpha,alpha);current=overlay+current*(1.0-alpha);}if(adjustment.grainEnabled>0u){let size=max(adjustment.grainSize,1.0);let cell=vec2<u32>(floor(input.position.xy/size))%vec2<u32>(32u);let noise=random01(adjustment.grainSeed,cell.y*32u+cell.x,7u);let alpha=adjustment.grainAmount;let b=current.rgb/max(current.a,0.000001);let mixed=soft_light(b,noise);let outputAlpha=alpha+current.a-alpha*current.a;let rgb=(1.0-alpha)*current.rgb+(1.0-current.a)*vec3<f32>(noise*alpha)+current.a*alpha*mixed;current=vec4<f32>(rgb,outputAlpha);}return clamp(current,vec4<f32>(0.0),vec4<f32>(1.0)); }
`;
  try {
    const module = state.device.createShaderModule({ code: wgsl });
    state.adjustmentPipeline = state.device.createRenderPipelineAsync
      ? await state.device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } })
      : state.device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    return { ok: true };
  } catch { return { ok: false, failure: { code: "gpu_render_failed", message: "Persistent WebGPU adjustment pipeline creation failed." } }; }
}
