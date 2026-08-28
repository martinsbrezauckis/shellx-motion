import { describe, expect, it, vi } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { planFinalVideoFrameTransport } from "@shellx-motion/renderer-ffmpeg";
import { runStreamedFinalDebugRender } from "./domains/render-streaming-final";

const LINEAGE = {
  schema: "shellx-motion/package-render-lineage@1" as const,
  manifestSha256: "a".repeat(64),
  motionSha256: "b".repeat(64),
};

describe("streamed final agent-script boundary", () => {
  it("refuses an injected streamed renderer for active content before execution", async () => {
    const injected = vi.fn();
    const transport = planFinalVideoFrameTransport({ injectedFrameRenderer: false });
    if (transport.delivery !== "streamed") throw new Error("test requires streamed transport");

    const result = await runStreamedFinalDebugRender({
      pkg: activePackage(), lineage: LINEAGE, outputPath: "/output/out.mp4", frameLane: "browser", preset: "mp4-h264",
      warnings: [], transport, context: { streamingFinalRenderer: injected }, dryRun: false,
      persistReceipt: async () => "/receipt.json"
    });

    expect(result).toMatchObject({ ok: false, error: { code: "script_provenance_unresolved" } });
    expect(injected).not.toHaveBeenCalled();
  });

  it("refuses before FFmpeg when the host did not grant active-script authority", async () => {
    const sessionFactory = vi.fn();
    const transport = planFinalVideoFrameTransport({ injectedFrameRenderer: false });
    if (transport.delivery !== "streamed") throw new Error("test requires streamed transport");

    const result = await runStreamedFinalDebugRender({
      pkg: activePackage(), lineage: LINEAGE, outputPath: "/output/out.mp4", frameLane: "browser", preset: "mp4-h264",
      warnings: [], transport, context: { browserSessionFactory: sessionFactory, activeScriptSessionAvailable: false }, dryRun: false,
      persistReceipt: async () => "/receipt.json"
    });

    expect(result).toMatchObject({ ok: false, error: { code: "script_provenance_unresolved" } });
    expect(sessionFactory).not.toHaveBeenCalled();
  });
});

function activePackage(): MotionPackage {
  return {
    root: "/package", manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg", name: "pkg", motion: "motion.json", assets: ["entry.html"], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion", name: "motion", durationMs: 1_000, fps: 2, width: 16, height: 16, layers: [{ id: "entry", type: "html", source: "entry.html", startMs: 0, durationMs: 1_000 }], assets: ["entry.html"], provenance: { sourceApp: "test", createdBy: "test" } }
  };
}
