/**
 * local-render-tool-provenance.test.ts — the local SDK's share of FFprobe receipt provenance.
 *
 * the tool-provenance invariant named three surfaces that must record the same evidence: the CLI, the
 * debug/MCP transport, and the local SDK. The SDK's render path is not a fourth implementation — it
 * dispatches `motion.render.final` and persists the receipt that command returns — so the fix lands
 * there by inheritance. Inheritance is exactly the kind of claim that quietly stops being true, so
 * it is asserted here on the RECEIPT FILE the SDK writes to disk, which is the artefact a host or
 * ShellX Cut actually reads.
 *
 * No real FFmpeg or FFprobe runs: the SDK's `ffmpegRunner` seam answers every command.
 *
 * Dependencies: `./local` (SDK), the debug API it dispatches into. Primary caller: vitest.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashFile } from "@shellx-motion/core";
import type { RenderStreamingFinalResult, StreamingFinalFrameTransportEvidence } from "@shellx-motion/renderer-ffmpeg";
import { createLocalMotionSdk, createLocalMotionSdkTransport, type LocalMotionSdkOptions } from "./local";
import { MOTION_SDK_SCHEMA } from "./types";

const tempDirs: string[] = [];

/** A 2×1 PNG with one bright and one dark pixel — enough to satisfy a `minBrightPixels` sample. */
const CONTRAST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64"
);

/** Read the single render receipt the SDK persisted under `receiptsRoot`. */
async function readRenderReceipt(receiptsRoot: string, receiptId: string): Promise<Record<string, unknown>> {
  const files = await readdir(receiptsRoot);
  const match = files.find((file) => file.includes(receiptId.replace(/[^a-zA-Z0-9_.-]/g, "_")));
  expect(match, `no receipt file for ${receiptId} in ${files.join(", ")}`).toBeDefined();
  return JSON.parse(await readFile(join(receiptsRoot, match as string), "utf8")) as Record<string, unknown>;
}

async function createPrivateArtifactRoot(root: string): Promise<void> {
  await mkdir(join(root, ".shellx-motion", "receipts"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".shellx-motion", "scratch"), { recursive: true, mode: 0o700 });
}

