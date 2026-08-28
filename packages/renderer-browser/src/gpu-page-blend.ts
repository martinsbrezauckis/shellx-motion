import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageBlendPipelineOutput = { ok: true } | { ok: false; failure: GpuRuntimeFailure };

/** Installs the fixed CSS-compatible blend compositor used between retained frame targets. */
export async function installWebGpuPageSessionBlendPipeline(): Promise<GpuPageBlendPipelineOutput> {
  type Device = { createRenderPipeline(value: unknown): unknown; createRenderPipelineAsync?(value: unknown): Promise<unknown>; createShaderModule(value: { code: string }): unknown };
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as { device: Device; blendPipeline?: unknown } | undefined;
  if (!state) return { ok: false, failure: { code: "gpu_device_unavailable", message: "The persistent GPU page session is unavailable for blend setup." } };
  const wgsl = `
struct VertexOut { @builtin(position) position: vec4<f32> }
struct CompositeState { mode: vec4<f32>, effects: vec4<f32>, groupA: vec4<f32>, groupB: vec4<f32> }
@group(0) @binding(0) var backdropTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> composite: CompositeState;
@vertex fn vs(@builtin(vertex_index) index:u32)->VertexOut { let positions=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));var o:VertexOut;o.position=vec4<f32>(positions[index],0.0,1.0);return o; }
fn lum(c:vec3<f32>)->f32 { return dot(c,vec3<f32>(0.3,0.59,0.11)); }
fn sat(c:vec3<f32>)->f32 { return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b); }
fn clip_color(c0:vec3<f32>)->vec3<f32> { var c=c0;let l=lum(c);let n=min(min(c.r,c.g),c.b);let x=max(max(c.r,c.g),c.b);if(n<0.0){c=vec3<f32>(l)+(c-vec3<f32>(l))*l/(l-n);}if(x>1.0){c=vec3<f32>(l)+(c-vec3<f32>(l))*(1.0-l)/(x-l);}return c; }
fn set_lum(c:vec3<f32>,l:f32)->vec3<f32> { return clip_color(c+vec3<f32>(l-lum(c))); }
fn set_sat(c:vec3<f32>,s:f32)->vec3<f32> { var o=vec3<f32>(0.0);if(c.r<=c.g){if(c.g<=c.b){o=vec3<f32>(0.0,(c.g-c.r)*s/max(c.b-c.r,0.000001),s);}else if(c.r<=c.b){o=vec3<f32>(0.0,s,(c.b-c.r)*s/max(c.g-c.r,0.000001));}else{o=vec3<f32>((c.r-c.b)*s/max(c.g-c.b,0.000001),s,0.0);}}else{if(c.r<=c.b){o=vec3<f32>((c.r-c.g)*s/max(c.b-c.g,0.000001),0.0,s);}else if(c.g<=c.b){o=vec3<f32>(s,0.0,(c.b-c.g)*s/max(c.r-c.g,0.000001));}else{o=vec3<f32>(s,(c.g-c.b)*s/max(c.r-c.b,0.000001),0.0);}}return o; }
fn overlay_channel(b:f32,s:f32)->f32 { return select(2.0*b*s,1.0-2.0*(1.0-b)*(1.0-s),b>0.5); }
fn soft_light_channel(b:f32,s:f32)->f32 { let d=select(((16.0*b-12.0)*b+4.0)*b,sqrt(b),b>0.25);return select(b-(1.0-2.0*s)*b*(1.0-b),b+(2.0*s-1.0)*(d-b),s>0.5); }
fn apply_color_effects(input:vec3<f32>,effect:vec4<f32>)->vec3<f32> { var c=input*effect.x;c=(c-vec3<f32>(0.5))*effect.y+vec3<f32>(0.5);let sl=dot(c,vec3<f32>(0.2126,0.7152,0.0722));c=vec3<f32>(sl)+(c-vec3<f32>(sl))*effect.z;let gl=dot(c,vec3<f32>(0.2126,0.7152,0.0722));return clamp(mix(c,vec3<f32>(gl),effect.w),vec3<f32>(0.0),vec3<f32>(1.0)); }
fn source_pixel(p:vec2<f32>)->vec4<f32> { var q=p;if(composite.groupB.w>0.5){let pivot=composite.groupB.xy;let shifted=p-pivot-composite.groupA.xy;let c=cos(composite.groupA.w);let s=sin(composite.groupA.w);q=vec2<f32>(c*shifted.x+s*shifted.y,-s*shifted.x+c*shifted.y)/composite.groupA.z+pivot;}let dims=vec2<f32>(textureDimensions(sourceTexture));if(any(q<vec2<f32>(0.0))||any(q>=dims)){return vec4<f32>(0.0);}return textureLoad(sourceTexture,vec2<i32>(floor(q)),0)*composite.groupB.z; }
fn blend_rgb(index:f32,b:vec3<f32>,s:vec3<f32>)->vec3<f32> { if(index<1.5){return b*s;}if(index<2.5){return b+s-b*s;}if(index<3.5){return vec3<f32>(overlay_channel(b.r,s.r),overlay_channel(b.g,s.g),overlay_channel(b.b,s.b));}if(index<4.5){return min(b,s);}if(index<5.5){return max(b,s);}if(index<6.5){return min(vec3<f32>(1.0),b/max(vec3<f32>(0.000001),vec3<f32>(1.0)-s));}if(index<7.5){return vec3<f32>(1.0)-min(vec3<f32>(1.0),(vec3<f32>(1.0)-b)/max(s,vec3<f32>(0.000001)));}if(index<8.5){return vec3<f32>(overlay_channel(s.r,b.r),overlay_channel(s.g,b.g),overlay_channel(s.b,b.b));}if(index<9.5){return vec3<f32>(soft_light_channel(b.r,s.r),soft_light_channel(b.g,s.g),soft_light_channel(b.b,s.b));}if(index<10.5){return abs(b-s);}if(index<11.5){return b+s-2.0*b*s;}if(index<12.5){return set_lum(set_sat(s,sat(b)),lum(b));}if(index<13.5){return set_lum(set_sat(b,sat(s)),lum(b));}if(index<14.5){return set_lum(s,lum(b));}return set_lum(b,lum(s)); }
@fragment fn fs(input:VertexOut)->@location(0) vec4<f32> { let p=vec2<i32>(input.position.xy);let backdrop=textureLoad(backdropTexture,p,0);let source=source_pixel(input.position.xy);let b=backdrop.rgb/max(backdrop.a,0.000001);let s=apply_color_effects(source.rgb/max(source.a,0.000001),composite.effects);let adjustedSource=vec4<f32>(s*source.a,source.a);if(composite.mode.x>15.5){return min(backdrop+adjustedSource,vec4<f32>(1.0));}let mixed=select(s,blend_rgb(composite.mode.x,b,s),composite.mode.x>0.5);let alpha=source.a+backdrop.a-source.a*backdrop.a;let rgb=(1.0-source.a)*backdrop.rgb+(1.0-backdrop.a)*adjustedSource.rgb+backdrop.a*source.a*mixed;return vec4<f32>(rgb,alpha); }
`;
  try {
    const module = state.device.createShaderModule({ code: wgsl });
    state.blendPipeline = state.device.createRenderPipelineAsync
      ? await state.device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } })
      : state.device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    return { ok: true };
  } catch { return { ok: false, failure: { code: "gpu_render_failed", message: "Persistent WebGPU blend pipeline creation failed." } }; }
}
