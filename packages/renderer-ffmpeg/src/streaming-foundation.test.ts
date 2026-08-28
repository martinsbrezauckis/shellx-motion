import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRgbaPng, LocalMotionJobGovernor } from "@shellx-motion/core";
import {
  buildEncodeImageSequenceCommand,
  type FfmpegCommand,
  type FfmpegProcessResult
} from "./index";
import { image2PipeCommandFromImageSequence, runStreamingFfmpegFinal } from "./streaming-foundation";
import {
  startStreamingFfmpegProcess,
  type StartStreamingFfmpegProcessInput,
  type StreamingFfmpegProcess,
  type StreamingFfmpegProcessFactory
} from "./streaming-process";

const tempDirs: string[] = [];
const FRAME = encodeRgbaPng(2, 2, Buffer.from([
  0, 0, 0, 255, 255, 255, 255, 255,
  10, 80, 180, 255, 250, 30, 40, 255
]));
const BLACK = encodeRgbaPng(2, 2, Buffer.alloc(16));

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("streaming FFmpeg foundation", () => {
  it("starts a real pipe child before production, interleaves writes with drain, and reports bounded byte backpressure", async () => {
    const events: string[] = [];
    const script = [
      "process.stdin.pause()",
      "setTimeout(() => process.stdin.resume(), 25)",
      "process.stdin.on('data', () => {})",
      "process.stdin.on('end', () => process.exit(0))"
    ].join(";");
    const command = pipeCommand(process.execPath, ["-e", script, "--", "-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"]);
    const factory: StreamingFfmpegProcessFactory = async (input) => {
      events.push("encoder-started");
      return startStreamingFfmpegProcess(input);
    };
    const largeFrame = encodeRgbaPng(512, 512, randomBytes(512 * 512 * 4));

    const result = await runStreamingFfmpegFinal({
      frameCount: 3,
      durationMs: 1500,
      fps: 2,
      width: 512,
      height: 512,
      attempts: [{ source: "software", command }],
      processFactory: factory,
      scratchRoot: await scratch("interleave"),
      produce: async (sink) => {
        for (let index = 0; index < 3; index += 1) {
          events.push(`produce-${index}`);
          await sink.write({ index, atMs: index * 500, png: largeFrame });
          events.push(`written-${index}`);
        }
      }
    });

    expect(result).toMatchObject({
      ok: true,
      evidence: {
        delivery: "streamed",
        maxConcurrentProducerWrites: 1,
        observedMaxConcurrentProducerWrites: 1,
        encoderHandoffSourceFramesRetained: 0,
        qualityPlaneSetCapacity: 2,
        backpressure: { writes: 3 }
      }
    });
    expect(events.indexOf("encoder-started")).toBeLessThan(events.indexOf("produce-0"));
    expect(events.indexOf("written-0")).toBeLessThan(events.indexOf("produce-1"));
    if (result.ok) {
      expect(result.evidence.backpressure.drainWaits).toBeGreaterThan(0);
      expect(result.evidence.maxBufferedInputBytes).toBeGreaterThan(0);
      expect(result.evidence.inputHighWaterMarkBytes).toBeGreaterThan(0);
    }
  });

  it("stops a producer when the encoder closes before input is complete", async () => {
    let produced = 0;
    const result = await runStreamingFfmpegFinal({
      ...baseInput("encoder-close"),
      processFactory: earlyCloseFactory(),
      produce: async (_sink, context) => {
        await nextTurn();
        if (!context.signal.aborted) produced += 1;
      }
    });

    expect(result).toMatchObject({ ok: false, error: { code: "encoder_failed" } });
    expect(produced).toBe(0);
  });

  it("preserves timeout exit evidence while terminating a real streaming child", async () => {
    const previous = process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS;
    process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS = "30";
    try {
      const controller = new AbortController();
      const stream = await startStreamingFfmpegProcess({
        command: pipeCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
        signal: controller.signal,
        watchProcess: () => undefined,
        reportProcessContainment: () => undefined
      });
      const result = await stream.closed;
      expect(result).toMatchObject({ exitCode: 124 });
      expect(result.stderr).toContain("timed out");
    } finally {
      if (previous === undefined) delete process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS;
      else process.env.SHELLX_MOTION_FFMPEG_TIMEOUT_MS = previous;
    }
  });

  it("terminates the encoder when a producer fails", async () => {
    const factory = mockFactory();
    const result = await runStreamingFfmpegFinal({
      ...baseInput("producer-failure"),
      processFactory: factory.factory,
      produce: async () => { throw new Error("renderer failed"); }
    });

    expect(result).toMatchObject({ ok: false, error: { code: "producer_failed", message: "renderer failed", resources: { state: "passed", processContainment: { status: "enforced" } } } });
    expect(factory.abortCalls).toBe(1);
  });

  it("retains governed process evidence and bounded diagnostics for an encoder failure", async () => {
    const factory = mockFactory({ endExitCodes: [124], stderr: "TOKEN=hidden PASSWORD=hidden" });
    const result = await runStreamingFfmpegFinal({
      ...baseInput("encoder-failure"),
      processFactory: factory.factory,
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME })
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "encoder_failed",
        process: { exitCode: 124, timedOut: true },
        resources: { state: "passed", processContainment: { status: "enforced" } }
      }
    });
    if (!result.ok) {
      expect(result.error.message).toContain("PASSWORD=[redacted]");
      expect(result.error.message).not.toContain("hidden");
    }
  });

  it("caps a huge single-line encoder diagnostic even when it contains no secret marker", async () => {
    const result = await runStreamingFfmpegFinal({
      ...baseInput("huge-diagnostic"),
      processFactory: mockFactory({ endExitCodes: [1], stderr: "x".repeat(20_000) }).factory,
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME })
    });
    expect(result).toMatchObject({ ok: false, error: { code: "encoder_failed" } });
    if (!result.ok) expect(result.error.message.length).toBeLessThanOrEqual(4_096);
  });

  it("bounds and redacts producer diagnostics in both the failure and attempt ledger", async () => {
    const result = await runStreamingFfmpegFinal({
      ...baseInput("producer-diagnostic"),
      processFactory: mockFactory().factory,
      produce: async () => { throw new Error(`TOKEN=hidden ${"x".repeat(20_000)}`); }
    });
    expect(result).toMatchObject({ ok: false, error: { code: "producer_failed", handoff: { attempts: [{ failure: { message: expect.stringContaining("TOKEN=[redacted]") } }] } } });
    if (!result.ok) {
      expect(result.error.message.length).toBeLessThanOrEqual(4_096);
      expect(result.error.message).not.toContain("hidden");
    }
  });

  it("cancels both sides and returns the governor's typed cancellation evidence", async () => {
    const controller = new AbortController();
    const factory = mockFactory();
    const result = await runStreamingFfmpegFinal({
      ...baseInput("cancel"),
      signal: controller.signal,
      processFactory: factory.factory,
      produce: async (sink) => {
        await sink.write({ index: 0, atMs: 0, png: FRAME });
        controller.abort(new Error("cancelled by test"));
      }
    });

    expect(result).toMatchObject({ ok: false, error: { code: "job_cancelled", resources: { state: "cancelled" } } });
    expect(result).toMatchObject({ ok: false, error: { handoff: { attempts: [{ outcome: "failed", failure: { code: "job_cancelled" } }] } } });
    expect(factory.abortCalls).toBe(1);
  });

  it("keeps the actual attempt ledger when the governor deadline stops a live stream", async () => {
    const factory = mockFactory();
    const result = await runStreamingFfmpegFinal({
      ...baseInput("deadline-ledger"),
      governor: governed(1, 100),
      processFactory: factory.factory,
      produce: async (sink) => {
        await sink.write({ index: 0, atMs: 0, png: FRAME });
        await new Promise((resolve) => setTimeout(resolve, 130));
      }
    });

    expect(result).toMatchObject({ ok: false, error: {
      code: "job_deadline_exceeded",
      resources: { state: "deadline_exceeded" },
      handoff: { attempts: [{ source: "software", outcome: "failed", failure: { code: "job_deadline_exceeded" } }] }
    } });
  });

  it("reruns the producer for hardware fallback without retaining frames", async () => {
    let produced = 0;
    const factory = mockFactory({ endExitCodes: [1, 0] });
    const result = await runStreamingFfmpegFinal({
      ...baseInput("retry"),
      frameCount: 2,
      fps: 2,
      attempts: [{ source: "hardware", encoder: "h264_nvenc", command: pipeCommand("hardware") }, { source: "software", encoder: "libx264", command: pipeCommand("software") }],
      processFactory: factory.factory,
      produce: async (sink) => {
        for (let index = 0; index < 2; index += 1) {
          produced += 1;
          await sink.write({ index, atMs: index * 500, png: FRAME });
        }
      }
    });

    expect(result).toMatchObject({
      ok: true,
      evidence: {
        encoderHandoffSourceFramesRetained: 0,
        attempts: [
          { source: "hardware", outcome: "failed" },
          { source: "software", outcome: "succeeded" }
        ]
      }
    });
    expect(produced).toBe(4);
    expect(factory.writeCalls).toBe(4);
  });

  it("fails quality before encoder completion and aborts the exact streaming process", async () => {
    const factory = mockFactory();
    const result = await runStreamingFfmpegFinal({
      ...baseInput("quality"),
      frameCount: 2,
      fps: 2,
      processFactory: factory.factory,
      produce: async (sink) => {
        await sink.write({ index: 0, atMs: 0, png: BLACK });
        await sink.write({ index: 1, atMs: 500, png: BLACK });
      }
    });

    expect(result).toMatchObject({ ok: false, error: { code: "frame_quality_failed" } });
    expect(factory.endCalls).toBe(0);
    expect(factory.abortCalls).toBe(1);
  });

  it("hands producer work the already-acquired lease instead of nesting a second governor job", async () => {
    const governor = governed(1);
    const factory = mockFactory();
    const result = await runStreamingFfmpegFinal({
      ...baseInput("admitted"),
      governor,
      processFactory: factory.factory,
      produce: async (sink, context) => {
        expect(context.job.admission).toBe("pre-acquired");
        await context.runAdmitted(async (job) => {
          expect(job.jobId).toBe(context.job.jobId);
          await sink.write({ index: 0, atMs: 0, png: FRAME });
        });
      }
    });

    expect(result).toMatchObject({ ok: true, evidence: { resources: { policy: { maxConcurrentJobs: 1 } } } });
  });

  it("reruns identical producer sandbox evidence but refuses conflicting retry evidence", async () => {
    const factory = mockFactory({ endExitCodes: [1, 0] });
    const successful = await runStreamingFfmpegFinal({
      ...baseInput("sandbox-retry"),
      frameCount: 2,
      fps: 2,
      attempts: hardwareThenSoftware(),
      processFactory: factory.factory,
      produce: async (sink, context) => {
        context.job.reportSandbox(chromiumSandbox());
        await sink.write({ index: 0, atMs: 0, png: FRAME });
        await sink.write({ index: 1, atMs: 500, png: FRAME });
      }
    });
    expect(successful).toMatchObject({ ok: true, evidence: { resources: { sandbox: chromiumSandbox() } } });

    let reports = 0;
    const conflicting = await runStreamingFfmpegFinal({
      ...baseInput("sandbox-conflict"),
      frameCount: 2,
      fps: 2,
      attempts: hardwareThenSoftware(),
      processFactory: mockFactory({ endExitCodes: [1, 0] }).factory,
      produce: async (sink, context) => {
        reports += 1;
        context.job.reportSandbox({ ...chromiumSandbox(), status: reports === 1 ? "requested" : "disabled", ...(reports === 1 ? {} : { reasonCode: "trusted_host_opt_out" as const }) });
        await sink.write({ index: 0, atMs: 0, png: FRAME });
        await sink.write({ index: 1, atMs: 500, png: FRAME });
      }
    });
    expect(conflicting).toMatchObject({ ok: false, error: { code: "streaming_evidence_conflict", resources: { state: "passed" } } });
  });

  it("refuses concurrent producer writes and conflicting encoder containment evidence", async () => {
    const concurrent = await runStreamingFfmpegFinal({
      ...baseInput("concurrent-write"),
      frameCount: 2,
      fps: 2,
      processFactory: mockFactory().factory,
      produce: async (sink) => Promise.all([
        sink.write({ index: 0, atMs: 0, png: FRAME }),
        sink.write({ index: 1, atMs: 500, png: FRAME })
      ]).then(() => undefined)
    });
    expect(concurrent).toMatchObject({ ok: false, error: { code: "streaming_write_concurrent", resources: { state: "passed" } } });

    const attempts = hardwareThenSoftware();
    const base = mockFactory({ endExitCodes: [1, 0] });
    let reports = 0;
    const conflictingContainment: StreamingFfmpegProcessFactory = async (input) => {
      reports += 1;
      input.reportProcessContainment(reports === 1 ? unixContainment() : { ...unixContainment(), memoryLimit: "none" });
      return base.factory({ ...input, reportProcessContainment: () => undefined });
    };
    const containment = await runStreamingFfmpegFinal({
      ...baseInput("containment-conflict"),
      frameCount: 2,
      fps: 2,
      attempts,
      processFactory: conflictingContainment,
      produce: async (sink) => {
        await sink.write({ index: 0, atMs: 0, png: FRAME });
        await sink.write({ index: 1, atMs: 500, png: FRAME });
      }
    });
    expect(containment).toMatchObject({ ok: false, error: { code: "streaming_evidence_conflict", resources: { state: "passed" } } });
  });

  it("keeps audio inputs intact when converting the uniquely anchored image input to image2pipe", () => {
    const materialized = buildEncodeImageSequenceCommand({
      framesDir: "/trusted/frames",
      fps: 30,
      durationMs: 1000,
      outputPath: "/trusted/out.mp4",
      audio: { path: "/trusted/audio.wav", normalizeLoudness: true },
      inputRoots: ["/trusted"],
      outputRoots: ["/trusted"]
    });
    const streamed = image2PipeCommandFromImageSequence(materialized);

    expect(streamed).toMatchObject({ shell: false });
    expect(streamed.args).toContain("pipe:0");
    expect(streamed.args).toContain("/trusted/audio.wav");
    expect(streamed.args.filter((arg) => arg === "-start_number")).toHaveLength(0);
    const audioFirst = image2PipeCommandFromImageSequence({
      executable: "ffmpeg",
      shell: false,
      args: ["-i", "/trusted/audio.wav", "-framerate", "30", "-start_number", "1", "-i", "/trusted/frames/%06d.png", "-shortest", "/trusted/out.mp4"]
    });
    expect(audioFirst.args).toEqual(["-i", "/trusted/audio.wav", "-framerate", "30", "-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0", "-shortest", "/trusted/out.mp4"]);
    expect(() => image2PipeCommandFromImageSequence({ ...materialized, args: [...materialized.args, "-start_number", "1"] })).toThrow("exactly one");
  });

  it("refuses unsupported quality, invalid metadata, and malformed pipe commands before spawning", async () => {
    let starts = 0;
    const factory: StreamingFfmpegProcessFactory = async (input) => {
      starts += 1;
      return earlyCloseFactory()(input);
    };
    const quality = await runStreamingFfmpegFinal({
      ...baseInput("quality-preflight"),
      quality: { minUniqueFrameHashes: 65 },
      processFactory: factory,
      produce: async () => { throw new Error("must not run"); }
    });
    const metadata = await runStreamingFfmpegFinal({
      ...baseInput("metadata-preflight"),
      width: 3_841,
      processFactory: factory,
      produce: async () => { throw new Error("must not run"); }
    });
    const cardinality = await runStreamingFfmpegFinal({
      ...baseInput("cardinality-preflight"),
      frameCount: 2,
      processFactory: factory,
      produce: async () => { throw new Error("must not run"); }
    });
    const frameBudget = await runStreamingFfmpegFinal({
      ...baseInput("frame-budget-preflight"),
      frameCount: 216_001,
      durationMs: 216_001_000,
      processFactory: factory,
      produce: async () => { throw new Error("must not run"); }
    });
    const malformed = await runStreamingFfmpegFinal({
      ...baseInput("malformed-command"),
      attempts: [{ source: "software", command: pipeCommand("ffmpeg", ["-f", "image2pipe", "-vcodec", "png", "-i", "not-pipe:0"]) }],
      processFactory: factory,
      produce: async () => { throw new Error("must not run"); }
    });
    const ambiguous = await runStreamingFfmpegFinal({
      ...baseInput("ambiguous-command"),
      attempts: [{ source: "software", command: pipeCommand("ffmpeg", ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0", "-i", "-"]) }],
      processFactory: factory,
      produce: async () => { throw new Error("must not run"); }
    });
    const indirectStdin = await runStreamingFfmpegFinal({
      ...baseInput("indirect-stdin-command"),
      attempts: [{ source: "software", command: pipeCommand("ffmpeg", ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0", "-filter_complex_script", "pipe:0"]) }],
      processFactory: factory,
      produce: async () => { throw new Error("must not run"); }
    });
    const stdinAliases = await Promise.all([
      "/dev/fd/0",
      "/dev/fd/00",
      "/proc/self/fd/0",
      "/proc/self/fd/00",
      "/proc/thread-self/fd/0",
      "pipe:00",
      "pipe:0?fd=0",
      "fd:0#stream",
      "cache:pipe:0",
      "async:pipe:0"
    ].map((alias) => runStreamingFfmpegFinal({
      ...baseInput(`stdin-alias-${alias.replace(/[^a-z0-9]/gi, "-")}`),
      attempts: [{ source: "software", command: pipeCommand("ffmpeg", ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0", "-filter_complex_script", alias]) }],
      processFactory: factory,
      produce: async () => { throw new Error("must not run"); }
    })));

    expect(quality).toMatchObject({ ok: false, error: { code: "streaming_quality_policy_unsupported" } });
    expect(metadata).toMatchObject({ ok: false, error: { code: "streaming_metadata_invalid" } });
    expect(cardinality).toMatchObject({ ok: false, error: { code: "streaming_metadata_invalid" } });
    expect(frameBudget).toMatchObject({ ok: false, error: { code: "job_input_budget_exceeded" } });
    expect(malformed).toMatchObject({ ok: false, error: { code: "streaming_command_invalid" } });
    expect(ambiguous).toMatchObject({ ok: false, error: { code: "streaming_command_invalid" } });
    expect(indirectStdin).toMatchObject({ ok: false, error: { code: "streaming_command_invalid" } });
    for (const alias of stdinAliases) expect(alias).toMatchObject({ ok: false, error: { code: "streaming_command_invalid" } });
    expect(starts).toBe(0);
  });

  it("tracks bounded byte buffering across many small producer frames", async () => {
    const factory = mockFactory({ bufferedInputBytes: 112, inputHighWaterMarkBytes: 16 * 1024 });
    const result = await runStreamingFfmpegFinal({
      ...baseInput("small-frames"),
      frameCount: 20,
      durationMs: 1_000,
      fps: 20,
      processFactory: factory.factory,
      produce: async (sink) => {
        for (let index = 0; index < 20; index += 1) await sink.write({ index, atMs: index * 50, png: FRAME });
      }
    });
    expect(result).toMatchObject({
      ok: true,
      evidence: { maxConcurrentProducerWrites: 1, observedMaxConcurrentProducerWrites: 1, maxBufferedInputBytes: 112, inputHighWaterMarkBytes: 16 * 1024, backpressure: { writes: 20 } }
    });
  });

  it("refuses an oversized PNG payload before decode or encoder stdin write", async () => {
    const factory = mockFactory();
    const result = await runStreamingFfmpegFinal({
      ...baseInput("oversized-png"),
      processFactory: factory.factory,
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: Buffer.alloc((2 * 2 * 4) + 1_048_577) })
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_frame", handoff: { maxPngBytesPerFrame: (2 * 2 * 4) + 1_048_576 } } });
    expect(factory.writeCalls).toBe(0);
  });

});

function baseInput(label: string) {
  return {
    frameCount: 1,
    durationMs: 1000,
    fps: 1,
    width: 2,
    height: 2,
    attempts: [{ source: "software" as const, command: pipeCommand(label) }],
    scratchRoot: join(tmpdir(), `shellx-motion-stream-${label}`),
    governor: governed(1)
  };
}

function pipeCommand(executable: string, args: string[] = ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"]): FfmpegCommand {
  return { executable, args, shell: false };
}

function governed(maxConcurrentJobs: number, maxWallClockMs = 10_000): LocalMotionJobGovernor {
  return new LocalMotionJobGovernor({
    maxConcurrentJobs,
    maxQueueDepth: 2,
    maxQueueWaitMs: 500,
    maxWallClockMs,
    minFreeScratchBytes: 0,
    scratchReservationBytes: 0,
    maxProcessTreeRssBytes: 512 * 1024 * 1024,
    rssPollIntervalMs: 1_000
  }, { leases: null, freeScratchBytes: async () => Number.MAX_SAFE_INTEGER });
}

function mockFactory(options: {
  endExitCodes?: number[];
  backpressured?: boolean;
  bufferedInputBytes?: number;
  inputHighWaterMarkBytes?: number;
  stderr?: string;
} = {}) {
  let endIndex = 0;
  const state = { abortCalls: 0, endCalls: 0, writeCalls: 0 };
  const factory: StreamingFfmpegProcessFactory = async (input) => {
    input.reportProcessContainment(unixContainment());
    let resolveClosed!: (result: FfmpegProcessResult) => void;
    const closed = new Promise<FfmpegProcessResult>((resolve) => { resolveClosed = resolve; });
    let settled: FfmpegProcessResult | undefined;
    const settle = (result: FfmpegProcessResult) => {
      if (!settled) {
        settled = result;
        resolveClosed(result);
      }
      return settled;
    };
    const process: StreamingFfmpegProcess = {
      closed,
      write: async () => {
        state.writeCalls += 1;
        return {
          backpressured: options.backpressured === true,
          bufferedInputBytes: options.bufferedInputBytes ?? 0,
          inputHighWaterMarkBytes: options.inputHighWaterMarkBytes ?? 16 * 1024
        };
      },
      end: async () => {
        state.endCalls += 1;
        return settle({ exitCode: options.endExitCodes?.[endIndex++] ?? 0, stdout: "", stderr: options.stderr ?? "hardware failure" });
      },
      abort: async () => {
        state.abortCalls += 1;
        return settle({ exitCode: 1, stdout: "", stderr: "stopped" });
      }
    };
    return process;
  };
  return { factory, ...state, get abortCalls() { return state.abortCalls; }, get endCalls() { return state.endCalls; }, get writeCalls() { return state.writeCalls; } };
}

function earlyCloseFactory(): StreamingFfmpegProcessFactory {
  return async (input: StartStreamingFfmpegProcessInput) => {
    input.reportProcessContainment(unixContainment());
    const result = { exitCode: 1, stdout: "", stderr: "encoder exited early" };
    return {
      closed: Promise.resolve(result),
      write: async () => ({ backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16 * 1024 }),
      end: async () => result,
      abort: async () => result
    };
  };
}

function unixContainment() {
  return { schema: "shellx-motion/process-containment@1" as const, mode: "unix-process-group" as const, status: "enforced" as const, killTree: true, memoryLimit: "rss-monitor" as const };
}

function chromiumSandbox() {
  return {
    schema: "shellx-motion/runtime-sandbox@1" as const,
    provider: "chromium" as const,
    status: "requested" as const,
    scope: "browser-process" as const
  };
}

function hardwareThenSoftware() {
  return [
    { source: "hardware" as const, encoder: "h264_nvenc", command: pipeCommand("hardware") },
    { source: "software" as const, encoder: "libx264", command: pipeCommand("software") }
  ];
}

async function scratch(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `shellx-motion-stream-${label}-`));
  tempDirs.push(path);
  return path;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
