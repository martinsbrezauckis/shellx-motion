import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export interface GpuPageComputeParticleMetrics {
  readonly pointRaster: "gpu-native-instanced";
  readonly positionEvaluation: "core-cpu-exact-time" | "gpu-fixed-analytic-time" | "mixed-core-cpu-and-gpu-fixed-analytic-time";
  readonly computeField: "not-used" | "fixed-analytic-v1";
  readonly computeParticleBufferSlots: number;
  readonly computeParticleBufferBytes: number;
  readonly computeParticleBufferHighWaterSlots: number;
  readonly computeParticleBufferHighWaterBytes: number;
  readonly adapterComputeParticleInstanceLimit: number;
  readonly computeParticleDispatches: number;
}

export type GpuPageComputeParticleInstallOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

/** Installs one fixed, pure, data-only analytic field compute pipeline. */
export async function installWebGpuPageSessionParticleCompute(): Promise<GpuPageComputeParticleInstallOutput> {
  type BufferFacade = { destroy?(): void };
  type ComputePipeline = { getBindGroupLayout(index: number): unknown };
  type Encoder = { beginComputePass(): { setPipeline(value: unknown): void; setBindGroup(index: number, value: unknown): void; dispatchWorkgroups(count: number): void; end(): void } };
  type Device = {
    createBuffer(value: unknown): BufferFacade;
    createShaderModule(value: unknown): unknown;
    createComputePipeline(value: unknown): ComputePipeline;
    /** Prefer this when exposed: synchronous pipeline creation can defer WGSL validation until submit. */
    createComputePipelineAsync?(value: unknown): Promise<ComputePipeline>;
    createBindGroup(value: unknown): unknown;
    queue: { writeBuffer(buffer: BufferFacade, offset: number, data: ArrayBuffer): void };
  };
  const fail = (message: string): GpuPageComputeParticleInstallOutput => ({ ok: false, failure: { code: "gpu_render_failed", message } });
  const MAX_PARTICLES = 131_072, MIN_PARTICLES = 100_000, INSTANCE_BYTES = 32, BUFFER_COUNT = 2, WORKGROUP_SIZE = 256;
  const browserGlobal = globalThis as unknown as { GPUBufferUsage?: Record<string, number>; __shellxMotionGpuSessionV1?: unknown };
  const usage = browserGlobal.GPUBufferUsage;
  const state = browserGlobal.__shellxMotionGpuSessionV1 as {
    device?: Device; limits?: { maxBufferSize?: number; maxStorageBufferBindingSize?: number }; computeParticles?: unknown;
  } | undefined;
  if (!state?.device || !usage) return fail("The persistent GPU page session cannot install fixed particle compute.");
  if (state.computeParticles) return { ok: true };
  if (![usage.STORAGE, usage.VERTEX, usage.COPY_DST, usage.UNIFORM].every((value) => typeof value === "number")) return fail("The persistent GPU page session does not expose fixed particle compute buffer usages.");
  const maxBufferSize = state.limits?.maxBufferSize;
  const maxStorage = state.limits?.maxStorageBufferBindingSize;
  const adapterComputeParticleInstanceLimit = typeof maxBufferSize === "number" && typeof maxStorage === "number"
    ? Math.min(MAX_PARTICLES, Math.floor(maxBufferSize / INSTANCE_BYTES), Math.floor(maxStorage / INSTANCE_BYTES)) : 0;
  const shader = `
struct Params { header: vec4<u32>, values: array<vec4<f32>, 14> }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> output: array<vec4<f32>>;
fn rnd(seed: u32, index: u32, channel: u32) -> f32 { var value = seed ^ ((index + 1u) * 0x9e3779b1u) ^ ((channel + 1u) * 0x85ebca6bu); value = value ^ (value >> 16u); value = value * 0x7feb352du; value = value ^ (value >> 15u); value = value * 0x846ca68bu; value = value ^ (value >> 16u); return f32(value) / 4294967296.0; }
fn clamp2(v: vec2<f32>) -> vec2<f32> { return clamp(v, vec2<f32>(-2.0), vec2<f32>(2.0)); }
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
 let index = invocation.x; let count = params.header.y; if (index >= count) { return; }
 let timing = params.values[0]; let dimensions = params.values[1]; let transform = params.values[2]; let origin = params.values[3]; let particle = params.values[4]; let physics = params.values[5];
 let phase = rnd(params.header.x,index,0u) * timing.z; let local = max(0.0,timing.x-timing.y); let age = (local + phase) % timing.z; let progress = age / timing.z;
 let angle = origin.w + (rnd(params.header.x,index,1u)-0.5)*physics.x; let speed = particle.z + rnd(params.header.x,index,2u)*(particle.w-particle.z); let size = particle.x + rnd(params.header.x,index,3u)*(particle.y-particle.x); let seconds = age/1000.0;
 let base = vec2<f32>(dimensions.x*0.5 + cos(angle)*speed*seconds,dimensions.y*0.5 + sin(angle)*speed*seconds + 0.5*physics.y*seconds*seconds);
 var deflection = vec2<f32>(0.0); let p2 = progress*progress;
 for (var sourceIndex=0u; sourceIndex<params.header.z; sourceIndex=sourceIndex+1u) { let a=params.values[8u+sourceIndex*2u]; let b=params.values[9u+sourceIndex*2u]; let delta=vec2<f32>(a.y,a.z)-base/vec2<f32>(dimensions.x,dimensions.y); let distance2=dot(delta,delta); if(distance2>0.0){let distance=sqrt(distance2);let magnitude=a.w*p2*(b.x*b.x/(distance2+b.x*b.x));let unit=delta/distance;if(a.x>0.5){deflection+=vec2<f32>(-unit.y,unit.x)*magnitude;}else{deflection+=unit*magnitude;}} }
 let center = base + clamp2(deflection)*vec2<f32>(dimensions.x,dimensions.y); let pivot=vec2<f32>(transform.x+origin.x,transform.y+origin.y); let placed=vec2<f32>(transform.x+origin.x+(center.x-origin.x)*transform.z,transform.y+origin.y+(center.y-origin.y)*transform.z); let rel=placed-pivot; let rotated=pivot+vec2<f32>(rel.x*cos(transform.w)-rel.y*sin(transform.w),rel.x*sin(transform.w)+rel.y*cos(transform.w)); let scaledSize=size*transform.z;
 let chosen=select(params.values[6],params.values[7],rnd(params.header.x,index,4u)>=0.5); let alpha=chosen.w*origin.z*select(1.0,max(0.0,1.0-progress),params.header.w!=0u); let outIndex=index*2u; output[outIndex]=vec4<f32>(rotated.x/dimensions.z*2.0-1.0,1.0-rotated.y/dimensions.w*2.0,scaledSize/dimensions.z*2.0,scaledSize/dimensions.w*2.0); output[outIndex+1u]=vec4<f32>(chosen.xyz*alpha,alpha);
}`;
  let pipeline: ComputePipeline | null = null;
  try {
    const module = state.device.createShaderModule({ code: shader });
    if (typeof module === "object" && module !== null && "getCompilationInfo" in module && typeof module.getCompilationInfo === "function") {
      const info = await module.getCompilationInfo() as { messages?: Array<{ type?: string; message?: string }> };
      const errors = info.messages?.filter((message) => message.type === "error").map((message) => message.message?.trim()).filter(Boolean) ?? [];
      if (errors.length > 0) return fail(`The persistent GPU page session fixed particle shader is invalid: ${errors.join("; ").slice(0, 512)}`);
    }
    const descriptor = { layout: "auto", compute: { module, entryPoint: "main" } };
    // Chrome may defer a synchronous pipeline's WGSL validation until the first
    // command-buffer submission. Awaiting the standard async form keeps an
    // invalid fixed shader from invalidating an otherwise valid frame and
    // being published as an all-black PNG.
    pipeline = state.device.createComputePipelineAsync
      ? await state.device.createComputePipelineAsync(descriptor)
      : state.device.createComputePipeline(descriptor);
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 512) : "unknown WebGPU validation error";
    return fail(`The persistent GPU page session could not create fixed particle compute: ${detail}`);
  }
  let buffers: BufferFacade[] = [], uniform: BufferFacade | null = null, bindGroups: unknown[] = [], count = 0, active = 0, dispatches = 0, highWaterSlots = 0, highWaterBytes = 0;
  const destroy = (): void => { for (const buffer of buffers) buffer.destroy?.(); uniform?.destroy?.(); buffers = []; uniform = null; bindGroups = []; count = 0; active = 0; };
  const ensure = (nextCount: number): void => {
    if (!Number.isInteger(nextCount) || nextCount < MIN_PARTICLES || nextCount > adapterComputeParticleInstanceLimit) throw new Error("GPU fixed particle compute exceeds the explicit adapter storage-buffer limit.");
    if (count === nextCount && uniform && buffers.length === BUFFER_COUNT) return;
    if (count !== 0) throw new Error("GPU fixed particle compute refuses a changing particle capacity inside one persistent session.");
    const bytes = nextCount * INSTANCE_BYTES;
    uniform = state.device!.createBuffer({ size: 240, usage: usage.UNIFORM | usage.COPY_DST });
    buffers = [state.device!.createBuffer({ size: bytes, usage: usage.STORAGE | usage.VERTEX | usage.COPY_DST }), state.device!.createBuffer({ size: bytes, usage: usage.STORAGE | usage.VERTEX | usage.COPY_DST })];
    bindGroups = buffers.map((buffer) => state.device!.createBindGroup({ layout: pipeline!.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform! } }, { binding: 1, resource: { buffer } }] })); count = nextCount; highWaterSlots = Math.max(highWaterSlots, buffers.length); highWaterBytes = Math.max(highWaterBytes, bytes * BUFFER_COUNT);
  };
  const render = (input: { count:number;seed:number;atMs:number;startMs:number;lifetimeMs:number;width:number;height:number;x:number;y:number;scale:number;originX:number;originY:number;rotationDeg:number;opacity:number;color:{r:number;g:number;b:number;a:number};secondaryColor:{r:number;g:number;b:number;a:number};minSize:number;maxSize:number;minSpeed:number;maxSpeed:number;direction:number;spread:number;gravity:number;fadeOut:boolean;sources:Array<{kind:"radial"|"vortex";centerX:number;centerY:number;strength:number;softening:number}> }, frameWidth: number, frameHeight: number, encoder: Encoder): BufferFacade => { ensure(input.count); const scalars=[input.atMs,input.startMs,input.lifetimeMs,input.width,input.height,input.x,input.y,input.scale,input.originX,input.originY,input.rotationDeg,input.opacity,input.minSize,input.maxSize,input.minSpeed,input.maxSpeed,input.direction,input.spread,input.gravity,frameWidth,frameHeight,input.color.r,input.color.g,input.color.b,input.color.a,input.secondaryColor.r,input.secondaryColor.g,input.secondaryColor.b,input.secondaryColor.a]; if(!scalars.every(Number.isFinite)||!Array.isArray(input.sources)||input.sources.length<1||input.sources.length>3||input.sources.some((source)=>!source||(source.kind!=="radial"&&source.kind!=="vortex")||![source.centerX,source.centerY,source.strength,source.softening].every(Number.isFinite))||!Number.isInteger(input.seed)||input.seed<0||input.seed>0xffff_ffff||typeof input.fadeOut!=="boolean")throw new Error("GPU fixed particle compute received an invalid admitted descriptor."); if (!uniform || bindGroups.length !== BUFFER_COUNT) throw new Error("GPU fixed particle compute did not retain its resources."); const data=new ArrayBuffer(240),meta=new Uint32Array(data,0,4),values=new Float32Array(data,16);meta.set([input.seed,input.count,input.sources.length,input.fadeOut?1:0]);values.set([input.atMs,input.startMs,input.lifetimeMs,0,input.width,input.height,frameWidth,frameHeight,input.x,input.y,input.scale,input.rotationDeg*Math.PI/180,input.originX,input.originY,input.opacity,input.direction*Math.PI/180,input.minSize,input.maxSize,input.minSpeed,input.maxSpeed,input.spread*Math.PI/180,input.gravity,0,0,input.color.r,input.color.g,input.color.b,input.color.a,input.secondaryColor.r,input.secondaryColor.g,input.secondaryColor.b,input.secondaryColor.a]);input.sources.forEach((source,index)=>values.set([source.kind==="vortex"?1:0,source.centerX,source.centerY,source.strength,source.softening,0,0,0],32+index*8)); state.device!.queue.writeBuffer(uniform, 0, data); const pass=encoder.beginComputePass(); pass.setPipeline(pipeline!); pass.setBindGroup(0,bindGroups[active]);pass.dispatchWorkgroups(Math.ceil(input.count/WORKGROUP_SIZE));pass.end();const result=buffers[active];active=(active+1)%BUFFER_COUNT;dispatches+=1;return result; };
  const snapshot = (): GpuPageComputeParticleMetrics => Object.freeze({ pointRaster:"gpu-native-instanced",positionEvaluation:dispatches>0?"gpu-fixed-analytic-time":"core-cpu-exact-time",computeField:dispatches>0?"fixed-analytic-v1":"not-used",computeParticleBufferSlots:buffers.length,computeParticleBufferBytes:count*INSTANCE_BYTES*buffers.length,computeParticleBufferHighWaterSlots:highWaterSlots,computeParticleBufferHighWaterBytes:highWaterBytes,adapterComputeParticleInstanceLimit,computeParticleDispatches:dispatches });
  state.computeParticles = { render, snapshot, destroy };
  return { ok: true };
}
