import type { InternalGpuFrameDraw, InternalGpuRgba } from "./gpu-runtime-types";

const RANGES:Record<string,Array<[number,number]>>={
  rain:[[0,1],[-2,2],[.1,5],[.1,2],[1,4],[.15,.9],[0,1],[0,1],[0,1],[0,1],[0,1],[0,1],[0,1],[0,0],[0,0],[0,0]],
  water:[[.1,.9],[.1,20],[0,1],[.05,5],[-Math.PI,Math.PI],[0,1],[1,4],[0,1],[0,1],[0,1],[0,1],[0,1],[0,1],[0,0],[0,0],[0,0]],
  snow:[[0,1],[.05,3],[-2,2],[0,1],[.1,3],[1,4],[0,1],[.1,.9],[0,1],[0,1],[0,1],[0,1],[0,1],[0,0],[0,0],[0,0]],
  fog:[[0,1],[.01,3],[.1,12],[0,1],[0,1],[1,4],[0,1],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0]],
};

/** Reconstructs only fixed bounded environment inputs; package shader fields are discarded. */
export function admitGpuEnvironment(value:Record<string,unknown>,id:string,composite:Record<string,unknown>):Extract<InternalGpuFrameDraw,{kind:"environment"}>|null{
  const environmentKind=enumValue(value.environmentKind,["rain","water","snow","fog"] as const),mode=enumValue(value.mode,["scene","overlay"] as const),seed=integer(value.seed,0,0xffff_ffff),timeSeconds=range(value.timeSeconds,0,86_400),x=range(value.x,-1_000_000,1_000_000),y=range(value.y,-1_000_000,1_000_000),width=range(value.width,Number.MIN_VALUE,4_096),height=range(value.height,Number.MIN_VALUE,4_096),rotationDeg=range(value.rotationDeg,-1_000_000,1_000_000),pivotX=range(value.pivotX,-1_000_000,1_000_000),pivotY=range(value.pivotY,-1_000_000,1_000_000),opacity=range(value.opacity,0,1);
  if(!environmentKind||!mode||seed===null||timeSeconds===null||x===null||y===null||width===null||height===null||rotationDeg===null||pivotX===null||pivotY===null||opacity===null)return null;
  const sceneResourceId=optionalId(value.sceneResourceId),effectMaskResourceId=optionalId(value.effectMaskResourceId);if(sceneResourceId===null||effectMaskResourceId===null)return null;
  if(!Array.isArray(value.colors)||value.colors.length!==5||!Array.isArray(value.parameters)||value.parameters.length!==16)return null;
  const colors=value.colors.map(rgba);if(colors.some((entry)=>entry===null))return null;const parameters=value.parameters.map((entry,index)=>range(entry,...RANGES[environmentKind][index]));if(parameters.some((entry)=>entry===null))return null;
  return{kind:"environment",id,...composite,environmentKind,mode,seed,timeSeconds,x,y,width,height,rotationDeg,pivotX,pivotY,opacity,...(sceneResourceId?{sceneResourceId}:{}),...(effectMaskResourceId?{effectMaskResourceId}:{}),colors:colors as Extract<InternalGpuFrameDraw,{kind:"environment"}>["colors"],parameters:parameters as Extract<InternalGpuFrameDraw,{kind:"environment"}>["parameters"]} as Extract<InternalGpuFrameDraw,{kind:"environment"}>;
}
function record(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
function range(value:unknown,min:number,max:number):number|null{return typeof value==="number"&&Number.isFinite(value)&&value>=min&&value<=max?value:null;}
function integer(value:unknown,min:number,max:number):number|null{return typeof value==="number"&&Number.isInteger(value)&&value>=min&&value<=max?value:null;}
function optionalId(value:unknown):string|null|undefined{return value===undefined?undefined:typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)?value:null;}
function enumValue<const T extends readonly string[]>(value:unknown,values:T):T[number]|null{return typeof value==="string"&&values.includes(value)?value as T[number]:null;}
function rgba(value:unknown):InternalGpuRgba|null{if(!record(value))return null;const r=range(value.r,0,1),g=range(value.g,0,1),b=range(value.b,0,1),a=range(value.a,0,1);return r===null||g===null||b===null||a===null?null:{r,g,b,a};}
