/** Late source drift must fail before any coordinated output allocation. */
import { appendFile, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertStableRenderPackageLineage, loadStableRenderPackage, type StableRenderPackage } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor, type TrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { runSegmentedFinalDebugRender } from "./domains/render-segmented-final.js";
import { runStreamedFinalDebugRender } from "./domains/render-streaming-final.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

type Fixture = { root: string; packageRoot: string; anchor: TrustedWorkspaceAnchor; stable: StableRenderPackage };

async function fixture(gpuCapable = false): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-coordinated-lineage-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  await cp(resolve("../../fixtures/packages/lower-third"), packageRoot, { recursive: true });
  if (gpuCapable) {
    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.layers = [{
      id: "background", type: "shape", shape: "rect", fill: "#101820", startMs: 0, durationMs: 4_000,
      transform: { x: 0, y: 0, width: 1_920, height: 1_080 }
    }];
    await writeFile(motionPath, `${JSON.stringify(motion)}\n`, "utf8");
  }
  const anchor = await createTrustedWorkspaceAnchor(root);
  const stable = await withTrustedWorkspaceAnchor(anchor, async () => await loadStableRenderPackage(packageRoot));
  return { root, packageRoot, anchor, stable };
}

type Pause = { reached: Promise<void>; release(): void };

function pausedHealth() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  return {
    reached,
    release,
    runner: async () => {
      entered();
      await resume;
      return { exitCode: 0, stdout: "ffmpeg version coordinated-lineage-test", stderr: "" };
    }
  };
}

function pausedAdapterRevalidation(value: Fixture) {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  return {
    reached,
    release,
    revalidate: async () => {
      entered();
      await resume;
      await assertStableRenderPackageLineage(value.stable.pkg, value.stable.lineage);
    }
  };
}

async function mutateAfterPause(value: Fixture, pause: Pause): Promise<void> {
  await pause.reached;
  await appendFile(join(value.packageRoot, "motion.json"), "\n", "utf8");
  pause.release();
}

function revalidate(value: Fixture) {
  return async () => await assertStableRenderPackageLineage(value.stable.pkg, value.stable.lineage);
}

function expectNoOutputAllocation(value: Fixture): Promise<string[]> {
  return readdir(value.root).then((entries) => {
    expect(entries.sort()).toEqual(["package"]);
    return entries;
  });
}

