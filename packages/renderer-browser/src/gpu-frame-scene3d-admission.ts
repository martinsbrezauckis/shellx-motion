import type { InternalGpuFrameDraw, InternalGpuRgba } from "./gpu-runtime-types";

export interface Scene3dAdmissionTotals { scenes:number; objects:number; vertices:number; indices:number }

/** Reconstructs only the bounded fixed-data subset admitted for WebGPU 3D. */
export function admitGpuScene3d(value:Record<string,unknown>,id:string,composite:Record<string,unknown>,totals:Scene3dAdmissionTotals):Extract<InternalGpuFrameDraw,{kind:"scene3d"}>|null {
  if(++totals.scenes>4)return null;
  const background=rgba(value.background),opacity=range(value.opacity,0,1),viewProjection=matrix(value.viewProjection),lightDirection=tuple3(value.lightDirection,-1,1),lightColor=rgba(value.lightColor),ambient=range(value.ambient,0,1),intensity=range(value.intensity,0,4);
  if(!background||opacity===null||!viewProjection||!lightDirection||Math.hypot(...lightDirection)<0.000001||!lightColor||ambient===null||intensity===null||!Array.isArray(value.objects)||value.objects.length<1||value.objects.length>16)return null;
  const ids=new Set<string>();const objects:Extract<InternalGpuFrameDraw,{kind:"scene3d"}>["objects"]=[];
  for(const raw of value.objects){if(!record(raw))return null;const objectId=safeId(raw.id);if(!objectId||ids.has(objectId))return null;ids.add(objectId);if(!Array.isArray(raw.vertices)||raw.vertices.length<18||raw.vertices.length%6!==0)return null;const vertices:number[]=[];for(let index=0;index<raw.vertices.length;index+=1){const parsed=range(raw.vertices[index],index%6<3?-10_000:-1.001,index%6<3?10_000:1.001);if(parsed===null)return null;vertices.push(parsed);}const vertexCount=vertices.length/6;if(vertexCount>4_096||!Array.isArray(raw.indices)||raw.indices.length<3||raw.indices.length>24_576||raw.indices.length%3!==0)return null;const indices:number[]=[];for(const entry of raw.indices){const parsed=integer(entry,0,vertexCount-1);if(parsed===null)return null;indices.push(parsed);}const model=matrix(raw.model),color=rgba(raw.color),emissive=range(raw.emissive,0,1);if(!model||!color||emissive===null)return null;totals.objects+=1;totals.vertices+=vertexCount;totals.indices+=indices.length;if(totals.objects>32||totals.vertices>8_192||totals.indices>49_152)return null;objects.push({id:objectId,vertices,indices,model,color,emissive});}
  return {kind:"scene3d",id,...composite,background,opacity,viewProjection,lightDirection,lightColor,ambient,intensity,objects} as Extract<InternalGpuFrameDraw,{kind:"scene3d"}>;
}
function record(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
function safeId(value:unknown):string|null{return typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)?value:null;}
function range(value:unknown,min:number,max:number):number|null{return typeof value==="number"&&Number.isFinite(value)&&value>=min&&value<=max?value:null;}
function integer(value:unknown,min:number,max:number):number|null{return typeof value==="number"&&Number.isInteger(value)&&value>=min&&value<=max?value:null;}
function matrix(value:unknown):number[]|null{if(!Array.isArray(value)||value.length!==16)return null;const out=value.map((entry)=>range(entry,-1_000_000,1_000_000));return out.some((entry)=>entry===null)?null:out as number[];}
function tuple3(value:unknown,min:number,max:number):[number,number,number]|null{if(!Array.isArray(value)||value.length!==3)return null;const out=value.map((entry)=>range(entry,min,max));return out.some((entry)=>entry===null)?null:out as [number,number,number];}
function rgba(value:unknown):InternalGpuRgba|null{if(!record(value))return null;const r=range(value.r,0,1),g=range(value.g,0,1),b=range(value.b,0,1),a=range(value.a,0,1);return r===null||g===null||b===null||a===null?null:{r,g,b,a};}
