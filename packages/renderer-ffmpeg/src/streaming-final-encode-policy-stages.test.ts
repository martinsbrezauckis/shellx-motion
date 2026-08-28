import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRgbaPng } from "@shellx-motion/core";
import {
  type FfmpegCommand,
  type FfmpegHardwareEncoderUsability,
  type FfmpegProcessResult,
  type FfmpegRunner
} from "./index";
import { encodePolicyCacheKey, type EncodePolicyCache } from "./encode-policy";
import {
  bindStreamingFinalResourceEvidence,
  finalizeStreamingFinalEncodePolicy,
  prepareStreamingFinalEncodePolicy,
  releaseStreamingFinalMediaSnapshots,
  runStreamingFinalEncodePolicy,
  type StreamingFinalEncodeExecutionEvidence
} from "./streaming-final-encode-policy";
import type { StreamingFfmpegProcess, StreamingFfmpegProcessFactory } from "./streaming-process";

const tempDirs: string[] = [];
const FRAME = encodeRgbaPng(2, 2, Buffer.from([
  0, 0, 0, 255, 255, 255, 255, 255,
  10, 80, 180, 255, 250, 30, 40, 255
]));

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("streaming final encode policy stages", () => {
  it("captures audio privately before its injected measurement runner, without frame production or output mutation", async () => {
    const root = await scratch("prepare");
    const audioPath = join(root, "music.wav");
    const outputPath = join(root, "out.mp4");
    await writeFile(audioPath, "audio-bytes");
    const commands: FfmpegCommand[] = [];
    const preparation = await prepareStreamingFinalEncodePolicy({
      input: {
        fps: 1,
        width: 2,
        height: 2,
        durationMs: 1_000,
        outputPath,
        inputRoots: [root],
        outputRoots: [root],
        forceSoftwareEncode: true,
        audio: { path: audioPath, normalizeLoudness: true }
      },
      runner: async (command) => {
        commands.push(command);
        return evidenceRunner()(command);
      }
    });

    expect(preparation).toMatchObject({
      ok: true,
      prepared: {
        plannedAttempts: [{ source: "software" }],
        renderAudioInputs: [{
          path: expect.stringMatching(/\/shellx-motion-ffmpeg-media-[^/]+\/[a-f0-9]{64}\.wav$/),
          receiptPath: audioPath,
          snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          loudnormMeasured: expect.any(Object)
        }]
      }
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toContain("-af");
    expect(commands[0]?.args).not.toContain(audioPath);
    expect(commands[0]?.args).toEqual(expect.arrayContaining([
      "-protocol_whitelist", "file", "-format_whitelist", "wav", "-i",
      expect.stringMatching(/\/shellx-motion-ffmpeg-media-[^/]+\/[a-f0-9]{64}\.wav$/)
    ]));
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    if (preparation.ok) await releaseStreamingFinalMediaSnapshots(preparation.prepared.mediaSnapshots);
  });

  it("accepts a durable complete-hash capacity only when the internal caller supplies it", async () => {
    const root = await scratch("complete-hash-capacity");
    const outputPath = join(root, "out.mp4");
    const normal = await prepareStreamingFinalEncodePolicy({
      input: { ...baseInput(root, outputPath), quality: { minUniqueFrameHashes: 65 } },
      runner: evidenceRunner()
    });
    const durable = await prepareStreamingFinalEncodePolicy({
      input: {
        ...baseInput(root, outputPath),
        quality: { minUniqueFrameHashes: 2 },
        qualityCapability: { uniqueFrameHashCapacity: 2 }
      },
      runner: evidenceRunner()
    });
    const oneFrame = await prepareStreamingFinalEncodePolicy({
      input: {
        ...baseInput(root, outputPath),
        quality: { minUniqueFrameHashes: 1 },
        qualityCapability: { uniqueFrameHashCapacity: 1 }
      },
      runner: evidenceRunner()
    });

    expect(normal).toMatchObject({ ok: false, error: { code: "streaming_quality_policy_unsupported" } });
    expect(durable).toMatchObject({ ok: true });
    expect(oneFrame).toMatchObject({ ok: true });
  });

  it("finalizes supplied success facts with only injected readback and exactly matches wrapper evidence", async () => {
    const root = await scratch("finalize");
    const outputPath = join(root, "out.mp4");
    const policyInput = baseInput(root, outputPath);
    const runner = evidenceRunner();
    const wrapped = await runStreamingFinalEncodePolicy({
      ...policyInput,
      runner,
      processFactory: outputFactory(outputPath, [0]),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME })
    });
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;

    const preparation = await prepareStreamingFinalEncodePolicy({ input: policyInput, runner });
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) return;
    const readbackCommands: FfmpegCommand[] = [];
    const finalized = await finalizeStreamingFinalEncodePolicy({
      prepared: preparation.prepared,
      runner: async (command) => {
        readbackCommands.push(command);
        return evidenceRunner()(command);
      },
      execution: {
        command: wrapped.command,
        output: { exitCode: 0, stdout: "", stderr: "" },
        attempts: wrapped.handoff.attempts
      },
      frameSequence: {
        sha256: wrapped.handoff.frameSequence.sha256,
        quality: wrapped.handoff.quality
      }
    });

    expect(finalized).toMatchObject({ ok: true, receiptEvidence: { inputHashes: { frames: expect.any(String) } } });
    if (!finalized.ok) return;
    expect(finalized.receiptEvidence.output).not.toHaveProperty("resources");
    const probesBeforeBinding = readbackCommands.length;
    const bound = bindStreamingFinalResourceEvidence(finalized.receiptEvidence, wrapped.handoff.resources);
    expect(bound).toEqual(wrapped.receiptEvidence);
    expect(readbackCommands).toHaveLength(probesBeforeBinding);
    expect(readbackCommands).toHaveLength(1);
    expect(readbackCommands[0]?.args).toContain("-show_streams");
    expect(await readFile(outputPath, "utf8")).toBe("encoded-media");
  });

  it("invalidates hardware capability only from actual final attempt history, never a planned fallback", async () => {
    const root = await scratch("attempt-history");
    const outputPath = join(root, "out.mp4");
    const wrapped = await runStreamingFinalEncodePolicy({
      ...baseInput(root, outputPath),
      runner: evidenceRunner(),
      processFactory: outputFactory(outputPath, [0]),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME })
    });
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;

    const invalidated: string[] = [];
    const cache: EncodePolicyCache = {
      get: () => undefined,
      set: () => {},
      delete: (key) => { invalidated.push(key); },
      clear: () => {}
    };
    const preparation = await prepareStreamingFinalEncodePolicy({
      input: { ...baseInput(root, outputPath), forceSoftwareEncode: false, cache, hardwareProbe: usableHardwareProbe() },
      runner: evidenceRunner()
    });
    expect(preparation).toMatchObject({ ok: true, prepared: { plannedAttempts: [{ source: "hardware" }, { source: "software" }] } });
    if (!preparation.ok) return;
    const common = {
      prepared: preparation.prepared,
      runner: evidenceRunner(),
      frameSequence: { sha256: wrapped.handoff.frameSequence.sha256, quality: wrapped.handoff.quality }
    };
    await finalizeStreamingFinalEncodePolicy({
      ...common,
      execution: {
        command: preparation.prepared.plannedAttempts[0]!.command,
        output: { exitCode: 0, stdout: "", stderr: "" },
        attempts: [{
          source: preparation.prepared.plannedAttempts[0]!.source,
          ...(preparation.prepared.plannedAttempts[0]!.encoder ? { encoder: preparation.prepared.plannedAttempts[0]!.encoder } : {}),
          outcome: "succeeded"
        }]
      }
    });
    expect(invalidated).toEqual([]);
    await finalizeStreamingFinalEncodePolicy({
      ...common,
      execution: {
        command: preparation.prepared.plannedAttempts[1]!.command,
        output: { exitCode: 0, stdout: "", stderr: "" },
        attempts: [
          {
            source: preparation.prepared.plannedAttempts[0]!.source,
            ...(preparation.prepared.plannedAttempts[0]!.encoder ? { encoder: preparation.prepared.plannedAttempts[0]!.encoder } : {}),
            outcome: "failed",
            failure: { code: "encoder_failed", message: "hardware failed" }
          },
          {
            source: preparation.prepared.plannedAttempts[1]!.source,
            ...(preparation.prepared.plannedAttempts[1]!.encoder ? { encoder: preparation.prepared.plannedAttempts[1]!.encoder } : {}),
            outcome: "succeeded"
          }
        ]
      }
    });
    expect(invalidated).toEqual([encodePolicyCacheKey("h264")]);
  });

  it("fails closed on forged execution evidence before readback or cache invalidation", async () => {
    const root = await scratch("forged-execution");
    const outputPath = join(root, "out.mp4");
    const invalidated: string[] = [];
    const cache: EncodePolicyCache = {
      get: () => undefined,
      set: () => {},
      delete: (key) => { invalidated.push(key); },
      clear: () => {}
    };
    const preparation = await prepareStreamingFinalEncodePolicy({
      input: { ...baseInput(root, outputPath), forceSoftwareEncode: false, cache, hardwareProbe: usableHardwareProbe() },
      runner: evidenceRunner()
    });
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) return;
    const command = preparation.prepared.plannedAttempts[0]!.command;
    const attempted = (index: number, outcome: "succeeded" | "failed") => {
      const planned = preparation.prepared.plannedAttempts[index]!;
      return { source: planned.source, ...(planned.encoder ? { encoder: planned.encoder } : {}), outcome };
    };
    let runnerCalls = 0;
    const finalize = async (execution: StreamingFinalEncodeExecutionEvidence) => await finalizeStreamingFinalEncodePolicy({
      prepared: preparation.prepared,
      runner: async () => {
        runnerCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "must not run" };
      },
      execution,
      frameSequence: {
        sha256: "a".repeat(64),
        quality: { warnings: [], frameCount: 1, blankFrames: 0, uniqueFrameHashes: 1, uniqueFrameHashesExact: true }
      }
    });
    const results = [
      await finalize({ command, output: { exitCode: 1, stdout: "", stderr: "failed" }, attempts: [attempted(0, "succeeded")] }),
      await finalize({ command, output: { exitCode: 0, stdout: "", stderr: "" }, attempts: [] }),
      await finalize({ command, output: { exitCode: 0, stdout: "", stderr: "" }, attempts: [{ source: "hardware", outcome: "succeeded" }] }),
      await finalize({ command, output: { exitCode: 0, stdout: "", stderr: "" }, attempts: [attempted(0, "failed")] }),
      await finalize({ command, output: { exitCode: 0, stdout: "", stderr: "" }, attempts: [attempted(0, "succeeded"), attempted(1, "succeeded")] }),
      await finalize({ command: { ...command, args: [...command.args, "-forged"] }, output: { exitCode: 0, stdout: "", stderr: "" }, attempts: [attempted(0, "succeeded")] })
    ];

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: "streaming_execution_evidence_invalid" } });
      if (!result.ok) expect(result.error.partialOutput).toBeUndefined();
    }
    expect(runnerCalls).toBe(0);
    expect(invalidated).toEqual([]);
  });
});

