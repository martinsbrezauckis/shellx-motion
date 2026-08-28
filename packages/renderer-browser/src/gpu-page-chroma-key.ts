import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageChromaKeyPipelineOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

/** Installs the fixed chroma keyer ported from compositing-keying's CPU formula. */
export async function installWebGpuPageSessionChromaKeyPipeline(): Promise<GpuPageChromaKeyPipelineOutput> {
  type Device = { createRenderPipeline(value: unknown): unknown; createRenderPipelineAsync?(value: unknown): Promise<unknown>; createShaderModule(value: { code: string }): unknown };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; chromaKeyPipeline?: unknown } | undefined;
  if (!state) return { ok: false, failure: { code: "gpu_device_unavailable", message: "The persistent GPU page session is unavailable for chroma-key setup." } };
  const wgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) opacity: f32 }
struct Key { color: vec4<f32>, controls: vec4<f32>, spill: vec4<f32> }
@group(0) @binding(0) var imageSampler: sampler; @group(0) @binding(1) var imageTexture: texture_2d<f32>; @group(0) @binding(2) var<uniform> key: Key;
@vertex fn vs(@location(0) position: vec2<f32>, @location(1) uv: vec2<f32>, @location(2) opacity: f32) -> VertexOut { var o: VertexOut; o.position=vec4<f32>(position,0.0,1.0);o.uv=uv;o.opacity=opacity;return o; }
fn chroma(c:vec3<f32>)->vec2<f32>{return vec2<f32>(-0.168736*c.r-0.331264*c.g+0.5*c.b,0.5*c.r-0.418688*c.g-0.081312*c.b);}
fn luminance(c:vec3<f32>)->f32{return dot(c,vec3<f32>(0.2126,0.7152,0.0722));}
fn keyed_rgb(c:vec3<f32>,foreground:f32)->vec3<f32>{
  let dominant=select(select(2u,1u,key.color.g>=key.color.b),0u,key.color.r>=key.color.g&&key.color.r>=key.color.b);let balance=key.spill.x;let spillWeight=1.0-foreground;let edge=key.spill.y*spillWeight;let amount=key.controls.w*spillWeight;var o=c;
  if(dominant==0u){let neutral=mix(c.g,c.b,(balance+1.0)*0.5);let reduction=max(0.0,c.r-neutral)*clamp(amount+edge,0.0,1.0);o.r-=reduction;if(edge>0.0){let correction=reduction*edge*0.35;o.g+=correction*(1.0-balance)*0.5;o.b+=correction*(1.0+balance)*0.5;}}
  else if(dominant==1u){let neutral=mix(c.r,c.b,(balance+1.0)*0.5);let reduction=max(0.0,c.g-neutral)*clamp(amount+edge,0.0,1.0);o.g-=reduction;if(edge>0.0){let correction=reduction*edge*0.35;o.r+=correction*(1.0-balance)*0.5;o.b+=correction*(1.0+balance)*0.5;}}
  else {let neutral=mix(c.r,c.g,(balance+1.0)*0.5);let reduction=max(0.0,c.b-neutral)*clamp(amount+edge,0.0,1.0);o.b-=reduction;if(edge>0.0){let correction=reduction*edge*0.35;o.r+=correction*(1.0-balance)*0.5;o.g+=correction*(1.0+balance)*0.5;}}
  return clamp(o,vec3<f32>(0.0),vec3<f32>(1.0));
}
@fragment fn fs(input:VertexOut)->@location(0) vec4<f32>{let sampled=textureSample(imageTexture,imageSampler,input.uv);let distance=length(chroma(sampled.rgb)-chroma(key.color.rgb))/1.5;let threshold=key.controls.x*(0.75+key.controls.z*0.25*luminance(sampled.rgb));let foreground=smoothstep(threshold,threshold+max(0.0001,key.controls.y),distance);let alpha=foreground*sampled.a*input.opacity;return vec4<f32>(keyed_rgb(sampled.rgb,foreground)*alpha,alpha);}
`;
  try { const module = state.device.createShaderModule({ code: wgsl }); const descriptor = { layout: "auto", vertex: { module, entryPoint: "vs", buffers: [{ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }, { shaderLocation: 2, offset: 16, format: "float32" }] }] }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } }] }, primitive: { topology: "triangle-list" } }; state.chromaKeyPipeline = state.device.createRenderPipelineAsync ? await state.device.createRenderPipelineAsync(descriptor) : state.device.createRenderPipeline(descriptor); return { ok: true }; }
  catch { return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed GPU chroma-key pipeline could not be created." } }; }
}
