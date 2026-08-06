import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFfmpegExecutable } from "../packages/renderer-ffmpeg/src/index";
import { runCli } from "../packages/cli/src/main";
import {
  assertReceiptSucceeded,
  MOTION_DENSITY_ADVISORY,
  STATIC_SEQUENCE_ADVISORY
} from "./render-smoke-status";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outDir = join(repoRoot, ".scratch", "render-audio-smoke");
const packageRoot = join(outDir, "package");
const assetsDir = join(packageRoot, "assets");
const audioPath = join(assetsDir, "tone.wav");
const framesRoot = join(outDir, "frames");
const qualityScratchRoot = join(outDir, "quality-scratch");
const outputPath = join(outDir, "audio-lower-third.mp4");

// Host gate for audio delivery: generate a local WAV, mux it, then enforce audio quality.
await rm(outDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

await runProcess(resolveFfmpegExecutable(), [
  "-y",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=880:duration=2",
  "-c:a",
  "pcm_s16le",
  audioPath
], "generate sine audio fixture");

await writeJson(join(packageRoot, "manifest.json"), {
  schema: "shellx-motion/package-manifest@1",
  id: "pkg_audio_smoke",
  name: "Audio Smoke",
  motion: "motion.json",
  assets: ["assets/tone.wav"],
  sourceApp: "shellx-motion",
  compatibility: {
    lanes: ["browser", "ffmpeg"],
    hosts: ["canvas", "cut", "motion"]
  }
});

await writeJson(join(packageRoot, "motion.json"), {
  schema: "shellx-motion/motion@1",
  id: "motion_audio_smoke",
  name: "Audio Smoke",
  durationMs: 2000,
  fps: 12,
  width: 640,
  height: 360,
  background: "#111827",
  layers: [
    {
      id: "panel",
      type: "shape",
      shape: "rect",
      startMs: 0,
      durationMs: 2000,
      width: 420,
      height: 96,
      transform: { x: 56, y: 204, scale: 1 },
      style: { fill: "#2563eb", radius: 10 }
    },
    {
      id: "title",
      type: "text",
      text: "Audio mux",
      startMs: 0,
      durationMs: 2000,
      transform: { x: 82, y: 230, scale: 1 },
      style: { color: "#ffffff", fontSize: 42, fontWeight: 800, width: 360 }
    },
    {
      id: "music",
      type: "audio",
      source: "assets/tone.wav",
      startMs: 0,
      durationMs: 2000,
      volume: 0.8,
      fadeInMs: 80,
      fadeOutMs: 120
    }
  ],
  assets: [],
  provenance: {
    sourceApp: "shellx-motion",
    createdBy: "render-audio-smoke"
  }
});

const validated = await runCli(["validate", packageRoot]);
assert(validated.ok, `Audio smoke package validation failed: ${JSON.stringify(validated, null, 2)}`);

const render = await runCli([
  "render",
  packageRoot,
  "--lane",
  "ffmpeg",
  "--out",
  outputPath
], { scratchRoot: framesRoot });

assert(render.ok, `Audio render smoke failed: ${JSON.stringify(render, null, 2)}`);
assert(readObjectField(render, "command", "render.command") === "render", "unexpected render command");
assert(readObjectField(render, "lane", "render.lane") === "ffmpeg", "Audio render must use the ffmpeg lane");
assert(readObjectField(render, "frameLane", "render.frameLane") === "browser", "Audio render must use browser frames");
assert(readObjectField(render, "preset", "render.preset") === "mp4-h264", "Audio render preset mismatch");
assert(readObjectField(render, "audioPath", "render.audioPath") === audioPath, "Audio render did not pick up package audio");

await stat(outputPath);
const mp4Bytes = await readFile(outputPath);
assert(mp4Bytes.subarray(4, 8).toString("ascii") === "ftyp", "audio render output is not an MP4 container");

const renderOutput = readObject(readObjectField(render, "output", "render.output"), "render.output");
assert(readObjectField(renderOutput, "codec", "render.output.codec") === "h264", "render receipt output codec mismatch");
assert(readObjectField(renderOutput, "container", "render.output.container") === "mp4", "render receipt output container mismatch");

const renderAudio = readObject(readObjectField(render, "audio", "render.audio"), "render.audio");
assert(readObjectField(renderAudio, "path", "render.audio.path") === audioPath, "render audio path mismatch");
assert(readNumber(readObjectField(renderAudio, "volume", "render.audio.volume"), "render.audio.volume") === 0.8, "render audio volume mismatch");

const renderReceipt = readObject(readObjectField(render, "receipt", "render.receipt"), "render.receipt");
assert(readObjectField(renderReceipt, "operation", "render.receipt.operation") === "render.final", "render receipt operation mismatch");
// Acceptance follows the shared contract rule rather than a hard-coded `passed`: this fixture is a
// deliberately STILL lower third — the picture is scaffolding for the audio under test — so a
// correct engine reports the static-sequence and motion-density advisories, and (since the
//  unified status rule) the receipt escalates on them. Both are declared here by anchored
// pattern; any OTHER warning still fails this gate.
const renderSuccess = assertReceiptSucceeded(renderReceipt, {
  label: "Audio render",
  expectedAdvisories: [STATIC_SEQUENCE_ADVISORY, MOTION_DENSITY_ADVISORY]
});
const renderArtifacts = readArray(readObjectField(renderReceipt, "artifacts", "render.receipt.artifacts"));
const mp4Artifact = renderArtifacts.find((artifact) => readObjectField(artifact, "mediaType", "artifact.mediaType") === "video/mp4");
assert(mp4Artifact, "render receipt missing video/mp4 artifact");

const quality = await runCli([
  "quality-check",
  outputPath,
  "--at-ms",
  "800",
  "--expect-width",
  "640",
  "--expect-height",
  "360",
  "--min-bright-pixels",
  "1000",
  "--min-edge-pixels",
  "1000",
  "--min-non-transparent-pixels",
  "1000",
  "--expect-audio",
  "--min-audio-peak-db",
  "-35",
  "--min-audio-mean-db",
  "-45",
  "--max-audio-peak-db",
  "-1"
], { scratchRoot: qualityScratchRoot });

assert(quality.ok, `Audio quality-check failed: ${JSON.stringify(quality, null, 2)}`);
assert(readObjectField(quality, "command", "quality.command") === "quality-check", "unexpected quality command");
const qualityMedia = readObject(readObjectField(quality, "media", "quality.media"), "quality.media");
const qualityAudio = readObject(readObjectField(qualityMedia, "audio", "quality.media.audio"), "quality.media.audio");
assert(readObjectField(qualityAudio, "present", "quality.media.audio.present") === true, "quality media must contain audio");
assert(readNumber(readObjectField(qualityAudio, "streamCount", "quality.media.audio.streamCount"), "quality.media.audio.streamCount") >= 1, "quality media audio stream missing");
const audioLevels = readObject(readObjectField(quality, "audioLevels", "quality.audioLevels"), "quality.audioLevels");
assert(readNumber(readObjectField(audioLevels, "maxVolumeDb", "quality.audioLevels.maxVolumeDb"), "quality.audioLevels.maxVolumeDb") >= -35, "audio peak below audible threshold");
assert(readNumber(readObjectField(audioLevels, "meanVolumeDb", "quality.audioLevels.meanVolumeDb"), "quality.audioLevels.meanVolumeDb") >= -45, "audio mean below audible threshold");

console.log(JSON.stringify({
  ok: true,
  command: "render-audio:smoke",
  packageRoot,
  audioPath,
  outputPath,
  render: {
    receiptId: readObjectField(renderReceipt, "id", "render.receipt.id"),
    mediaType: "video/mp4",
    receiptStatus: renderSuccess.status,
    acceptedWarnings: renderSuccess.warnings,
    matchedAdvisories: renderSuccess.matchedAdvisories,
    audio: renderAudio
  },
  quality: {
    framePath: readObjectField(quality, "framePath", "quality.framePath"),
    media: qualityMedia,
    audioLevels
  }
}, null, 2));

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runProcess(executable: string, args: string[], label: string): Promise<void> {
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
  assert(result.exitCode === 0, `${label} failed with exit ${String(result.exitCode)} signal ${String(result.signal)}: ${result.stderr || result.stdout}`);
}

function readObject(value: unknown, label: string = "value"): object {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value;
}

function readObjectField(value: unknown, key: string, label = key): unknown {
  const record = readObject(value, label);
  return Reflect.get(record, key);
}

function readArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "expected array");
  return value;
}

function readNumber(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value), `expected ${label} finite number, got ${typeof value}`);
  return value;
}
