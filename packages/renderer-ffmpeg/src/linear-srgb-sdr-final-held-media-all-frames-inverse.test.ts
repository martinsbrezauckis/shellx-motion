import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { HeldTool } from "./linear-srgb-sdr-final-held-media-files.js";

const binary = vi.hoisted(() => ({ run: vi.fn(), terminal: vi.fn(() => true) }));

vi.mock("./linear-srgb-sdr-final-held-media-all-frames-process.js", () => ({
  runLinearSrgbSdrHeldAllFramesChild: binary.run,
  strictSdrHeldAllFramesTerminalEstablished: binary.terminal,
}));
vi.mock("./linear-srgb-sdr-final-held-media-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./linear-srgb-sdr-final-held-media-files.js")>()),
  assertCurrentHeldToolResolution: () => undefined,
  assertHeldTool: async () => undefined,
}));
vi.mock("./streaming-final-lineage-revalidation.js", () => ({ revalidateStreamingFinalLaunch: async () => undefined }));
vi.mock("./index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./index.js")>()),
  resolveFfmpegExecutable: () => "/fixed/ffmpeg",
}));

import { runLinearSrgbSdrHeldMediaAllDeliveredFramesInverse } from "./linear-srgb-sdr-final-held-media-all-frames-inverse.js";

const FRAME_BYTES = 3_686_400;

afterEach(() => vi.clearAllMocks());