function baseInput(root: string, outputPath: string) {
  return {
    fps: 1,
    width: 2,
    height: 2,
    durationMs: 1_000,
    outputPath,
    inputRoots: [root],
    outputRoots: [root],
    forceSoftwareEncode: true
  };
}

function evidenceRunner(): FfmpegRunner {
  return async (command) => {
    if (command.args.includes("-af")) {
      return {
        exitCode: 0,
        stdout: "",
        stderr: '{"input_i":"-12","input_tp":"-1","input_lra":"4","input_thresh":"-22","target_offset":"0.3"}'
      };
    }
    if (command.args.includes("-show_streams")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", codec_name: "h264", width: 2, height: 2, avg_frame_rate: "1/1", duration: "1", pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }],
          format: { duration: "1", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
        }),
        stderr: ""
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function outputFactory(outputPath: string, exitCodes: number[]): StreamingFfmpegProcessFactory {
  let attempt = 0;
  return async (input) => {
    input.reportProcessContainment({ schema: "shellx-motion/process-containment@1", mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor" });
    let settled: FfmpegProcessResult | undefined;
    let resolveClosed!: (result: FfmpegProcessResult) => void;
    const closed = new Promise<FfmpegProcessResult>((resolve) => { resolveClosed = resolve; });
    const settle = (result: FfmpegProcessResult) => {
      if (!settled) {
        settled = result;
        resolveClosed(result);
      }
      return settled;
    };
    const process: StreamingFfmpegProcess = {
      closed,
      write: async () => ({ backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16 * 1024 }),
      end: async () => {
        const exitCode = exitCodes[attempt++] ?? 0;
        if (exitCode === 0) await writeFile(outputPath, "encoded-media");
        return settle({ exitCode, stdout: "", stderr: exitCode === 0 ? "" : "encoder failed" });
      },
      abort: async () => settle({ exitCode: 1, stdout: "", stderr: "aborted" })
    };
    return process;
  };
}

function usableHardwareProbe(): FfmpegHardwareEncoderUsability {
  return {
    ok: true,
    command: "ffmpeg",
    selection: "first-usable",
    usableEncoders: ["h264_nvenc"],
    probes: [{ encoder: "h264_nvenc", compiled: true, usable: true, status: "usable", exitCode: 0 }]
  };
}

async function scratch(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `shellx-motion-stream-stage-${label}-`));
  tempDirs.push(path);
  return path;
}
