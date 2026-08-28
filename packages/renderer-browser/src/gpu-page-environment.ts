import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export type GpuPageEnvironmentPipelineOutput={ok:true}|{ok:false;failure:GpuRuntimeFailure};

/** Installs the fixed Motion-owned rain, water, snow and fog pipeline. */
export async function installWebGpuPageSessionEnvironmentPipeline():Promise<GpuPageEnvironmentPipelineOutput>{
  type Pipeline={getBindGroupLayout(index:number):unknown};
  type Device={createRenderPipeline(value:unknown):Pipeline;createRenderPipelineAsync?(value:unknown):Promise<Pipeline>;createShaderModule(value:{code:string}):unknown};
  const browserGlobal=globalThis as unknown as {__shellxMotionGpuSessionV1?:unknown};
  const state=browserGlobal.__shellxMotionGpuSessionV1 as {device:Device;environmentPipeline?:Pipeline;additiveEnvironmentPipeline?:Pipeline}|undefined;
  if(!state)return{ok:false,failure:{code:"gpu_device_unavailable",message:"The persistent GPU page session is unavailable for environment setup."}};
  const wgsl=`
struct EnvironmentUniform {
  frame:vec4<f32>, box:vec4<f32>, transform:vec4<f32>, header:vec4<f32>,
  color0:vec4<f32>, color1:vec4<f32>, color2:vec4<f32>, color3:vec4<f32>, color4:vec4<f32>,
  param0:vec4<f32>, param1:vec4<f32>, param2:vec4<f32>, param3:vec4<f32>
}
struct VertexOut{@builtin(position) position:vec4<f32>}
@group(0) @binding(0) var imageSampler:sampler;
@group(0) @binding(1) var sceneTexture:texture_2d<f32>;
@group(0) @binding(2) var maskTexture:texture_2d<f32>;
@group(0) @binding(3) var<uniform> env:EnvironmentUniform;
@vertex fn vs(@builtin(vertex_index) vertex:u32)->VertexOut{let p=array<vec2<f32>,3>(vec2<f32>(-1.0,-1.0),vec2<f32>(3.0,-1.0),vec2<f32>(-1.0,3.0));var o:VertexOut;o.position=vec4<f32>(p[vertex],0.0,1.0);return o;}
fn hash21(p:vec2<f32>)->f32{return fract(sin(dot(p,vec2<f32>(127.1,311.7))+env.frame.w*17.17)*43758.5453);}
fn noise(p:vec2<f32>)->f32{let i=floor(p);let f=fract(p);let u=f*f*(vec2<f32>(3.0)-2.0*f);return mix(mix(hash21(i),hash21(i+vec2<f32>(1,0)),u.x),mix(hash21(i+vec2<f32>(0,1)),hash21(i+vec2<f32>(1,1)),u.x),u.y);}
fn fbm(p0:vec2<f32>,layers:f32)->f32{var p=p0;var amplitude=.5;var value=0.0;for(var i=0;i<4;i=i+1){if(f32(i)>=layers){break;}value+=noise(p)*amplitude;p=p*2.03+vec2<f32>(13.7,7.9);amplitude*=.5;}return value;}
fn rain(uv:vec2<f32>)->vec4<f32>{
  let intensity=env.param0.x;var drops=0.0;
  for(var i=0;i<4;i=i+1){if(f32(i)>=env.param1.x){break;}let depth=1.0+f32(i)*.65;let grid=vec2<f32>(46.0/depth,13.0/depth);let travel=env.frame.z*env.param0.z*(1.2+f32(i)*.27);let q=uv*grid+vec2<f32>(travel*env.param0.y,-travel);let cell=floor(q);let local=fract(q)-vec2<f32>(.5);let jitter=hash21(cell+vec2<f32>(f32(i)*19.0))-.5;let streak=smoothstep(.055/depth,0.0,abs(local.x-jitter*.7))*smoothstep(.52,.52-env.param0.w*.32,abs(local.y));drops+=streak/depth;}
  let horizon=env.param1.y;let ground=smoothstep(horizon,horizon+.3,uv.y);let ripple=sin((length(fract(uv*vec2<f32>(17,8)+vec2<f32>(env.frame.z*.4))-vec2<f32>(.5))*70.0)-env.frame.z*8.0)*env.param2.x*ground*.08;let splash=smoothstep(.94,1.0,noise(vec2<f32>(uv.x*31.0,env.frame.z*5.0+floor(uv.y*12.0))))*env.param2.y*ground;let mist=fbm(uv*4.0+vec2<f32>(env.frame.z*.05,0),3.0)*env.param2.w*.35;let lens=smoothstep(.96,1.0,noise(uv*11.0+vec2<f32>(env.frame.w)))*env.param3.x*.3;let effect=clamp(drops*intensity+mist+lens+ripple+splash,0.0,1.0);let wet=mix(env.color0.rgb,env.color2.rgb,vec3<f32>(ground*env.param1.z*.18))+mix(env.color3.rgb,env.color4.rgb,vec3<f32>(splash))*env.param2.z*(1.0-env.param1.w*.7)*ground*.08;return vec4<f32>(mix(wet,env.color1.rgb,vec3<f32>(effect)),clamp(effect*.9+ground*env.param1.z,0.0,1.0));
}
fn water(uv:vec2<f32>)->vec4<f32>{
  let horizon=env.param0.x;let angle=env.param1.x;let direction=vec2<f32>(cos(angle),sin(angle));var wave=0.0;var amplitude=1.0;var scale=env.param0.y;
  for(var i=0;i<4;i=i+1){if(f32(i)>=env.param1.z){break;}let phase=dot(uv,direction)*scale+env.frame.z*env.param0.w*(1.0+f32(i)*.31);wave+=sin(phase+noise(uv*scale+vec2<f32>(f32(i)*7.0))*env.param1.y*3.0)*amplitude;amplitude*=.5;scale*=1.87;}wave*=env.param0.z;
  let waterMask=smoothstep(horizon-.02,horizon+.02,uv.y);let crest=smoothstep(.55,.95,wave*.5+.5)*env.param3.x;let depth=clamp((uv.y-horizon)/max(.001,1.0-horizon)+wave*env.param2.x*.08,0.0,1.0);var color=mix(env.color1.rgb,env.color2.rgb,vec3<f32>(depth*env.param2.w));color=mix(color,env.color3.rgb,vec3<f32>(pow(1.0-depth,1.0+env.param2.y*4.0)*env.param1.w));color+=env.color4.rgb*crest;let caustic=pow(max(0.0,sin(wave*5.0+env.frame.z*2.0)),8.0)*env.param2.z*.18;color+=vec3<f32>(caustic);return vec4<f32>(mix(env.color0.rgb,color,vec3<f32>(waterMask)),waterMask);
}
fn snow(uv:vec2<f32>)->vec4<f32>{
  var flakes=0.0;for(var i=0;i<4;i=i+1){if(f32(i)>=env.param1.y){break;}let depth=1.0+f32(i)*.7;let cells=vec2<f32>(18.0/depth,12.0/depth);let q=uv*cells+vec2<f32>(env.frame.z*env.param0.z+sin(env.frame.z+uv.y*8.0)*env.param0.w,-env.frame.z*env.param0.y);let cell=floor(q);let local=fract(q)-vec2<f32>(.5);let offset=vec2<f32>(hash21(cell)-.5,hash21(cell+vec2<f32>(31.0))-.5)*.7;let radius=length(local-offset);flakes+=smoothstep(.12*env.param1.x/depth,0.0,radius)*(1.0-env.param1.z*f32(i)/4.0)*(1.0-env.param3.x*f32(i)/4.0);}
  let ground=smoothstep(env.param1.w-.03,env.param1.w+.08,uv.y);let contact=smoothstep(.08,0.0,abs(uv.y-env.param1.w))*env.param2.z;let drift=fbm(vec2<f32>(uv.x*8.0+env.param2.y*3.0,0),3.0)*env.param2.x;let haze=fbm(uv*3.0+vec2<f32>(env.frame.z*.03),3.0)*env.param2.w;let coverage=clamp(flakes*env.param0.x+ground*(env.param2.x+drift*.2)+haze*.25,0.0,1.0);let shaded=mix(env.color2.rgb,env.color1.rgb,vec3<f32>(clamp(flakes+ground-contact*.25,0.0,1.0)));return vec4<f32>(mix(env.color0.rgb,shaded,vec3<f32>(coverage))+env.color3.rgb*haze*.08,coverage);
}
fn fog(uv:vec2<f32>)->vec4<f32>{let layers=env.param1.y;let drift=vec2<f32>(env.frame.z*env.param0.y*.08,0);let warp=(noise(uv*2.0+drift)-.5)*env.param0.w;let volume=fbm(uv*env.param0.z+drift+vec2<f32>(warp,-warp),layers);let height=smoothstep(1.0,env.param1.x,uv.y);let density=clamp((volume*.65+.35)*env.param0.x*height,0.0,1.0);let shaft=pow(max(0.0,1.0-distance(uv,vec2<f32>(.72,.18))*1.4),3.0)*env.param1.z;return vec4<f32>(mix(env.color0.rgb,env.color1.rgb,density)+env.color2.rgb*shaft*.18,density);}
@fragment fn fs(input:VertexOut)->@location(0) vec4<f32>{
  let p=input.position.xy;let pivot=env.transform.yz;let c=cos(-env.transform.x);let s=sin(-env.transform.x);let d=p-pivot;let q=vec2<f32>(d.x*c-d.y*s,d.x*s+d.y*c)+pivot;let uv=(q-env.box.xy)/env.box.zw;if(any(uv<vec2<f32>(0))||any(uv>vec2<f32>(1))){discard;}
  let generated=select(select(rain(uv),water(uv),env.header.x>.5),select(snow(uv),fog(uv),env.header.x>2.5),env.header.x>1.5);let scene=textureSample(sceneTexture,imageSampler,uv);let hasScene=env.header.z>.5;let mask=select(1.0,textureSample(maskTexture,imageSampler,uv).a,env.header.w>.5);let base=select(env.color0,scene,hasScene);var straight:vec4<f32>;
  if(env.header.y>.5){straight=vec4<f32>(generated.rgb,generated.a*mask);}else{straight=vec4<f32>(mix(base.rgb,generated.rgb,vec3<f32>(generated.a*mask)),max(base.a,generated.a*mask));}
  let alpha=clamp(straight.a*env.transform.w,0.0,1.0);return vec4<f32>(clamp(straight.rgb,vec3<f32>(0),vec3<f32>(1))*alpha,alpha);
}`;
  try{
    const module=state.device.createShaderModule({code:wgsl});
    const create=(descriptor:unknown):Promise<Pipeline>=>state.device.createRenderPipelineAsync?state.device.createRenderPipelineAsync(descriptor):Promise.resolve(state.device.createRenderPipeline(descriptor));
    const descriptor={layout:"auto",vertex:{module,entryPoint:"vs"},fragment:{module,entryPoint:"fs",targets:[{format:"rgba8unorm"}]},primitive:{topology:"triangle-list"}};
    const additiveDescriptor={...descriptor,fragment:{...descriptor.fragment,targets:[{format:"rgba16float",blend:{color:{srcFactor:"one",dstFactor:"one",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one",operation:"add"}}}]}};
    const [environmentPipeline,additiveEnvironmentPipeline]=await Promise.all([create(descriptor),create(additiveDescriptor)]);
    state.environmentPipeline=environmentPipeline;state.additiveEnvironmentPipeline=additiveEnvironmentPipeline;return{ok:true};
  }
  catch{return{ok:false,failure:{code:"gpu_render_failed",message:"Persistent WebGPU environment pipeline creation failed."}};}
}
