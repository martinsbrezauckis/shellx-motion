import type { GpuRuntimeFailure } from "./gpu-runtime-types";

/** Kept out of the legacy page catalog until the material-only route is atomically joined. */
export const GPU_PAGE_SCENE3D_GLTF_PBR_SDR_ABI = "shellx-motion/browser-scene3d-gltf-pbr-sdr@1" as const;

export interface GpuPageScene3dGltfPbrPipelineIdentity {
  readonly abi: typeof GPU_PAGE_SCENE3D_GLTF_PBR_SDR_ABI;
  readonly pipelineImplementationSha256: string;
  readonly resourceCeilingSha256: string;
}

export type GpuPageScene3dGltfPbrPipelineOutput = { readonly ok: true } | { readonly ok: false; readonly failure: GpuRuntimeFailure };

/** Installs fixed SDR PBR and mip-generation pipelines without changing the legacy scene3d slot. */
export async function installWebGpuPageSessionScene3dGltfPbrPipeline(identity: GpuPageScene3dGltfPbrPipelineIdentity): Promise<GpuPageScene3dGltfPbrPipelineOutput> {
  type Pipeline = { getBindGroupLayout(index: number): unknown };
  type Device = {
    createRenderPipeline(value: unknown): Pipeline;
    createRenderPipelineAsync?(value: unknown): Promise<Pipeline>;
    createShaderModule(value: { code: string }): unknown;
  };
  type State = {
    device: Device;
    gltfPbrPipeline?: Pipeline;
    gltfPbrMipPipeline?: Pipeline;
    gltfPbrPipelineIdentity?: GpuPageScene3dGltfPbrPipelineIdentity;
  };
  // This function is serialized into Playwright's page; keep its ABI literal self-contained.
  const ABI = "shellx-motion/browser-scene3d-gltf-pbr-sdr@1";
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: State };
  const state = browserGlobal.__shellxMotionGpuSessionV1;
  if (!state) return fail("gpu_device_unavailable", "The persistent GPU page session is unavailable for fixed glTF PBR setup.");
  if (!admitIdentity(identity)) return fail("gpu_render_failed", "The fixed glTF PBR pipeline requires its exact ABI and implementation identity.");
  if (state.gltfPbrPipeline || state.gltfPbrMipPipeline) {
    const current = state.gltfPbrPipelineIdentity;
    return current && sameIdentity(current, identity) && state.gltfPbrPipeline && state.gltfPbrMipPipeline
      ? { ok: true }
      : fail("gpu_render_failed", "The fixed glTF PBR pipeline identity changed during a retained page session.");
  }
  const pbrWgsl = `
struct ObjectUniform {
  model: mat4x4<f32>, viewProjection: mat4x4<f32>, baseColorFactor: vec4<f32>,
  emissiveMetallic: vec4<f32>, roughnessAmbient: vec4<f32>, lightDirectionIntensity: vec4<f32>, lightColor: vec4<f32>, cameraPosition: vec4<f32>
}
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) normal: vec3<f32>, @location(1) uv: vec2<f32>, @location(2) worldPosition: vec3<f32> }
@group(0) @binding(0) var<uniform> object: ObjectUniform;
@group(0) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(0) @binding(2) var baseColorSampler: sampler;
@vertex fn vs(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>) -> VertexOut {
  var output: VertexOut; let world = object.model * vec4<f32>(position, 1.0);
  output.position = object.viewProjection * world; output.normal = normalize((object.model * vec4<f32>(normal, 0.0)).xyz); output.uv = uv; output.worldPosition = world.xyz; return output;
}
fn distributionGgx(n: vec3<f32>, h: vec3<f32>, roughness: f32) -> f32 { let a = roughness * roughness; let a2 = a * a; let ndh = max(dot(n,h),0.0); let d = ndh * ndh * (a2 - 1.0) + 1.0; return a2 / max(3.14159265 * d * d, 0.0001); }
fn geometrySchlickGgx(ndv: f32, roughness: f32) -> f32 { let r = roughness + 1.0; let k = r * r / 8.0; return ndv / max(ndv * (1.0 - k) + k, 0.0001); }
fn geometrySmith(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32) -> f32 { return geometrySchlickGgx(max(dot(n,v),0.0),roughness) * geometrySchlickGgx(max(dot(n,l),0.0),roughness); }
fn fresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> { return f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - cosTheta, 5.0); }
fn linearToSrgb(linear: vec3<f32>) -> vec3<f32> { let low = linear * 12.92; let high = 1.055 * pow(max(linear,vec3<f32>(0.0)),vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055); return select(high,low,linear <= vec3<f32>(0.0031308)); }
@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> {
  let texel = textureSample(baseColorTexture, baseColorSampler, input.uv); let base = texel.rgb * object.baseColorFactor.rgb;
  let n = normalize(input.normal); let v = normalize(object.cameraPosition.xyz-input.worldPosition); let l = normalize(-object.lightDirectionIntensity.xyz); let h = normalize(v+l);
  let metallic = clamp(object.emissiveMetallic.w,0.0,1.0); let roughness = clamp(object.roughnessAmbient.x,0.04,1.0); let ndl = max(dot(n,l),0.0); let ndv = max(dot(n,v),0.0);
  let f0 = mix(vec3<f32>(0.04),base,vec3<f32>(metallic)); let f = fresnelSchlick(max(dot(h,v),0.0),f0); let ndf = distributionGgx(n,h,roughness); let g = geometrySmith(n,v,l,roughness);
  let specular = (ndf * g * f) / max(4.0 * ndv * ndl,0.0001); let kd = (vec3<f32>(1.0)-f) * (1.0-metallic);
  let direct = (kd * base / 3.14159265 + specular) * object.lightColor.rgb * object.lightDirectionIntensity.w * ndl;
  let ambient = kd * base * clamp(object.roughnessAmbient.y,0.0,1.0); let linear = max(direct + ambient + object.emissiveMetallic.rgb,vec3<f32>(0.0));
  // This ABI admits glTF alphaMode=OPAQUE only: sampled PNG alpha never affects compositing.
  return vec4<f32>(clamp(linearToSrgb(linear),vec3<f32>(0.0),vec3<f32>(1.0)), 1.0);
}`;
  const mipWgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
