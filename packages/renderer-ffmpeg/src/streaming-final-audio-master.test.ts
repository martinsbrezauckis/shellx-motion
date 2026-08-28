import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRgbaPng } from "@shellx-motion/core";
import type { FfmpegProcessResult, FfmpegRunner } from "./index";
import { runStreamingFinalEncodePolicy } from "./streaming-final-encode-policy";
import type { StreamingFrameSink } from "./streaming-foundation-types";
import type { StreamingFfmpegProcess, StreamingFfmpegProcessFactory } from "./streaming-process";

const tempDirs: string[] = [];
const FRAME_A = encodeRgbaPng(2, 2, Buffer.from([
  0, 0, 0, 255, 255, 255, 255, 255,
  10, 80, 180, 255, 250, 30, 40, 255
]));

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("streamed document audio master", () => {
  it("fails closed before producing frames when a hostile or audio-less document master is supplied", async () => {
    const root = await scratch("master-refusal");
    const common = {
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath: join(root, "out.mp4"),
      inputRoots: [root],
      outputRoots: [root],
      runner: evidenceRunner(),
      processFactory: outputFactory(join(root, "out.mp4"), [0]),
      produce: async () => { throw new Error("must not produce"); },
    };
    const hostile = await runStreamingFinalEncodePolicy({
      ...common,
      audioMaster: { loudness: { integratedLufs: Number.NaN } } as never,
    });
    const unavailable = await runStreamingFinalEncodePolicy({ ...common, audioMaster: { volume: 0.8 } });
    expect(hostile).toMatchObject({ ok: false, error: { code: "audio_master_invalid" } });
    expect(unavailable).toMatchObject({ ok: false, error: { code: "audio_master_unavailable" } });
  });

  it("records single-pass master readback on success and keeps target misses as bounded streamed partial evidence", async () => {
    const root = await scratch("master-evidence");
    const outputPath = join(root, "out.mp4");
    const audioPath = join(root, "audio.wav");
    await writeFile(audioPath, "audio");
    const base = {
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      audio: { path: audioPath },
      audioMaster: { loudness: { integratedLufs: -16, toleranceLufs: 1, maxTruePeakDbtp: -1, maxLoudnessRangeLu: 11 } },
      processFactory: outputFactory(outputPath, [0]),
      produce: async (sink: StreamingFrameSink) => sink.write({ index: 0, atMs: 0, png: FRAME_A }),
    };
    const successRunner: FfmpegRunner = async (command) => command.args.includes("-af")
      ? { exitCode: 0, stdout: "", stderr: '{"input_i":"-16.2","input_tp":"-1.2","input_lra":"10","input_thresh":"-26","target_offset":"0"}' }
      : evidenceRunner({ audio: true })(command);
    const success = await runStreamingFinalEncodePolicy({ ...base, runner: successRunner });
    expect(success).toMatchObject({
      ok: true,
      receiptEvidence: { output: { audio: { master: {
        loudnessRealization: { mode: "single-pass-loudnorm", integratedLufs: -16 },
        readback: { integratedLufs: -16.2, truePeakDbtp: -1.2, loudnessRangeLu: 10 },
        loudnessConformance: "passed",
      } } } },
    });
    const failed = await runStreamingFinalEncodePolicy({ ...base, runner: evidenceRunner({ audio: true }) });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "audio_master_quality_failed", partialOutput: {
        status: "nonconforming",
        audioMaster: { loudnessConformance: "failed", readback: { integratedLufs: -12 } },
      } },
    });
  });

  it("does not run delivered loudness analysis for a volume/fade-only master", async () => {
    const root = await scratch("master-controls-only");
    const outputPath = join(root, "out.mp4");
    const audioPath = join(root, "audio.wav");
    await writeFile(audioPath, "audio");
    let analysisCalls = 0;
    const runner: FfmpegRunner = async (command) => {
      if (command.args.includes("-af")) analysisCalls += 1;
      return evidenceRunner({ audio: true })(command);
    };
    const result = await runStreamingFinalEncodePolicy({
      fps: 1,
      width: 2,
      height: 2,
      durationMs: 1_000,
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      audio: { path: audioPath },
      audioMaster: { volume: 0.8, fadeInMs: 100, fadeOutMs: 200, fadeCurve: "equal-power" },
      runner,
      processFactory: outputFactory(outputPath, [0]),
      produce: async (sink) => sink.write({ index: 0, atMs: 0, png: FRAME_A }),
    });
    expect(result).toMatchObject({ ok: true, receiptEvidence: { output: { audio: { master: { controls: { volume: 0.8, fadeInMs: 100, fadeOutMs: 200 } } } } } });
    if (result.ok) expect(result.receiptEvidence.output.audio?.master).not.toHaveProperty("readback");
    expect(analysisCalls).toBe(0);
  });
});

function evidenceRunner(options: { audio?: boolean } = {}): FfmpegRunner {
  return async (command) => {
    if (command.args.includes("-af")) {
      return { exitCode: 0, stdout: "", stderr: '{"input_i":"-12","input_tp":"-1","input_lra":"4","input_thresh":"-22","target_offset":"0.3"}' };
    }
    if (command.args.includes("-show_streams")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [
            { codec_type: "video", codec_name: "h264", width: 2, height: 2, avg_frame_rate: "1/1", duration: "1", pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" },
            ...(options.audio ? [{ codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000", duration: "1" }] : []),
          ],
          format: { duration: "1", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
        }),
        stderr: "",
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
      abort: async () => settle({ exitCode: 1, stdout: "", stderr: "aborted" }),
    };
    return process;
  };
}

async function scratch(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `shellx-motion-stream-master-${label}-`));
  tempDirs.push(path);
  return path;
}
