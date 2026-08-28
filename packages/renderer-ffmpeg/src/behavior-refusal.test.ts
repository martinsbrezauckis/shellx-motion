import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { renderSegmentedFinal } from "./segmented-final.js";
import { renderStreamingFinal } from "./streaming-final-adapter.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("behavior Phase 1 FFmpeg refusal", () => {
  it("refuses active and disabled browser/native frame lanes before output publication", async () => {
    for (const enabled of [true, false]) for (const frameLane of ["browser", "native"] as const) {
      const root = await mkdtemp(join(homedir(), ".shellx-motion-ffmpeg-behavior-"));
      roots.push(root);
      const outputPath = join(root, `${frameLane}-${enabled ? "active" : "disabled"}.mp4`);
      const pkg = behaviorPackage(root, enabled);
      const streamed = await renderStreamingFinal({ pkg, frameLane, outputPath, inputRoots: [root], outputRoots: [root] });
      expect(streamed).toMatchObject({
        ok: false,
        error: {
          code: "motion_behaviors_unavailable",
          message: `FFmpeg ${frameLane}-frame delivery does not yet support document behaviors@1.`,
        },
      });
      expect(existsSync(outputPath)).toBe(false);
      const segmented = await renderSegmentedFinal({ pkg, frameLane, outputPath, segmented: { segmentFrames: 1 }, inputRoots: [root], outputRoots: [root] });
      expect(segmented).toMatchObject({
        ok: false,
        error: {
          code: "segmented_final_unsupported",
          message: `FFmpeg ${frameLane}-frame delivery does not yet support document behaviors@1.`,
          evidence: { phase: "preflight" },
        },
      });
      expect(existsSync(outputPath)).toBe(false);
    }
  });
});

function behaviorPackage(root: string, enabled: boolean): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "ffmpeg-behavior", name: "FFmpeg behavior", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["ffmpeg"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "ffmpeg-behavior", name: "FFmpeg behavior", durationMs: 1_000, fps: 1, width: 100, height: 50,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000 }],
      behaviors: { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "shape", enabled, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 } }] },
    },
  };
}
