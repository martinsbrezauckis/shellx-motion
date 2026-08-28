import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { derivePackageRenderLineage } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import type { RenderStreamingFinalResult, StreamingFinalFrameTransportEvidence } from "@shellx-motion/renderer-ffmpeg";
import { dispatchDebugCommand, type MotionDebugContext } from "./index";

const tempDirs: string[] = [];
const CONTRAST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64"
);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("motion.render.final streamed video adoption", () => {
  it("dry-runs the closed durable segmented selector without exposing a store path", async () => {
    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: resolve(".scratch/host-tests/segmented-final/default.mp4"),
      segmented: { segmentFrames: 48 },
      dryRun: true
    }, { tier: "render_motion" });
    expect(result).toMatchObject({
      ok: true,
      result: { dryRun: true, segmented: { segmentFrames: 48, resume: false, store: "derived-from-output" } }
    });
    expect(JSON.stringify(result)).not.toContain("segments.ffconcat");
  });

  it("refuses incompatible and malformed durable segmented selectors before rendering", async () => {
    const base = { packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath: resolve(".scratch/host-tests/segmented-final/refusal.mp4") };
    await expect(dispatchDebugCommand("motion.render.final", {
      ...base, segmented: { segmentFrames: 48 }, keepFrames: true
    }, { tier: "render_motion" })).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
    await expect(dispatchDebugCommand("motion.render.final", {
      ...base, segmented: { segmentFrames: 48, storeRoot: "/caller-controlled" }
    }, { tier: "render_motion" })).resolves.toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("dry-runs a default video as image2pipe without a materialized preflight", async () => {
    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: resolve(".scratch/host-tests/streamed-final/default.mp4"),
      dryRun: true
    }, {
      tier: "render_motion",
      materializedFrameSequencePreflight: { jobPolicy: { maxProcessTreeRssBytes: 64 * 1024 * 1024 } }
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        dryRun: true,
        frameTransport: { delivery: "streamed", reason: "stream_default" },
        ffmpeg: { shell: false, args: expect.arrayContaining(["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"]) }
      }
    });
    if (!result.ok) return;
    expect((result.result as Record<string, unknown>).resourcePreflight).toBeUndefined();
    expect(JSON.stringify(result.result)).not.toContain("%06d.png");
  });

  it("refuses an unverified browser HTML font-fallback attestation before the Debug/MCP streaming seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-html-typography-"));
    tempDirs.push(root);
    const packageRoot = await writeUnverifiedHtmlTypographyPackage(root);
    let streamedCalls = 0;

    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot,
      outputPath: join(root, "out.mp4")
    }, {
      tier: "render_motion",
      streamingFinalRenderer: async () => {
        streamedCalls += 1;
        throw new Error("preflight must refuse before streaming execution");
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "browser_html_typography_unverified",
        detail: { attestation: "font-fallback", scope: "html-web-canvas", layerIds: ["interactive"] }
      }
    });
    expect(streamedCalls).toBe(0);
  });

  it("materializes only for the planner's explicit retention, exact-quality, capacity, and injected-frame seams", async () => {
    const args = {
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: resolve(".scratch/host-tests/streamed-final/materialized.mp4"),
      dryRun: true
    };
    const exactRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-quality-"));
    tempDirs.push(exactRoot);
    const exact = await dispatchDebugCommand("motion.render.final", {
      ...args,
      qualityManifestPath: join(exactRoot, "quality.json")
    }, { tier: "render_motion", scratchRoot: exactRoot });
    const capacity = await dispatchDebugCommand("motion.render.final", {
      ...args,
      minUniqueFrameHashes: 65
    }, { tier: "render_motion" });
    const retained = await dispatchDebugCommand("motion.render.final", { ...args, keepFrames: true }, { tier: "render_motion" });
    const injected = await dispatchDebugCommand("motion.render.final", args, {
      tier: "render_motion",
      browserFrameRenderer: async () => { throw new Error("dry run must not render"); }
    });

    for (const [result, reason] of [
      [exact, "exact_source_quality"],
      [capacity, "streaming_quality_capacity"],
      [retained, "explicit_frame_retention"],
      [injected, "injected_frame_renderer"]
    ] as const) {
      expect(result).toMatchObject({
        ok: true,
        result: { frameTransport: { delivery: "materialized", reason }, resourcePreflight: { schema: "shellx-motion/materialized-frame-preflight@1" } }
      });
    }
  });

  it("refuses retention for non-video final exports and row-resolved batch presets", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-keep-frames-refusal-"));
    tempDirs.push(root);
    const rowsPath = join(root, "rows.json");
    await writeFile(rowsPath, JSON.stringify({
      schema: "shellx-motion/data-rows@1",
      rows: [{ id: "still", name: "Still", background: "#111827", accent: "#22c55e", render: { preset: "png-frame" } }]
    }), "utf8");

    const final = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath: join(root, "frame.png"), preset: "png-frame", keepFrames: true, dryRun: true
    }, { tier: "render_motion" });
    expect(final).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.render.final keepFrames requires a final-video FFmpeg preset." }
    });

    const batchOutDir = join(root, "batch");
    const batch = await dispatchDebugCommand("motion.render.batch", {
      packageRoot: resolve("../../fixtures/packages/batch-card"), outDir: batchOutDir, rowsPath, keepFrames: true, dryRun: true
    }, { tier: "render_motion", scratchRoot: root });
    expect(batch).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "motion.render.batch keepFrames requires final-video FFmpeg presets; png-frame is not eligible." }
    });
    await expect(readdir(batchOutDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the host streaming seam for execution and persists its streamed receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-streamed-execution-"));
    tempDirs.push(root);
    const packageRoot = join(root, "package");
    await cp(resolve("../../fixtures/packages/lower-third"), packageRoot, { recursive: true });
    const outputPath = join(root, "out.mp4");
    const receiptsRoot = join(root, "receipts");
    let streamedCalls = 0;
    const lineage = await derivePackageRenderLineage(packageRoot);
    const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => await dispatchDebugCommand("motion.render.final", {
      packageRoot, outputPath, receiptsRoot
    }, {
      tier: "render_motion",
      ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version streamed-test", stderr: "" }),
      streamingFinalRenderer: async (input) => {
        streamedCalls += 1;
        await writeFile(input.outputPath, "host-streamed final", "utf8");
        const frameTransport = streamedFrameTransportEvidence();
        const streamed: RenderStreamingFinalResult = {
          ok: true,
          command: { executable: "ffmpeg", args: ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"], shell: false },
          receipt: {
            schema: "shellx-motion/receipt@1", id: "streamed-debug-receipt", operation: "render.final", status: "passed",
            packageId: input.pkg.manifest.id, inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-08T00:00:00.000Z",
            lane: "ffmpeg",
            output: {
              path: input.outputPath,
              frameTransport
            },
            warnings: []
          },
          transport: frameTransport
        };
        return streamed;
      }
    }));

    expect(streamedCalls).toBe(1);
    await expect(readFile(outputPath, "utf8")).resolves.toBe("host-streamed final");
    expect(result).toMatchObject({
      ok: true,
      receiptId: "streamed-debug-receipt",
      result: { frameTransport: { delivery: "streamed", reason: "stream_default" } }
    });
    if (!result.ok) return;
    const receiptPath = (result.result as Record<string, string>).receiptPath;
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
      id: "streamed-debug-receipt",
      lane: "ffmpeg",
      inputHashes: {
        manifestSha256: lineage.manifestSha256,
        motionSha256: lineage.motionSha256
      },
      output: { frameTransport: { delivery: "streamed", retainedFrameCount: 0 } }
    });
  });

  it("refuses an existing streamed output before FFmpeg or the renderer starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-streamed-existing-"));
    tempDirs.push(root);
    const outputPath = join(root, "out.mp4");
    await writeFile(outputPath, "existing final cut", "utf8");
    let ffmpegCalls = 0;
    let streamedCalls = 0;

    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath
    }, {
      tier: "render_motion",
      ffmpegRunner: async () => { ffmpegCalls += 1; return { exitCode: 0, stdout: "", stderr: "" }; },
      streamingFinalRenderer: async () => { streamedCalls += 1; throw new Error("must not render"); }
    });

    expect(result).toMatchObject({ ok: false, error: { code: "derived_output_exists" } });
    expect(ffmpegCalls).toBe(0);
    expect(streamedCalls).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe("existing final cut");
    expect(await readdir(root)).toEqual(["out.mp4"]);
  });

  it("cleans non-retained materialization without returning deleted frame paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-transient-frames-"));
    tempDirs.push(root);
    const manifestPath = join(root, "quality.json");
    await writeFile(manifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [{ id: "must-fail", atMs: 0, minBrightPixels: 999 }]
    }), "utf8");
    const runner = async (command: { executable: string; args: string[] }) => {
      if (command.executable.includes("ffprobe")) {
        if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffprobe version transient-test", stderr: "" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 2, height: 1, avg_frame_rate: "24/1" }], format: { duration: "2.000000" } }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version transient-test", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      const outputPath = command.args.at(-1)!;
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, outputPath.endsWith(".png") ? CONTRAST_PNG : Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom transient", "ascii")]));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const browserFrameRenderer: NonNullable<MotionDebugContext["browserFrameRenderer"]> = async (pkg, options) => {
      const path = options.outputPath ?? join(options.outDir, "frame.png");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, CONTRAST_PNG);
      const output = {
        path,
        sha256: "a".repeat(64),
        format: "png" as const,
        width: pkg.motion.width,
        height: pkg.motion.height,
        atMs: options.atMs,
        browser: { name: "chromium", version: "transient-test" },
        viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
      };
      return {
        ok: true as const,
        output,
        receipt: {
          schema: "shellx-motion/receipt@1",
          id: `preview-${options.atMs}`,
          operation: "preview.frame",
          status: "passed",
          packageId: pkg.manifest.id,
          inputHashes: { motion: "a".repeat(64) },
          createdAt: "2026-08-08T00:00:00.000Z",
          lane: "browser",
          output,
          warnings: []
        }
      };
    };
    const context = { tier: "render_motion" as const, scratchRoot: root, ffmpegRunner: runner, browserFrameRenderer };
    const transientFramesDir = join(root, "pkg_lower_third");
    const success = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath: join(root, "success.mp4"), keepFrames: false
    }, context);
    expect(success).toMatchObject({ ok: true, result: { frameTransport: { delivery: "materialized", reason: "injected_frame_renderer" } } });
    if (!success.ok) return;
    const successPayload = success.result as Record<string, unknown>;
    expect(successPayload.frameReceipt).toBeUndefined();
    expect(successPayload.frames).toBeUndefined();
    expect(JSON.stringify(successPayload)).not.toContain(transientFramesDir);
    await expect(readdir(transientFramesDir)).rejects.toMatchObject({ code: "ENOENT" });

    const failure = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath: join(root, "failure.mp4"), qualityManifestPath: manifestPath
    }, context);
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    const detail = failure.error.detail as Record<string, unknown>;
    expect(detail.frameReceipt).toBeUndefined();
    expect(detail.frames).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain(transientFramesDir);
    await expect(readdir(transientFramesDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs fresh GPU batch rows through the injected stream, refusing stale/non-video/unavailable paths before output", async () => {
    const root = await hostTestDir("gpu-batch-"); tempDirs.push(root);
    const packageRoot = resolve("../../fixtures/packages/batch-card"), base = { packageRoot, frameLane: "gpu" as const, preset: "mp4-h264", dryRun: false };
    let calls = 0;
    const context: MotionDebugContext = {
      tier: "render_motion", scratchRoot: root, gpuFinalExecutionAvailable: true,
      ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version gpu-batch-test", stderr: "" }),
      streamingFinalRenderer: async (input) => {
        calls += 1; await writeFile(input.outputPath, "gpu batch final", "utf8");
        const transport = { ...streamedFrameTransportEvidence(), frameLane: "gpu" } as unknown as StreamingFinalFrameTransportEvidence;
        return { ok: true, command: { executable: "ffmpeg", args: [], shell: false }, receipt: { schema: "shellx-motion/receipt@1", id: `gpu-batch-${calls}`, operation: "render.final", status: "passed", packageId: input.pkg.manifest.id, inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-14T00:00:00.000Z", lane: "ffmpeg", output: { path: input.outputPath, frameTransport: transport }, warnings: [] }, transport } as RenderStreamingFinalResult;
      }
    };
    const success = await dispatchDebugCommand("motion.render.batch", { ...base, outDir: join(root, "success") }, context);
    expect(success, success.ok ? "" : JSON.stringify(success.error)).toMatchObject({ ok: true, result: { jobs: [{ frameLane: "gpu", frameTransport: { delivery: "streamed" } }, { frameLane: "gpu", frameTransport: { delivery: "streamed" } }] } });
    expect(calls).toBe(2);
    for (const [name, args, host] of [
      ["nonvideo", { ...base, outDir: join(root, "nonvideo"), preset: "png-sequence" }, context],
      ["resume", { ...base, outDir: join(root, "resume"), resume: true }, context],
      ["unavailable", { ...base, outDir: join(root, "unavailable") }, { ...context, gpuFinalExecutionAvailable: false }]
    ] as const) {
      const result = await dispatchDebugCommand("motion.render.batch", args, host);
      expect(result.ok, name).toBe(false); await expect(readdir(args.outDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(calls).toBe(2);
  });

  it("keeps a GPU batch quality closure in the plan receipt without materializing source frames", async () => {
    const root = await hostTestDir("gpu-batch-quality-"); tempDirs.push(root);
    const manifestPath = join(root, "quality.json"), outDir = join(root, "batch");
    await writeFile(manifestPath, JSON.stringify({ schema: "shellx-motion/quality-manifest@1", samples: [{ id: "delivered", atMs: 0, minBrightPixels: 0 }] }));
    const result = await dispatchDebugCommand("motion.render.batch", { packageRoot: resolve("../../fixtures/packages/batch-card"), outDir, frameLane: "gpu", preset: "mp4-h264", dryRun: true, qualityManifestPath: manifestPath }, { tier: "render_motion", scratchRoot: root, gpuFinalExecutionAvailable: true });
    expect(result, result.ok ? "" : JSON.stringify(result.error)).toMatchObject({ ok: true });
    if (!result.ok) return;
    type QualityJob = { rowId: string; frameLane: string; frameTransport: { delivery: string }; qualityInputs: { closureSha256: string } };
    const plannedJobs = (result.result as { jobs: QualityJob[] }).jobs;
    expect(plannedJobs).toHaveLength(2);
    expect(plannedJobs.map((job) => job.rowId)).toEqual(["ada", "grace"]);
    for (const job of plannedJobs) {
      expect(job).toMatchObject({ frameLane: "gpu", frameTransport: { delivery: "streamed" }, qualityInputs: { closureSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    }
    expect(new Set(plannedJobs.map((job) => job.qualityInputs.closureSha256)).size).toBe(1);
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "batch-render.receipt.json"), "utf8"));
    expect(receipt.output).toMatchObject({ frameLane: "gpu" });
    const receiptJobs = receipt.output.jobs as QualityJob[];
    expect(receiptJobs).toHaveLength(2);
    expect(receiptJobs.map((job) => job.rowId)).toEqual(["ada", "grace"]);
    for (const job of receiptJobs) {
      expect(job).toMatchObject({ frameLane: "gpu", frameTransport: { delivery: "streamed" }, qualityInputs: { closureSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    }
    expect(receiptJobs.map((job) => job.qualityInputs.closureSha256)).toEqual(plannedJobs.map((job) => job.qualityInputs.closureSha256));
  });
});

function streamedFrameTransportEvidence(): StreamingFinalFrameTransportEvidence {
  return {
    delivery: "streamed",
    frameLane: "browser",
    frameCount: 1,
    retainedFrameCount: 0,
    producer: {
      frameLane: "browser",
      evidence: {
        schema: "shellx-motion/browser-streaming-producer@1",
        warningUnion: [],
        warningsOmitted: 0,
        stableInputHashUnion: {},
        stableInputHashKeysOmitted: 0,
        stableInputHashConflictKeys: [],
        stableInputHashConflictKeysOmitted: 0,
        processMonitoring: {
          mode: "cooperative-browser-session",
          chromiumPid: "unavailable",
          watchedRoot: "host-node-process",
          rssScope: "host-node-process-tree",
          measurement: "conservative-fallback-not-exact-per-job",
          encoderRssOverlap: "possible",
          encoderContainmentCoversChromium: false,
          reasonCode: "worker_process_unavailable"
        },
        session: { state: "closed", cleanup: "complete" }
      }
    },
    encoderHandoff: {
      delivery: "streamed",
      maxConcurrentProducerWrites: 1,
      observedMaxConcurrentProducerWrites: 1,
      maxBufferedInputBytes: 64,
      inputHighWaterMarkBytes: 64,
      maxPngBytesPerFrame: 64,
      backpressure: { writes: 1, drainWaits: 0 },
      encoderHandoffSourceFramesRetained: 0,
      qualityPlaneSetCapacity: 2,
      uniqueHashCapacity: 0,
      attempts: [{ source: "software", outcome: "succeeded" }]
    }
  };
}

async function hostTestDir(prefix: string): Promise<string> {
  const root = resolve(".scratch/host-tests"); await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  return await mkdtemp(join(root, prefix));
}

async function writeUnverifiedHtmlTypographyPackage(root: string): Promise<string> {
  const packageRoot = join(root, "package");
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(packageRoot, "manifest.json"), JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_unverified_html_typography",
    name: "Unverified HTML typography",
    motion: "motion.json",
    assets: ["card.html"],
    sourceApp: "test",
    compatibility: { lanes: ["browser"], hosts: ["motion"] },
    quality: { maxFontFallbacks: 0 }
  }));
  await writeFile(join(packageRoot, "motion.json"), JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_unverified_html_typography",
    name: "Unverified HTML typography",
    durationMs: 1_000,
    fps: 1,
    width: 64,
    height: 36,
    layers: [{ id: "interactive", type: "web", source: "card.html", startMs: 0, durationMs: 1_000 }],
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" }
  }));
  await writeFile(join(packageRoot, "card.html"), "<canvas id=\"dynamic\"></canvas>");
  return packageRoot;
}
