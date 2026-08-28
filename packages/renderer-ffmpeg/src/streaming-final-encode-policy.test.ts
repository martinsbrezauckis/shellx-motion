import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRgbaPng } from "@shellx-motion/core";
import {
  buildEncodeImageSequenceCommand,
  encodeImageSequence,
  type FfmpegCommand,
  type FfmpegHardwareEncoderUsability,
  type FfmpegProcessResult,
  type FfmpegRunner
} from "./index";
import { image2PipeCommandFromImageSequence } from "./streaming-foundation";
import type { StreamingFfmpegProcess, StreamingFfmpegProcessFactory } from "./streaming-process";
import { runStreamingFinalEncodePolicy } from "./streaming-final-encode-policy";
import { createEncodePolicyCache } from "./encode-policy";

const tempDirs: string[] = [];
const initialForceSoftwareEncode = process.env.SHELLX_MOTION_FORCE_SOFTWARE_ENCODE;
const hostFfmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const FRAME_A = encodeRgbaPng(2, 2, Buffer.from([
  0, 0, 0, 255, 255, 255, 255, 255,
  10, 80, 180, 255, 250, 30, 40, 255
]));
const FRAME_B = encodeRgbaPng(2, 2, Buffer.from([
  255, 255, 255, 255, 0, 0, 0, 255,
  20, 130, 30, 255, 30, 20, 160, 255
]));