describe("coordinated final lineage revalidation", () => {
  it("refuses before the Debug health launch without invoking FFmpeg or an injected renderer", async () => {
    const value = await fixture();
    let healthLaunches = 0;
    let rendererCalls = 0;
    const result = await withTrustedWorkspaceAnchor(value.anchor, async () => await runStreamedFinalDebugRender({
      pkg: value.stable.pkg, lineage: value.stable.lineage, outputPath: join(value.root, "out.mp4"), frameLane: "browser", preset: "mp4-h264",
      warnings: [], transport: { delivery: "streamed", reason: "stream_default" },
      context: {
        ffmpegRunner: async () => { healthLaunches += 1; return { exitCode: 0, stdout: "ffmpeg version coordinated-lineage-test", stderr: "" }; },
        streamingFinalRenderer: async () => { rendererCalls += 1; throw new Error("must not launch"); }
      },
      dryRun: false,
      revalidateLineage: async () => { throw new Error("stable lineage changed before Debug health"); },
      persistReceipt: async () => "/receipt.json"
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "render_failed", message: "stable lineage changed before Debug health" } });
    expect(healthLaunches).toBe(0);
    expect(rendererCalls).toBe(0);
    await expectNoOutputAllocation(value);
  });

  it("refuses before segmented Debug health without invoking FFmpeg or the one-argument injected seam", async () => {
    const value = await fixture();
    let healthLaunches = 0;
    let rendererCalls = 0;
    const result = await withTrustedWorkspaceAnchor(value.anchor, async () => await runSegmentedFinalDebugRender({
      pkg: value.stable.pkg, lineage: value.stable.lineage, outputPath: join(value.root, "out.mp4"), frameLane: "browser", preset: "mp4-h264",
      segmented: { segmentFrames: 12 }, warnings: [],
      context: {
        ffmpegRunner: async () => { healthLaunches += 1; return { exitCode: 0, stdout: "ffmpeg version coordinated-lineage-test", stderr: "" }; },
        segmentedFinalRenderer: async () => { rendererCalls += 1; throw new Error("must not launch"); }
      },
      dryRun: false,
      revalidateLineage: async () => { throw new Error("stable lineage changed before segmented Debug health"); },
      persistReceipt: async () => "/receipt.json"
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "render_failed", message: "stable lineage changed before segmented Debug health" } });
    expect(healthLaunches).toBe(0);
    expect(rendererCalls).toBe(0);
    await expectNoOutputAllocation(value);
  });

  it("refuses a browser mutation after adapter preflight and before output reservation", async () => {
    const value = await fixture();
    const pause = pausedAdapterRevalidation(value);
    const result = withTrustedWorkspaceAnchor(value.anchor, async () => await runStreamedFinalDebugRender({
      pkg: value.stable.pkg, lineage: value.stable.lineage, outputPath: join(value.root, "out.mp4"), frameLane: "browser", preset: "mp4-h264",
      warnings: [], transport: { delivery: "streamed", reason: "stream_default" }, context: { ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version coordinated-lineage-test", stderr: "" }) }, dryRun: false,
      revalidateLineage: pause.revalidate, persistReceipt: async () => "/receipt.json"
    }));

    await mutateAfterPause(value, pause);
    await expect(result).resolves.toMatchObject({ ok: false, error: { code: "render_failed", message: expect.stringContaining("lineage changed") } });
    await expectNoOutputAllocation(value);
  });

  it("refuses a GPU-capable mutation after adapter preflight and before output reservation", async () => {
    const value = await fixture(true);
    const pause = pausedAdapterRevalidation(value);
    const result = withTrustedWorkspaceAnchor(value.anchor, async () => await runStreamedFinalDebugRender({
      pkg: value.stable.pkg, lineage: value.stable.lineage, outputPath: join(value.root, "out.mp4"), frameLane: "gpu", preset: "mp4-h264",
      warnings: [], transport: { delivery: "streamed", reason: "stream_default" }, context: { ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version coordinated-lineage-test", stderr: "" }) }, dryRun: false,
      revalidateLineage: pause.revalidate, persistReceipt: async () => "/receipt.json"
    }));

    await mutateAfterPause(value, pause);
    await expect(result).resolves.toMatchObject({ ok: false, error: { code: "render_failed", message: expect.stringContaining("lineage changed") } });
    await expectNoOutputAllocation(value);
  });

  it("refuses a late mutation after injected streamed health and before its output publication reservation", async () => {
    const value = await fixture();
    const pause = pausedHealth();
    let rendererCalls = 0;
    const result = withTrustedWorkspaceAnchor(value.anchor, async () => await runStreamedFinalDebugRender({
      pkg: value.stable.pkg, lineage: value.stable.lineage, outputPath: join(value.root, "out.mp4"), frameLane: "browser", preset: "mp4-h264",
      warnings: [], transport: { delivery: "streamed", reason: "stream_default" },
      context: { ffmpegRunner: pause.runner, streamingFinalRenderer: async () => { rendererCalls += 1; throw new Error("must not allocate or render"); } }, dryRun: false,
      revalidateLineage: revalidate(value), persistReceipt: async () => "/receipt.json"
    }));

    await mutateAfterPause(value, pause);
    await expect(result).resolves.toMatchObject({ ok: false, error: { code: "render_failed", message: expect.stringContaining("lineage changed") } });
    expect(rendererCalls).toBe(0);
    await expectNoOutputAllocation(value);
  });

  it("refuses a late mutation before segmented prepareOutputFile", async () => {
    const value = await fixture();
    const pause = pausedHealth();
    const result = withTrustedWorkspaceAnchor(value.anchor, async () => await runSegmentedFinalDebugRender({
      pkg: value.stable.pkg, lineage: value.stable.lineage, outputPath: join(value.root, "out.mp4"), frameLane: "browser", preset: "mp4-h264",
      segmented: { segmentFrames: 12 }, warnings: [], context: { ffmpegRunner: pause.runner }, dryRun: false,
      revalidateLineage: revalidate(value), persistReceipt: async () => "/receipt.json"
    }));

    await mutateAfterPause(value, pause);
    await expect(result).resolves.toMatchObject({ ok: false, error: { code: "render_failed", message: expect.stringContaining("lineage changed") } });
    await expectNoOutputAllocation(value);
  });

  it("projects renderer-authenticated segmented publication uncertainty into the Debug producer failure", async () => {
    const value = await fixture();
    const outputPath = join(value.root, "possibly-published.mp4");
    const result = await withTrustedWorkspaceAnchor(value.anchor, async () => await runSegmentedFinalDebugRender({
      pkg: value.stable.pkg, lineage: value.stable.lineage, outputPath, frameLane: "browser", preset: "mp4-h264",
      segmented: { segmentFrames: 12 }, warnings: [], dryRun: false,
      context: {
        ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version segmented-uncertainty-test", stderr: "" }),
        segmentedFinalRenderer: async () => ({
          ok: false,
          error: {
            code: "segment_checkpoint_invalid",
            message: "final destination may have been created but could not be revalidated",
            retryable: false,
            evidence: { phase: "publish", publication: "destination_created_identity_unverified" },
            possiblyCommitted: true,
            publicPaths: [outputPath],
            expectedPublications: [{
              publicPath: outputPath,
              kind: "file",
              expectedIdentity: { dev: 1, ino: 2 },
              expected: { sha256: "a".repeat(64), byteLength: 1 }
            }]
          }
        })
      },
      persistReceipt: async () => join(value.root, "receipts", "segmented-uncertain.json")
    }));
    expect(result).toMatchObject({
      ok: false,
      error: { detail: { possiblyCommitted: true, publicPaths: [outputPath] } },
      result: { possiblyCommitted: true, publicPaths: [outputPath] }
    });
  });

  it("refuses before Debug delivered-quality readback after one published injected render", async () => {
    const value = await fixture();
    const outputPath = join(value.root, "out.mp4");
    let healthLaunches = 0;
    let rendererCalls = 0;
    let qualityCalls = 0;
    let persisted = 0;
    let checks = 0;
    const result = await withTrustedWorkspaceAnchor(value.anchor, async () => await runStreamedFinalDebugRender({
      pkg: value.stable.pkg, lineage: value.stable.lineage, outputPath, frameLane: "browser", preset: "mp4-h264",
      warnings: [], transport: { delivery: "streamed", reason: "stream_default" },
      context: {
        ffmpegRunner: async () => { healthLaunches += 1; return { exitCode: 0, stdout: "ffmpeg version coordinated-lineage-test", stderr: "" }; },
        streamingFinalRenderer: async (streamingInput) => {
          rendererCalls += 1;
          await writeFile(streamingInput.outputPath, "injected-streamed-output", "utf8");
          return {
            ok: true,
            command: { executable: "ffmpeg", args: ["-f", "image2pipe", "-i", "pipe:0", streamingInput.outputPath], shell: false },
            receipt: {
              schema: "shellx-motion/receipt@1", id: "quality-lineage-receipt", operation: "render.final", status: "passed",
              packageId: streamingInput.pkg.manifest.id, inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-09-02T00:00:00.000Z",
              lane: "ffmpeg", output: { path: streamingInput.outputPath }, warnings: []
            },
            transport: { delivery: "streamed", reason: "stream_default" }
          } as never;
        }
      },
      dryRun: false,
      evaluateDeliveredQuality: async () => { qualityCalls += 1; return { qualityCheck: { ok: true } as never }; },
      revalidateLineage: async () => {
        checks += 1;
        if (checks === 5) throw new Error("stable lineage changed before Debug quality readback");
      },
      persistReceipt: async () => { persisted += 1; return "/receipt.json"; }
    }));

    expect(result).toMatchObject({ ok: false, error: { code: "render_failed", message: "stable lineage changed before Debug quality readback" } });
    expect(checks).toBe(5);
    expect(healthLaunches).toBe(1);
    expect(rendererCalls).toBe(1);
    expect(qualityCalls).toBe(0);
    expect(persisted).toBe(0);
    await expect(readFile(outputPath, "utf8")).resolves.toBe("injected-streamed-output");
  });
});
