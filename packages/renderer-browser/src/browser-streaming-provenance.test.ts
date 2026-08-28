import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentScriptExecutionEvidence, MotionPackage } from "@shellx-motion/core";
import { createBrowserStreamingFrameProducer, type BrowserFrameResult, type MotionBrowserRenderSession } from "./index";
import { registerBrowserStreamingFrameRender } from "./browser-streaming-session-registry";

const roots: string[] = [];
const scriptExecution: AgentScriptExecutionEvidence = {
  schema: "shellx-motion/script-execution@1", detectedClass: "active-content",
  requestedMode: "trusted-local-agent-authored", activeMode: "trusted-local-agent-authored",
  resolverVersion: 1, packageSnapshotSha256: "a".repeat(64), attestationId: "attestation-1", sources: []
};

describe("browser streaming provenance", () => {
  afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("opens one host session and retains one consistent script verdict", async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "motion-stream-provenance-")); roots.push(scratchRoot);
    const close = vi.fn(async () => undefined);
    const session = { browserVersion: "test", metrics: {}, renderFrame: vi.fn(), renderFrames: vi.fn(), close } as unknown as MotionBrowserRenderSession;
    registerBrowserStreamingFrameRender(session, async (options) => ({ png: Buffer.from("png"), result: frame(options.atMs) }));
    const sessionFactory = vi.fn(async () => session);
    const producer = createBrowserStreamingFrameProducer({ pkg: pkg(), sessionFactory });
    const delivered: number[] = [];

    await producer.produce({ write: async ({ index }) => { delivered.push(index); } }, {
      admission: "pre-acquired", jobId: "test", scratchRoot, signal: new AbortController().signal,
      watchProcess: () => undefined, reportSandbox: () => undefined
    });

    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([0, 1]);
    expect(producer.evidence.scriptExecution).toEqual(scriptExecution);
    expect(producer.evidence.terminalFrame?.output).toMatchObject({ scriptExecution });
  });
});

function pkg(): MotionPackage {
  return {
    root: "/package", manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg", name: "pkg", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion", name: "motion", durationMs: 1_000, fps: 2, width: 16, height: 16, layers: [], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }
  };
}

function frame(atMs: number): BrowserFrameResult {
  const output = { path: "/private/frame.png", sha256: "b".repeat(64), format: "png" as const, width: 16, height: 16, atMs, browser: { name: "chromium", version: "test" }, viewport: { width: 16, height: 16, deviceScaleFactor: 1 }, scriptExecution };
  return { ok: true, output, receipt: { schema: "shellx-motion/receipt@1", id: `frame-${atMs}`, operation: "preview.frame", status: "passed", packageId: "pkg", inputHashes: { motion: "c".repeat(64) }, createdAt: "2026-08-09T00:00:00.000Z", lane: "browser", output, warnings: [] } };
}
