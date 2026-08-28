import type { InternalGpuFrameDraw } from "./gpu-runtime-types";

/** Independently rechecks exact nested group spans at the browser boundary. */
export function admitGpuGroupGrammar(draws: readonly InternalGpuFrameDraw[]): { count: number; maxDepth: number } | null {
  let count=0,maxDepth=0;const stack:Array<{id:string;endIndex:number}>=[];
  for(let index=0;index<draws.length;index+=1){
    const draw=draws[index];if(stack.length&&index>stack[stack.length-1].endIndex)return null;
    if(draw.kind==="groupStart"){const endIndex=index+draw.drawCount+1;if(endIndex>=draws.length||++count>64)return null;stack.push({id:draw.id,endIndex});maxDepth=Math.max(maxDepth,stack.length);if(maxDepth>5)return null;continue;}
    if(draw.kind==="effectModule"){const open=stack[stack.length-1],close=draws[index+1];if(stack.length!==1||!open||open.id!==draw.scopeGroupDrawId||draw.scopeGroupDrawId!==`${draw.scopeGroupId}.group`||close?.kind!=="groupEnd"||close.groupId!==open.id)return null;continue;}
    if(draw.kind!=="groupEnd")continue;const open=stack.pop();if(!open||open.endIndex!==index||open.id!==draw.groupId)return null;
  }
  return stack.length?null:{count,maxDepth};
}
