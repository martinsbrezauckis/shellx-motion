import type { GpuMaterialIntent } from "./gpu-frame-intent";
import { gpuMaterialUniformValues, isMotionGpuMaterialUniform } from "./gpu-material";
import { parseGpuSceneColor } from "./gpu-scene-color";
import { gpuSceneEffects, gpuSceneHasOnlySupportedEffects } from "./gpu-scene-effects";
import type { GpuScene2dFailure } from "./gpu-scene-2d-plan";
import type { MotionDocument, MotionLayer } from "./types";

type Result={ok:true;draw:GpuMaterialIntent}|{ok:false;failure:GpuScene2dFailure};
const TRANSFORM_FIELDS=new Set(["x","y","width","height","opacity","scale","rotation","originX","originY"]);
const KEYFRAMES=new Set(["transform.x","transform.y","transform.width","transform.height","transform.originX","transform.originY","transform.scale","transform.rotation","opacity","effects.blur","effects.brightness","effects.contrast","effects.saturate","effects.grayscale"]);

/** Admits only fixed named materials; package GLSL remains outside this boundary. */
export function validateGpuSceneMaterialLayer(layer:MotionLayer):GpuScene2dFailure|null{
  if(!layer.shader?.gpuMaterial)return failure(layer,"gpu_unsupported_layer",`GPU shader layer ${layer.id} requires a fixed gpuMaterial preset.`);
  const invalidKeyframe=Object.keys(layer.keyframes??{}).some((key)=>!KEYFRAMES.has(key)&&!(key.startsWith("shader.uniforms.")&&isMotionGpuMaterialUniform(key.slice("shader.uniforms.".length))));
  if(Object.keys(layer.style??{}).length||layer.keying||layer.crop||layer.pathReveal||layer.textFit||layer.transitions||Object.keys(layer.transform??{}).some((key)=>!TRANSFORM_FIELDS.has(key))||invalidKeyframe)return failure(layer,"gpu_unsupported_feature",`GPU shader layer ${layer.id} accepts fixed material uniforms, transform, depth, opacity, blend, effects and masks only.`);
  if(!gpuMaterialUniformValues(layer.shader.uniforms))return failure(layer,"gpu_unsupported_feature",`GPU shader layer ${layer.id} has unsupported fixed-material uniforms.`);
  return gpuSceneHasOnlySupportedEffects(layer)?null:failure(layer,"gpu_unsupported_effect",`GPU shader layer ${layer.id} uses an unsupported post effect.`);
}

/** Lowers one named material to a fixed eight-float Motion-owned shader ABI. */
export function compileGpuSceneMaterial(layer:MotionLayer,motion:MotionDocument,atMs:number):Result{
  const shader=layer.shader,material=shader?.gpuMaterial;if(!shader||!material)return fail(layer,"GPU fixed material data is missing.");
  const transform=layer.transform??{},width=positive(transform.width??layer.width??motion.width),height=positive(transform.height??layer.height??motion.height),scale=positive(transform.scale??1),x=finite(transform.x??0),y=finite(transform.y??0),rotationDeg=finite(transform.rotation??0),opacity=unit(layer.opacity??transform.opacity??1);
  if(width===null||height===null||scale===null||x===null||y===null||rotationDeg===null||opacity===null)return fail(layer,"GPU fixed material transform or opacity is invalid.");
  const originX=finite(transform.originX??width/2),originY=finite(transform.originY??height/2);if(originX===null||originY===null)return fail(layer,"GPU fixed material pivot is invalid.");
  const colors=material.colors.map(parseGpuSceneColor);if(colors.some((color)=>!color))return fail(layer,"GPU fixed material colors must be hexadecimal or transparent.");
  const parameters=gpuMaterialUniformValues(shader.uniforms);if(!parameters)return fail(layer,"GPU fixed material uniforms are unsupported or outside their bounds.");
  return{ok:true,draw:{kind:"material",id:layer.id,blendMode:layer.blendMode??"normal",effects:gpuSceneEffects(layer),preset:material.preset,seed:shader.seed,timeSeconds:Math.max(0,atMs-layer.startMs)/1_000,x:x+originX-originX*scale,y:y+originY-originY*scale,width:width*scale,height:height*scale,rotationDeg,pivotX:x+originX,pivotY:y+originY,opacity,colors:colors as GpuMaterialIntent["colors"],parameters}};
}
function finite(value:unknown):number|null{return typeof value==="number"&&Number.isFinite(value)&&Math.abs(value)<=1_000_000?value:null;}
function positive(value:unknown):number|null{const number=finite(value);return number!==null&&number>0&&number<=4_096?number:null;}
function unit(value:unknown):number|null{return typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=1?value:null;}
function fail(layer:MotionLayer,message:string):{ok:false;failure:GpuScene2dFailure}{return{ok:false,failure:{code:"gpu_unsupported_feature",message,layerId:layer.id}};}
function failure(layer:MotionLayer,code:GpuScene2dFailure["code"],message:string):GpuScene2dFailure{return{code,message,layerId:layer.id};}
