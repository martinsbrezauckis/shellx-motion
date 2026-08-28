import { describe, expect, it, vi } from "vitest";
import type { AgentScriptExecutionEvidence, MotionPackage, OperationReceipt } from "@shellx-motion/core";
import type { BrowserFrameResult, MotionBrowserRenderSession } from "@shellx-motion/renderer-browser";
import { renderFinalDeliveryFrames } from "./render-final-frame-lane";

const evidence: AgentScriptExecutionEvidence = {
  schema: "shellx-motion/script-execution@1", detectedClass: "active-content",
  requestedMode: "trusted-local-agent-authored", activeMode: "trusted-local-agent-authored",
  resolverVersion: 1, packageSnapshotSha256: "a".repeat(64), attestationId: "attestation-1",
  sources: [{ layerId: "entry", layerType: "html", path: "entry.html", sha256: "d".repeat(64), bytes: 12 }],
  entry: { layerId: "entry", layerType: "html", path: "entry.html", sha256: "d".repeat(64), bytes: 12 }
};

describe("aggregate browser script evidence", () => {
  it("uses one active-content session and promotes its consistent evidence", async () => {
    const close = vi.fn(async () => undefined);
    const renderFrame = vi.fn(async (options: { atMs: number }) => frame(options.atMs));
    const sessionFactory = vi.fn(async () => ({ renderFrame, close } as unknown as MotionBrowserRenderSession));
    const rendered = await renderFinalDeliveryFrames({
      pkg: activePackage(), packageRoot: "/package", outputDir: "/output", frameLane: "browser", frameCount: 2,
      browserFrameRenderer: vi.fn(),
      browserSessionFactory: sessionFactory
    });

    expect(rendered.ok).toBe(true);
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(renderFrame).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    const receipt = aggregateReceipt(); rendered.applyTo(receipt);
    expect(receipt.output).toMatchObject({ scriptExecution: evidence });
  });

  it("refuses active multi-frame work before an injected per-frame renderer", async () => {
    const renderer = vi.fn();
    await expect(renderFinalDeliveryFrames({
      pkg: activePackage(), packageRoot: "/package", outputDir: "/output", frameLane: "browser", frameCount: 2,
      browserFrameRenderer: renderer
    })).rejects.toMatchObject({ code: "script_provenance_unresolved" });
    expect(renderer).not.toHaveBeenCalled();
  });

  it("closes and refuses when one session contradicts its resolver evidence", async () => {
    const close = vi.fn(async () => undefined);
    let index = 0;
    const renderFrame = vi.fn(async (options: { atMs: number }) => frame(
      options.atMs,
      index++ === 0 ? evidence : { ...evidence, attestationId: "different-attestation" }
    ));
    await expect(renderFinalDeliveryFrames({
      pkg: activePackage(), packageRoot: "/package", outputDir: "/output", frameLane: "browser", frameCount: 2,
      browserSessionFactory: async () => ({ renderFrame, close } as unknown as MotionBrowserRenderSession)
    })).rejects.toMatchObject({ code: "script_provenance_unresolved" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("refuses structurally incomplete active evidence instead of promoting a renderer claim", async () => {
    const close = vi.fn(async () => undefined);
    const forged = { ...evidence, sources: [] };
    await expect(renderFinalDeliveryFrames({
      pkg: activePackage(), packageRoot: "/package", outputDir: "/output", frameLane: "browser", frameCount: 1,
      browserSessionFactory: async () => ({ renderFrame: async () => frame(0, forged), close } as unknown as MotionBrowserRenderSession)
    })).rejects.toMatchObject({ code: "script_provenance_unresolved" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

function activePackage(): MotionPackage {
  return {
    root: "/package", manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg", name: "pkg", motion: "motion.json", assets: ["entry.html"], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion", name: "motion", durationMs: 1_000, fps: 2, width: 16, height: 16, layers: [{ id: "entry", type: "html", source: "entry.html", startMs: 0, durationMs: 1_000 }], assets: ["entry.html"], provenance: { sourceApp: "test", createdBy: "test" } }
  };
}

function frame(atMs: number, scriptExecution = evidence): BrowserFrameResult {
  const output = { path: `/output/${atMs}.png`, sha256: "b".repeat(64), format: "png" as const, width: 16, height: 16, atMs, browser: { name: "chromium", version: "test" }, viewport: { width: 16, height: 16, deviceScaleFactor: 1 }, scriptExecution };
  return { ok: true, output, receipt: { ...aggregateReceipt(), id: `frame-${atMs}`, operation: "preview.frame", output } };
}

function aggregateReceipt(): OperationReceipt {
  return { schema: "shellx-motion/receipt@1", id: "aggregate", operation: "render.final", status: "passed", packageId: "pkg", inputHashes: { motion: "c".repeat(64) }, createdAt: "2026-08-09T00:00:00.000Z", lane: "browser", output: {}, warnings: [] };
}
