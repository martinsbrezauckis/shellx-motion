import type { GpuEnvironmentIntent, GpuRgba } from "./gpu-frame-intent-types";

type Composite = Pick<GpuEnvironmentIntent, "blendMode" | "effects" | "mask">;
type Refuse = (message: string) => never;
const PARAMETER_RANGES: Record<GpuEnvironmentIntent["environmentKind"], Array<[number, number]>> = {
  rain: [[0,1],[-2,2],[.1,5],[.1,2],[1,4],[.15,.9],[0,1],[0,1],[0,1],[0,1],[0,1],[0,1],[0,1],[0,0],[0,0],[0,0]],
  water: [[.1,.9],[.1,20],[0,1],[.05,5],[-Math.PI,Math.PI],[0,1],[1,4],[0,1],[0,1],[0,1],[0,1],[0,1],[0,1],[0,0],[0,0],[0,0]],
  snow: [[0,1],[.05,3],[-2,2],[0,1],[.1,3],[1,4],[0,1],[.1,.9],[0,1],[0,1],[0,1],[0,1],[0,1],[0,0],[0,0],[0,0]],
  fog: [[0,1],[.01,3],[.1,12],[0,1],[0,1],[1,4],[0,1],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0],[0,0]],
};

/** Re-admits a fixed-data environment before it contributes to a GPU plan. */
export function readGpuEnvironmentIntent(value:Record<string,unknown>,id:string,composite:Composite,refuse:Refuse):GpuEnvironmentIntent {
  const environmentKind=enumValue(value.environmentKind,["rain","water","snow","fog"] as const,`${id}.environmentKind`,refuse);
  const mode=enumValue(value.mode,["scene","overlay"] as const,`${id}.mode`,refuse);
  const seed=integer(value.seed,`${id}.seed`,0,0xffff_ffff,refuse),timeSeconds=finite(value.timeSeconds,`${id}.timeSeconds`,0,86_400,refuse);
  const x=finite(value.x,`${id}.x`,-1_000_000,1_000_000,refuse),y=finite(value.y,`${id}.y`,-1_000_000,1_000_000,refuse);
  const width=finite(value.width,`${id}.width`,Number.MIN_VALUE,4_096,refuse),height=finite(value.height,`${id}.height`,Number.MIN_VALUE,4_096,refuse);
  const rotationDeg=finite(value.rotationDeg,`${id}.rotationDeg`,-1_000_000,1_000_000,refuse),pivotX=finite(value.pivotX,`${id}.pivotX`,-1_000_000,1_000_000,refuse),pivotY=finite(value.pivotY,`${id}.pivotY`,-1_000_000,1_000_000,refuse),opacity=finite(value.opacity,`${id}.opacity`,0,1,refuse);
  const sceneResourceId=optionalId(value.sceneResourceId,`${id}.sceneResourceId`,refuse),effectMaskResourceId=optionalId(value.effectMaskResourceId,`${id}.effectMaskResourceId`,refuse);
  if(!Array.isArray(value.colors)||value.colors.length!==5)refuse(`${id}.colors must contain five RGBA values.`);
  const colors=value.colors.map((entry,index)=>rgba(entry,`${id}.colors[${index}]`,refuse)) as GpuEnvironmentIntent["colors"];
  if(!Array.isArray(value.parameters)||value.parameters.length!==16)refuse(`${id}.parameters must contain 16 fixed values.`);
  const parameters=value.parameters.map((entry,index)=>finite(entry,`${id}.parameters[${index}]`,...PARAMETER_RANGES[environmentKind][index],refuse)) as GpuEnvironmentIntent["parameters"];
  return {kind:"environment",id,...composite,environmentKind,mode,seed,timeSeconds,x,y,width,height,rotationDeg,pivotX,pivotY,opacity,...(sceneResourceId?{sceneResourceId}:{}),...(effectMaskResourceId?{effectMaskResourceId}:{}),colors,parameters};
}
function record(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
function finite(value:unknown,name:string,min:number,max:number,refuse:Refuse):number{if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max)refuse(`${name} must be finite in ${min}..${max}.`);return value;}
function integer(value:unknown,name:string,min:number,max:number,refuse:Refuse):number{if(!Number.isInteger(value)||Number(value)<min||Number(value)>max)refuse(`${name} must be an integer in ${min}..${max}.`);return Number(value);}
function optionalId(value:unknown,name:string,refuse:Refuse):string|undefined{if(value===undefined)return undefined;if(typeof value!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))refuse(`${name} is invalid.`);return value;}
function enumValue<const T extends readonly string[]>(value:unknown,values:T,name:string,refuse:Refuse):T[number]{if(typeof value!=="string"||!values.includes(value))refuse(`${name} is unsupported.`);return value as T[number];}
function rgba(value:unknown,name:string,refuse:Refuse):GpuRgba{if(!record(value))refuse(`${name} must be RGBA.`);return{r:finite(value.r,`${name}.r`,0,1,refuse),g:finite(value.g,`${name}.g`,0,1,refuse),b:finite(value.b,`${name}.b`,0,1,refuse),a:finite(value.a,`${name}.a`,0,1,refuse)};}
