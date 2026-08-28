import type { GpuEnvironmentIntent } from "./gpu-frame-intent";
import { MAX_FOG_DEPTH_LAYERS, MAX_RAIN_DEPTH_LAYERS, MAX_SNOW_DEPTH_LAYERS, MAX_WATER_WAVE_OCTAVES } from "./environment";
import { parseGpuSceneColor } from "./gpu-scene-color";
import { gpuSceneEffects, gpuSceneHasOnlySupportedEffects } from "./gpu-scene-effects";
import { gpuSceneImageAssetRef } from "./gpu-scene-media";
import { SUPPORTED_KEYFRAME_TARGETS } from "./keyframe-targets";
import type { GpuScene2dFailure, GpuScene2dImageResource } from "./gpu-scene-2d-plan";
import type { MotionDocument, MotionEnvironment, MotionLayer } from "./types";

type Result={ok:true;draw:GpuEnvironmentIntent}|{ok:false;failure:GpuScene2dFailure};
const TRANSFORM_FIELDS=new Set(["x","y","width","height","opacity","scale","rotation","originX","originY"]);

/** Independently admits only the authored surface consumed by the fixed environment compiler. */
export function validateGpuSceneEnvironmentLayer(layer:MotionLayer):GpuScene2dFailure|null{
  if(!layer.environment)return failure(layer,"gpu_unsupported_layer",`GPU environment layer ${layer.id} requires environment data.`);
  const invalidKeyframe=Object.keys(layer.keyframes??{}).some((key)=>!(["transform.x","transform.y","transform.width","transform.height","transform.originX","transform.originY","transform.scale","transform.rotation","opacity","effects.blur","effects.brightness","effects.contrast","effects.saturate","effects.grayscale"].includes(key))&&!(key.startsWith("environment.")&&SUPPORTED_KEYFRAME_TARGETS.has(key)));
  if(Object.keys(layer.style??{}).length||layer.keying||layer.crop||layer.pathReveal||layer.textFit||layer.transitions||layer.depth!==undefined||Object.keys(layer.transform??{}).some((key)=>!TRANSFORM_FIELDS.has(key))||invalidKeyframe)return failure(layer,"gpu_unsupported_feature",`GPU environment layer ${layer.id} accepts bounded environment keyframes, transform, opacity, blend, effects and masks only.`);
  return gpuSceneHasOnlySupportedEffects(layer)?null:failure(layer,"gpu_unsupported_effect",`GPU environment layer ${layer.id} uses an unsupported post effect.`);
}

/** Lowers authored rain, water, snow and fog to fixed Motion-owned shader inputs. */
export function compileGpuSceneEnvironment(layer:MotionLayer,motion:MotionDocument,atMs:number,resources:ReadonlyMap<string,GpuScene2dImageResource>|undefined):Result{
  const environment=layer.environment;if(!environment)return fail(layer,"GPU environment data is missing.");
  const transform=layer.transform??{},width=positive(transform.width??layer.width??motion.width),height=positive(transform.height??layer.height??motion.height),scale=positive(transform.scale??1),x=finite(transform.x??0),y=finite(transform.y??0),rotationDeg=finite(transform.rotation??0),opacity=unit(layer.opacity??transform.opacity??1);
  if(width===null||height===null||scale===null||x===null||y===null||rotationDeg===null||opacity===null)return fail(layer,"GPU environment transform or opacity is invalid.");
  const originX=finite(transform.originX??width/2),originY=finite(transform.originY??height/2);if(originX===null||originY===null)return fail(layer,"GPU environment pivot is invalid.");
  const sceneResourceId=environmentResourceId(environment.sceneSourceLayerId,motion,resources),effectMaskResourceId=environmentResourceId(environment.effectMaskLayerId,motion,resources);
  if(environment.sceneSourceLayerId&&!sceneResourceId)return fail(layer,"GPU environment scene source has no prepared exact image resource.");
  if(environment.effectMaskLayerId&&!effectMaskResourceId)return fail(layer,"GPU environment effect mask has no prepared exact image resource.");
  const common={kind:"environment" as const,id:layer.id,blendMode:layer.blendMode??"normal",effects:gpuSceneEffects(layer),environmentKind:environment.kind,mode:environment.mode,seed:environment.seed,timeSeconds:Math.max(0,atMs-layer.startMs)/1_000,x:x+originX-originX*scale,y:y+originY-originY*scale,width:width*scale,height:height*scale,rotationDeg,pivotX:x+originX,pivotY:y+originY,opacity,...(sceneResourceId?{sceneResourceId}:{}),...(effectMaskResourceId?{effectMaskResourceId}:{})};
  const packed=pack(environment);if(!packed)return fail(layer,"GPU environment contains unsupported colors or parameters.");
  return{ok:true,draw:{...common,...packed}};
}

