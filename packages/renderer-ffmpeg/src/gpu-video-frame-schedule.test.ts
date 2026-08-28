import type { MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { gpuVideoFrameSchedules, MAX_GPU_VIDEO_LOOP_SEGMENTS, resolveGpuVideoFrameSchedules } from "./gpu-video-frame-schedule";

describe("GPU video frame schedule", () => {
  it("wraps a probed full source and an explicit trim window at canonical frame times", () => {
    const full = gpuVideoFrameSchedules(videoPackage());
    expect(resolveGpuVideoFrameSchedules(full, () => 1_000)[0]).toMatchObject({
      sourceAtMs: [0, 500, 0],
      segments: [
        { startOrdinal: 0, frameCount: 2, sourceStartMs: 0 },
        { startOrdinal: 2, frameCount: 1, sourceStartMs: 0 },
      ],
    });

    const trimmedPackage = videoPackage();
    trimmedPackage.motion.layers[0]!.trimStartMs = 100;
    trimmedPackage.motion.layers[0]!.trimDurationMs = 300;
    const trimmed = gpuVideoFrameSchedules(trimmedPackage);
    expect(resolveGpuVideoFrameSchedules(trimmed, () => 1_000)[0]).toMatchObject({
      sourceAtMs: [100, 300, 200],
      segments: [
        { startOrdinal: 0, frameCount: 1, sourceStartMs: 100 },
        { startOrdinal: 1, frameCount: 1, sourceStartMs: 300 },
        { startOrdinal: 2, frameCount: 1, sourceStartMs: 200 },
      ],
    });
  });

  it("refuses non-looping trim overruns and pathological segment counts", () => {
    const nonLooping = videoPackage();
    nonLooping.motion.layers[0]!.loop = false;
    nonLooping.motion.layers[0]!.trimDurationMs = 600;
    expect(() => resolveGpuVideoFrameSchedules(gpuVideoFrameSchedules(nonLooping), () => 1_000)).toThrow("non-looping trim window");

    const excessive = videoPackage();
    excessive.motion.durationMs = (MAX_GPU_VIDEO_LOOP_SEGMENTS + 1) * 1_000;
    excessive.motion.fps = 1;
    excessive.motion.layers[0]!.durationMs = excessive.motion.durationMs;
    excessive.motion.layers[0]!.trimDurationMs = 500;
    expect(() => resolveGpuVideoFrameSchedules(gpuVideoFrameSchedules(excessive), () => 1_000)).toThrow("loop staging bound");
  });
});

function videoPackage(): MotionPackage {
  return {
    root: "/fixture",
    manifest: {
      schema: "shellx-motion/package-manifest@1", id: "pkg", name: "pkg", motion: "motion.json",
      assets: ["assets/clip.mp4"], sourceApp: "test", compatibility: { lanes: ["gpu", "ffmpeg"], hosts: ["motion"] },
    },
    motion: {
      schema: "shellx-motion/motion@1", id: "motion", name: "motion", durationMs: 1_500, fps: 2, width: 16, height: 16,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_500, loop: true, transform: { width: 16, height: 16 } }],
    },
  };
}
