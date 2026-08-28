import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageScene3dPipelineOutput = {ok:true}|{ok:false;failure:GpuRuntimeFailure};

/** Installs the fixed Motion-owned depth-buffered 3D pipeline. */
export async function installWebGpuPageSessionScene3dPipeline():Promise<GpuPageScene3dPipelineOutput>{
  type Device={createRenderPipeline(value:unknown):unknown;createRenderPipelineAsync?(value:unknown):Promise<unknown>;createShaderModule(value:{code:string}):unknown};
  const browserGlobal=globalThis as unknown as {__shellxMotionGpuSessionV1?:unknown};
  const state=browserGlobal.__shellxMotionGpuSessionV1 as {device:Device;scene3dPipeline?:unknown}|undefined;
  if(!state)return{ok:false,failure:{code:"gpu_device_unavailable",message:"The persistent GPU page session is unavailable for scene3d setup."}};
  const wgsl=`
struct ObjectUniform {
  viewProjection: mat4x4<f32>, model: mat4x4<f32>,
  lightDirectionAmbient: vec4<f32>, lightColorIntensity: vec4<f32>,
  color: vec4<f32>, params: vec4<f32>
}
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) normal: vec3<f32> }
@group(0) @binding(0) var<uniform> object: ObjectUniform;
@vertex fn vs(@location(0) position:vec3<f32>,@location(1) normal:vec3<f32>)->VertexOut{var o:VertexOut;o.position=object.viewProjection*object.model*vec4<f32>(position,1.0);o.normal=normalize((object.model*vec4<f32>(normal,0.0)).xyz);return o;}
@fragment fn fs(input:VertexOut)->@location(0) vec4<f32>{let diffuse=max(dot(normalize(input.normal),normalize(-object.lightDirectionAmbient.xyz)),0.0);let lighting=object.lightDirectionAmbient.w+object.params.x+diffuse*object.lightColorIntensity.w;let rgb=clamp(object.color.rgb*object.lightColorIntensity.rgb*lighting,vec3<f32>(0.0),vec3<f32>(1.0));return vec4<f32>(rgb*object.color.a,object.color.a);}
`;
  try{const module=state.device.createShaderModule({code:wgsl}),descriptor={layout:"auto",vertex:{module,entryPoint:"vs",buffers:[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:"float32x3"},{shaderLocation:1,offset:12,format:"float32x3"}]}]},fragment:{module,entryPoint:"fs",targets:[{format:"rgba8unorm",blend:{color:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha",operation:"add"}}}]},primitive:{topology:"triangle-list",cullMode:"back"},depthStencil:{format:"depth24plus",depthWriteEnabled:true,depthCompare:"less"}};state.scene3dPipeline=state.device.createRenderPipelineAsync?await state.device.createRenderPipelineAsync(descriptor):state.device.createRenderPipeline(descriptor);return{ok:true};}
  catch{return{ok:false,failure:{code:"gpu_render_failed",message:"Persistent WebGPU scene3d pipeline creation failed."}};}
}
