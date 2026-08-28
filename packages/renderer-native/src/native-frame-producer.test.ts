/** Internal native streaming-producer contract: ordered, backpressured, and no nested admission. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashBuffer,
  LocalMotionJobError,
  LocalMotionJobGovernor,
  streamingFrameTimestampMs,
  type OperationReceipt,
} from "@shellx-motion/core";
import {
  createNativeRenderSession,
  INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL,
  type NativePreviewFrameResult,
} from "./index";
import {
  getNativeFrameProducerFailureEvidence,
  NativeFrameProducerCleanupFailure,
  NativeFrameProducerFailure,
  produceNativeFrameStream,
  type NativeFrameProducerEvidence,
  type NativeFrameProducerContext,
} from "./native-frame-producer";

const tempDirs: string[] = [];
const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64",
);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("native streaming frame producer", () => {
  it("selects first, middle, and final canonical ranges without rendering prior frames", async () => {
    const expectedTimestamps = [0, 250, 500, 750];
    const cases = [
      { range: { startFrameIndex: 0, endFrameIndexExclusive: 1 }, expectedIndexes: [0] },
      { range: { startFrameIndex: 1, endFrameIndexExclusive: 3 }, expectedIndexes: [1, 2] },
      { range: { startFrameIndex: 3, endFrameIndexExclusive: 4 }, expectedIndexes: [3] }
    ];

    for (const testCase of cases) {
      const renderedAt: number[] = [];
      const emitted: Array<{ index: number; atMs: number }> = [];
      const result = await produceNativeFrameStream({
        packageRoot: "/unused",
        frameCount: 4,
        fps: 4,
        durationMs: 1_000,
        range: testCase.range
      }, {
        write: async (frame) => { emitted.push({ index: frame.index, atMs: frame.atMs }); }
      }, admittedContext(), {
        openSession: async () => ({
          renderFrameAtMs: async (atMs) => {
            renderedAt.push(atMs);
            return successfulFrame(atMs);
          },
          close: () => undefined
        })
      });

      const expected = testCase.expectedIndexes.map((index) => ({ index, atMs: expectedTimestamps[index]! }));
      expect(renderedAt).toEqual(expected.map((frame) => frame.atMs));
      expect(emitted).toEqual(expected);
      expect(result).toMatchObject({
        ok: true,
        emittedFrameCount: expected.length,
        evidence: {
          producer: {
            timelineFrameCount: 4,
            range: { timelineFrameCount: 4, ...testCase.range, frameCount: expected.length },
            peakInFlightPngHandoffs: 1
          },
          session: { cleanupState: "closed" }
        }
      });
    }
  });

  it("rejects invalid native ranges before opening a render session", async () => {
    let opened = 0;
    for (const range of [
      { startFrameIndex: -1, endFrameIndexExclusive: 1 },
      { startFrameIndex: 1, endFrameIndexExclusive: 1 },
      { startFrameIndex: 0, endFrameIndexExclusive: 5 },
      { startFrameIndex: 0, endFrameIndexExclusive: Number.NaN }
    ]) {
      await expect(produceNativeFrameStream({
        packageRoot: "/unused",
        frameCount: 4,
        fps: 4,
        durationMs: 1_000,
        range
      }, { write: async () => undefined }, admittedContext(), {
        openSession: async () => {
          opened += 1;
          throw new Error("must not open");
        }
      })).rejects.toMatchObject({ code: "job_input_budget_exceeded" });
    }
    expect(opened).toBe(0);
  });

  it("emits one backpressured native delivery frame at a time with materialized-frame byte/hash/timestamp parity", async () => {
    const packageRoot = await writeDeliveryPackage();
    const input = { packageRoot, frameCount: 4, fps: 4, durationMs: 1_000, now: fixedNow };
    const expected = await materializedDeliveryFrames(input);
    const emitted: Array<{ index: number; atMs: number; png: Buffer; sha256: string }> = [];
    let writesInFlight = 0;
    let maxWritesInFlight = 0;
    const retention: NativeFrameProducerEvidence[] = [];
    let releaseSink!: () => void;
    let sinkEntered!: () => void;
    const sinkPaused = new Promise<void>((resolve) => { releaseSink = resolve; });
    const sinkHasFrame = new Promise<void>((resolve) => { sinkEntered = resolve; });

    const production = produceNativeFrameStream(input, {
      write: async (frame) => {
        writesInFlight += 1;
        maxWritesInFlight = Math.max(maxWritesInFlight, writesInFlight);
        expect(writesInFlight).toBe(1);
        sinkEntered();
        await sinkPaused;
        emitted.push({ ...frame, sha256: hashBuffer(frame.png) });
        writesInFlight -= 1;
      },
    }, admittedContext(), { observeRetention: (evidence) => retention.push(evidence) });

    await sinkHasFrame;
    expect(retention.at(-1)).toMatchObject({
      producer: { frameCacheEntries: 0, emittedFrameCount: 0, inFlightPngHandoffs: 1, peakInFlightPngHandoffs: 1 },
      session: {
        cleanupState: "open",
        frameCacheEntries: 0,
        assetCache: { scope: "native-render-session-decoded-assets", includedInFrameRetention: false },
      },
    });
    releaseSink();
    const result = await production;

    expect(result).toMatchObject({
      ok: true,
      emittedFrameCount: input.frameCount,
      evidence: {
        producer: {
          timelineFrameCount: 4,
          range: { timelineFrameCount: 4, startFrameIndex: 0, endFrameIndexExclusive: 4, frameCount: 4 },
          frameCacheEntries: 0,
          emittedFrameCount: 4,
          inFlightPngHandoffs: 0,
          peakInFlightPngHandoffs: 1
        },
        session: { cleanupState: "closed", frameCacheEntries: 0 },
      },
    });
    expect(retention.at(-1)).toMatchObject({
      producer: {
        frameCacheEntries: 0,
        emittedFrameCount: 4,
        inFlightPngHandoffs: 0,
        peakInFlightPngHandoffs: 1,
      },
      session: { cleanupState: "closed" },
    });
    expect(maxWritesInFlight).toBe(1);
    expect(emitted.map((frame) => [frame.index, frame.atMs])).toEqual([
      [0, 0], [1, 250], [2, 500], [3, 750],
    ]);
    expect(expected[0].sha256).not.toBe(expected[3].sha256);
    for (const [index, frame] of emitted.entries()) {
      expect(frame.atMs).toBe(streamingFrameTimestampMs(index, input.fps, input.durationMs));
      expect(frame.png.equals(expected[index].png)).toBe(true);
      expect(frame.sha256).toBe(expected[index].sha256);
    }
  });

  it("runs inside one pre-acquired maxConcurrentJobs=1 context without nesting a lease", async () => {
    const packageRoot = await writeDeliveryPackage();
    const scratchRoot = await makeTempDir("native-frame-producer-governor-");
    const frameWarning = "Native frame warning retained for downstream delivery.";
    const audioHandoff = { status: "handled_downstream", layers: [{ id: "bed", type: "audio" }] };
    const governor = new LocalMotionJobGovernor({
      maxConcurrentJobs: 1,
      maxQueueDepth: 1,
      maxQueueWaitMs: 1_000,
      maxWallClockMs: 5_000,
      minFreeScratchBytes: 0,
      scratchReservationBytes: 0,
      maxProcessTreeRssBytes: 512 * 1024 * 1024,
      rssPollIntervalMs: 1_000,
    }, { leases: null, freeScratchBytes: async () => Number.MAX_SAFE_INTEGER });

    const execution = await governor.run({
      lane: "native",
      operation: "native.frame-producer-test",
      scratchRoot,
      jobId: "native-frame-producer-test",
    }, async (job) => await produceNativeFrameStream({ packageRoot, frameCount: 1, fps: 1, durationMs: 1_000 }, {
      write: async () => {
        expect(governor.snapshot()).toMatchObject({ activeJobs: 1, queuedJobs: 0, policy: { maxConcurrentJobs: 1 } });
      },
    }, {
      signal: job.signal,
      job: { admission: "pre-acquired", jobId: job.jobId, scratchRoot: job.scratchRoot, signal: job.signal },
    }, {
      openSession: async () => ({
        renderFrameAtMs: async (atMs) => successfulFrame(atMs, [frameWarning], { audioHandoff }),
        close: () => undefined,
      }),
    }));

    expect(execution.value).toMatchObject({
      ok: true,
      emittedFrameCount: 1,
      evidence: {
        producer: { inFlightPngHandoffs: 0, peakInFlightPngHandoffs: 1 },
        session: { cleanupState: "closed" },
        terminal: {
          lastFrameReceipt: { operation: "preview.frame", status: "warning", output: { audioHandoff } },
          laneWarnings: [frameWarning],
          downstreamAudioHandoffLayers: [{ id: "bed", type: "audio" }],
        },
      },
    });
    expect(execution.evidence.policy.maxConcurrentJobs).toBe(1);
  });

  it("propagates cancellation/deadline reasons and closes the session before emitting another frame", async () => {
    const controller = new AbortController();
    const deadline = new LocalMotionJobError("job_deadline_exceeded", "native producer deadline elapsed");
    let closes = 0;
    let renders = 0;
    let writes = 0;
    const retention: NativeFrameProducerEvidence[] = [];

    await expect(produceNativeFrameStream({ packageRoot: "/unused", frameCount: 2, fps: 2, durationMs: 1_000 }, {
      write: async () => { writes += 1; },
    }, admittedContext(controller), {
      openSession: async () => ({
        renderFrameAtMs: async (atMs) => {
          renders += 1;
          controller.abort(deadline);
          return successfulFrame(atMs);
        },
        close: () => { closes += 1; },
      }),
      observeRetention: (evidence) => retention.push(evidence),
    })).rejects.toBe(deadline);

    expect({ renders, writes, closes }).toEqual({ renders: 1, writes: 0, closes: 1 });
    expect(getNativeFrameProducerFailureEvidence(deadline)).toMatchObject({
      producer: { emittedFrameCount: 0, inFlightPngHandoffs: 0, peakInFlightPngHandoffs: 0 },
      session: { cleanupState: "closed" },
    });
    expect(retention.at(-1)).toMatchObject({ session: { cleanupState: "closed" } });
  });

  it("closes the native session and preserves a frozen encoder Error when the sink fails", async () => {
    const sinkFailure = Object.freeze(new Error("encoder stdin closed"));
    let closes = 0;
    let renders = 0;
    const retention: NativeFrameProducerEvidence[] = [];

    await expect(produceNativeFrameStream({ packageRoot: "/unused", frameCount: 2, fps: 2, durationMs: 1_000 }, {
      write: async () => { throw sinkFailure; },
    }, admittedContext(), {
      openSession: async () => ({
        renderFrameAtMs: async (atMs) => {
          renders += 1;
          return successfulFrame(atMs);
        },
        close: () => { closes += 1; },
      }),
      observeRetention: (evidence) => retention.push(evidence),
    })).rejects.toBe(sinkFailure);

    expect({ renders, closes }).toEqual({ renders: 1, closes: 1 });
    expect(getNativeFrameProducerFailureEvidence(sinkFailure)).toMatchObject({
      producer: { emittedFrameCount: 0, inFlightPngHandoffs: 0, peakInFlightPngHandoffs: 1 },
      session: { cleanupState: "closed" },
    });
    expect(retention.at(-1)).toMatchObject({ session: { cleanupState: "closed" } });
  });

  it("wraps a primitive sink failure with its cause and terminal cleanup evidence", async () => {
    const sinkFailure = "encoder stdin closed";
    let closes = 0;
    let failure: unknown;

    try {
      await produceNativeFrameStream({ packageRoot: "/unused", frameCount: 2, fps: 2, durationMs: 1_000 }, {
        write: async () => { throw sinkFailure; },
      }, admittedContext(), {
        openSession: async () => ({
          renderFrameAtMs: async (atMs) => successfulFrame(atMs),
          close: () => { closes += 1; },
        }),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(NativeFrameProducerFailure);
    expect(failure).toMatchObject({
      message: "Native frame production failed: encoder stdin closed",
      cause: sinkFailure,
    });
    expect(getNativeFrameProducerFailureEvidence(failure)).toMatchObject({
      producer: { emittedFrameCount: 0, inFlightPngHandoffs: 0, peakInFlightPngHandoffs: 1 },
      session: { cleanupState: "closed" },
    });
    expect(closes).toBe(1);
  });

  it("attests that no session opened when setup fails before a native frame", async () => {
    const openFailure = Object.freeze(new Error("native session setup failed"));

    await expect(produceNativeFrameStream({ packageRoot: "/unused", frameCount: 1, fps: 1, durationMs: 1_000 }, {
      write: async () => undefined,
    }, admittedContext(), {
      openSession: async () => { throw openFailure; },
    })).rejects.toBe(openFailure);

    expect(getNativeFrameProducerFailureEvidence(openFailure)).toMatchObject({
      producer: { emittedFrameCount: 0, inFlightPngHandoffs: 0, peakInFlightPngHandoffs: 0 },
      session: { cleanupState: "not_opened" },
      terminal: { lastFrameReceipt: null, laneWarnings: [], downstreamAudioHandoffLayers: [] },
    });
  });

  it("attests a close failure after an otherwise successful handoff", async () => {
    const closeFailure = new Error("native session close failed");
    let failure: unknown;

    try {
      await produceNativeFrameStream({ packageRoot: "/unused", frameCount: 1, fps: 1, durationMs: 1_000 }, {
        write: async () => undefined,
      }, admittedContext(), {
        openSession: async () => ({
          renderFrameAtMs: async (atMs) => successfulFrame(atMs),
          close: () => { throw closeFailure; },
        }),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(NativeFrameProducerCleanupFailure);
    expect(failure).toMatchObject({ primaryFailure: undefined, cleanupFailure: closeFailure, cause: closeFailure });
    expect(getNativeFrameProducerFailureEvidence(failure)).toMatchObject({
      producer: { emittedFrameCount: 1, inFlightPngHandoffs: 0, peakInFlightPngHandoffs: 1 },
      session: { cleanupState: "close_failed" },
    });
  });

  it("preserves both sink and close failures when deterministic cleanup fails", async () => {
    const sinkFailure = Object.freeze(new Error("encoder stdin closed"));
    const closeFailure = new Error("native session close failed");
    let failure: unknown;

    try {
      await produceNativeFrameStream({ packageRoot: "/unused", frameCount: 1, fps: 1, durationMs: 1_000 }, {
        write: async () => { throw sinkFailure; },
      }, admittedContext(), {
        openSession: async () => ({
          renderFrameAtMs: async (atMs) => successfulFrame(atMs),
          close: () => { throw closeFailure; },
        }),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(NativeFrameProducerCleanupFailure);
    expect(failure).toMatchObject({ primaryFailure: sinkFailure, cleanupFailure: closeFailure, cause: sinkFailure });
    expect(getNativeFrameProducerFailureEvidence(failure)).toMatchObject({
      producer: { emittedFrameCount: 0, inFlightPngHandoffs: 0, peakInFlightPngHandoffs: 1 },
      session: { cleanupState: "close_failed" },
    });
  });

  it("refuses a non-canonical frame count before loading a native session", async () => {
    let opened = 0;

    await expect(produceNativeFrameStream({ packageRoot: "/unused", frameCount: 1, fps: 4, durationMs: 1_000 }, {
      write: async () => undefined,
    }, admittedContext(), {
      openSession: async () => {
        opened += 1;
        throw new Error("must not load");
      },
    })).rejects.toMatchObject({
      code: "job_input_budget_exceeded",
      message: "Streaming frameCount 1 must equal ceil(durationMs / 1000 * fps) (4).",
    });

    expect(opened).toBe(0);
  });

  it("preserves native delivery and repertoire refusals without emitting a frame", async () => {
    const lowercaseText = await writePackage({
      id: "native_delivery_refusal",
      layers: [{ id: "title", type: "text", text: "Sveiks", startMs: 0, durationMs: 200, transform: { x: 4, y: 4 }, style: { color: "#ffffff", fontSize: 16 } }],
    });
    const unsupportedWeb = await writePackage({
      id: "native_repertoire_refusal",
      layers: [{ id: "web", type: "web", source: "card.html", startMs: 0, durationMs: 200 }],
    });
    let writes = 0;
    const sink = { write: async () => { writes += 1; } };

    const delivery = await produceNativeFrameStream({ packageRoot: lowercaseText, frameCount: 1, fps: 5, durationMs: 200 }, sink, admittedContext());
    const repertoire = await produceNativeFrameStream({ packageRoot: unsupportedWeb, frameCount: 1, fps: 5, durationMs: 200 }, sink, admittedContext());

    expect(delivery).toMatchObject({
      ok: false,
      emittedFrameCount: 0,
      error: { code: "native_text_not_deliverable", message: expect.stringContaining("--frame-lane browser") },
    });
    expect(repertoire).toMatchObject({
      ok: false,
      emittedFrameCount: 0,
      error: { code: "unsupported_layer", unsupported: [{ layerId: "web", feature: "layer.type:web" }] },
    });
    expect(delivery).toMatchObject({
      evidence: {
        producer: { emittedFrameCount: 0, inFlightPngHandoffs: 0, peakInFlightPngHandoffs: 0 },
        session: { cleanupState: "closed" },
        terminal: { lastFrameReceipt: { status: "failed" } },
      },
    });
    expect(repertoire).toMatchObject({
      evidence: {
        producer: { emittedFrameCount: 0, inFlightPngHandoffs: 0, peakInFlightPngHandoffs: 0 },
        session: { cleanupState: "closed" },
        terminal: { lastFrameReceipt: { status: "failed" } },
      },
    });
    expect(writes).toBe(0);
  });
});

async function materializedDeliveryFrames(input: { packageRoot: string; frameCount: number; fps: number; durationMs: number; now: () => string }) {
  const session = await createNativeRenderSession({
    packageRoot: input.packageRoot,
    renderTarget: "delivery",
    pngCompressionLevel: INTERMEDIATE_FRAME_PNG_COMPRESSION_LEVEL,
    now: input.now,
  });
  try {
    const frames: Array<{ atMs: number; png: Buffer; sha256: string }> = [];
    for (let index = 0; index < input.frameCount; index += 1) {
      const atMs = streamingFrameTimestampMs(index, input.fps, input.durationMs);
      const rendered = await session.renderFrameAtMs(atMs);
      expect(rendered.ok).toBe(true);
      if (rendered.ok) frames.push(rendered.frame);
    }
    return frames;
  } finally {
    session.close();
  }
}

function admittedContext(controller: AbortController = new AbortController()): NativeFrameProducerContext {
  return {
    signal: controller.signal,
    job: {
      admission: "pre-acquired",
      jobId: "native-frame-producer-test",
      scratchRoot: "/trusted/scratch",
      signal: controller.signal,
    },
  };
}

function successfulFrame(atMs: number, warnings: string[] = [], output: unknown = null): NativePreviewFrameResult {
  const png = SAMPLE_PNG;
  return {
    ok: true,
    frame: { png, path: null, sha256: hashBuffer(png), width: 2, height: 1, atMs },
    receipt: {
      schema: "shellx-motion/receipt@1",
      id: `native-frame-${atMs}`,
      operation: "preview.frame",
      status: warnings.length > 0 ? "warning" : "passed",
      packageId: "pkg_test",
      inputHashes: {},
      createdAt: fixedNow(),
      lane: "native",
      output,
      warnings,
    } satisfies OperationReceipt,
    warnings,
  };
}

async function writeDeliveryPackage(): Promise<string> {
  const root = await writePackage({
    id: "native_streaming_delivery",
    durationMs: 1_000,
    fps: 4,
    layers: [
      { id: "background", type: "shape", shape: "rect", fill: "#061a2c", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 160, height: 90 } },
      { id: "glow", type: "shape", shape: "ellipse", fill: "#157fcb", blendMode: "screen", startMs: 0, durationMs: 1_000, transform: { x: 12, y: 20, width: 42, height: 42 }, keyframes: { "transform.x": [{ atMs: 0, value: 12 }, { atMs: 1_000, value: 94 }] } },
      { id: "label", type: "text", text: "STREAM 7", startMs: 0, durationMs: 1_000, transform: { x: 16, y: 12 }, style: { color: "#ffffff", fontSize: 18 } },
      { id: "logo", type: "image", source: "assets/logo.png", assetRef: "assets/logo.png", startMs: 0, durationMs: 1_000, transform: { x: 130, y: 52, width: 16, height: 16 }, fit: "fill" },
    ],
  });
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "logo.png"), SAMPLE_PNG);
  return root;
}

async function writePackage(input: { id: string; durationMs?: number; fps?: number; layers: unknown[] }): Promise<string> {
  const root = await makeTempDir("native-frame-producer-");
  const durationMs = input.durationMs ?? 200;
  const fps = input.fps ?? 5;
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: `pkg_${input.id}`,
    name: input.id,
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] },
  }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: `motion_${input.id}`,
    name: input.id,
    durationMs,
    fps,
    width: 160,
    height: 90,
    background: "#000000",
    layers: input.layers,
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
  }, null, 2)}\n`);
  return root;
}

async function makeTempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function fixedNow(): string {
  return "2026-08-08T12:00:00.000Z";
}
