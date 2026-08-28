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

describe("relations@1 FFmpeg refusal", () => {
  it("refuses active, disabled, and malformed stores in every direct and segmented frame lane before output publication", async () => {
    for (const relations of [relationStore(true), relationStore(false), { schema: "shellx-motion/relations@1", bindings: [] } as never]) {
      for (const frameLane of ["browser", "native", "gpu"] as const) {
        const root = await mkdtemp(join(homedir(), ".shellx-motion-ffmpeg-relation-"));
        roots.push(root);
        const outputPath = join(root, `${frameLane}-${relations.bindings[0]?.enabled === false ? "disabled" : "present"}.mp4`);
        const pkg = relationPackage(root, relations);
        const streamed = await renderStreamingFinal({ pkg, frameLane, outputPath, inputRoots: [root], outputRoots: [root] });
        expect(streamed).toMatchObject({
          ok: false,
          error: { code: "motion_relations_unavailable", message: `FFmpeg ${frameLane === "gpu" ? "GPU" : frameLane}-frame delivery does not yet support document relations@1.` },
        });
        expect(existsSync(outputPath)).toBe(false);
        const segmented = await renderSegmentedFinal({ pkg, frameLane, outputPath, segmented: { segmentFrames: 1 }, inputRoots: [root], outputRoots: [root] });
        expect(segmented).toMatchObject({
          ok: false,
          error: { code: "segmented_final_unsupported", message: `FFmpeg ${frameLane === "gpu" ? "GPU" : frameLane}-frame delivery does not yet support document relations@1.`, evidence: { phase: "preflight" } },
        });
        expect(existsSync(outputPath)).toBe(false);
      }
    }
  });
});

function relationPackage(root: string, relations: NonNullable<MotionPackage["motion"]["relations"]>): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "ffmpeg-relation", name: "FFmpeg relation", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["ffmpeg"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "ffmpeg-relation", name: "FFmpeg relation", durationMs: 1_000, fps: 1, width: 100, height: 50,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [
        { id: "leader", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } },
        { id: "follower", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 20, y: 0, width: 10, height: 10 } },
      ],
      relations,
    },
  };
}

function relationStore(enabled: boolean): NonNullable<MotionPackage["motion"]["relations"]> {
  return { schema: "shellx-motion/relations@1", bindings: [{
    id: "follow", enabled, kind: "attach", mode: "follow", startUs: 0, durationUs: 1_000_000,
    source: { layerId: "leader", anchor: { x: 0, y: 0 } }, target: { layerId: "follower", anchor: { x: 0, y: 0 } },
    offset: { space: "source", x: 0, y: 0, rotationDeg: 0, scale: 1 },
  }] };
}
