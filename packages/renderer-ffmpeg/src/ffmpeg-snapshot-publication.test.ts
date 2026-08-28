import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRgbaPng } from "@shellx-motion/core";
import { encodeImageSequence, type FfmpegCommand, type FfmpegRunner } from "./index.js";

const roots: string[] = [];
const CONTRAST_FRAME = encodeRgbaPng(2, 1, Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]));

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("FFmpeg snapshot publication", () => {
  it("uses one immutable final-audio snapshot across FFmpeg passes and publishes only after verified staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-snapshot-red-"));
    roots.push(root);
    const outputPath = join(root, "render.mp4");
    const audioPath = join(root, "voiceover.wav");
    const admittedBytes = Buffer.from("admitted audio bytes", "utf8");
    await writeFrames(root, 2);
    await writeFile(audioPath, admittedBytes);
    const commands: FfmpegCommand[] = [];
    const invocationOutputs: string[] = [];
    let substituted = false;
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      invocationOutputs.push(command.args.at(-1) as string);
      if (!substituted) {
        substituted = true;
        await writeFile(audioPath, "RED substituted bytes", "utf8");
      }
      if (command.args.includes("-f") && command.args.includes("null")) {
        return { exitCode: 0, stdout: "", stderr: '{"input_i":"-23","input_tp":"-4","input_lra":"6","input_thresh":"-31","target_offset":"0.2"}' };
      }
      await writeFfmpegTestOutput(command, "verified staged output");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await encodeImageSequence({
      packageId: "pkg_snapshot_red",
      framesDir: root,
      fps: 2,
      width: 2,
      height: 1,
      durationMs: 1_000,
      outputPath,
      audio: { path: audioPath, normalizeLoudness: true },
      runner
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const privateAudioInputs = commands
      .filter((command) => command.args.includes("-format_whitelist"))
      .map((command) => {
        const whitelist = command.args.indexOf("-format_whitelist");
        return command.args[command.args.indexOf("-i", whitelist) + 1];
      });
    expect(privateAudioInputs).toHaveLength(2);
    expect(new Set(privateAudioInputs).size).toBe(1);
    expect(privateAudioInputs[0]).toMatch(/shellx-motion-ffmpeg-media-[^/]+\/[a-f0-9]{64}\.wav$/);
    expect(commands.flatMap((command) => command.args)).not.toContain(audioPath);
    expect(result.receipt.inputHashes["audio:0"]).toBe(createHash("sha256").update(admittedBytes).digest("hex"));
    expect(result.receipt.output).toMatchObject({ path: outputPath, audio: { path: audioPath } });
    expect(invocationOutputs.find((path) => path.endsWith(".mp4"))).not.toBe(outputPath);
    await expect(readFile(outputPath, "utf8")).resolves.toBe("verified staged output");

    const rerun = await encodeImageSequence({
      packageId: "pkg_snapshot_red",
      framesDir: root,
      fps: 2,
      width: 2,
      height: 1,
      durationMs: 1_000,
      outputPath,
      runner
    });
    expect(rerun).toMatchObject({ ok: false, error: { code: "derived_output_exists" } });
    await expect(readFile(outputPath, "utf8")).resolves.toBe("verified staged output");
  });
});

async function writeFrames(root: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await writeFile(join(root, `${String(index + 1).padStart(6, "0")}.png`), CONTRAST_FRAME);
  }
}

async function writeFfmpegTestOutput(command: FfmpegCommand, contents: string): Promise<void> {
  if (command.args.includes("-frames:v")) await writeFile(command.args.at(-1) as string, contents, "utf8");
}
