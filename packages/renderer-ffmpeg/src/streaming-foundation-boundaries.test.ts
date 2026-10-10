import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRgbaPng, LocalMotionJobGovernor } from "@shellx-motion/core";
import { type FfmpegCommand, type FfmpegProcessResult } from "./index";
import { runStreamingFfmpegFinal } from "./streaming-foundation";
import type { StreamingFfmpegProcessFactory } from "./streaming-process";

const tempDirs: string[] = [];
const PNG = encodeRgbaPng(2, 2, Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 10, 80, 180, 255, 250, 30, 40, 255]));
const RGBA = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 10, 80, 180, 255, 250, 30, 40, 255]);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("streaming FFmpeg trust boundaries", () => {
  it("refuses an exact-source quality manifest before job, encoder, or producer admission", async () => {
    const factory = successfulFactory();
    let producerCalls = 0;
    const result = await runStreamingFfmpegFinal({
      ...input("exact-source-boundary"), qualityManifest: { exactSourceComparison: "required" }, processFactory: factory.factory,
      produce: async () => { producerCalls += 1; }
    });

    expect(result).toMatchObject({ ok: false, error: { code: "streaming_quality_boundary_unsupported" } });
    expect(factory.starts).toBe(0);
    expect(producerCalls).toBe(0);
  });

  it("runs admitted preparation under the held job before it starts the encoder", async () => {
    const events: string[] = [], factory = successfulFactory();
    const result = await runStreamingFfmpegFinal({
      frameCount: 1, durationMs: 1_000, fps: 1, width: 2, height: 2, scratchRoot: await scratch("admitted-preparation"), governor: governor(),
      processFactory: async (value) => {
        events.push(value.command.args[0] === "-version" ? "preflight" : "encoder");
        return await factory.factory(value);
      },
      admittedPrepare: async ({ job, runner }) => {
        events.push(`prepare:${job.admission}`);
        await runner(command("ffmpeg", ["-version"]));
        events.push("prepared");
        return { attempts: [{ source: "software", command: command("ffmpeg") }], produce: async (sink) => await sink.write({ index: 0, atMs: 0, png: PNG }) };
      }
    });

    expect(result).toMatchObject({ ok: true, evidence: { resources: { processContainment: { status: "enforced" } } } });
    expect(events).toEqual(["prepare:pre-acquired", "preflight", "prepared", "encoder"]);
  });

  it("streams one tightly packed raw RGBA frame and reports its raw byte bound", async () => {
    const factory = successfulFactory();
    const result = await runStreamingFfmpegFinal({
      ...input("raw-rgba"), scratchRoot: await scratch("raw-rgba"), frameFormat: "rgba", attempts: [{ source: "software", command: rawCommand("ffmpeg") }], processFactory: factory.factory,
      produce: async (sink) => await sink.write({ index: 0, atMs: 0, format: "rgba", rgba: RGBA, width: 2, height: 2, strideBytes: 8, colorSpace: "srgb", alphaMode: "straight" })
    });

    expect(result).toMatchObject({ ok: true, evidence: { frameFormat: "rgba", maxFrameBytesPerFrame: 16, maxRgbaBytesPerFrame: 16 } });
    if (result.ok) expect(result.evidence).not.toHaveProperty("maxPngBytesPerFrame");
    expect(factory.writes).toBe(1);
  });
});

function input(label: string) {
  return { frameCount: 1, durationMs: 1_000, fps: 1, width: 2, height: 2, attempts: [{ source: "software" as const, command: command(label) }], scratchRoot: join(tmpdir(), `shellx-motion-stream-${label}`), governor: governor() };
}

function command(executable: string, args: string[] = ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"]): FfmpegCommand {
  return { executable, args, shell: false };
}

function rawCommand(executable: string): FfmpegCommand {
  return command(executable, ["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-framerate", "1", "-i", "pipe:0"]);
}

function governor(): LocalMotionJobGovernor {
  return new LocalMotionJobGovernor({
    maxConcurrentJobs: 1, maxQueueDepth: 2, maxQueueWaitMs: 500, maxWallClockMs: 10_000, minFreeScratchBytes: 0,
    scratchReservationBytes: 0, maxProcessTreeRssBytes: 512 * 1024 * 1024, rssPollIntervalMs: 1_000
  }, { leases: null, freeScratchBytes: async () => Number.MAX_SAFE_INTEGER });
}

function successfulFactory() {
  let starts = 0, writes = 0;
  const factory: StreamingFfmpegProcessFactory = async (input) => {
    starts += 1;
    input.reportProcessContainment({ schema: "shellx-motion/process-containment@1", mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor" });
    const result: FfmpegProcessResult = { exitCode: 0, stdout: "", stderr: "" };
    let resolveClosed!: (value: FfmpegProcessResult) => void;
    const closed = new Promise<FfmpegProcessResult>((resolve) => { resolveClosed = resolve; });
    let settled = false;
    const complete = () => {
      if (!settled) {
        settled = true;
        resolveClosed(result);
      }
      return result;
    };
    return {
      closed,
      write: async () => {
        writes += 1;
        return { backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16 * 1024 };
      },
      end: async () => complete(),
      abort: async () => complete()
    };
  };
  return { factory, get starts() { return starts; }, get writes() { return writes; } };
}

async function scratch(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `shellx-motion-stream-${label}-`));
  tempDirs.push(path);
  return path;
}
