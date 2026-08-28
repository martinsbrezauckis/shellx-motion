import type { GpuMaterialIntent, GpuRgba } from "./gpu-frame-intent-types";

type Composite = Pick<GpuMaterialIntent, "blendMode" | "effects" | "mask">;
type Refuse = (message: string) => never;
const PARAMETER_RANGES: Array<[number, number]> = [[-4,4],[.1,20],[0,2],[1,4],[0,2],[0,2],[0,1],[-1_000,1_000]];

/** Re-admits fixed material data before it contributes to a GPU frame plan. */
export function readGpuMaterialIntent(value:Record<string,unknown>,id:string,composite:Composite,refuse:Refuse):GpuMaterialIntent {
  const preset=enumValue(value.preset,["plasma","hologram","energy","noise"] as const,`${id}.preset`,refuse);
  const seed=integer(value.seed,`${id}.seed`,0,0xffff_ffff,refuse),timeSeconds=finite(value.timeSeconds,`${id}.timeSeconds`,0,86_400,refuse);
  const x=finite(value.x,`${id}.x`,-1_000_000,1_000_000,refuse),y=finite(value.y,`${id}.y`,-1_000_000,1_000_000,refuse);
  const width=finite(value.width,`${id}.width`,Number.MIN_VALUE,4_096,refuse),height=finite(value.height,`${id}.height`,Number.MIN_VALUE,4_096,refuse);
  const rotationDeg=finite(value.rotationDeg,`${id}.rotationDeg`,-1_000_000,1_000_000,refuse),pivotX=finite(value.pivotX,`${id}.pivotX`,-1_000_000,1_000_000,refuse),pivotY=finite(value.pivotY,`${id}.pivotY`,-1_000_000,1_000_000,refuse),opacity=finite(value.opacity,`${id}.opacity`,0,1,refuse);
  if(!Array.isArray(value.colors)||value.colors.length!==3)refuse(`${id}.colors must contain three RGBA values.`);
  const colors=value.colors.map((entry,index)=>rgba(entry,`${id}.colors[${index}]`,refuse)) as GpuMaterialIntent["colors"];
  if(!Array.isArray(value.parameters)||value.parameters.length!==8)refuse(`${id}.parameters must contain eight fixed values.`);
  const parameters=value.parameters.map((entry,index)=>finite(entry,`${id}.parameters[${index}]`,...PARAMETER_RANGES[index],refuse)) as GpuMaterialIntent["parameters"];
  return {kind:"material",id,...composite,preset,seed,timeSeconds,x,y,width,height,rotationDeg,pivotX,pivotY,opacity,colors,parameters};
}
function record(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
function finite(value:unknown,name:string,min:number,max:number,refuse:Refuse):number{if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max)refuse(`${name} must be finite in ${min}..${max}.`);return value;}
function integer(value:unknown,name:string,min:number,max:number,refuse:Refuse):number{if(!Number.isInteger(value)||Number(value)<min||Number(value)>max)refuse(`${name} must be an integer in ${min}..${max}.`);return Number(value);}
function enumValue<const T extends readonly string[]>(value:unknown,values:T,name:string,refuse:Refuse):T[number]{if(typeof value!=="string"||!values.includes(value))refuse(`${name} is unsupported.`);return value as T[number];}
function rgba(value:unknown,name:string,refuse:Refuse):GpuRgba{if(!record(value))refuse(`${name} must be RGBA.`);return{r:finite(value.r,`${name}.r`,0,1,refuse),g:finite(value.g,`${name}.g`,0,1,refuse),b:finite(value.b,`${name}.b`,0,1,refuse),a:finite(value.a,`${name}.a`,0,1,refuse)};}