function pack(environment:MotionEnvironment):Pick<GpuEnvironmentIntent,"colors"|"parameters">|null{
  const colors=(values:string[])=>{const parsed=values.map(parseGpuSceneColor);return parsed.some((value)=>!value)?null:parsed as GpuEnvironmentIntent["colors"];};
  if(environment.kind==="rain")return packed(colors([environment.backgroundColor,environment.color,environment.lightColor,environment.accentColor,"#00000000"]),[environment.intensity,environment.wind,environment.dropSpeed,environment.dropLength,qualityCap(environment.depthLayers,environment.quality,MAX_RAIN_DEPTH_LAYERS),environment.ground.horizon,environment.ground.wetness,environment.ground.roughness,environment.ground.rippleAmount,environment.ground.splashAmount,environment.ground.reflectionStrength,environment.atmosphere.mist,environment.atmosphere.lensDroplets,0,0,0]);
  if(environment.kind==="water")return packed(colors([environment.backgroundColor,environment.shallowColor,environment.deepColor,environment.reflectionColor,environment.foamColor]),[environment.surface.horizon,environment.surface.waveScale,environment.surface.waveHeight,environment.surface.waveSpeed,environment.surface.direction*Math.PI/180,environment.surface.choppiness,qualityCap(environment.surface.waveOctaves,environment.quality,MAX_WATER_WAVE_OCTAVES),environment.optics.reflectionStrength,environment.optics.refractionStrength,environment.optics.fresnel,environment.optics.caustics,environment.optics.clarity,environment.optics.foam,0,0,0]);
  if(environment.kind==="snow")return packed(colors([environment.backgroundColor,environment.snowColor,environment.shadowColor,environment.lightColor,"#00000000"]),[environment.fall.intensity,environment.fall.speed,environment.fall.wind,environment.fall.turbulence,environment.fall.flakeSize,qualityCap(environment.fall.depthLayers,environment.quality,MAX_SNOW_DEPTH_LAYERS),environment.fall.focusFalloff,environment.ground.horizon,environment.ground.accumulation,environment.ground.drift,environment.ground.contactAmount,environment.atmosphere.haze,environment.atmosphere.depthFade,0,0,0]);
  return packed(colors([environment.backgroundColor,environment.fogColor,environment.lightColor,"#00000000","#00000000"]),[environment.fog.density,environment.fog.speed,environment.fog.scale,environment.fog.turbulence,environment.fog.height,qualityCap(environment.fog.depthLayers,environment.quality,MAX_FOG_DEPTH_LAYERS),environment.fog.lightStrength,0,0,0,0,0,0,0,0,0]);
}
function packed(colors:GpuEnvironmentIntent["colors"]|null,parameters:number[]):Pick<GpuEnvironmentIntent,"colors"|"parameters">|null{return colors&&parameters.length===16&&parameters.every(Number.isFinite)?{colors,parameters:parameters as GpuEnvironmentIntent["parameters"]}:null;}
function qualityCap(value:number,quality:MotionEnvironment["quality"],maximum:number):number{return Math.min(value,quality==="preview"?2:quality==="balanced"?3:maximum);}
function environmentResourceId(layerId:string|undefined,motion:MotionDocument,resources:ReadonlyMap<string,GpuScene2dImageResource>|undefined):string|undefined{if(!layerId)return undefined;const layer=motion.layers.find((candidate)=>candidate.id===layerId);const assetRef=layer?gpuSceneImageAssetRef(motion,layer):null;return assetRef?resources?.get(assetRef)?.resourceId:undefined;}
function finite(value:unknown):number|null{return typeof value==="number"&&Number.isFinite(value)&&Math.abs(value)<=1_000_000?value:null;}
function positive(value:unknown):number|null{const number=finite(value);return number!==null&&number>0&&number<=4_096?number:null;}
function unit(value:unknown):number|null{return typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=1?value:null;}
function fail(layer:MotionLayer,message:string):{ok:false;failure:GpuScene2dFailure}{return{ok:false,failure:{code:"gpu_unsupported_feature",message,layerId:layer.id}};}
function failure(layer:MotionLayer,code:GpuScene2dFailure["code"],message:string):GpuScene2dFailure{return{code,message,layerId:layer.id};}
