import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { preliminaryGpuAudio } from "./index.js";
import { renderSegmentedFinal } from "./segmented-final.js";
import { renderStreamingFinal } from "./streaming-final-adapter.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("scene3dAnimation@1 FFmpeg refusal", () => {
  it("refuses layout-gap animation for every direct and segmented frame lane before output publication", async () => {
    for (const frameLane of ["browser", "native", "gpu"] as const) {
      const root = await mkdtemp(join(homedir(), ".shellx-motion-ffmpeg-layout-gap-"));
      roots.push(root);
      const pkg = scene3dAnimationPackage(root);
      delete pkg.motion.scene3dAnimation;
      pkg.motion.layoutGapAnimation = { schema: "shellx-motion/layout-gap-animation@1", tracks: [] } as never;
      const outputPath = join(root, `${frameLane}.mp4`);
      await expect(renderStreamingFinal({ pkg, frameLane, outputPath, inputRoots: [root], outputRoots: [root] })).resolves.toMatchObject({ ok: false, error: { code: "motion_layout_gap_animation_unavailable", message: `FFmpeg ${frameLane === "gpu" ? "GPU" : frameLane}-frame delivery does not yet support document layoutGapAnimation@1.` } });
      await expect(renderSegmentedFinal({ pkg, frameLane, outputPath, segmented: { segmentFrames: 1 }, inputRoots: [root], outputRoots: [root] })).resolves.toMatchObject({ ok: false, error: { code: "segmented_final_unsupported", evidence: { phase: "preflight" } } });
      expect(existsSync(outputPath)).toBe(false);
    }
  });

  it("refuses every direct and segmented frame lane before output publication", async () => {
    for (const frameLane of ["browser", "native", "gpu"] as const) {
      const root = await mkdtemp(join(homedir(), ".shellx-motion-ffmpeg-scene3d-animation-"));
      roots.push(root);
      const outputPath = join(root, `${frameLane}.mp4`);
      const pkg = scene3dAnimationPackage(root);
      const streamed = await renderStreamingFinal({ pkg, frameLane, outputPath, inputRoots: [root], outputRoots: [root] });
      expect(streamed).toMatchObject({
        ok: false,
        error: { code: "motion_scene3d_animation_unavailable", message: `FFmpeg ${frameLane === "gpu" ? "GPU" : frameLane}-frame delivery does not yet support document scene3dAnimation@1.` },
      });
      expect(existsSync(outputPath)).toBe(false);
      const segmented = await renderSegmentedFinal({ pkg, frameLane, outputPath, segmented: { segmentFrames: 1 }, inputRoots: [root], outputRoots: [root] });
      expect(segmented).toMatchObject({
        ok: false,
        error: { code: "segmented_final_unsupported", message: `FFmpeg ${frameLane === "gpu" ? "GPU" : frameLane}-frame delivery does not yet support document scene3dAnimation@1.`, evidence: { phase: "preflight" } },
      });
      expect(existsSync(outputPath)).toBe(false);
    }
  });

  it("refuses an accessor root without reading it before direct or segmented work", async () => {
    const root = await mkdtemp(join(homedir(), ".shellx-motion-ffmpeg-scene3d-animation-accessor-"));
    roots.push(root);
    const pkg = scene3dAnimationPackage(root);
    let reads = 0;
    Object.defineProperty(pkg.motion, "scene3dAnimation", { enumerable: true, get() { reads += 1; return { schema: "shellx-motion/scene3d-animation@1", tracks: [] }; } });
    await expect(renderStreamingFinal({ pkg, frameLane: "gpu", outputPath: join(root, "direct.mp4"), inputRoots: [root], outputRoots: [root] })).resolves.toMatchObject({ ok: false, error: { code: "motion_scene3d_animation_unavailable" } });
    await expect(renderSegmentedFinal({ pkg, frameLane: "gpu", outputPath: join(root, "segmented.mp4"), segmented: { segmentFrames: 1 }, inputRoots: [root], outputRoots: [root] })).resolves.toMatchObject({ ok: false, error: { code: "segmented_final_unsupported" } });
    expect(reads).toBe(0);
  });

  it("refuses the public GPU-audio preflight before it traverses layers", () => {
    const pkg = scene3dAnimationPackage("/not-opened-scene3d-animation-audio");
    let rootReads = 0, layerReads = 0;
    const layers = pkg.motion.layers;
    Object.defineProperty(pkg.motion, "scene3dAnimation", { enumerable: true, get() { rootReads += 1; return { schema: "shellx-motion/scene3d-animation@1", tracks: [] }; } });
    Object.defineProperty(pkg.motion, "layers", { enumerable: true, get() { layerReads += 1; return layers; } });
    expect(() => preliminaryGpuAudio({ pkg })).toThrow("FFmpeg GPU-frame delivery does not yet support document scene3dAnimation@1.");
    expect({ rootReads, layerReads }).toEqual({ rootReads: 0, layerReads: 0 });
  });

  it("uses the named C2 refusal code in the public GPU-audio helper", () => {
    const pkg = scene3dAnimationPackage("/not-opened-layout-gap-audio");
    delete pkg.motion.scene3dAnimation;
    pkg.motion.layoutGapAnimation = { schema: "shellx-motion/layout-gap-animation@1", tracks: [] } as never;
    try {
      preliminaryGpuAudio({ pkg });
      throw new Error("layout-gap GPU audio preflight unexpectedly succeeded");
    } catch (error) {
      expect(error).toMatchObject({
        name: "PreliminaryGpuAudioRefusal",
        code: "motion_layout_gap_animation_unavailable",
        message: "FFmpeg GPU-frame delivery does not yet support document layoutGapAnimation@1.",
      });
    }
  });
});

function scene3dAnimationPackage(root: string): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "ffmpeg-scene3d-animation", name: "FFmpeg scene3d animation", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["ffmpeg"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "ffmpeg-scene3d-animation", name: "FFmpeg scene3d animation", durationMs: 1_000, fps: 1, width: 100, height: 50,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } }],
      scene3dAnimation: { schema: "shellx-motion/scene3d-animation@1", tracks: [] } as never,
    },
  };
}
