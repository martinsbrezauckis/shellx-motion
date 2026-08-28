import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MotionPackage, OperationReceipt } from "@shellx-motion/core";

// This focused test owns only the cancellation boundary. Production artifact-topology checks
// remain covered by streaming-final.test.ts; this hosted filesystem's `/` owner deliberately
// refuses those topology checks before a renderer can be called.
vi.mock("./artifact-handle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./artifact-handle.js")>();
  return {
    ...actual,
    captureConnectorArtifactStagingTopology: async () => ({ stagingParent: { dev: 0, ino: 0 } }),
    discardConnectorArtifactStaging: async (path: string) => {
      await rm(path, { force: true });
      return true;
    }
  };
});

import { renderConnectorStreamingArtifact, type ConnectorStreamingFinalRenderer } from "./streaming-final";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("connector cancellation propagation", () => {
  it("forwards coordinator cancellation to the streamed renderer and never publishes a late successful stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-cancelled-stream-"));
    roots.push(root);
    const pkg = testPackage(root);
    const outputPath = join(root, "render", "cancelled.mp4");
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let stagedPath: string | undefined;
    const renderer: ConnectorStreamingFinalRenderer = async (input) => {
      receivedSignal = input.signal;
      stagedPath = input.outputPath;
      await mkdir(dirname(input.outputPath), { recursive: true, mode: 0o700 });
      await writeFile(input.outputPath, Buffer.from("late renderer success"));
      controller.abort(new Error("coordinator cancelled connector job"));
      return { ok: true, receipt: renderReceipt(input.pkg, input.outputPath) };
    };

    await expect(renderConnectorStreamingArtifact({
      pkg,
      frameLane: "browser",
      outputPath,
      signal: controller.signal,
      streamingRenderer: renderer,
      now: () => "2026-08-25T00:00:00.000Z"
    })).rejects.toThrow("coordinator cancelled connector job");

    expect(receivedSignal).toBe(controller.signal);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(stagedPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function testPackage(root: string): MotionPackage {
  return {
    root: join(root, "package"),
    manifest: { id: "connector-cancellation" },
    motion: { id: "connector-cancellation-motion", width: 640, height: 360, fps: 30, durationMs: 1_000, layers: [] }
  } as unknown as MotionPackage;
}

function renderReceipt(pkg: MotionPackage, outputPath: string): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: "connector-cancellation-render",
    operation: "render.final",
    status: "passed",
    packageId: pkg.manifest.id,
    inputHashes: { motion: "0".repeat(64) },
    createdAt: "2026-08-25T00:00:00.000Z",
    lane: "ffmpeg",
    output: { path: outputPath },
    warnings: []
  };
}