@group(0) @binding(0) var sourceTexture: texture_2d<f32>; @group(0) @binding(1) var sourceSampler: sampler;
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut { let positions = array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0)); let uvs = array<vec2<f32>,3>(vec2<f32>(0.0,1.0),vec2<f32>(2.0,1.0),vec2<f32>(0.0,-1.0)); var output: VertexOut; output.position=vec4<f32>(positions[index],0.0,1.0); output.uv=uvs[index]; return output; }
@fragment fn fs(input: VertexOut) -> @location(0) vec4<f32> { return textureSampleLevel(sourceTexture,sourceSampler,input.uv,0.0); }`;
  try {
    const pbrModule = state.device.createShaderModule({ code: pbrWgsl });
    const mipModule = state.device.createShaderModule({ code: mipWgsl });
    const pbrDescriptor = { layout: "auto", vertex: { module: pbrModule, entryPoint: "vs", buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }, { shaderLocation: 2, offset: 24, format: "float32x2" }] }] }, fragment: { module: pbrModule, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list", cullMode: "back" }, depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" } };
    const mipDescriptor = { layout: "auto", vertex: { module: mipModule, entryPoint: "vs" }, fragment: { module: mipModule, entryPoint: "fs", targets: [{ format: "rgba8unorm-srgb" }] }, primitive: { topology: "triangle-list" } };
    state.gltfPbrPipeline = state.device.createRenderPipelineAsync ? await state.device.createRenderPipelineAsync(pbrDescriptor) : state.device.createRenderPipeline(pbrDescriptor);
    state.gltfPbrMipPipeline = state.device.createRenderPipelineAsync ? await state.device.createRenderPipelineAsync(mipDescriptor) : state.device.createRenderPipeline(mipDescriptor);
    state.gltfPbrPipelineIdentity = Object.freeze({ ...identity });
    return { ok: true };
  } catch {
    delete state.gltfPbrPipeline; delete state.gltfPbrMipPipeline; delete state.gltfPbrPipelineIdentity;
    return fail("gpu_render_failed", "Fixed glTF PBR pipeline creation failed.");
  }

  function fail(code: GpuRuntimeFailure["code"], message: string): GpuPageScene3dGltfPbrPipelineOutput { return { ok: false, failure: { code, message } }; }
  function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
  function admitIdentity(value: unknown): value is GpuPageScene3dGltfPbrPipelineIdentity { return !!value && typeof value === "object" && (value as GpuPageScene3dGltfPbrPipelineIdentity).abi === ABI && hash((value as GpuPageScene3dGltfPbrPipelineIdentity).pipelineImplementationSha256) && hash((value as GpuPageScene3dGltfPbrPipelineIdentity).resourceCeilingSha256); }
  function sameIdentity(left: GpuPageScene3dGltfPbrPipelineIdentity, right: GpuPageScene3dGltfPbrPipelineIdentity): boolean { return left.abi === right.abi && left.pipelineImplementationSha256 === right.pipelineImplementationSha256 && left.resourceCeilingSha256 === right.resourceCeilingSha256; }
}
