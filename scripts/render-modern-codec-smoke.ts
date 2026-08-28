import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeImageSequence,
  probeMedia,
  resolveFfmpegExecutable,
  type FfmpegExportPreset
} from "../packages/renderer-ffmpeg/src/index";
import { assertPrivateRepoScratchPath, preparePrivateRepoScratch } from "./repo-scratch.mjs";

const CONFIG = {
  "mp4-hevc": { extension: "mp4", codec: "hevc", encoders: ["libx265"], pixelFormat: "yuv420p10le", containerMagic: "ftyp" },
  "webm-av1": { extension: "webm", codec: "av1", encoders: ["libsvtav1", "libaom-av1"], pixelFormat: "yuv420p", containerMagic: "1a45dfa3" }
} as const;

const requestedPreset = process.argv[2];
assert(requestedPreset === "mp4-hevc" || requestedPreset === "webm-av1", "Expected mp4-hevc or webm-av1 preset argument.");
const preset: Extract<FfmpegExportPreset, "mp4-hevc" | "webm-av1"> = requestedPreset;
const config = CONFIG[preset];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commandId = preset === "mp4-hevc" ? "render-hevc:smoke" : "render-av1:smoke";
const outDir = join(await preparePrivateRepoScratch(repoRoot), commandId.replace(":", "-"));
const framesDir = join(outDir, "frames");
const outputPath = join(outDir, `modern-codec.${config.extension}`);

// Fast host gate: synthesize deterministic visible frames, select a compiled software encoder, then prove the emitted stream facts.
await assertPrivateRepoScratchPath(repoRoot, outDir);
await rm(outDir, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true, mode: 0o700 });
await runProcess(resolveFfmpegExecutable(), [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "testsrc=size=64x64:rate=1",
  "-frames:v",
  "1",
  join(framesDir, "000001.png")
]);
await copyFile(join(framesDir, "000001.png"), join(framesDir, "000002.png"));

const rendered = await encodeImageSequence({
  packageId: `smoke-${preset}`,
  framesDir,
  fps: 2,
  width: 64,
  height: 64,
  durationMs: 1000,
  outputPath,
  preset
});
assert(rendered.ok, `${commandId} encode failed: ${JSON.stringify(rendered, null, 2)}`);
await stat(outputPath);

const receiptOutput = rendered.receipt.output as Record<string, unknown>;
assert(receiptOutput.preset === preset, "receipt preset mismatch");
assert(receiptOutput.codec === config.codec, "receipt codec mismatch");
assert(typeof receiptOutput.encoder === "string" && config.encoders.some((encoder) => encoder === receiptOutput.encoder), "receipt encoder selection mismatch");
// This host gate does not opt into hardware probing, so the software encoder runs by default.
assert(receiptOutput.encoderSource === "software", "receipt encoder source mismatch");

const media = await probeMedia(outputPath);
assert(media.codec === config.codec, `ffprobe codec mismatch: ${media.codec}`);
assert(media.width === 64 && media.height === 64, "ffprobe dimensions mismatch");
assert(media.color.pixelFormat === config.pixelFormat, `ffprobe pixel format mismatch: ${media.color.pixelFormat}`);
assert(media.color.space === "bt709", `ffprobe color space mismatch: ${media.color.space}`);
assert(media.color.transfer === "bt709", `ffprobe transfer mismatch: ${media.color.transfer}`);
assert(media.color.primaries === "bt709", `ffprobe primaries mismatch: ${media.color.primaries}`);
assert(media.color.range === "tv", `ffprobe range mismatch: ${media.color.range}`);

const bytes = await readFile(outputPath);
if (preset === "mp4-hevc") {
  assert(bytes.subarray(4, 8).toString("ascii") === config.containerMagic, "output is not an MP4 container");
} else {
  assert(bytes.subarray(0, 4).toString("hex") === config.containerMagic, "output is not a WebM container");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  command: commandId,
  preset,
  outputPath,
  encoder: receiptOutput.encoder,
  receiptId: rendered.receipt.id,
  media
}, null, 2)}\n`);

async function runProcess(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk.slice(0, 64 * 1024 - stderr.length);
    });
    child.once("error", rejectProcess);
    child.once("close", (code) => {
      if (code === 0) resolveProcess();
      else rejectProcess(new Error(`${executable} exited with ${code}: ${stderr.trim()}`));
    });
  });
}
