import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRgbaPng, LocalMotionJobGovernor } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import type { FfmpegProcessResult } from "./index.js";
import { runStreamingFfmpegFinal } from "./streaming-foundation.js";
import type { StreamingFfmpegProcessFactory } from "./streaming-process.js";

const roots: string[] = [];
const FRAME = encodeRgbaPng(2, 2, Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 10, 80, 180, 255, 250, 30, 40, 255]));

afterEach(async () => await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true }))));

describe("streaming admitted preparation", () => {
  it("runs same-job preparation and its contained child before encoder creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-admitted-preparation-"));
    roots.push(root);
    const events: string[] = [];
    const result = await runStreamingFfmpegFinal({
      frameCount: 1, durationMs: 1_000, fps: 1, width: 2, height: 2, scratchRoot: root,
      governor: governor(), processFactory: factory(events),
      admittedPrepare: async ({ job, runner }) => {
        events.push(`prepare:${job.scratchRoot}`);
        expect(events).not.toContain("encoder");
        expect((await runner({ executable: process.execPath, args: ["-e", ""], shell: false })).exitCode).toBe(0);
        events.push("staged");
        return { attempts: [{ source: "software", command: { executable: "ffmpeg", args: ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"], shell: false } }], produce: async (sink) => await sink.write({ index: 0, atMs: 0, png: FRAME }) };
      }
    });

    expect(result).toMatchObject({ ok: true, evidence: { resources: { processContainment: { status: "enforced" } } } });
    expect(events).toEqual([`prepare:${root}`, "staged", "encoder"]);
  });
});

function factory(events: string[]): StreamingFfmpegProcessFactory {
  return async (input) => {
    if (!input.command.args.includes("-e")) events.push("encoder");
    input.reportProcessContainment({ schema: "shellx-motion/process-containment@1", mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor" });
    let resolve!: (result: FfmpegProcessResult) => void;
    const closed = new Promise<FfmpegProcessResult>((done) => { resolve = done; });
    const done = (result: FfmpegProcessResult) => { resolve(result); return result; };
    return { closed, write: async () => ({ backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16 * 1024 }), end: async () => done({ exitCode: 0, stdout: "", stderr: "" }), abort: async () => done({ exitCode: 1, stdout: "", stderr: "aborted" }) };
  };
}

function governor(): LocalMotionJobGovernor {
  return new LocalMotionJobGovernor({ maxConcurrentJobs: 1, maxQueueDepth: 2, maxQueueWaitMs: 500, maxWallClockMs: 10_000, minFreeScratchBytes: 0, scratchReservationBytes: 0, maxProcessTreeRssBytes: 512 * 1024 * 1024, rssPollIntervalMs: 1_000 }, { leases: null, freeScratchBytes: async () => Number.MAX_SAFE_INTEGER });
}
