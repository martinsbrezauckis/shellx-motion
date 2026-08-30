import { isSupportedMotionColorString, MAX_MOTION_COLOR_STRING_LENGTH } from "./color";
import { GPU_MATERIAL_PRESETS, gpuMaterialUniformRule, isMotionGpuMaterialPreset, isMotionGpuMaterialUniform } from "./gpu-material";
import { PUBLIC_SCHEMA_EXTENSION_COMMENT } from "./motion-public-schema-environments";

export function buildGpuMaterialPublicSchema():Record<string,unknown>{return{
  type:"object",required:["preset","colors"],
  properties:{preset:{enum:GPU_MATERIAL_PRESETS},colors:{type:"array",minItems:3,maxItems:3,items:{type:"string",minLength:1,maxLength:MAX_MOTION_COLOR_STRING_LENGTH}}},
  $comment:"A fixed Motion-owned WebGPU material. Package GLSL remains the browser fallback and never crosses the WebGPU execution boundary. "+PUBLIC_SCHEMA_EXTENSION_COMMENT
};}

/** Adds semantic fixed-material failures without widening the legacy GLSL contract. */
export function validateGpuMaterialExtension(shader:Record<string,unknown>,path:string,errors:Array<{path:string;message:string}>):void{
  if(shader.gpuMaterial===undefined)return;const material=record(shader.gpuMaterial);
  if(!material){errors.push({path:`${path}/shader/gpuMaterial`,message:"must be an object"});return;}
  if(!isMotionGpuMaterialPreset(material.preset))errors.push({path:`${path}/shader/gpuMaterial/preset`,message:"must name a supported Motion-owned GPU material"});
  if(!Array.isArray(material.colors)||material.colors.length!==3||material.colors.some((color)=>!isSupportedMotionColorString(color)))errors.push({path:`${path}/shader/gpuMaterial/colors`,message:"must contain exactly three supported colors"});
  const uniforms=record(shader.uniforms)??{};
  for(const[name,value]of Object.entries(uniforms)){if(!isMotionGpuMaterialUniform(name)){errors.push({path:`${path}/shader/uniforms/${name}`,message:"is not supported by fixed GPU materials"});continue;}const[minimum,maximum]=gpuMaterialUniformRule(name);if(typeof value!=="number"||!Number.isFinite(value)||value<minimum||value>maximum)errors.push({path:`${path}/shader/uniforms/${name}`,message:`must be between ${minimum} and ${maximum} for fixed GPU materials`});}
}
function record(value:unknown):Record<string,unknown>|null{return typeof value==="object"&&value!==null&&!Array.isArray(value)?Object.fromEntries(Object.entries(value)):null;}