function sdkFor(counters: { encodes: number; ffprobeVersionProbes: number }, hostOptions: Pick<LocalMotionSdkOptions, "materializedFrameSequencePreflight"> = {}) {
  return createLocalMotionSdk({
    ...hostOptions,
    browserFrameRenderer: async (pkg, options) => {
      const path = options.outputPath ?? join(options.outDir, "frame.png");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, CONTRAST_PNG);
      const output = {
        path,
        sha256: await hashFile(path),
        format: "png" as const,
        width: pkg.motion.width,
        height: pkg.motion.height,
        atMs: options.atMs,
        browser: { name: "chromium", version: "sdk-test" },
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
          inputHashes: { motion: "d".repeat(64) },
          createdAt: "2026-07-01T00:00:00.000Z",
          lane: "browser",
          output,
          warnings: []
        }
      };
    },
    ffmpegRunner: async (command) => {
      if (command.executable.includes("ffprobe")) {
        if (command.args[0] === "-version") {
          counters.ffprobeVersionProbes += 1;
          return { exitCode: 0, stdout: "ffprobe version sdk-fixture", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 960, height: 540, avg_frame_rate: "24/1" }],
            format: { duration: "2.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version sdk-fixture", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      // Branch on the OUTPUT EXTENSION, not on `-frames:v`: the image-sequence encode itself carries
      // `-frames:v` to bound the muxed output, so keying on the flag wrote PNG bytes into the .mp4
      // and the artifact magic-byte check rejected it.
      if (outputPath.endsWith(".png")) await writeFile(outputPath, CONTRAST_PNG);
      else {
        counters.encodes += 1;
        await writeFile(outputPath, Buffer.from([0, 0, 0, 24, ...Buffer.from(`ftypisom sdk local ${counters.encodes}`, "ascii")]));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  });
}

describe("local SDK render — FFprobe provenance parity", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("refuses retained frames for a non-final-video preset in the local adapter", async () => {
    const response = await createLocalMotionSdkTransport().execute({
      schema: MOTION_SDK_SCHEMA,
      operation: "render",
      requestId: "sdk-render-png-keep-frames",
      cacheKey: "a".repeat(64),
      input: {
        packageRoot: "/not-read-after-preset-refusal",
        outputPath: "/not-written.png",
        artifactRoot: "/not-written",
        preset: "png-frame",
        keepFrames: true
      }
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: "SDK render keepFrames: true requires a final-video FFmpeg preset." }
    });
  });

  it("persists output.tools.ffprobe on the receipt when a quality manifest read the encode back", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-tool-provenance-"));
    tempDirs.push(root);
    const artifactRoot = join(root, "run");
    const receiptsRoot = join(artifactRoot, ".shellx-motion", "receipts");
    const manifestPath = join(root, "quality-manifest.json");
    await createPrivateArtifactRoot(artifactRoot);
    await writeFile(manifestPath, `${JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [{ id: "sample", atMs: 0, minBrightPixels: 1, minEdgePixels: 0, maxChangedPixels: 0, maxMeanDiff: 0 }]
    }, null, 2)}\n`, "utf8");
    const counters = { encodes: 0, ffprobeVersionProbes: 0 };

    const rendered = await sdkFor(counters).render({
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(artifactRoot, "final.mp4"),
      artifactRoot,
      receiptsRoot,
      preset: "mp4-h264",
      qualityManifestPath: manifestPath
    });
    if (!rendered.ok) throw new Error(`local SDK render failed: ${JSON.stringify(rendered.error)}`);

    const receipt = await readRenderReceipt(receiptsRoot, rendered.output.receiptId as string);
    const tools = (receipt.output as Record<string, unknown>).tools as Record<string, unknown>;
    const resourcePreflight = (receipt.output as Record<string, unknown>).resourcePreflight as Record<string, unknown>;

    // The SDK does not re-implement the rule; it inherits the debug API's. Asserted on the persisted
    // file because that is what a host and ShellX Cut read.
    expect(tools.ffprobe).toMatchObject({ tool: "ffprobe", version: "ffprobe version sdk-fixture" });
    expect(tools.ffmpeg).toMatchObject({ tool: "ffmpeg" });
    // The same persisted final-render receipt names the pre-allocation budget and estimate the SDK
    // inherited from Debug/Core; it must not become a CLI-only capability card claim.
    expect(resourcePreflight).toMatchObject({
      schema: "shellx-motion/materialized-frame-preflight@1",
      status: "admitted",
      budget: { processTreeRssCeilingBytes: expect.any(Number), admissionBytes: expect.any(Number) },
      estimate: { bytes: expect.any(Number), conservative: true }
    });
    expect(counters.ffprobeVersionProbes).toBe(1);
    // Additive: the fields a receipt consumer already binds to are untouched.
    expect(receipt).toMatchObject({ schema: "shellx-motion/receipt@1", operation: "render.final", lane: "ffmpeg" });
  }, 120000);

  it("leaves FFprobe unnamed, and unprobed, on a render with no quality manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-tool-provenance-absent-"));
    tempDirs.push(root);
    const artifactRoot = join(root, "run");
    const receiptsRoot = join(artifactRoot, ".shellx-motion", "receipts");
    const counters = { encodes: 0, ffprobeVersionProbes: 0 };
    await createPrivateArtifactRoot(artifactRoot);

    const rendered = await sdkFor(counters).render({
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(artifactRoot, "final.mp4"),
      artifactRoot,
      receiptsRoot,
      preset: "mp4-h264"
    });
    if (!rendered.ok) throw new Error(`local SDK render failed: ${JSON.stringify(rendered.error)}`);

    const receipt = await readRenderReceipt(receiptsRoot, rendered.output.receiptId as string);
    const tools = (receipt.output as Record<string, unknown>).tools as Record<string, unknown>;

    expect(tools.ffmpeg).toBeDefined();
    // Nothing read the file back, so nothing claims to have — and no process was spawned to ask.
    expect(tools.ffprobe).toBeUndefined();
    expect(counters.ffprobeVersionProbes).toBe(0);
  }, 120000);

  it("uses the local SDK's host-only streaming seam for the ordinary file-video default", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-streamed-final-"));
    tempDirs.push(root);
    const artifactRoot = join(root, "run");
    const receiptsRoot = join(artifactRoot, ".shellx-motion", "receipts");
    await createPrivateArtifactRoot(artifactRoot);
    let streamedCalls = 0;
    const sdk = createLocalMotionSdk({
      ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version sdk-streamed-fixture", stderr: "" }),
      streamingFinalRenderer: async (input) => {
        streamedCalls += 1;
        await mkdir(dirname(input.outputPath), { recursive: true, mode: 0o700 });
        await writeFile(input.outputPath, Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom sdk streamed", "ascii")]));
        const frameTransport = streamedFrameTransportEvidence();
        const streamed: RenderStreamingFinalResult = {
          ok: true,
          command: { executable: "ffmpeg", args: ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"], shell: false },
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: "sdk-streamed-receipt",
            operation: "render.final",
            status: "passed",
            packageId: input.pkg.manifest.id,
            inputHashes: {
              frames: "a".repeat(64),
              "audio:0": "b".repeat(64),
              "gpu-static-plan": "c".repeat(64),
            },
            createdAt: "2026-08-08T00:00:00.000Z",
            lane: "ffmpeg",
            output: { path: input.outputPath, sha256: await hashFile(input.outputPath), frameTransport },
            warnings: []
          },
          transport: frameTransport
        };
        return streamed;
      }
    });

    const rendered = await sdk.render({
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(artifactRoot, "final.mp4"),
      artifactRoot,
      receiptsRoot,
      preset: "mp4-h264"
    });
    if (!rendered.ok) throw new Error(`streamed local SDK render failed: ${JSON.stringify(rendered.error)}`);

    expect(streamedCalls).toBe(1);
    expect(rendered.output.frames).toBeUndefined();
    const receipt = await readRenderReceipt(receiptsRoot, rendered.output.receiptId as string);
    if (!rendered.output.artifact?.packageLineage) throw new Error("expected attested package lineage");
    expect(receipt.inputHashes).toEqual({
      operationHash: rendered.cacheKey,
      manifestSha256: rendered.output.artifact.packageLineage.manifestSha256,
      motionSha256: rendered.output.artifact.packageLineage.motionSha256,
    });
    expect(receipt.output).toMatchObject({
      frameTransport: {
        delivery: "streamed",
        frameLane: "browser",
        retainedFrameCount: 0,
        encoderHandoff: { encoderHandoffSourceFramesRetained: 0 }
      },
      rendererInputHashes: {
        frames: "a".repeat(64),
        "audio:0": "b".repeat(64),
        "gpu-static-plan": "c".repeat(64),
      },
    });
    await expect(readdir(join(artifactRoot, ".shellx-motion", "scratch", rendered.cacheKey, "pkg_lower_third"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120000);

  it("forwards the browser HTML typography-attestation refusal before the local SDK streaming seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-html-typography-"));
    tempDirs.push(root);
    const packageRoot = await writeUnverifiedHtmlTypographyPackage(root);
    let streamedCalls = 0;
    const sdk = createLocalMotionSdk({
      streamingFinalRenderer: async () => {
        streamedCalls += 1;
        throw new Error("the typography refusal must occur before a streaming encoder is created");
      }
    });

    const rendered = await sdk.render({
      packageRoot,
      outputPath: join(root, "run", "final.mp4"),
      artifactRoot: join(root, "run"),
      preset: "mp4-h264"
    });

    expect(rendered).toMatchObject({
      ok: false,
      error: {
        code: "browser_html_typography_unverified",
        detail: { attestation: "font-fallback", scope: "html-web-canvas", layerIds: ["interactive"] }
      }
    });
    expect(streamedCalls).toBe(0);
  });

  it("uses scratch for injected materialization and retains it only for explicit keepFrames", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-keep-frames-"));
    tempDirs.push(root);
    const transientRoot = join(root, "transient");
    const retainedRoot = join(root, "retained");
    const transientKey = "a".repeat(64);
    const retainedKey = "b".repeat(64);
    await Promise.all([createPrivateArtifactRoot(transientRoot), createPrivateArtifactRoot(retainedRoot)]);

    const transient = await sdkFor({ encodes: 0, ffprobeVersionProbes: 0 }).render({
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(transientRoot, "final.mp4"),
      artifactRoot: transientRoot,
      preset: "mp4-h264",
      idempotencyKey: transientKey
    });
    if (!transient.ok) throw new Error(`transient local SDK render failed: ${JSON.stringify(transient.error)}`);
    const transientReceipt = await readRenderReceipt(join(transientRoot, ".shellx-motion", "receipts"), transient.output.receiptId as string);

    // The SDK's injected browser seam still requires materialization, but an omitted keepFrames
    // must not publish its temporary directory as the historical default framesDir did.
    expect(transientReceipt.output).toMatchObject({
      frameTransportPlan: { delivery: "materialized", reason: "injected_frame_renderer" }
    });
    expect(transient.output.frames).toBeUndefined();
    await expect(readdir(join(transientRoot, ".shellx-motion", "scratch", transientKey, "pkg_lower_third"))).rejects.toMatchObject({ code: "ENOENT" });

    const retainedCounters = { encodes: 0, ffprobeVersionProbes: 0 };
    const retainedSdk = sdkFor(retainedCounters);
    const retainedRequest = {
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(retainedRoot, "final.mp4"),
      artifactRoot: retainedRoot,
      preset: "mp4-h264",
      idempotencyKey: retainedKey,
      keepFrames: true
    } as const;
    const retained = await retainedSdk.render(retainedRequest);
    if (!retained.ok) throw new Error(`retained local SDK render failed: ${JSON.stringify(retained.error)}`);
    const retainedReceipt = await readRenderReceipt(join(retainedRoot, ".shellx-motion", "receipts"), retained.output.receiptId as string);

    expect(retainedReceipt.output).toMatchObject({
      frameTransportPlan: { delivery: "materialized", reason: "explicit_frame_retention" }
    });
    const retainedFramesDir = join(retainedRoot, ".shellx-motion", "scratch", retainedKey, "pkg_lower_third");
    expect(retained.output.frames).toMatchObject({ dir: retainedFramesDir, count: expect.any(Number) });
    expect(retained.output.frames?.count).toBeGreaterThan(0);
    expect(await readdir(retainedFramesDir)).toContain("000001.png");

    // A diagnostic folder can be deleted independently of the attested video, but the public
    // output remains immutable: SDK has no force option and must not recreate it by overwriting.
    await rm(retainedFramesDir, { recursive: true, force: true });
    const rerendered = await retainedSdk.render(retainedRequest);
    expect(rerendered).toMatchObject({ ok: false, error: { code: "derived_output_exists" } });
    expect(retainedCounters.encodes).toBe(1);
  }, 120000);

  it("forwards the shared materialised-sequence refusal and its evidence to SDK callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-render-preflight-"));
    tempDirs.push(root);
    const artifactRoot = join(root, "run");
    const counters = { encodes: 0, ffprobeVersionProbes: 0 };

    const rendered = await sdkFor(counters, {
      materializedFrameSequencePreflight: {
        jobPolicy: { maxProcessTreeRssBytes: 64 * 1024 * 1024 }
      }
    }).render({
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(artifactRoot, "final.mp4"),
      artifactRoot,
      preset: "mp4-h264"
    });

    expect(rendered).toMatchObject({
      ok: false,
      error: {
        code: "render_resource_preflight_exceeded",
        detail: {
          resourcePreflight: {
            status: "refused",
            pipeline: { frameSequence: "materialized", encoderStreaming: false },
            budget: { source: "trusted-host", admissionBytes: Math.floor(64 * 1024 * 1024 * 0.8) }
          }
        }
      }
    });
    expect(counters.encodes).toBe(0);
  }, 120000);
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

async function writeUnverifiedHtmlTypographyPackage(root: string): Promise<string> {
  const packageRoot = join(root, "package");
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_sdk_unverified_html_typography",
    name: "SDK Unverified HTML Typography",
    motion: "motion.json",
    assets: ["card.html"],
    sourceApp: "test",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion"] },
    quality: { maxFontFallbacks: 0 }
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_sdk_unverified_html_typography",
    name: "SDK Unverified HTML Typography",
    width: 64,
    height: 64,
    fps: 1,
    durationMs: 1_000,
    layers: [{ id: "interactive", type: "web", source: "card.html", startMs: 0, durationMs: 1_000 }],
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" }
  }, null, 2)}\n`);
  await writeFile(join(packageRoot, "card.html"), "<main>unobservable browser text</main>");
  return packageRoot;
}
