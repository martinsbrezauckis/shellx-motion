import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMotionJobGovernor } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { buildEncodeImageSequenceCommand, type FfmpegCommand, type FfmpegProcessResult } from "./index";
import { rawVideoCommandFromImageSequence, runStreamingFfmpegFinal } from "./streaming-foundation";
import type { StreamingFrameSink } from "./streaming-foundation-types";
import type { StreamingFfmpegProcessFactory } from "./streaming-process";

const RAW_RGBA = Buffer.from([
  0, 0, 0, 255, 255, 255, 255, 255,
  10, 80, 180, 255, 250, 30, 40, 255
]);

describe("streaming raw RGBA transport", () => {
  it("replaces only the materialized frame input and retains audio", () => {
    const materialized = buildEncodeImageSequenceCommand({
      framesDir: "/trusted/frames", fps: 30, durationMs: 1000, outputPath: "/trusted/out.mp4",
      audio: { path: "/trusted/audio.wav" }, inputRoots: ["/trusted"], outputRoots: ["/trusted"]
    });
    const streamed = rawVideoCommandFromImageSequence(materialized, { width: 1920, height: 1080, fps: 30 });
    expect(streamed.args).toEqual(expect.arrayContaining([
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "1920x1080", "-framerate", "30", "-i", "pipe:0"
    ]));
    expect(streamed.args).toContain("/trusted/audio.wav");
    expect(streamed.args).not.toContain("-start_number");
  });

  it.each([
    ["webm-vp9-alpha", "/trusted/out.webm", "yuva420p"],
    ["mov-prores", "/trusted/out.mov", "yuva444p10le"]
  ] as const)("preserves straight RGBA input for the %s alpha delivery command", (preset, outputPath, outputPixelFormat) => {
    const materialized = buildEncodeImageSequenceCommand({
      framesDir: "/trusted/frames", fps: 30, durationMs: 1000, outputPath, preset,
      inputRoots: ["/trusted"], outputRoots: ["/trusted"]
    });
    const streamed = rawVideoCommandFromImageSequence(materialized, { width: 1920, height: 1080, fps: 30 });
    expect(streamed.args).toEqual(expect.arrayContaining([
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "1920x1080", "-framerate", "30", "-i", "pipe:0",
      "-pix_fmt", outputPixelFormat
    ]));
  });

  it("streams exact straight-alpha sRGB and reports its fixed byte boundary", async () => {
    const process = mockProcess();
    const result = await runStreamingFfmpegFinal({
      ...baseInput(process.factory),
      produce: async (sink) => sink.write(rawFrame())
    });
    expect(result).toMatchObject({
      ok: true,
      evidence: { frameFormat: "rgba", maxFrameBytesPerFrame: 16, maxRgbaBytesPerFrame: 16, backpressure: { writes: 1 } }
    });
    expect(process.writeCalls).toBe(1);
  });

  it("refuses a PNG mismatch and malformed raw metadata before encoder stdin", async () => {
    const producers: Array<(sink: StreamingFrameSink) => Promise<void>> = [
      async (sink) => sink.write({ index: 0, atMs: 0, png: Buffer.from("not raw") }),
      async (sink) => sink.write({ ...rawFrame(), strideBytes: 16 }),
      async (sink) => sink.write({ ...rawFrame(), width: 1 } as never),
      async (sink) => sink.write({ ...rawFrame(), colorSpace: "display-p3" } as never),
      async (sink) => sink.write({ ...rawFrame(), alphaMode: "premultiplied" } as never)
    ];
    for (const produce of producers) {
      const process = mockProcess();
      const result = await runStreamingFfmpegFinal({ ...baseInput(process.factory), produce });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_frame" } });
      expect(process.writeCalls).toBe(0);
    }
  });

  it("refuses invalid frame formats and ambiguous raw input options before spawning", async () => {
    for (const override of [
      { frameFormat: "bogus", attempts: [{ source: "software" as const, command: rawPipeCommand() }] },
      { frameFormat: "rgba", attempts: [{ source: "software" as const, command: { ...rawPipeCommand(), args: [...rawPipeCommand().args, "-video_size", "1x1"] } }] }
    ]) {
      const process = mockProcess();
      const result = await runStreamingFfmpegFinal({ ...baseInput(process.factory), ...override, produce: async () => undefined } as never);
      expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/streaming_(?:metadata|command)_invalid/) } });
      expect(process.starts).toBe(0);
    }
  });
});

function rawFrame() {
  return {
    index: 0, atMs: 0, format: "rgba" as const, rgba: RAW_RGBA, width: 2, height: 2,
    strideBytes: 8, colorSpace: "srgb" as const, alphaMode: "straight" as const
  };
}

function baseInput(processFactory: StreamingFfmpegProcessFactory) {
  return {
    frameCount: 1, durationMs: 1000, fps: 1, width: 2, height: 2, frameFormat: "rgba" as const,
    attempts: [{ source: "software" as const, command: rawPipeCommand() }], processFactory,
    scratchRoot: join(tmpdir(), "shellx-motion-stream-raw-rgba"), governor: governed()
  };
}

function rawPipeCommand(): FfmpegCommand {
  return { executable: "ffmpeg", shell: false, args: ["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-framerate", "1", "-i", "pipe:0"] };
}

function mockProcess() {
  let writeCalls = 0;
  let starts = 0;
  const factory: StreamingFfmpegProcessFactory = async (input) => {
    starts += 1;
    input.reportProcessContainment({ schema: "shellx-motion/process-containment@1", mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor" });
    const output: FfmpegProcessResult = { exitCode: 0, stdout: "", stderr: "" };
    let resolveClosed!: (result: FfmpegProcessResult) => void;
    const closed = new Promise<FfmpegProcessResult>((resolve) => { resolveClosed = resolve; });
    return {
      closed,
      write: async () => { writeCalls += 1; return { backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16_384 }; },
      end: async () => { resolveClosed(output); return output; },
      abort: async () => { const failed = { ...output, exitCode: 1 }; resolveClosed(failed); return failed; }
    };
  };
  return { factory, get starts() { return starts; }, get writeCalls() { return writeCalls; } };
}

function governed(): LocalMotionJobGovernor {
  return new LocalMotionJobGovernor({
    maxConcurrentJobs: 1, maxQueueDepth: 1, maxQueueWaitMs: 500, maxWallClockMs: 10_000,
    minFreeScratchBytes: 0, scratchReservationBytes: 0, maxProcessTreeRssBytes: 512 * 1024 * 1024, rssPollIntervalMs: 1_000
  }, { leases: null, freeScratchBytes: async () => Number.MAX_SAFE_INTEGER });
}
