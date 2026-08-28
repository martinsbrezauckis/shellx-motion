import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installWebGpuPageSessionMaskPipeline } from "./gpu-page-mask";

describe("installWebGpuPageSessionMaskPipeline", () => {
  it("installs only a fixed geometric mask shader", async () => {
    const createShaderModule=vi.fn((value:{code:string})=>value);const createRenderPipeline=vi.fn(()=>({getBindGroupLayout:()=>({})}));
    const install=runInContext(`(${installWebGpuPageSessionMaskPipeline.toString()})`,createContext({__shellxMotionGpuSessionV1:{device:{createShaderModule,createRenderPipeline}}})) as typeof installWebGpuPageSessionMaskPipeline;
    expect(await install()).toEqual({ok:true});
    const code=createShaderModule.mock.calls[0][0].code;expect(code).toContain("roundedBox");expect(code).toContain("triangleDistance");expect(code).toContain("segmentDistance");expect(code).toContain("textureLoad");expect(code).toContain("var strength=coverage*mask.options.z");expect(code).toContain("return textureLoad(source,vec2<i32>(position.xy),0)*strength");expect(code).not.toContain("eval");
    expect(createRenderPipeline).toHaveBeenCalledOnce();
  });
});