describe("strict SDR all-delivered-frame inverse", () => {
  it("delivers only one scoped current-frame observation across all sixty exact frames", async () => {
    binary.run.mockImplementation(async (input: Readonly<{
      consumeChunk(chunk: Buffer): Promise<void>;
      observeTerminal(value: unknown): void;
    }>) => {
      const frame = Buffer.alloc(FRAME_BYTES, 0x5a);
      for (let index = 0; index < 60; index += 1) await input.consumeChunk(frame);
      input.observeTerminal({ childCloseObserved: true });
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    let duplicateRejected = false, containment = 0;
    const result = await runLinearSrgbSdrHeldMediaAllDeliveredFramesInverse({
      slot: "f2a", route: route(), ffmpeg: tool(), sourceFd: 4,
      job: { signal: new AbortController().signal, watchProcess: () => undefined, reportProcessContainment: () => { containment += 1; }, admission: "pre-acquired", scratchRoot: "/private", maxProcessTreeRssBytes: 256 * 1024 * 1024 },
      observeFrame: async ({ frame, withOwnedRgba }) => {
        const value = await withOwnedRgba(() => frame.frameIndex);
        try { await withOwnedRgba(() => value); } catch { duplicateRejected = true; }
        return value;
      },
    });

    expect(result.frames).toEqual(Array.from({ length: 60 }, (_value, index) => index));
    expect(result.decodedByteLength).toBe(221_184_000);
    expect(containment).toBe(1);
    expect(duplicateRejected).toBe(true);
  });

  it("drains an already-started scoped observation before it can zero or reuse the rolling frame", async () => {
    let release!: () => void, firstSettled = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    binary.run.mockImplementation(async (input: Readonly<{
      consumeChunk(chunk: Buffer): Promise<void>;
      observeTerminal(value: unknown): void;
    }>) => {
      const frame = Buffer.alloc(FRAME_BYTES, 0x5a);
      const first = input.consumeChunk(frame).then(() => { firstSettled = true; });
      await Promise.resolve();
      expect(firstSettled).toBe(false);
      release();
      await first;
      for (let index = 1; index < 60; index += 1) await input.consumeChunk(frame);
      input.observeTerminal({ childCloseObserved: true });
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = await runLinearSrgbSdrHeldMediaAllDeliveredFramesInverse({
      slot: "f2a", route: route(), ffmpeg: tool(), sourceFd: 4,
      job: { signal: new AbortController().signal, watchProcess: () => undefined, reportProcessContainment: () => undefined, admission: "pre-acquired", scratchRoot: "/private", maxProcessTreeRssBytes: 256 * 1024 * 1024 },
      observeFrame: ({ frame, withOwnedRgba }) => {
        const pending = withOwnedRgba(async () => {
          if (frame.frameIndex === 0) await gate;
          return frame.frameIndex;
        });
        return frame.frameIndex === 0 ? 0 : pending;
      },
    });
    expect(result.frames).toHaveLength(60);
    expect(firstSettled).toBe(true);
  });

  it("refuses a frame callback that returns without consuming its owned RGBA capability", async () => {
    binary.run.mockImplementation(async (input: Readonly<{ consumeChunk(chunk: Buffer): Promise<void> }>) => {
      await input.consumeChunk(Buffer.alloc(FRAME_BYTES));
      return { exitCode: 1, stdout: "", stderr: "" };
    });
    await expect(runLinearSrgbSdrHeldMediaAllDeliveredFramesInverse({
      slot: "f2a", route: route(), ffmpeg: tool(), sourceFd: 4,
      job: { signal: new AbortController().signal, watchProcess: () => undefined, reportProcessContainment: () => undefined, admission: "pre-acquired", scratchRoot: "/private", maxProcessTreeRssBytes: 256 * 1024 * 1024 },
      observeFrame: () => 0,
    })).rejects.toThrow(/did not consume/i);
  });

  it("drains started owned work before zeroing when the outer frame observer rejects", async () => {
    let rejectWork!: (error: Error) => void;
    const work = new Promise<never>((_resolve, reject) => { rejectWork = reject; });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      binary.run.mockImplementation(async (input: Readonly<{ consumeChunk(chunk: Buffer): Promise<void> }>) => {
        const pending = input.consumeChunk(Buffer.alloc(FRAME_BYTES));
        await Promise.resolve();
        rejectWork(new Error("owned observer failed"));
        await pending;
        return { exitCode: 1, stdout: "", stderr: "" };
      });
      await expect(runLinearSrgbSdrHeldMediaAllDeliveredFramesInverse({
        slot: "f2a", route: route(), ffmpeg: tool(), sourceFd: 4,
        job: { signal: new AbortController().signal, watchProcess: () => undefined, reportProcessContainment: () => undefined, admission: "pre-acquired", scratchRoot: "/private", maxProcessTreeRssBytes: 256 * 1024 * 1024 },
        observeFrame: ({ withOwnedRgba }) => {
          void withOwnedRgba(async () => await work);
          throw new Error("outer observer failed");
        },
      })).rejects.toBeInstanceOf(AggregateError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("refuses an extra byte after frame sixty, rather than accepting a capped decode", async () => {
    await expectAssemblyRefusal(async (consume) => {
      const frame = Buffer.alloc(FRAME_BYTES);
      for (let index = 0; index < 60; index += 1) await consume(frame);
      await consume(Buffer.from([0]));
    }, /beyond its 60th/i);
  });

  it("refuses a missing fifty-ninth frame and a truncated sixtieth frame", async () => {
    await expectAssemblyRefusal(async (consume) => {
      const frame = Buffer.alloc(FRAME_BYTES);
      for (let index = 0; index < 59; index += 1) await consume(frame);
    }, /exactly 60/i);
    await expectAssemblyRefusal(async (consume) => {
      const frame = Buffer.alloc(FRAME_BYTES);
      for (let index = 0; index < 59; index += 1) await consume(frame);
      await consume(frame.subarray(0, FRAME_BYTES - 1));
    }, /exactly 60/i);
  });

  it("assembles sixty exact frames across chunk boundaries that cross raw frame boundaries", async () => {
    const result = await runAssembly(async (consume) => {
      const pair = Buffer.alloc(FRAME_BYTES * 2, 0x5a);
      for (let index = 0; index < 30; index += 1) {
        await consume(pair.subarray(0, FRAME_BYTES + 17));
        await consume(pair.subarray(FRAME_BYTES + 17));
      }
    });
    expect(result.frames).toEqual(Array.from({ length: 60 }, (_value, index) => index));
  });
});

function route(): LinearSrgbSdrFinalRoute {
  return { canvas: { width: 1280, height: 720, fps: 30, durationMs: 2000 } } as LinearSrgbSdrFinalRoute;
}
function tool(): HeldTool {
  return { path: "/fixed/ffmpeg", sha256: "a".repeat(64), handle: { fd: 3 } } as unknown as HeldTool;
}

async function expectAssemblyRefusal(
  deliver: (consume: (chunk: Buffer) => Promise<void>) => Promise<void>,
  message: RegExp,
): Promise<void> {
  await expect(runAssembly(deliver)).rejects.toThrow(message);
}
async function runAssembly(deliver: (consume: (chunk: Buffer) => Promise<void>) => Promise<void>) {
  binary.run.mockImplementation(async (input: Readonly<{
    consumeChunk(chunk: Buffer): Promise<void>;
    observeTerminal(value: unknown): void;
  }>) => {
    await deliver(input.consumeChunk);
    input.observeTerminal({ childCloseObserved: true });
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return await runLinearSrgbSdrHeldMediaAllDeliveredFramesInverse({
    slot: "f2a", route: route(), ffmpeg: tool(), sourceFd: 4,
    job: { signal: new AbortController().signal, watchProcess: () => undefined, reportProcessContainment: () => undefined, admission: "pre-acquired", scratchRoot: "/private", maxProcessTreeRssBytes: 256 * 1024 * 1024 },
    observeFrame: ({ frame, withOwnedRgba }) => withOwnedRgba(() => frame.frameIndex),
  });
}