afterEach(async () => {
  if (initialForceSoftwareEncode === undefined) delete process.env.SHELLX_MOTION_FORCE_SOFTWARE_ENCODE;
  else process.env.SHELLX_MOTION_FORCE_SOFTWARE_ENCODE = initialForceSoftwareEncode;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("streaming final encode policy", () => {
  it("shares materialized audio/loudness command decisions without requiring a frame directory", async () => {
    const root = await scratch("audio-parity");
    const outputPath = join(root, "out.mp4");
    const audioPath = join(root, "music.wav");
    await writeFile(audioPath, "audio-bytes");
    const processFactory = outputFactory(outputPath, [0]);
    const result = await runStreamingFinalEncodePolicy({
      fps: 2,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      audio: { path: audioPath, normalizeLoudness: true },
      runner: evidenceRunner({ audio: true }),
      processFactory,
      produce: async (sink) => {
        await sink.write({ index: 0, atMs: 0, png: FRAME_A });
        await sink.write({ index: 1, atMs: 500, png: FRAME_B });
      }
    });

    expect(result).toMatchObject({
      ok: true,
      receiptEvidence: {
        output: { encoderReason: "forced-software", audio: { path: audioPath, loudness: { mode: "two-pass" } }, tools: { ffmpeg: expect.any(Object), ffprobe: expect.any(Object) } },
        inputHashes: { "audio:0": expect.any(String), frames: expect.any(String) }
      }
    });
    if (!result.ok) return;
    const placeholderFramesDir = join(dirname(outputPath), ".shellx-motion-streaming-command-input");
    const materialized = buildEncodeImageSequenceCommand({
      framesDir: placeholderFramesDir,
      fps: 2,
      durationMs: 1_000,
      outputPath,
      inputRoots: [placeholderFramesDir, root],
      outputRoots: [root],
      audioTracks: [{
        path: audioPath,
        normalizeLoudness: true,
        loudnormMeasured: { integratedLufs: -12, truePeakDbtp: -1, lra: 4, thresholdLufs: -22, offsetLu: 0.3 }
      }]
    });
    const normalizedCommand = {
      ...result.command,
      args: result.command.args.map((arg) => arg.includes("/shellx-motion-ffmpeg-media-") ? audioPath : arg)
    };
    expect(normalizedCommand).toEqual(image2PipeCommandFromImageSequence(materialized));
    expect(result.command.args).not.toContain(audioPath);
    expect(result.command.args).not.toContain(placeholderFramesDir);
  });

  it("records the actual hardware failure and software rerender, then invalidates no inferred attempt", async () => {
    const root = await scratch("fallback");
    const outputPath = join(root, "out.mp4");
    const result = await runStreamingFinalEncodePolicy({
      fps: 2,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      hardwareProbe: usableHardwareProbe(),
      runner: evidenceRunner(),
      processFactory: outputFactory(outputPath, [1, 0]),
      produce: async (sink) => {
        await sink.write({ index: 0, atMs: 0, png: FRAME_A });
        await sink.write({ index: 1, atMs: 500, png: FRAME_B });
      }
    });

    expect(result).toMatchObject({ ok: true, plannedAttempts: [{ source: "hardware" }, { source: "software" }], handoff: {
      attempts: [
        { source: "hardware", outcome: "failed", failure: { code: "encoder_failed" } },
        { source: "software", outcome: "succeeded" }
      ]
    }, receiptEvidence: { output: { encoderReason: "hardware-fallback", encoderFallback: { attemptedEncoder: "h264_nvenc" } } } });
  });

  it("labels planned fallback separately when the hardware attempt itself succeeds", async () => {
    const root = await scratch("hardware-success");
    const outputPath = join(root, "out.mp4");
    const result = await runStreamingFinalEncodePolicy({
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      hardwareProbe: usableHardwareProbe(),
      runner: evidenceRunner({ fps: 1 }),
      processFactory: outputFactory(outputPath, [0]),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A })
    });

    expect(result).toMatchObject({ ok: true, plannedAttempts: [{ source: "hardware" }, { source: "software" }], handoff: {
      attempts: [{ source: "hardware", outcome: "succeeded" }]
    } });
  });

  it("returns resource evidence and exact encoder outcome when streaming fails before an output exists", async () => {
    const root = await scratch("encoder-failure");
    const outputPath = join(root, "out.mp4");
    const result = await runStreamingFinalEncodePolicy({
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      runner: evidenceRunner(),
      processFactory: outputFactory(outputPath, [1], false),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A })
    });

    expect(result).toMatchObject({ ok: false, error: {
      code: "encoder_failed",
      resources: { processContainment: { status: "enforced" } },
      handoff: { attempts: [{ source: "software", outcome: "failed", failure: { process: { exitCode: 1 } } }] }
    } });
    if (!result.ok) expect(result.error.partialOutput).toBeUndefined();
  });

  it("keeps a real but nonconforming output as a quarantinable partial artifact", async () => {
    const root = await scratch("validation-failure");
    const outputPath = join(root, "out.mp4");
    const result = await runStreamingFinalEncodePolicy({
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      runner: evidenceRunner({ width: 3 }),
      processFactory: outputFactory(outputPath, [0]),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A })
    });

    expect(result).toMatchObject({ ok: false, error: {
      code: "output_validation_failed",
      partialOutput: { path: outputPath, status: "nonconforming", sha256: expect.any(String), observedMedia: { width: 3 } }
    } });
  });

  it("distinguishes missing output from an existing but unverified output", async () => {
    const root = await scratch("partial-output");
    const missingPath = join(root, "missing.mp4");
    const missing = await runStreamingFinalEncodePolicy({
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath: missingPath,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      runner: evidenceRunner({ fps: 1 }),
      processFactory: outputFactory(missingPath, [0], false),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A })
    });
    const uncertainPath = join(root, "uncertain.mp4");
    const uncertainRunner: FfmpegRunner = async (command) => command.args.includes("-show_streams")
      ? { exitCode: 1, stdout: "", stderr: `TOKEN=hidden ${"x".repeat(20_000)}` }
      : evidenceRunner({ fps: 1 })(command);
    const uncertain = await runStreamingFinalEncodePolicy({
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath: uncertainPath,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      runner: uncertainRunner,
      processFactory: outputFactory(uncertainPath, [0]),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A })
    });
    const hashFailureTarget = join(root, "hash-target.mp4");
    const hashFailurePath = join(root, "hash-unverified.mp4");
    await writeFile(hashFailureTarget, "target");
    let hashFailure: Awaited<ReturnType<typeof runStreamingFinalEncodePolicy>> | undefined;
    try {
      await symlink(hashFailureTarget, hashFailurePath);
      hashFailure = await runStreamingFinalEncodePolicy({
        fps: 1,
        width: 2,
        height: 2,
        durationMs: 1_000,
        outputPath: hashFailurePath,
        inputRoots: [root],
        outputRoots: [root],
        forceSoftwareEncode: true,
        runner: evidenceRunner({ fps: 1 }),
        processFactory: outputFactory(hashFailurePath, [0]),
        produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A })
      });
    } catch (error) {
      if (!isWindowsSymlinkUnavailable(error)) throw error;
      // Standard Windows accounts cannot create file symlinks; other hosts retain this hash-refusal case.
    }

    expect(missing).toMatchObject({ ok: false, error: { partialOutput: { status: "missing" } } });
    expect(uncertain).toMatchObject({ ok: false, error: { partialOutput: { status: "unverified", sha256: expect.any(String) } } });
    if (hashFailure) expect(hashFailure).toMatchObject({ ok: false, error: { partialOutput: { status: "unverified" } } });
    if (!missing.ok) expect(missing.error.partialOutput?.tools.ffprobe).toBeUndefined();
    if (hashFailure && !hashFailure.ok) expect(hashFailure.error.partialOutput?.tools.ffprobe).toBeUndefined();
    if (!uncertain.ok) {
      expect(uncertain.error.partialOutput?.tools.ffprobe).toEqual(expect.any(Object));
      expect(uncertain.error.message).not.toContain("hidden");
      expect(uncertain.error.message.length).toBeLessThanOrEqual(4_096);
    }
  });

  it("keeps quality and genuine encoder warnings in the receipt-compatible evidence", async () => {
    const root = await scratch("warnings");
    const outputPath = join(root, "out.mp4");
    const result = await runStreamingFinalEncodePolicy({
      fps: 2,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      runner: evidenceRunner(),
      processFactory: outputFactory(outputPath, [0], true, "genuine encoder warning"),
      produce: async (sink) => {
        await sink.write({ index: 0, atMs: 0, png: FRAME_A });
        await sink.write({ index: 1, atMs: 500, png: FRAME_A });
      }
    });

    expect(result).toMatchObject({ ok: true, receiptEvidence: { warnings: expect.arrayContaining([
      "genuine encoder warning",
      "Rendered frame sequence is static; verify this is intentional before using it as product output."
    ]) } });
  });

  it("runs stream-only preflight before probes, production, or a process start", async () => {
    const root = await scratch("preflight");
    let runnerCalls = 0;
    let processStarts = 0;
    const runner: FfmpegRunner = async () => {
      runnerCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const processFactory: StreamingFfmpegProcessFactory = async () => {
      processStarts += 1;
      throw new Error("must not start");
    };
    const common = {
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath: join(root, "out.mp4"),
      inputRoots: [root],
      outputRoots: [root],
      runner,
      processFactory,
      produce: async () => { throw new Error("must not produce"); }
    };
    const invalid = await runStreamingFinalEncodePolicy({ ...common, width: 3_841 });
    const unique = await runStreamingFinalEncodePolicy({ ...common, quality: { minUniqueFrameHashes: 65 } });
    const exactSource = await runStreamingFinalEncodePolicy({ ...common, qualityManifest: { exactSourceComparison: "required" } });

    expect(invalid).toMatchObject({ ok: false, error: { code: "streaming_metadata_invalid" } });
    expect(unique).toMatchObject({ ok: false, error: { code: "streaming_quality_policy_unsupported" } });
    expect(exactSource).toMatchObject({ ok: false, error: { code: "streaming_quality_boundary_unsupported" } });
    expect({ runnerCalls, processStarts }).toEqual({ runnerCalls: 0, processStarts: 0 });
  });

  it("uses one resolved force-software decision for explicit and environment override cases", async () => {
    const root = await scratch("force-software");
    const run = async (name: string, forceSoftwareEncode: boolean | undefined, runner: FfmpegRunner) => runStreamingFinalEncodePolicy({
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath: join(root, `${name}.mp4`),
      inputRoots: [root],
      outputRoots: [root],
      ...(forceSoftwareEncode !== undefined ? { forceSoftwareEncode } : {}),
      cache: createEncodePolicyCache(),
      runner,
      processFactory: outputFactory(join(root, `${name}.mp4`), [0]),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A })
    });
    const explicitCommands: FfmpegCommand[] = [];
    const explicit = await run("explicit", true, async (command) => {
      explicitCommands.push(command);
      return evidenceRunner({ fps: 1 })(command);
    });
    process.env.SHELLX_MOTION_FORCE_SOFTWARE_ENCODE = "yes";
    const environmentCommands: FfmpegCommand[] = [];
    const environment = await run("environment", undefined, async (command) => {
      environmentCommands.push(command);
      return evidenceRunner({ fps: 1 })(command);
    });
    const explicitFalseCommands: FfmpegCommand[] = [];
    const explicitFalse = await run("explicit-false", false, async (command) => {
      explicitFalseCommands.push(command);
      return evidenceRunner({ fps: 1 })(command);
    });

    expect(explicit).toMatchObject({ ok: true, plannedAttempts: [{ source: "software" }] });
    expect(environment).toMatchObject({ ok: true, plannedAttempts: [{ source: "software" }] });
    expect(explicitCommands.some((command) => command.args.includes("-encoders"))).toBe(false);
    expect(environmentCommands.some((command) => command.args.includes("-encoders"))).toBe(false);
    expect(explicitFalse).toMatchObject({ ok: true, plannedAttempts: [{ source: "software" }] });
    expect(explicitFalseCommands.some((command) => command.args.includes("-encoders"))).toBe(true);
  });

  it.each([
    ["codec", { codec: "hevc" }, "codec"],
    ["container", { container: "webm" }, "container"],
    ["fps", { fps: 2 }, "fps"],
    ["duration", { durationMs: 3_000 }, "duration"],
    ["requested audio presence", { audio: false }, "missing the requested audio"],
    ["requested audio codec", { audio: true, audioCodec: "opus" }, "audio codec"],
    ["requested audio duration", { audio: true, audioDurationMs: 3_000 }, "audio duration"]
  ])("rejects delivered %s mismatch as a concrete nonconforming artifact", async (_name, facts, message) => {
    const root = await scratch(`output-${_name}`);
    const outputPath = join(root, "out.mp4");
    const audioPath = join(root, "audio.wav");
    await writeFile(audioPath, "audio");
    const result = await runStreamingFinalEncodePolicy({
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      ...(_name.startsWith("requested audio") ? { audio: { path: audioPath } } : {}),
      runner: evidenceRunner({ fps: 1, ...facts }),
      processFactory: outputFactory(outputPath, [0]),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A })
    });
    expect(result).toMatchObject({ ok: false, error: {
      code: "output_validation_failed",
      partialOutput: { status: "nonconforming", observedMedia: expect.any(Object) }
    } });
    if (!result.ok) expect(result.error.message).toContain(message);
  });

  it("requires alpha for alpha presets when FFprobe can prove it is absent", async () => {
    const root = await scratch("output-alpha");
    const outputPath = join(root, "out.webm");
    const result = await runStreamingFinalEncodePolicy({
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      preset: "webm-vp9-alpha",
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      runner: evidenceRunner({ codec: "vp9", container: "webm", fps: 1, alpha: false }),
      processFactory: outputFactory(outputPath, [0]),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A })
    });
    expect(result).toMatchObject({ ok: false, error: { code: "output_validation_failed", partialOutput: { status: "nonconforming" } } });
    if (!result.ok) expect(result.error.message).toContain("alpha");
  });

  it("requires alpha for MOV ProRes 4444 when FFprobe can prove it is absent", async () => {
    const root = await scratch("output-prores-alpha");
    const outputPath = join(root, "out.mov");
    const result = await runStreamingFinalEncodePolicy({
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      preset: "mov-prores",
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      runner: evidenceRunner({ codec: "prores", container: "mov", fps: 1, alpha: false }),
      processFactory: outputFactory(outputPath, [0]),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A })
    });
    expect(result).toMatchObject({ ok: false, error: { code: "output_validation_failed", partialOutput: { status: "nonconforming" } } });
    if (!result.ok) expect(result.error.message).toContain("alpha");
  });

  it("keeps the materialized receipt output shape compatible while adding FFprobe evidence", async () => {
    const root = await scratch("receipt-shape");
    const framesDir = join(root, "frames");
    const materializedOutput = join(root, "materialized.mp4");
    const streamedOutput = join(root, "streamed.mp4");
    await mkdir(framesDir);
    await writeFile(join(framesDir, "000001.png"), FRAME_A);
    const runner = materializedEvidenceRunner({ fps: 1 });
    const materialized = await encodeImageSequence({
      packageId: "internal-shape-test",
      framesDir,
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath: materializedOutput,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      runner
    });
    const streamed = await runStreamingFinalEncodePolicy({
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath: streamedOutput,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      runner,
      processFactory: outputFactory(streamedOutput, [0]),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A })
    });
    expect(materialized.ok).toBe(true);
    expect(streamed).toMatchObject({ ok: true, receiptEvidence: { output: { tools: { ffmpeg: expect.any(Object), ffprobe: expect.any(Object) } } } });
    if (!materialized.ok || !streamed.ok) return;
    expect(streamed.receiptEvidence.output.tools).toMatchObject((materialized.receipt.output as { tools: unknown }).tools as object);
  });
  it.skipIf(!hostFfmpegAvailable)("runs an actual image2pipe FFmpeg encode (requires local FFmpeg; skipped when unavailable)", async () => {
    const root = await scratch("real-pipe");
    const outputPath = join(root, "out.mp4");
    const result = await runStreamingFinalEncodePolicy({
      fps: 2,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      produce: async (sink) => {
        await sink.write({ index: 0, atMs: 0, png: FRAME_A });
        await sink.write({ index: 1, atMs: 500, png: FRAME_B });
      }
    });

    expect(result).toMatchObject({ ok: true, receiptEvidence: { output: { sha256: expect.any(String), observedMedia: { codec: "h264", width: 2, height: 2 } } } });
  });

});

