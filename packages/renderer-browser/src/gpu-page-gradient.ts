import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageGradientPipelineOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

/** Installs one fixed Motion-owned gradient pipeline into the retained device. */
export async function installWebGpuPageSessionGradientPipeline(): Promise<GpuPageGradientPipelineOutput> {
  type Device = { createRenderPipeline(value: unknown): unknown; createRenderPipelineAsync?(value: unknown): Promise<unknown>; createShaderModule(value: { code: string }): unknown };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; gradientPipeline?: unknown; additiveGradientPipeline?: unknown } | undefined;
  if (!state) return { ok: false, failure: { code: "gpu_device_unavailable", message: "The persistent GPU page session is unavailable for gradient setup." } };
  const wgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) local: vec2<f32> }
struct Gradient { header: vec4<f32>, offsets: array<vec4<f32>,4>, colors: array<vec4<f32>,16> }
@group(0) @binding(0) var<uniform> gradient: Gradient;
@vertex fn vs(@location(0) position: vec2<f32>, @location(1) local: vec2<f32>) -> VertexOut { var o: VertexOut; o.position=vec4<f32>(position,0.0,1.0); o.local=local; return o; }
fn offset_at(index:u32)->f32 { return gradient.offsets[index/4u][index%4u]; }
fn paint(t0:f32)->vec4<f32> { let t=clamp(t0,0.0,1.0); var prior=offset_at(0u); var color=gradient.colors[0]; for(var i:u32=1u;i<16u;i=i+1u){let next=offset_at(i);if(next>1.0){break;}let nextColor=gradient.colors[i];if(t<=next){let span=max(next-prior,0.000001);return mix(color,nextColor,clamp((t-prior)/span,0.0,1.0));}prior=next;color=nextColor;}return color; }
@fragment fn fs(input:VertexOut)->@location(0) vec4<f32> { var t:f32; if(gradient.header.x<0.5){let radians=gradient.header.y;let direction=vec2<f32>(sin(radians),-cos(radians));let extent=max(0.000001,0.5*(abs(direction.x)+abs(direction.y)));t=dot(input.local-vec2<f32>(0.5,0.5),direction)/(2.0*extent)+0.5;}else{let center=gradient.header.zw;let radius=max(max(distance(center,vec2<f32>(0.0,0.0)),distance(center,vec2<f32>(1.0,0.0))),max(distance(center,vec2<f32>(0.0,1.0)),distance(center,vec2<f32>(1.0,1.0))));t=distance(input.local,center)/max(radius,0.000001);}return paint(t); }
`;
  try {
    const module = state.device.createShaderModule({ code: wgsl });
    const vertex = { module, entryPoint: "vs", buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }] }] };
    const pipeline = (blend: unknown): Promise<unknown> => state.device.createRenderPipelineAsync ? state.device.createRenderPipelineAsync({ layout: "auto", vertex, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] }, primitive: { topology: "triangle-list" } }) : Promise.resolve(state.device.createRenderPipeline({ layout: "auto", vertex, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] }, primitive: { topology: "triangle-list" } }));
    state.gradientPipeline = await pipeline({ color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } });
    state.additiveGradientPipeline = await pipeline({ color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } });
    return { ok: true };
  } catch { return { ok: false, failure: { code: "gpu_render_failed", message: "Persistent WebGPU gradient pipeline creation failed." } }; }
}
