import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  C6G_COLLISION_VIDEO_DURATION_MS,
  C6G_COLLISION_VIDEO_FRAME_COUNT,
  buildCollisionVideoProofCases,
  collisionVideoCommandIdentity,
  collisionVideoFrameAtMs,
  collisionVideoFrameAtUs,
  parseCollisionVideoProofArguments,
  planCollisionVideoCommand,
} from "./c6g-collision-video-proof-contract";

const commit = "a".repeat(40);

describe("C6G isolated collision video proof", () => {
  it("maps the five-second author bake onto one exact 151-frame 30 fps presentation schedule", () => {
    expect(C6G_COLLISION_VIDEO_FRAME_COUNT).toBe(151);
    expect(C6G_COLLISION_VIDEO_DURATION_MS).toBeCloseTo(5_033.333333333333, 10);
    expect([0, 1, 149, 150].map(collisionVideoFrameAtMs)).toEqual([0, 33, 4_967, 5_000]);
    expect([0, 1, 149, 150].map(collisionVideoFrameAtUs)).toEqual([0, 33_333, 4_966_666, 5_000_000]);
    expect(buildCollisionVideoProofCases().map((entry) => ({ slug: entry.slug, frames: entry.plan.frames.length }))).toEqual([
      { slug: "bingo", frames: 61 },
      { slug: "wrecking", frames: 61 },
    ]);
  });

  it("retains the production shell-free libx264 image2pipe and BT.709 command", () => {
    const outputPath = join(process.cwd(), ".scratch", "c6g-video-contract", "bingo.mp4");
    const command = planCollisionVideoCommand(outputPath);
    expect(command.args).toEqual(expect.arrayContaining([
      "-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0",
      "-frames:v", "151", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-movflags", "+faststart",
    ]));
    expect(collisionVideoCommandIdentity(command, outputPath)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("admits only a fresh child of project scratch at one exact commit", () => {
    const outputRoot = join(process.cwd(), ".scratch", "c6g-video-proof-test-arguments");
    expect(parseCollisionVideoProofArguments(["--output-root", outputRoot, "--expected-commit", commit])).toEqual({ outputRoot, expectedCommit: commit });
    expect(() => parseCollisionVideoProofArguments(["--output-root", "relative", "--expected-commit", commit])).toThrow("Usage:");
    expect(() => parseCollisionVideoProofArguments(["--output-root", process.cwd(), "--expected-commit", commit])).toThrow("Output root must be a child");
    expect(() => parseCollisionVideoProofArguments(["--output-root", outputRoot, "--expected-commit", "not-a-commit"])).toThrow("Usage:");
  });
});
