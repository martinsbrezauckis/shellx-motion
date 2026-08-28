import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRgbaPng, LocalMotionJobGovernor } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import type { FfmpegProcessResult } from "./index.js";
import { runStreamingFinalEncodePolicy } from "./streaming-final-encode-policy.js";
import type { StreamingFfmpegProcessFactory } from "./streaming-process.js";

const roots: string[] = [];
const FRAME = encodeRgbaPng(2, 2, Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 10, 80, 180, 255, 250, 30, 40, 255]));

afterEach(async () => await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true }))));

describe("admitted streaming-final cleanup", () => {
  it("releases admitted staging after an encoder output failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-admitted-cleanup-"));
    roots.push(root);
    let releases = 0;
    const result = await runStreamingFinalEncodePolicy({
      fps: 1, width: 2, height: 2, durationMs: 1_000, outputPath: join(root, "out.mp4"),
      inputRoots: [root], outputRoots: [root], forceSoftwareEncode: true,
      governor: governor(), processFactory: failedFactory(), runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      produce: async () => { throw new Error("provisional producer must not run"); },
      admittedPreflight: async () => ({
        input: { fps: 1, width: 2, height: 2, durationMs: 1_000, outputPath: join(root, "out.mp4"), inputRoots: [root], outputRoots: [root], forceSoftwareEncode: true },
        produce: async (sink) => await sink.write({ index: 0, atMs: 0, png: FRAME }),
        release: async () => { releases += 1; }
      })
    });

    expect(result).toMatchObject({ ok: false, error: { code: "encoder_failed" } });
    expect(releases).toBe(1);
  });
});

function failedFactory(): StreamingFfmpegProcessFactory {
  return async (input) => {
    input.reportProcessContainment({ schema: "shellx-motion/process-containment@1", mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor" });
    let resolve!: (result: FfmpegProcessResult) => void;
    const closed = new Promise<FfmpegProcessResult>((done) => { resolve = done; });
    const done = (result: FfmpegProcessResult) => { resolve(result); return result; };
    return { closed, write: async () => ({ backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16 * 1024 }), end: async () => done({ exitCode: 1, stdout: "", stderr: "encoder failed" }), abort: async () => done({ exitCode: 1, stdout: "", stderr: "aborted" }) };
  };
}

function governor(): LocalMotionJobGovernor {
  return new LocalMotionJobGovernor({ maxConcurrentJobs: 1, maxQueueDepth: 2, maxQueueWaitMs: 500, maxWallClockMs: 10_000, minFreeScratchBytes: 0, scratchReservationBytes: 0, maxProcessTreeRssBytes: 512 * 1024 * 1024, rssPollIntervalMs: 1_000 }, { leases: null, freeScratchBytes: async () => Number.MAX_SAFE_INTEGER });
}
