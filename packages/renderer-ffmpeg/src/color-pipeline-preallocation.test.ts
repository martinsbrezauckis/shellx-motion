import * as core from "@shellx-motion/core";
import type { MotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSegmentedFinal, renderStreamingFinal } from "./index.js";
import { preflightGpuFinalDelivery } from "./streaming-final-adapter-execution.js";

const strictPackage = (): MotionPackage => ({
  root: "/strict-color-pipeline",
  manifest: { schema: "shellx-motion/package-manifest@1", id: "strict-color-pipeline", name: "Strict color pipeline", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser", "native", "gpu"], hosts: ["motion"] } },
  motion: {
    schema: "shellx-motion/motion@1", id: "strict-color-pipeline", name: "Strict color pipeline", durationMs: 1_000, fps: 1, width: 16, height: 16,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [], colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }
  }
});

afterEach(() => vi.restoreAllMocks());

describe("F0 strict GPU final preallocation guards", () => {
  it("refuses every streamed and segmented lane before output, job, process, or renderer allocation", async () => {
    const pkg = strictPackage();
    let runnerCalls = 0, processStarts = 0, gpuOpens = 0, browserLaunches = 0, nativeClockReads = 0;
    const outputPublication = vi.spyOn(core, "acquireDerivedOutputPublication");
    const outputReservation = vi.spyOn(core.OutputDirectoryReservation, "acquire");
    const toolPolicy = {
      runner: async () => { runnerCalls += 1; return { exitCode: 0, stdout: "", stderr: "" }; },
      processFactory: async () => { processStarts += 1; throw new Error("encoder must not start"); },
      gpu: { openRuntime: async () => { gpuOpens += 1; throw new Error("GPU runtime must not open"); } },
      browser: { launchBrowser: async () => { browserLaunches += 1; throw new Error("Browser must not launch"); } },
      native: { now: () => { nativeClockReads += 1; return "never"; } }
    };
    await expect(preflightGpuFinalDelivery({ pkg, frameLane: "gpu", outputPath: "/strict-color-pipeline/never.mp4" })).resolves.toMatchObject({ ok: false, failure: { code: "color_pipeline_unsupported" } });
    for (const frameLane of ["browser", "native", "gpu"] as const) {
      await expect(renderStreamingFinal({ pkg, frameLane, outputPath: `/strict-color-pipeline/never-${frameLane}.mp4`, toolPolicy })).resolves.toMatchObject({ ok: false, error: { code: "linear_srgb_sdr_final_unsupported" } });
      await expect(renderSegmentedFinal({ pkg, frameLane, outputPath: `/strict-color-pipeline/never-segmented-${frameLane}.mp4`, segmented: { segmentFrames: 1 }, toolPolicy })).resolves.toMatchObject({ ok: false, error: { code: "segmented_final_unsupported", evidence: { phase: "preflight" } } });
    }
    expect({ runnerCalls, processStarts, gpuOpens, browserLaunches, nativeClockReads }).toEqual({ runnerCalls: 0, processStarts: 0, gpuOpens: 0, browserLaunches: 0, nativeClockReads: 0 });
    expect(outputPublication).not.toHaveBeenCalled();
    expect(outputReservation).not.toHaveBeenCalled();
  });
});
