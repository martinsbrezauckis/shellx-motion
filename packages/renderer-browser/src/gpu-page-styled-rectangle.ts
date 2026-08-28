import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageStyledRectanglePipelineOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

/** Installs Motion's fixed rounded-fill/stroke/shadow pipeline into the retained device. */
export async function installWebGpuPageSessionStyledRectanglePipeline(): Promise<GpuPageStyledRectanglePipelineOutput> {
  type Device = { createRenderPipeline(value: unknown): unknown; createRenderPipelineAsync?(value: unknown): Promise<unknown>; createShaderModule(value: { code: string }): unknown };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; styledRectanglePipeline?: unknown; additiveStyledRectanglePipeline?: unknown } | undefined;
  if (!state) return { ok: false, failure: { code: "gpu_device_unavailable", message: "The persistent GPU page session is unavailable for styled rectangle setup." } };
  const wgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) local: vec2<f32> }
struct Style { geometry: vec4<f32>, shadow: vec4<f32>, fill: vec4<f32>, stroke: vec4<f32>, shadowColor: vec4<f32> }
@group(0) @binding(0) var<uniform> style: Style;
@vertex fn vs(@location(0) position: vec2<f32>, @location(1) local: vec2<f32>) -> VertexOut { var o:VertexOut;o.position=vec4<f32>(position,0.0,1.0);o.local=local;return o; }
fn rounded_distance(point:vec2<f32>,size:vec2<f32>,radius0:f32)->f32 { let radius=min(max(radius0,0.0),min(size.x,size.y)*0.5);let q=abs(point-size*0.5)-(size*0.5-vec2<f32>(radius));return length(max(q,vec2<f32>(0.0)))+min(max(q.x,q.y),0.0)-radius; }
fn coverage(distance:f32)->f32 { let edge=max(fwidth(distance),0.75);return 1.0-smoothstep(-edge,edge,distance); }
@fragment fn fs(input:VertexOut)->@location(0) vec4<f32> { let size=style.geometry.xy;let radius=style.geometry.z;let strokeWidth=min(style.geometry.w,min(size.x,size.y)*0.5);let outer=coverage(rounded_distance(input.local,size,radius));let innerSize=max(size-vec2<f32>(strokeWidth*2.0),vec2<f32>(0.0));let innerDistance=rounded_distance(input.local-vec2<f32>(strokeWidth),innerSize,max(radius-strokeWidth,0.0));let inner=select(0.0,coverage(innerDistance),strokeWidth<size.x*0.5&&strokeWidth<size.y*0.5);let body=style.stroke*max(outer-inner,0.0)+style.fill*inner;let shadowSize=max(size+vec2<f32>(style.shadow.w*2.0),vec2<f32>(0.0));let shadowPoint=input.local-style.shadow.xy+vec2<f32>(style.shadow.w);let shadowDistance=rounded_distance(shadowPoint,shadowSize,max(radius+style.shadow.w,0.0));let blur=max(style.shadow.z,0.0);let shadowCoverage=select(coverage(shadowDistance),1.0-smoothstep(-blur,blur,shadowDistance),blur>0.0);let shadowPaint=style.shadowColor*shadowCoverage;return body+shadowPaint*(1.0-body.a); }
`;
  try {
    const module = state.device.createShaderModule({ code: wgsl });
    const vertex = { module, entryPoint: "vs", buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }] }] };
    const pipeline = (blend: unknown): Promise<unknown> => state.device.createRenderPipelineAsync ? state.device.createRenderPipelineAsync({ layout: "auto", vertex, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] }, primitive: { topology: "triangle-list" } }) : Promise.resolve(state.device.createRenderPipeline({ layout: "auto", vertex, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] }, primitive: { topology: "triangle-list" } }));
    state.styledRectanglePipeline = await pipeline({ color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } });
    state.additiveStyledRectanglePipeline = await pipeline({ color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } });
    return { ok: true };
  } catch { return { ok: false, failure: { code: "gpu_render_failed", message: "Persistent WebGPU styled rectangle pipeline creation failed." } }; }
}
