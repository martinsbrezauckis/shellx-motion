import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export const GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_ABI = "shellx-motion/browser-scene3d-gltf-pbr-hdr10@1" as const;
export interface GpuPageScene3dGltfPbrHdr10PipelineIdentity { readonly abi: typeof GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_ABI; readonly pipelineImplementationSha256: string; readonly resourceCeilingSha256: string; }
export type GpuPageScene3dGltfPbrHdr10PipelineOutput = { readonly ok: true } | { readonly ok: false; readonly failure: GpuRuntimeFailure };

/** Fixed HDR-only PBR: sRGB textures/factors become linear Rec.2020 nits in an opaque rgba16float target. */
export async function installWebGpuPageSessionScene3dGltfPbrHdr10Pipeline(identity: GpuPageScene3dGltfPbrHdr10PipelineIdentity): Promise<GpuPageScene3dGltfPbrHdr10PipelineOutput> {
  type Pipeline = { getBindGroupLayout(index: number): unknown };
  type Device = { createRenderPipeline(value: unknown): Pipeline; createRenderPipelineAsync?(value: unknown): Promise<Pipeline>; createShaderModule(value: { code: string }): unknown };
  type State = { device: Device; hdr10PbrPipeline?: Pipeline; hdr10PbrMipPipeline?: Pipeline; hdr10PbrPipelineIdentity?: GpuPageScene3dGltfPbrHdr10PipelineIdentity };
  const ABI = "shellx-motion/browser-scene3d-gltf-pbr-hdr10@1", state = (globalThis as unknown as { __shellxMotionGpuHdr10PbrSessionV1?: State }).__shellxMotionGpuHdr10PbrSessionV1;
  if (!state) return fail("gpu_device_unavailable", "The isolated HDR10 PBR page session is unavailable.");
  if (!identity || identity.abi !== ABI || !hash(identity.pipelineImplementationSha256) || !hash(identity.resourceCeilingSha256)) return fail("gpu_render_failed", "The HDR10 PBR pipeline identity is invalid.");
  if (state.hdr10PbrPipeline || state.hdr10PbrMipPipeline) return same(state.hdr10PbrPipelineIdentity, identity) && state.hdr10PbrPipeline && state.hdr10PbrMipPipeline ? { ok: true } : fail("gpu_render_failed", "The retained HDR10 PBR pipeline identity changed.");
  const pbr = `
struct ObjectUniform { model: mat4x4<f32>, viewProjection: mat4x4<f32>, baseColorFactor: vec4<f32>, emissiveMetallic: vec4<f32>, roughnessAmbient: vec4<f32>, lightDirectionIntensity: vec4<f32>, lightColor: vec4<f32>, cameraPosition: vec4<f32> }
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) normal: vec3<f32>, @location(1) uv: vec2<f32>, @location(2) world: vec3<f32> }
@group(0) @binding(0) var<uniform> object: ObjectUniform; @group(0) @binding(1) var tex: texture_2d<f32>; @group(0) @binding(2) var samp: sampler;
@vertex fn vs(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>) -> VertexOut { var o: VertexOut; let w=object.model*vec4<f32>(position,1.0); o.position=object.viewProjection*w; o.normal=normalize((object.model*vec4<f32>(normal,0.0)).xyz); o.uv=uv; o.world=w.xyz; return o; }
fn dGgx(n:vec3<f32>,h:vec3<f32>,r:f32)->f32 { let a=r*r; let a2=a*a; let x=max(dot(n,h),0.0); let d=x*x*(a2-1.0)+1.0; return a2/max(3.14159265*d*d,0.0001); }
fn gSchlick(x:f32,r:f32)->f32 { let q=(r+1.0)*(r+1.0)/8.0; return x/max(x*(1.0-q)+q,0.0001); }
fn fresnel(x:f32,f0:vec3<f32>)->vec3<f32> { return f0+(vec3<f32>(1.0)-f0)*pow(1.0-x,5.0); }
fn toRec2020(linear:vec3<f32>)->vec3<f32> { return vec3<f32>(0.627403896*linear.r+0.329283038*linear.g+0.043313066*linear.b,0.069097289*linear.r+0.919540395*linear.g+0.011362316*linear.b,0.016391439*linear.r+0.088013308*linear.g+0.895595253*linear.b); }
@fragment fn fs(i:VertexOut)->@location(0) vec4<f32> { let base=textureSample(tex,samp,i.uv).rgb*object.baseColorFactor.rgb; let n=normalize(i.normal); let v=normalize(object.cameraPosition.xyz-i.world); let l=normalize(-object.lightDirectionIntensity.xyz); let h=normalize(v+l); let m=clamp(object.emissiveMetallic.w,0.0,1.0); let r=clamp(object.roughnessAmbient.x,0.04,1.0); let ndl=max(dot(n,l),0.0); let ndv=max(dot(n,v),0.0); let f=fresnel(max(dot(h,v),0.0),mix(vec3<f32>(0.04),base,vec3<f32>(m))); let spec=(dGgx(n,h,r)*gSchlick(ndv,r)*gSchlick(ndl,r)*f)/max(4.0*ndv*ndl,0.0001); let kd=(vec3<f32>(1.0)-f)*(1.0-m); let linear=max((kd*base/3.14159265+spec)*object.lightColor.rgb*object.lightDirectionIntensity.w*ndl+kd*base*clamp(object.roughnessAmbient.y,0.0,1.0)+object.emissiveMetallic.rgb,vec3<f32>(0.0)); return vec4<f32>(min(toRec2020(linear)*203.0,vec3<f32>(1000.0)),1.0); }`;
  const mip = `struct O{@builtin(position) p:vec4<f32>,@location(0) uv:vec2<f32>} @group(0) @binding(0) var t:texture_2d<f32>; @group(0) @binding(1) var s:sampler; @vertex fn vs(@builtin(vertex_index)i:u32)->O{let p=array<vec2<f32>,3>(vec2<f32>(-1.,-1.),vec2<f32>(3.,-1.),vec2<f32>(-1.,3.));let u=array<vec2<f32>,3>(vec2<f32>(0.,1.),vec2<f32>(2.,1.),vec2<f32>(0.,-1.));var o:O;o.p=vec4<f32>(p[i],0.,1.);o.uv=u[i];return o;} @fragment fn fs(i:O)->@location(0) vec4<f32>{return textureSampleLevel(t,s,i.uv,0.);} `;
  try {
    const pbrModule = state.device.createShaderModule({ code: pbr }), mipModule = state.device.createShaderModule({ code: mip });
    const pbrDescriptor = { layout: "auto", vertex: { module: pbrModule, entryPoint: "vs", buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }, { shaderLocation: 2, offset: 24, format: "float32x2" }] }] }, fragment: { module: pbrModule, entryPoint: "fs", targets: [{ format: "rgba16float" }] }, primitive: { topology: "triangle-list", cullMode: "back" }, depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" } };
    const mipDescriptor = { layout: "auto", vertex: { module: mipModule, entryPoint: "vs" }, fragment: { module: mipModule, entryPoint: "fs", targets: [{ format: "rgba8unorm-srgb" }] }, primitive: { topology: "triangle-list" } };
    state.hdr10PbrPipeline = state.device.createRenderPipelineAsync ? await state.device.createRenderPipelineAsync(pbrDescriptor) : state.device.createRenderPipeline(pbrDescriptor);
    state.hdr10PbrMipPipeline = state.device.createRenderPipelineAsync ? await state.device.createRenderPipelineAsync(mipDescriptor) : state.device.createRenderPipeline(mipDescriptor);
    state.hdr10PbrPipelineIdentity = Object.freeze({ ...identity }); return { ok: true };
  } catch { delete state.hdr10PbrPipeline; delete state.hdr10PbrMipPipeline; delete state.hdr10PbrPipelineIdentity; return fail("gpu_render_failed", "Fixed HDR10 PBR pipeline creation failed."); }
  function fail(code: GpuRuntimeFailure["code"], message: string): GpuPageScene3dGltfPbrHdr10PipelineOutput { return { ok: false, failure: { code, message } }; }
  function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
  function same(left: GpuPageScene3dGltfPbrHdr10PipelineIdentity | undefined, right: GpuPageScene3dGltfPbrHdr10PipelineIdentity): boolean { return !!left && left.abi === right.abi && left.pipelineImplementationSha256 === right.pipelineImplementationSha256 && left.resourceCeilingSha256 === right.resourceCeilingSha256; }
}
