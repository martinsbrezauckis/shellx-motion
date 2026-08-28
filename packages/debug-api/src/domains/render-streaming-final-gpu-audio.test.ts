import { describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { runStreamedFinalDebugRender } from "./render-streaming-final.js";

const LINEAGE = {
  schema: "shellx-motion/package-render-lineage@1" as const,
  manifestSha256: "a".repeat(64),
  motionSha256: "b".repeat(64),
};

describe("Debug streamed GPU final audio planning", () => {
  it("defers package MP4 audio until immutable GPU PCM staging", async () => {
    const pkg = {
      root: "/package",
      manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_audio", name: "GPU audio", motion: "motion.json", assets: ["assets/clip.mp4"], sourceApp: "test", compatibility: { lanes: ["gpu", "ffmpeg"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_audio", name: "GPU audio", durationMs: 1_000, fps: 30, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [
        { id: "clip", type: "video", assetRef: "assets/clip.mp4", includeAudio: true, startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } }
      ] }
    } as MotionPackage;
    const result = await runStreamedFinalDebugRender({
      pkg, lineage: LINEAGE, outputPath: "/output/final.mp4", frameLane: "gpu", preset: "mp4-h264",
      warnings: [], transport: { delivery: "streamed", reason: "stream_default" }, context: {}, dryRun: true,
      persistReceipt: async () => { throw new Error("dry run must not persist a receipt"); }
    });
    expect(result).toMatchObject({ ok: true, result: { frameLane: "gpu", ffmpeg: { args: expect.arrayContaining(["-f", "rawvideo", "-i", "pipe:0"]) } } });
    if (!result.ok) return;
    const args = (result.result as { ffmpeg: { args: string[] } }).ffmpeg.args;
    expect(args).not.toContain("/package/assets/clip.mp4");
  });
});
