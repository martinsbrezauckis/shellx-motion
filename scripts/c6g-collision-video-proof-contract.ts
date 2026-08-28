import assert from "node:assert/strict";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJsonSha256, streamingFrameTimestampMs } from "../packages/core/src/index";
import { planStreamingFinalCommand, type FfmpegCommand } from "../packages/renderer-ffmpeg/src/index";
import {
  buildCollisionCheckpointProofCases,
  c6gProofRepoRoot,
} from "./c6g-collision-checkpoint-proof-contract";

export const C6G_COLLISION_VIDEO_FPS = 30;
export const C6G_COLLISION_VIDEO_FRAME_COUNT = 151;
/** 151 displayed frames at 30 fps, including the author-time sample at exactly 5,000ms. */
export const C6G_COLLISION_VIDEO_DURATION_MS = (C6G_COLLISION_VIDEO_FRAME_COUNT * 1_000) / C6G_COLLISION_VIDEO_FPS;
export const C6G_COLLISION_VIDEO_PRESET = "mp4-h264" as const;
export const C6G_COLLISION_VIDEO_MIN_UNIQUE_FRAMES = 120;
export const C6G_COLLISION_VIDEO_STREAMING_MIN_UNIQUE_FRAMES = 64;
export const C6G_COLLISION_VIDEO_CHECKPOINTS = Object.freeze({
  bingo: Object.freeze([0, 15, 115, 150]),
  wrecking: Object.freeze([0, 60, 80, 150]),
});
export const C6G_COLLISION_VIDEO_REVIEW_FRAMES = Object.freeze([0, 15, 38, 60, 80, 105, 125, 150]);
export const C6G_COLLISION_ACCEPTED_ADAPTER_FINGERPRINT = "c113bf2feb3c862d81da09adb592da35aaf23d3be209ef657fb43f60fab28453";
export const C6G_COLLISION_ACCEPTED_SEQUENCES: Readonly<Record<"bingo" | "wrecking", Readonly<{ png: string; framePlan: string }>>> | null = Object.freeze({
  bingo: Object.freeze({
    png: "595fc91cf571583d19d53497a5194e5a0e9c9bb882a1eaa0f25a1cc988e99e50",
    framePlan: "fef6bb1de5b58b19ee5f063b8d57a3d8b41caae7b01f663ed721c107fc4e0165",
  }),
  wrecking: Object.freeze({
    png: "a349b63e72fd02da13e495825ddce30a68bbfb13411eb5da31568ed1debd5432",
    framePlan: "772c88c0f03a1e0826a115df9671f5ad431748b5ad35f0a422e7f103d1eb67f9",
  }),
});

const repoScratchRoot = join(c6gProofRepoRoot, ".scratch");

export interface CollisionVideoProofArguments {
  outputRoot: string;
  expectedCommit: string;
}

export function parseCollisionVideoProofArguments(args: string[]): CollisionVideoProofArguments {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  assert.equal(normalized.length, 4, usage());
  assert.equal(normalized[0], "--output-root", usage());
  assert.equal(normalized[2], "--expected-commit", usage());
  assert(isAbsolute(normalized[1] ?? ""), usage());
  assert(/^[a-f0-9]{40}$/.test(normalized[3] ?? ""), usage());
  const outputRoot = resolve(normalized[1]!);
  const fromScratch = relative(repoScratchRoot, outputRoot);
  assert(fromScratch.length > 0 && fromScratch !== ".." && !fromScratch.startsWith(`..${sep}`) && !isAbsolute(fromScratch), `Output root must be a child of ${repoScratchRoot}.`);
  return { outputRoot, expectedCommit: normalized[3]! };
}

export function collisionVideoFrameAtMs(frameIndex: number): number {
  assert(Number.isSafeInteger(frameIndex) && frameIndex >= 0 && frameIndex < C6G_COLLISION_VIDEO_FRAME_COUNT, "C6G video frame index is outside the fixed schedule.");
  return streamingFrameTimestampMs(frameIndex, C6G_COLLISION_VIDEO_FPS, C6G_COLLISION_VIDEO_DURATION_MS);
}