function isWindowsSymlinkUnavailable(error: unknown): boolean {
  return process.platform === "win32" && (error as NodeJS.ErrnoException)?.code === "EPERM";
}

function evidenceRunner(options: {
  width?: number;
  audio?: boolean;
  fps?: number;
  codec?: string;
  container?: string;
  durationMs?: number;
  audioCodec?: string;
  audioDurationMs?: number;
  alpha?: boolean;
} = {}): FfmpegRunner {
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
          streams: [
            { codec_type: "video", codec_name: options.codec ?? "h264", width: options.width ?? 2, height: 2, avg_frame_rate: `${options.fps ?? 2}/1`, duration: String((options.durationMs ?? 1_000) / 1_000), pix_fmt: options.alpha ? "yuva420p" : "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" },
            ...(options.audio ? [{ codec_type: "audio", codec_name: options.audioCodec ?? "aac", channels: 2, sample_rate: "48000", duration: String((options.audioDurationMs ?? 1_000) / 1_000) }] : [])
          ],
          format: { duration: String((options.durationMs ?? 1_000) / 1_000), format_name: options.container ?? "mov,mp4,m4a,3gp,3g2,mj2" }
        }),
        stderr: ""
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function outputFactory(outputPath: string, exitCodes: number[], writesOutput = true, successfulStderr = ""): StreamingFfmpegProcessFactory {
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
        if (exitCode === 0 && writesOutput) await writeFile(outputPath, "encoded-media");
        return settle({ exitCode, stdout: "", stderr: exitCode === 0 ? successfulStderr : "encoder failed" });
      },
      abort: async () => settle({ exitCode: 1, stdout: "", stderr: "aborted" })
    };
    return process;
  };
}

function materializedEvidenceRunner(options: { fps?: number } = {}): FfmpegRunner {
  const evidence = evidenceRunner(options);
  return async (command) => {
    if (command.args.at(-1)?.endsWith(".mp4") && !command.args.includes("-show_streams")) {
      await writeFile(command.args.at(-1) as string, "encoded-media");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return evidence(command);
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
  const path = await mkdtemp(join(tmpdir(), `shellx-motion-stream-policy-${label}-`));
  tempDirs.push(path);
  return path;
}
