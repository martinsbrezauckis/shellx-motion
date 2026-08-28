import { describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import type { GpuEffectModuleUseAuthority } from "@shellx-motion/renderer-browser";
import { debugCommandContract } from "./command-metadata.js";
import { runSegmentedFinalDebugRender, segmentedFinalToolPolicy } from "./domains/render-segmented-final.js";
import { runStreamedFinalDebugRender, streamedFinalToolPolicy } from "./domains/render-streaming-final.js";

const LINEAGE = {
  schema: "shellx-motion/package-render-lineage@1" as const,
  manifestSha256: "a".repeat(64),
  motionSha256: "b".repeat(64),
};

describe("Debug GPU final module-use authority", () => {
  it("injects the server-owned opaque authority into direct and segmented GPU policies", () => {
    const authority = Object.freeze({}) as GpuEffectModuleUseAuthority;
    const context = { gpuEffectModuleUseAuthority: authority };
    expect(streamedFinalToolPolicy(context, "gpu").gpu).toEqual({ effectModuleUseAuthority: authority });
    expect(segmentedFinalToolPolicy(context, "gpu", "ffmpeg version authority-test").gpu).toEqual({ effectModuleUseAuthority: authority });
  });

  it("refuses a module-bearing GPU final before FFmpeg or a browser-backed host renderer starts when authority is absent", async () => {
    let ffmpegCalls = 0;
    let rendererCalls = 0;
    const context = {
      ffmpegRunner: async () => {
        ffmpegCalls += 1;
        return { exitCode: 0, stdout: "ffmpeg version must-not-start", stderr: "" };
      },
      streamingFinalRenderer: async () => {
        rendererCalls += 1;
        throw new Error("must not start a browser-backed GPU renderer");
      },
      segmentedFinalRenderer: async () => {
        rendererCalls += 1;
        throw new Error("must not start a browser-backed GPU renderer");
      }
    };

    const direct = await runStreamedFinalDebugRender({
      pkg: gpuPackage(true), lineage: LINEAGE, outputPath: "/unreachable/direct.mp4", frameLane: "gpu", preset: "mp4-h264",
      warnings: [], transport: { delivery: "streamed", reason: "stream_default" }, context, dryRun: false,
      persistReceipt: async () => "/receipt.json"
    });
    const segmented = await runSegmentedFinalDebugRender({
      pkg: gpuPackage(true), lineage: LINEAGE, outputPath: "/unreachable/segmented.mp4", frameLane: "gpu", preset: "mp4-h264",
      segmented: { segmentFrames: 1 }, warnings: [], context, dryRun: false,
      persistReceipt: async () => "/receipt.json"
    });

    expect(direct).toMatchObject({ ok: false, error: { code: "gpu_resource_refused", message: expect.stringContaining("trusted host") } });
    expect(segmented).toMatchObject({ ok: false, error: { code: "gpu_resource_refused", message: expect.stringContaining("trusted host") } });
    expect(ffmpegCalls).toBe(0);
    expect(rendererCalls).toBe(0);
  });

  it("keeps module-free GPU policy and the public final argument contract authority-free", async () => {
    expect(streamedFinalToolPolicy({}, "gpu").gpu).toBeUndefined();
    expect(segmentedFinalToolPolicy({}, "gpu", undefined).gpu).toBeUndefined();

    const properties = debugCommandContract("motion.render.final")?.argsSchema?.properties;
    expect(properties).not.toHaveProperty("gpuEffectModuleUseAuthority");
    expect(properties).not.toHaveProperty("effectModuleUseAuthority");
    expect(properties).not.toHaveProperty("effectModuleAuthority");
    expect(properties).not.toHaveProperty("effectModulesRoot");
  });
});

function gpuPackage(withModule: boolean): MotionPackage {
  return {
    root: "/trusted/package",
    manifest: {
      schema: "shellx-motion/package-manifest@1", id: withModule ? "pkg_gpu_module" : "pkg_gpu_plain", name: "GPU final test", motion: "motion.json",
      assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] }
    },
    motion: {
      schema: "shellx-motion/motion@1", id: withModule ? "motion_gpu_module" : "motion_gpu_plain", name: "GPU final test",
      durationMs: 100, fps: 30, width: 32, height: 32, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: withModule
        ? [
          { id: "group", type: "group", startMs: 0, durationMs: 100, childLayerIds: ["plate", "afterimage"] },
          { id: "plate", type: "shape", shape: "rect", startMs: 0, durationMs: 100, fill: "#ffffffff", width: 32, height: 32 },
          {
            id: "afterimage", type: "adjustment", startMs: 0, durationMs: 100,
            effectModule: {
              schema: "shellx-motion/effect-module-ref@1", moduleId: "motion.afterimage-stack", version: "1.0.0",
              parameters: { amountQ16: 32768, echoes: [{ dxPx: 2, dyPx: -1, color: "#C04080C0", opacityQ16: 32768 }] }
            }
          }
        ]
        : [{ id: "plate", type: "shape", shape: "rect", startMs: 0, durationMs: 100, fill: "#ffffffff", width: 32, height: 32 }]
    }
  } as MotionPackage;
}
