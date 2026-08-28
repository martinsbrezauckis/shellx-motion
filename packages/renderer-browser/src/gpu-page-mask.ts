import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageMaskPipelineOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

/** Installs the fixed canvas-space geometric alpha-mask pipeline. */
export async function installWebGpuPageSessionMaskPipeline(): Promise<GpuPageMaskPipelineOutput> {
  type ShaderModule = { getCompilationInfo?(): Promise<{ messages?: Array<{ type?: string; message?: string; lineNum?: number; linePos?: number }> }> };
  type Device = { createRenderPipeline(value: unknown): unknown; createRenderPipelineAsync?(value: unknown): Promise<unknown>; createShaderModule(value: { code: string }): ShaderModule };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; maskPipeline?: unknown } | undefined;
  if (!state) return { ok: false, failure: { code: "gpu_device_unavailable", message: "The persistent GPU page session is unavailable." } };
  const wgsl = `
struct Mask { box: vec4<f32>, transform: vec4<f32>, options: vec4<f32> }
@group(0) @binding(0) var source: texture_2d<f32>; @group(0) @binding(1) var<uniform> mask: Mask;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{let p=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));return vec4<f32>(p[i],0.0,1.0);}
fn roundedBox(point:vec2<f32>,center:vec2<f32>,halfSize:vec2<f32>,radius:f32)->f32{let q=abs(point-center)-halfSize+vec2<f32>(radius);return length(max(q,vec2<f32>(0.0)))+min(max(q.x,q.y),0.0)-radius;}
fn segmentDistance(point:vec2<f32>,start:vec2<f32>,end:vec2<f32>)->f32{let edge=end-start;let projection=clamp(dot(point-start,edge)/max(dot(edge,edge),0.000001),0.0,1.0);return length(point-(start+edge*projection));}
fn triangleDistance(point:vec2<f32>,box:vec4<f32>)->f32{let local=point-box.xy;let top=vec2<f32>(box.z*0.5,0.0);let left=vec2<f32>(0.0,box.w);let right=vec2<f32>(box.z,box.w);let edge=min(segmentDistance(local,top,left),min(segmentDistance(local,left,right),segmentDistance(local,right,top)));let inside=local.y>=0.0&&local.y<=box.w&&abs(local.x-box.z*0.5)<=local.y*box.z/max(box.w*2.0,0.000001);return select(edge,-edge,inside);}
@fragment fn fs(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
  let delta=position.xy-mask.transform.yz;let angle=-mask.transform.x;let cosine=cos(angle);let sine=sin(angle);let point=mask.transform.yz+vec2<f32>(delta.x*cosine-delta.y*sine,delta.x*sine+delta.y*cosine);
  let center=mask.box.xy+mask.box.zw*0.5;let halfSize=mask.box.zw*0.5;var distance=roundedBox(point,center,halfSize,mask.transform.w);
  if(mask.options.x>0.5){distance=(length((point-center)/max(halfSize,vec2<f32>(0.0001)))-1.0)*min(halfSize.x,halfSize.y);}
  if(mask.options.x>1.5){distance=triangleDistance(point,mask.box);}
  var coverage=select(select(0.0,1.0,distance<=0.0),1.0-smoothstep(-mask.options.w,mask.options.w,distance),mask.options.w>0.0);var strength=coverage*mask.options.z;if(mask.options.y>0.5){strength=1.0-strength;}
  return textureLoad(source,vec2<i32>(position.xy),0)*strength;
}`;
  try {
    const module=state.device.createShaderModule({code:wgsl});
    const compilation=await module.getCompilationInfo?.();
    const shaderError=compilation?.messages?.find((message)=>message.type==="error");
    if(shaderError)throw new Error(`WGSL ${shaderError.lineNum??0}:${shaderError.linePos??0}: ${shaderError.message??"validation failed"}`);
    const descriptor={layout:"auto",vertex:{module,entryPoint:"vs"},fragment:{module,entryPoint:"fs",targets:[{format:"rgba8unorm"}]},primitive:{topology:"triangle-list"}};
    state.maskPipeline=state.device.createRenderPipelineAsync?await state.device.createRenderPipelineAsync(descriptor):state.device.createRenderPipeline(descriptor);
    return{ok:true};
  }
  catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 512) : "unknown WebGPU validation error";
    return { ok:false,failure:{code:"gpu_render_failed",message:`The fixed GPU mask pipeline could not be created: ${detail}`} };
  }
}
