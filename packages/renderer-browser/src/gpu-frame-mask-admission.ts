import type { InternalGpuLayerMask } from "./gpu-runtime-types";

export function admitGpuLayerMask(value: unknown): InternalGpuLayerMask | null | undefined {
  if (value === undefined) return null;
  if (!record(value) || Object.keys(value).some((key) => !["shape", "x", "y", "width", "height", "radius", "rotationDeg", "pivotX", "pivotY", "inverted", "opacity", "featherPx"].includes(key))) return undefined;
  if (value.shape !== "rect" && value.shape !== "ellipse" && value.shape !== "triangle") return undefined;
  const x=coordinate(value.x),y=coordinate(value.y),width=range(value.width,Number.MIN_VALUE,4_096),height=range(value.height,Number.MIN_VALUE,4_096),radius=range(value.radius,0,4_096),rotationDeg=range(value.rotationDeg,-1_000_000,1_000_000),pivotX=coordinate(value.pivotX),pivotY=coordinate(value.pivotY),opacity=range(value.opacity,0,1),featherPx=range(value.featherPx,0,128);
  if ([x,y,width,height,radius,rotationDeg,pivotX,pivotY,opacity,featherPx].some((entry)=>entry===null) || typeof value.inverted !== "boolean" || radius! > Math.min(width!, height!) / 2 || (value.shape === "triangle" && radius !== 0)) return undefined;
  return { shape:value.shape,x:x!,y:y!,width:width!,height:height!,radius:radius!,rotationDeg:rotationDeg!,pivotX:pivotX!,pivotY:pivotY!,inverted:value.inverted,opacity:opacity!,featherPx:featherPx! };
}

function record(value: unknown): value is Record<string,unknown> { return Boolean(value)&&typeof value==="object"&&!Array.isArray(value); }
function range(value: unknown, minimum: number, maximum: number): number|null { return typeof value==="number"&&Number.isFinite(value)&&value>=minimum&&value<=maximum?value:null; }
function coordinate(value: unknown): number|null { return range(value,-1_000_000,1_000_000); }
