import { describe,expect,it } from "vitest";
import { loadSchema,validateDocument } from "./validate";
import type { MotionDocument } from "./types";

function document(layers:MotionDocument["layers"]):MotionDocument{return{schema:"shellx-motion/motion@1",id:"groups",name:"Groups",durationMs:1000,fps:30,width:100,height:60,layers,assets:[],provenance:{sourceApp:"test",createdBy:"test"}};}

describe("Motion group validation",()=>{
  it("admits bounded nested local timelines",async()=>{
    const value=document([
      {id:"outer",type:"group",startMs:0,durationMs:1000,childLayerIds:["child","inner"]},
      {id:"child",type:"shape",shape:"rect",startMs:0,durationMs:1000},
      {id:"inner",type:"group",startMs:100,durationMs:800,childLayerIds:["orb"]},
      {id:"orb",type:"shape",shape:"ellipse",startMs:0,durationMs:800}
    ]);
    expect(await validateDocument(await loadSchema("motion"),value)).toEqual({ok:true});
  });
  it("rejects duplicate ownership, cycles and children outside the local timeline",async()=>{
    const value=document([
      {id:"a",type:"group",startMs:0,durationMs:500,childLayerIds:["b","leaf"]},
      {id:"b",type:"group",startMs:0,durationMs:500,childLayerIds:["a","leaf"]},
      {id:"leaf",type:"shape",shape:"rect",startMs:400,durationMs:200}
    ]);
    const result=await validateDocument(await loadSchema("motion"),value);expect(result.ok).toBe(false);if(result.ok)return;
    expect(result.errors.map((error)=>error.message).join("\n")).toMatch(/already owned|cycle|local timeline/);
  });
});
