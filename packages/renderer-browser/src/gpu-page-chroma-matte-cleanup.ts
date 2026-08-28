import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageChromaMatteCleanupPipelineOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

/**
 * Installs the closed Motion chroma-matte cleanup chain. It mirrors
 * compositing-keying's ordered CPU cleanup: denoise, grow/shrink, choke,
 * feather, then clip/source-alpha capping. The package supplies only bounded
 * scalar settings; all WGSL, sampling strategy, and passes are host-owned.
 */
export async function installWebGpuPageSessionChromaMatteCleanupPipeline(): Promise<GpuPageChromaMatteCleanupPipelineOutput> {
  type Device = { createRenderPipeline(value: unknown): unknown; createRenderPipelineAsync?(value: unknown): Promise<unknown>; createShaderModule(value: { code: string }): unknown };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; chromaMatteSeedPipeline?: unknown; chromaMatteCleanupPipeline?: unknown; chromaMattePresentPipeline?: unknown; additiveChromaMattePresentPipeline?: unknown } | undefined;
  if (!state) return { ok: false, failure: { code: "gpu_device_unavailable", message: "The persistent GPU page session is unavailable for chroma matte cleanup." } };
  const seedWgsl = `
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> }
struct Key { color: vec4<f32>, controls: vec4<f32>, spill: vec4<f32> }
@group(0) @binding(0) var imageSampler: sampler; @group(0) @binding(1) var imageTexture: texture_2d<f32>; @group(0) @binding(2) var<uniform> key: Key;
@vertex fn vs(@location(0) position: vec2<f32>, @location(1) uv: vec2<f32>, @location(2) opacity: f32) -> VertexOut { var o: VertexOut; o.position=vec4<f32>(position,0.0,1.0);o.uv=uv;return o; }
fn chroma(c:vec3<f32>)->vec2<f32>{return vec2<f32>(-0.168736*c.r-0.331264*c.g+0.5*c.b,0.5*c.r-0.418688*c.g-0.081312*c.b);}
fn luminance(c:vec3<f32>)->f32{return dot(c,vec3<f32>(0.2126,0.7152,0.0722));}
fn keyed_rgb(c:vec3<f32>,foreground:f32)->vec3<f32>{let dominant=select(select(2u,1u,key.color.g>=key.color.b),0u,key.color.r>=key.color.g&&key.color.r>=key.color.b);let balance=key.spill.x;let spillWeight=1.0-foreground;let edge=key.spill.y*spillWeight;let amount=key.controls.w*spillWeight;var o=c;if(dominant==0u){let neutral=mix(c.g,c.b,(balance+1.0)*0.5);let reduction=max(0.0,c.r-neutral)*clamp(amount+edge,0.0,1.0);o.r-=reduction;if(edge>0.0){let correction=reduction*edge*0.35;o.g+=correction*(1.0-balance)*0.5;o.b+=correction*(1.0+balance)*0.5;}}else if(dominant==1u){let neutral=mix(c.r,c.b,(balance+1.0)*0.5);let reduction=max(0.0,c.g-neutral)*clamp(amount+edge,0.0,1.0);o.g-=reduction;if(edge>0.0){let correction=reduction*edge*0.35;o.r+=correction*(1.0-balance)*0.5;o.b+=correction*(1.0+balance)*0.5;}}else{let neutral=mix(c.r,c.g,(balance+1.0)*0.5);let reduction=max(0.0,c.b-neutral)*clamp(amount+edge,0.0,1.0);o.b-=reduction;if(edge>0.0){let correction=reduction*edge*0.35;o.r+=correction*(1.0-balance)*0.5;o.g+=correction*(1.0+balance)*0.5;}}return clamp(o,vec3<f32>(0.0),vec3<f32>(1.0));}
@fragment fn fs(input:VertexOut)->@location(0) vec4<f32>{let sampled=textureSample(imageTexture,imageSampler,input.uv);let distance=length(chroma(sampled.rgb)-chroma(key.color.rgb))/1.5;let threshold=key.controls.x*(0.75+key.controls.z*0.25*luminance(sampled.rgb));let foreground=smoothstep(threshold,threshold+max(0.0001,key.controls.y),distance);return vec4<f32>(keyed_rgb(sampled.rgb,foreground),foreground*sampled.a);}
`;
  const cleanupWgsl = `
struct Fullscreen { @builtin(position) position: vec4<f32> }
struct Cleanup { mode: f32, radius: f32, grow: f32, blackClip: f32, whiteClip: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(1) var inputTexture: texture_2d<f32>; @group(0) @binding(2) var originalTexture: texture_2d<f32>; @group(0) @binding(3) var<uniform> cleanup: Cleanup;
@vertex fn vs(@builtin(vertex_index) index:u32)->Fullscreen{let p=array<vec2<f32>,3>(vec2<f32>(-1.0,-3.0),vec2<f32>(3.0,1.0),vec2<f32>(-1.0,1.0));var o:Fullscreen;o.position=vec4<f32>(p[index],0.0,1.0);return o;}
fn clamp_coord(coord:vec2<i32>,dimensions:vec2<i32>)->vec2<i32>{return clamp(coord,vec2<i32>(0),dimensions-vec2<i32>(1));}
fn rounded(value:f32)->f32{return round(clamp(value,0.0,1.0)*255.0)/255.0;}
fn box_alpha(coord:vec2<i32>,dimensions:vec2<i32>,horizontal:bool,radius:i32)->f32{var sum=0.0;var count=0.0;var offset=-32;loop{if(offset>32){break;}if(abs(offset)<=radius){let delta=select(vec2<i32>(0,offset),vec2<i32>(offset,0),horizontal);sum+=textureLoad(inputTexture,clamp_coord(coord+delta,dimensions),0).a;count+=1.0;}offset+=1;}return rounded(sum/max(1.0,count));}
fn extrema_alpha(coord:vec2<i32>,dimensions:vec2<i32>,horizontal:bool,radius:i32,grow:bool)->f32{var result=select(1.0,0.0,grow);var offset=-16;loop{if(offset>16){break;}if(abs(offset)<=radius){let delta=select(vec2<i32>(0,offset),vec2<i32>(offset,0),horizontal);let value=textureLoad(inputTexture,clamp_coord(coord+delta,dimensions),0).a;result=select(min(result,value),max(result,value),grow);}offset+=1;}return result;}
@fragment fn fs(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{let dimensions=vec2<i32>(textureDimensions(inputTexture));let coord=clamp_coord(vec2<i32>(position.xy),dimensions);let original=textureLoad(originalTexture,coord,0);let radius=i32(cleanup.radius);var alpha=textureLoad(inputTexture,coord,0).a;if(cleanup.mode==0.0){alpha=box_alpha(coord,dimensions,true,radius);}else if(cleanup.mode==1.0){let blurred=box_alpha(coord,dimensions,false,radius);let difference=abs(original.a-blurred);alpha=select(rounded(original.a*0.75+blurred*0.25),blurred,difference>=48.0/255.0);}else if(cleanup.mode==2.0){alpha=extrema_alpha(coord,dimensions,true,radius,cleanup.grow>0.5);}else if(cleanup.mode==3.0){alpha=extrema_alpha(coord,dimensions,false,radius,cleanup.grow>0.5);}else if(cleanup.mode==4.0){alpha=box_alpha(coord,dimensions,true,radius);}else if(cleanup.mode==5.0){alpha=box_alpha(coord,dimensions,false,radius);}else{let span=cleanup.whiteClip-cleanup.blackClip;alpha=rounded((alpha-cleanup.blackClip)/span);}return vec4<f32>(original.rgb,alpha);}
`;
  const presentWgsl = `
struct Fullscreen { @builtin(position) position: vec4<f32> }
struct Present { opacity:f32, pad0:f32, pad1:f32, pad2:f32 }
@group(0) @binding(0) var seedTexture:texture_2d<f32>; @group(0) @binding(1) var matteTexture:texture_2d<f32>; @group(0) @binding(2) var<uniform> present:Present;
@vertex fn vs(@builtin(vertex_index) index:u32)->Fullscreen{let p=array<vec2<f32>,3>(vec2<f32>(-1.0,-3.0),vec2<f32>(3.0,1.0),vec2<f32>(-1.0,1.0));var o:Fullscreen;o.position=vec4<f32>(p[index],0.0,1.0);return o;}
@fragment fn fs(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{let dimensions=vec2<i32>(textureDimensions(seedTexture));let coord=clamp(vec2<i32>(position.xy),vec2<i32>(0),dimensions-vec2<i32>(1));let seed=textureLoad(seedTexture,coord,0);let cleaned=textureLoad(matteTexture,coord,0).a;let alpha=min(cleaned,seed.a)*present.opacity;return vec4<f32>(seed.rgb*alpha,alpha);}
`;
  try {
    const seed = state.device.createShaderModule({ code: seedWgsl }); const cleanup = state.device.createShaderModule({ code: cleanupWgsl }); const present = state.device.createShaderModule({ code: presentWgsl });
    const vertex = { module: seed, entryPoint: "vs", buffers: [{ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x2" }, { shaderLocation: 2, offset: 16, format: "float32" }] }] };
    const full = { module: cleanup, entryPoint: "vs" };
    const blend = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } };
    const additive = { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } };
    const createPipeline = (descriptor: unknown): Promise<unknown> => state.device.createRenderPipelineAsync ? state.device.createRenderPipelineAsync(descriptor) : Promise.resolve(state.device.createRenderPipeline(descriptor));
    state.chromaMatteSeedPipeline = await createPipeline({ layout: "auto", vertex, fragment: { module: seed, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    state.chromaMatteCleanupPipeline = await createPipeline({ layout: "auto", vertex: full, fragment: { module: cleanup, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    state.chromaMattePresentPipeline = await createPipeline({ layout: "auto", vertex: { module: present, entryPoint: "vs" }, fragment: { module: present, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend }] }, primitive: { topology: "triangle-list" } });
    state.additiveChromaMattePresentPipeline = await createPipeline({ layout: "auto", vertex: { module: present, entryPoint: "vs" }, fragment: { module: present, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend: additive }] }, primitive: { topology: "triangle-list" } });
    return { ok: true };
  } catch { return { ok: false, failure: { code: "gpu_render_failed", message: "The fixed GPU chroma matte-cleanup pipelines could not be created." } }; }
}
