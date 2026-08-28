/** Focused materialized-render proof for the bounded document audio master. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRgbaPng } from "@shellx-motion/core";
import { buildEncodeImageSequenceCommand, encodeImageSequence, type FfmpegRunner } from "./index.js";

const roots: string[] = [];
const FRAME_A = encodeRgbaPng(2, 2, Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 20, 100, 200, 255, 220, 30, 40, 255]));
const FRAME_B = encodeRgbaPng(2, 2, Buffer.from([255, 255, 255, 255, 0, 0, 0, 255, 30, 180, 60, 255, 50, 30, 180, 255]));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("materialized document audio master", () => {
  it("rejects hostile direct renderer input and a master with no resolved audio before frame or process work", async () => {
    const root = await fixture();
    expect(() => buildEncodeImageSequenceCommand({
      ...renderInput(root),
      audioMaster: { loudness: { integratedLufs: Number.NaN, toleranceLufs: 1, maxTruePeakDbtp: -1 } } as never,
    })).toThrow(/finite number/);
    const getter = Object.create(null, { volume: { enumerable: true, get: () => { throw new Error("must not execute"); } } });
    const result = await encodeImageSequence({ ...renderInput(root), audioMaster: getter, runner: async () => { throw new Error("must not run"); } });
    expect(result).toMatchObject({ ok: false, error: { code: "audio_master_invalid" } });

    const unavailable = await encodeImageSequence({ ...renderInput(root), audioMaster: { volume: 0.8 }, runner: async () => { throw new Error("must not run"); } });
    expect(unavailable).toMatchObject({ ok: false, error: { code: "audio_master_unavailable" } });
  });

  it("keeps a nonconforming materialized output as an explicit failed receipt with delivered master readback", async () => {
    const root = await fixture();
    const outputPath = join(root, "failed.mp4");
    const commands: string[][] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command.args);
      if (command.args.includes("-af")) {
        return { exitCode: 0, stdout: "", stderr: '{"input_i":"-12","input_tp":"-1.2","input_lra":"10","input_thresh":"-25","target_offset":"0"}' };
      }
      if (command.args.includes("-frames:v")) await writeFile(command.args.at(-1) as string, "nonconforming rendered output", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await encodeImageSequence({
      ...renderInput(root, outputPath),
      audio: { path: join(root, "audio.wav") },
      audioMaster: { loudness: { integratedLufs: -16, toleranceLufs: 1, maxTruePeakDbtp: -1, maxLoudnessRangeLu: 11 } },
      runner,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "audio_master_quality_failed" },
      receipt: {
        status: "failed",
        artifacts: [expect.objectContaining({ role: "rendered_media", status: "failed", path: outputPath })],
        output: {
          audio: {
            master: {
              loudnessRealization: { mode: "single-pass-loudnorm", integratedLufs: -16 },
              readback: { integratedLufs: -12, truePeakDbtp: -1.2, loudnessRangeLu: 10 },
              loudnessConformance: "failed",
            },
          },
        },
      },
    });
    expect(commands.some((args) => args.join(" ").includes("loudnorm=I=-16:TP=-1:LRA=11"))).toBe(true);
    expect(commands.filter((args) => args.includes("-af"))).toHaveLength(1);
  });

  it("does not measure an already-delivered program for volume/fade-only controls and omits master readback", async () => {
    const root = await fixture();
    const outputPath = join(root, "controls.mp4");
    let analysisCalls = 0;
    const runner: FfmpegRunner = async (command) => {
      if (command.args.includes("-af")) analysisCalls += 1;
      if (command.args.includes("-frames:v")) await writeFile(command.args.at(-1) as string, "controls-only rendered output", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await encodeImageSequence({
      ...renderInput(root, outputPath),
      audio: { path: join(root, "audio.wav") },
      audioMaster: { volume: 0.8, fadeInMs: 100, fadeOutMs: 200, fadeCurve: "equal-power" },
      runner,
    });

    expect(result).toMatchObject({ ok: true, receipt: { output: { audio: { master: { controls: { volume: 0.8, fadeInMs: 100, fadeOutMs: 200, fadeCurve: "equal-power" } } } } } });
    if (result.ok) expect((result.receipt.output as { audio?: { master?: Record<string, unknown> } }).audio?.master).not.toHaveProperty("readback");
    expect(analysisCalls).toBe(0);
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-audio-master-render-"));
  roots.push(root);
  const framesDir = join(root, "frames");
  await mkdir(framesDir, { recursive: true });
  await Promise.all([
    writeFile(join(framesDir, "000001.png"), FRAME_A),
    writeFile(join(framesDir, "000002.png"), FRAME_B),
    writeFile(join(root, "audio.wav"), "bounded fixture audio", "utf8"),
  ]);
  return root;
}

function renderInput(root: string, outputPath = join(root, "out.mp4")) {
  return {
    packageId: "audio-master-render-fixture",
    framesDir: join(root, "frames"),
    fps: 2,
    width: 2,
    height: 2,
    durationMs: 1_000,
    outputPath,
    inputRoots: [root],
    outputRoots: [root],
    forceSoftwareEncode: true,
    verifyDeliveredColor: false,
  };
}
