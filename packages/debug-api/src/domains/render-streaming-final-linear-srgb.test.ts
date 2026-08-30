import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { runStreamedFinalDebugRender } from "./render-streaming-final.js";

const LINEAGE = { schema: "shellx-motion/package-render-lineage@1" as const, manifestSha256: "a".repeat(64), motionSha256: "b".repeat(64) };

describe("Debug strict linear-sRGB SDR final projection", () => {
  it("keeps dry-run exact and output-free even when the host has unrelated Browser configuration", async () => {
    let receiptWrites = 0;
    const result = await runStreamedFinalDebugRender({
      pkg: strictPackage(), lineage: LINEAGE, outputPath: join(tmpdir(), "strict-debug.mp4"), frameLane: "gpu", preset: "mp4-h264",
      warnings: [], transport: { delivery: "streamed", reason: "stream_default" },
      context: { browserSessionFactory: {} as never }, dryRun: true,
      async persistReceipt() { receiptWrites += 1; return "/must-not-write.json"; },
    });
    expect(result).toMatchObject({ ok: true, result: { dryRun: true, ffmpeg: { args: expect.arrayContaining(["libx264"]) }, colorPipeline: { intent: "linear-srgb-sdr@1", preflight: "not_run" } } });
    expect(receiptWrites).toBe(0);
  });

  it("refuses an injected strict renderer in the pure branch without calling it", async () => {
    let rendererCalls = 0;
    const result = await runStreamedFinalDebugRender({
      pkg: strictPackage(), lineage: LINEAGE, outputPath: join(tmpdir(), "strict-debug-injected.mp4"), frameLane: "gpu", preset: "mp4-h264",
      warnings: [], transport: { delivery: "streamed", reason: "stream_default" },
      context: { streamingFinalRenderer: async () => { rendererCalls += 1; throw new Error("must not run"); } }, dryRun: true,
      async persistReceipt() { throw new Error("must not write"); },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "linear_srgb_sdr_final_unsupported" } });
    expect(rendererCalls).toBe(0);
  });
});

function strictPackage(): MotionPackage {
  const motion = {
    schema: "shellx-motion/motion@1" as const, id: "strict-debug", name: "Strict Debug", durationMs: 1_000, fps: 2, width: 2, height: 2, background: "#101820",
    colorPipeline: { schema: "shellx-motion/color-pipeline@1" as const, intent: "linear-srgb-sdr@1" as const }, assets: [], provenance: { sourceApp: "test", createdBy: "strict-debug-test" },
    layers: [{ id: "rect", type: "shape" as const, shape: "rect" as const, startMs: 0, durationMs: 1_000, fill: "#ff0040", opacity: 0.5, transform: { x: 0, y: 0, width: 1, height: 1 } }],
  };
  return { root: "/package", manifest: { schema: "shellx-motion/package-manifest@1", id: motion.id, name: motion.name, motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu", "ffmpeg"], hosts: ["local"] } }, motion };
}
