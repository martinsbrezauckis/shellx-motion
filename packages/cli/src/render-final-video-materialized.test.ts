import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeRgbaPng, loadMotionPackage, type OperationReceipt } from "@shellx-motion/core";
import type { FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { afterEach, describe, expect, it } from "vitest";
import { renderMaterializedFinalVideo } from "./render-final-video-materialized.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("renderMaterializedFinalVideo failed publication", () => {
  it("removes a deleted stage's output hash, path, artifact, and command evidence while preserving the failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-materialized-abort-"));
    roots.push(root);
    const pkg = await materializedFixture(root);
    const outputPath = join(root, "out.mp4");
    const response = await renderMaterializedFinalVideo({
      pkg,
      packageRoot: root,
      frameLane: "browser",
      frameCount: 1,
      framesDir: join(root, "frames"),
      framesRoot: root,
      framesDirCallerSupplied: false,
      outputPath,
      preset: "mp4-h264",
      audio: { path: join(root, "tone.wav") },
      audioMaster: { loudness: { integratedLufs: -16, toleranceLufs: 1, maxTruePeakDbtp: -1 } },
      inputRoots: [root],
      outputRoots: [root],
      forceSoftwareEncode: true,
      force: false,
      keepFrames: false,
      dryRun: false,
      browserFrameRenderer: async (_pkg, options) => {
        const framePath = options.outputPath ?? join(options.outDir, "frame.png");
        await mkdir(dirname(framePath), { recursive: true });
        await writeFile(framePath, visiblePng());
        return {
          ok: true,
          output: { path: framePath, sha256: "a".repeat(64), width: 2, height: 2, atMs: options.atMs, browser: { name: "test", version: "1" }, viewport: { width: 2, height: 2, deviceScaleFactor: 1 } },
          receipt: { schema: "shellx-motion/receipt@1", id: "materialized-frame", operation: "render.frame", status: "passed", packageId: "pkg_materialized_abort", inputHashes: {}, createdAt: "2026-08-10T00:00:00.000Z", lane: "browser", output: { path: framePath }, warnings: [] }
        } as never;
      },
      ffmpegRunner: failedMasterRunner()
    });

    expect(response.kind).toBe("refused");
    if (response.kind !== "refused") throw new Error("fixture must fail its delivered-program loudness readback");
    expect(response.response.error).toMatchObject({ code: "audio_master_quality_failed", message: expect.stringContaining("complete delivered-program readback") });
    const receipt = response.response.receipt as OperationReceipt;
    const stageHash = createHash("sha256").update("encoded-stage", "utf8").digest("hex");
    const serialized = JSON.stringify(response.response);
    expect(receipt).toMatchObject({ status: "failed", output: { publication: "aborted", failure: { code: "audio_master_quality_failed" } } });
    expect(receipt.artifacts).toEqual([]);
    expect(serialized).not.toContain(".shellx-motion-stage");
    expect(serialized).not.toContain(stageHash);
    expect(serialized).not.toContain("rendered_media");
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function materializedFixture(root: string) {
  await writeFile(join(root, "tone.wav"), validWav());
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_materialized_abort",
    name: "Materialized abort",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-motion"] }
  })}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_materialized_abort",
    name: "Materialized abort",
    durationMs: 1_000,
    fps: 1,
    width: 2,
    height: 2,
    layers: [{ id: "card", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 2, height: 2 } }],
    assets: [],
    provenance: { sourceApp: "shellx-motion-test", createdBy: "test" }
  })}\n`);
  return await loadMotionPackage(root);
}

function failedMasterRunner(): FfmpegRunner {
  return async (command) => {
    if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version test", stderr: "" };
    if (command.args.some((argument) => argument.startsWith("volumedetect,"))) return { exitCode: 0, stdout: "", stderr: "" };
    if (command.args.includes("-show_streams")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 2, height: 2, avg_frame_rate: "1/1", duration: "1", pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }], format: { duration: "1", format_name: "mov,mp4" } }),
        stderr: ""
      };
    }
    const stagePath = command.args.at(-1);
    if (!stagePath) throw new Error("encode fixture is missing an output path");
    await writeFile(stagePath, "encoded-stage");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function visiblePng(): Buffer {
  return encodeRgbaPng(2, 2, Buffer.from([
    0, 0, 0, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
    0, 0, 0, 255
  ]));
}

function validWav(): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(36, 4);
  bytes.write("WAVEfmt ", 8, "latin1");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "latin1");
  return bytes;
}