export function collisionVideoFrameAtUs(frameIndex: number): number {
  assert(Number.isSafeInteger(frameIndex) && frameIndex >= 0 && frameIndex < C6G_COLLISION_VIDEO_FRAME_COUNT, "C6G video frame index is outside the fixed schedule.");
  return Number(BigInt(frameIndex) * 1_000_000n / BigInt(C6G_COLLISION_VIDEO_FPS));
}

export function buildCollisionVideoProofCases() {
  const cases = buildCollisionCheckpointProofCases();
  assert.deepEqual(cases.map((entry) => entry.plan.frames.length), [61, 61]);
  return cases;
}

export function planCollisionVideoCommand(outputPath: string): FfmpegCommand {
  const planned = planStreamingFinalCommand({
    fps: C6G_COLLISION_VIDEO_FPS,
    width: 1_280,
    height: 720,
    durationMs: C6G_COLLISION_VIDEO_DURATION_MS,
    outputPath,
    outputRoots: [dirname(outputPath)],
    preset: C6G_COLLISION_VIDEO_PRESET,
    quality: { minDurationMs: 5_000, minUniqueFrameHashes: C6G_COLLISION_VIDEO_STREAMING_MIN_UNIQUE_FRAMES },
  });
  assert(planned.ok, planned.ok ? undefined : `${planned.error.code}: ${planned.error.message}`);
  if (!planned.ok) throw new Error("Unreachable C6G video command refusal.");
  assertCollisionVideoCommand(planned.command, outputPath);
  return planned.command;
}

export function assertCollisionVideoCommand(command: FfmpegCommand, outputPath: string): void {
  assert.equal(command.shell, false, "C6G proof encoder must remain shell-free.");
  assert.equal(command.args.at(-1), outputPath, "C6G proof encoder output path drifted.");
  assert.deepEqual(sliceFrom(command.args, "-f", 6), ["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"], "C6G proof encoder no longer uses canonical PNG image2pipe input.");
  assert.deepEqual(valueAfter(command.args, "-frames:v"), String(C6G_COLLISION_VIDEO_FRAME_COUNT));
  assert.deepEqual(valueAfter(command.args, "-c:v"), "libx264");
  assert.deepEqual(valueAfter(command.args, "-crf"), "18");
  assert.deepEqual(valueAfter(command.args, "-pix_fmt"), "yuv420p");
  assert.deepEqual(valueAfter(command.args, "-colorspace"), "bt709");
  assert.deepEqual(valueAfter(command.args, "-color_primaries"), "bt709");
  assert.deepEqual(valueAfter(command.args, "-color_trc"), "bt709");
  assert.deepEqual(valueAfter(command.args, "-color_range"), "tv");
  assert.deepEqual(valueAfter(command.args, "-movflags"), "+faststart");
  assert(command.args.includes("scale=in_range=full:out_range=tv:out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"), "C6G proof encoder lost its production SDR BT.709 conversion chain.");
  assert.equal(command.args.filter((value) => value === "pipe:0").length, 1, "C6G proof encoder must have one stdin consumer.");
}

export function collisionVideoCommandIdentity(command: FfmpegCommand, outputPath: string): string {
  assertCollisionVideoCommand(command, outputPath);
  return canonicalJsonSha256({
    schema: "shellx-motion/c6g-collision-video-command@1",
    executable: command.executable.split(/[\\/]/).at(-1),
    args: command.args.map((value) => value === outputPath ? "<proof-output>.mp4" : value),
    shell: command.shell,
  });
}

function valueAfter(args: string[], token: string): string | undefined {
  const indexes = args.flatMap((value, index) => value === token ? [index] : []);
  assert.equal(indexes.length, 1, `C6G proof encoder requires one ${token} token.`);
  return args[indexes[0]! + 1];
}

function sliceFrom(args: string[], token: string, length: number): string[] {
  const index = args.indexOf(token);
  assert(index >= 0, `C6G proof encoder omitted ${token}.`);
  return args.slice(index, index + length);
}

function usage(): string {
  return "Usage: pnpm run c6g:collision-video-proof -- --output-root /absolute/repo/.scratch/fresh-run --expected-commit <40-hex-commit>";
}
