import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@shellx-motion/core";
import type { MotionLayer, MotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderStreamingFinal } from "./index.js";
import { activeGpuVideoKeyframedPlaybackRateLayer } from "./gpu-video-frame-schedule.js";
import { preflightGpuFinalDelivery } from "./streaming-final-adapter-execution.js";

afterEach(() => vi.restoreAllMocks());

describe("GPU final video preflight", () => {
  it("refuses an active nested keyframed playback rate before job, resource, or output admission", async () => {
    const root = process.cwd(), outputPath = join(tmpdir(), `shellx-motion-gpu-video-preflight-${randomUUID()}.mp4`);
    const pkg = videoPackage(root, true, "active-parent");
    let runnerCalls = 0, processStarts = 0, gpuOpens = 0;
    const governor = new core.LocalMotionJobGovernor({
      maxConcurrentJobs: 1, maxQueueDepth: 1, maxQueueWaitMs: 500, maxWallClockMs: 10_000,
      minFreeScratchBytes: 0, scratchReservationBytes: 0, maxProcessTreeRssBytes: 512 * 1024 * 1024, rssPollIntervalMs: 1_000
    }, { leases: null, freeScratchBytes: async () => Number.MAX_SAFE_INTEGER });
    const jobAdmission = vi.spyOn(governor, "run");
    const outputPublication = vi.spyOn(core, "acquireDerivedOutputPublication");
    const resourceReservation = vi.spyOn(core.OutputDirectoryReservation, "acquire");
    const result = await renderStreamingFinal({
      pkg, frameLane: "gpu", outputPath, governor,
      toolPolicy: {
        forceSoftwareEncode: true,
        runner: async () => { runnerCalls += 1; return { exitCode: 0, stdout: "", stderr: "" }; },
        processFactory: async () => { processStarts += 1; throw new Error("encoder must not start"); },
        gpu: { openRuntime: async () => { gpuOpens += 1; throw new Error("GPU runtime must not open"); } }
      }
    });

    expect(result).toMatchObject({ ok: false, error: {
      code: "gpu_unsupported_feature", layerId: "nested-keyed-clip",
      message: "GPU final delivery does not support keyframed playbackRate on video layer nested-keyed-clip; use a static playbackRate."
    } });
    expect(jobAdmission).not.toHaveBeenCalled();
    expect(outputPublication).not.toHaveBeenCalled();
    expect(resourceReservation).not.toHaveBeenCalled();
    expect(runnerCalls).toBe(0);
    expect(processStarts).toBe(0);
    expect(gpuOpens).toBe(0);
    await expect(preflightGpuFinalDelivery({ pkg: videoPackage(root, false), frameLane: "gpu", outputPath })).resolves.toMatchObject({ ok: true, staticPlan: { maxima: { maxVideoCount: 1 } } });
  });

  it("does not refuse a keyframed child that its invisible parent prevents GPU staging", async () => {
    const root = process.cwd(), outputPath = join(tmpdir(), `shellx-motion-gpu-video-preflight-${randomUUID()}.mp4`);
    await expect(preflightGpuFinalDelivery({ pkg: videoPackage(root, true, "invisible-parent"), frameLane: "gpu", outputPath }))
      .resolves.toMatchObject({ ok: true, staticPlan: { maxima: { maxVideoCount: 0 } } });
  });

  it("skips group expansion when no visible keyframed video candidate exists", () => {
    const pkg = videoPackage(process.cwd(), false);
    pkg.motion.layers.push({ id: "unvisited-invalid-group", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["missing-child"] });
    expect(activeGpuVideoKeyframedPlaybackRateLayer(pkg)).toEqual({ ok: true });
  });
});

function videoPackage(root: string, keyframed: boolean, parent: "root" | "active-parent" | "invisible-parent" = "root"): MotionPackage {
  const clip: MotionLayer = {
    id: parent === "root" ? "keyed-clip" : "nested-keyed-clip", type: "video", assetId: "clip_asset", startMs: 0, durationMs: 1_000, playbackRate: 1.25,
    ...(keyframed ? { keyframes: { playbackRate: [{ atMs: 0, value: 1.25 }, { atMs: 1_000, value: 1.5 }] } } : {}), transform: { x: 0, y: 0, width: 16, height: 16 }
  };
  const layers: MotionLayer[] = parent === "root"
    ? [clip]
    : [{ id: "clip-parent", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: [clip.id], ...(parent === "invisible-parent" ? { visible: false } : {}) }, clip];
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_keyframed_video_preflight", name: "GPU keyframed video preflight", motion: "motion.json", assets: ["assets/clip.mp4"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "motion_gpu_keyframed_video_preflight", name: "GPU keyframed video preflight", durationMs: 1_000, fps: 1, width: 16, height: 16, background: "#061a2c",
      assets: [{ id: "clip_asset", source: { path: "assets/clip.mp4", mimeType: "video/mp4" } }], provenance: { sourceApp: "test", createdBy: "test" },
      layers
    }
  };
}
