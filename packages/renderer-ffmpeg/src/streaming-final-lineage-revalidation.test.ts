import { afterEach, describe, expect, it } from "vitest";
import { encodeRgbaPng } from "@shellx-motion/core";
import type { FfmpegProcessResult } from "./index";
import { runStreamingFfmpegFinal } from "./streaming-foundation";
import { revalidateStreamingFinalLaunch, withStreamingFinalLaunchRevalidation } from "./streaming-final-lineage-revalidation";
import type { StreamingFfmpegProcessFactory } from "./streaming-process";

const FRAME = encodeRgbaPng(2, 2, Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 10, 80, 180, 255, 250, 30, 40, 255]));

afterEach(() => { delete process.env.SHELLX_MOTION_SCRATCH_ROOT; });

describe("streamed final lineage launch revalidation", () => {
  it("fences the software fallback after a failed hardware attempt before the next process starts", async () => {
    const process = fakeProcess([1, 0]);
    let fences = 0, producerCalls = 0;
    await expect(withStreamingFinalLaunchRevalidation(async () => {
      if (++fences === 3) throw new Error("stable lineage changed before software fallback");
    }, async () => await runStreamingFfmpegFinal({
      ...input("fallback"), attempts: [attempt("hardware"), attempt("software")], processFactory: process.factory,
      produce: async (sink) => { producerCalls += 1; await sink.write({ index: 0, atMs: 0, png: FRAME }); }
    }))).rejects.toThrow("stable lineage changed before software fallback");
    expect({ fences, producerCalls, starts: process.starts, aborts: process.aborts }).toEqual({ fences: 3, producerCalls: 1, starts: 1, aborts: 1 });
  });

  it("aborts a prestarted encoder when the producer launch fence refuses", async () => {
    const process = fakeProcess([0]);
    let fences = 0, producerCalls = 0;
    await expect(withStreamingFinalLaunchRevalidation(async () => {
      if (++fences === 2) throw new Error("stable lineage changed before producer");
    }, async () => await runStreamingFfmpegFinal({
      ...input("producer"), attempts: [attempt("software")], processFactory: process.factory,
      produce: async () => { producerCalls += 1; }
    }))).rejects.toThrow("stable lineage changed before producer");
    expect({ fences, producerCalls, starts: process.starts, aborts: process.aborts }).toEqual({ fences: 2, producerCalls: 0, starts: 1, aborts: 1 });
  });

  it("keeps concurrent guard contexts isolated and clears the guard after the coordinated operation", async () => {
    let firstReached!: () => void;
    const firstReachedPromise = new Promise<void>((resolve) => { firstReached = resolve; });
    let secondReached!: () => void;
    const secondReachedPromise = new Promise<void>((resolve) => { secondReached = resolve; });
    const calls: string[] = [];

    const first = withStreamingFinalLaunchRevalidation(async () => { calls.push("first"); }, async () => {
      await revalidateStreamingFinalLaunch();
      firstReached();
      await secondReachedPromise;
      await revalidateStreamingFinalLaunch();
    });
    const second = withStreamingFinalLaunchRevalidation(async () => { calls.push("second"); }, async () => {
      await firstReachedPromise;
      await revalidateStreamingFinalLaunch();
      secondReached();
    });

    await Promise.all([first, second]);
    await revalidateStreamingFinalLaunch();
    expect(calls).toEqual(["first", "second", "first"]);
  });
});

function input(operation: string) { return { operation, frameCount: 1, durationMs: 1_000, fps: 1, width: 2, height: 2, scratchRoot: ".scratch" }; }
function attempt(source: "hardware" | "software") { return { source, command: { executable: "ffmpeg", args: ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0", "out.mp4"], shell: false as const } }; }
function fakeProcess(exitCodes: number[]) {
  let starts = 0, aborts = 0, index = 0;
  const factory: StreamingFfmpegProcessFactory = async (input) => {
    starts += 1;
    input.reportProcessContainment({ schema: "shellx-motion/process-containment@1", mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor" });
    let settled: FfmpegProcessResult | undefined;
    let resolveClosed!: (result: FfmpegProcessResult) => void;
    const closed = new Promise<FfmpegProcessResult>((resolve) => { resolveClosed = resolve; });
    const settle = (result: FfmpegProcessResult) => settled ?? (settled = result, resolveClosed(result), result);
    return {
      closed, write: async () => ({ backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16_384 }),
      end: async () => settle({ exitCode: exitCodes[index++] ?? 0, stdout: "", stderr: "" }),
      abort: async () => { aborts += 1; return settle({ exitCode: 1, stdout: "", stderr: "aborted" }); }
    };
  };
  return { factory, get starts() { return starts; }, get aborts() { return aborts; } };
}
