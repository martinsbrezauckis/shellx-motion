import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRgbaPng } from "@shellx-motion/core";
import {
  buildEncodeImageSequenceCommand,
  probeMedia,
  type FfmpegCommand,
  type FfmpegRunner
} from "./index.js";
import {
  buildLosslessSegmentIntermediateCommand,
  buildSegmentConcatFinalCommand,
  losslessSegmentFilename
} from "./segmented-final-internal/lossless-segment-concat-command.js";
import { image2PipeCommandFromImageSequence, rawVideoCommandFromImageSequence } from "./streaming-foundation.js";

const tempDirs: string[] = [];
const WIDTH = 4;
const HEIGHT = 2;
const FPS = 2;
const hostFfmpegAndFfprobeAvailable = ["ffmpeg", "ffprobe"].every((tool) =>
  spawnSync(tool, ["-version"], { stdio: "ignore", shell: false }).status === 0
);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("lossless segment concat command authority", () => {
  it("builds the one bounded alpha-preserving FFV1 image2pipe intermediate command", async () => {
    const root = await scratch("intermediate-command");
    const plan = buildLosslessSegmentIntermediateCommand({
      segmentDirectory: root,
      segmentIndex: 1,
      frameCount: 7,
      fps: 23.976
    });

    expect(plan).toMatchObject({
      command: {
        shell: false,
        args: expect.arrayContaining([
          "-f", "image2pipe",
          "-vcodec", "png",
          "-framerate", "23.976",
          "-i", "pipe:0",
          "-frames:v", "7",
          "-c:v", "ffv1",
          "-g", "1",
        "-pix_fmt", "bgra",
        "-color_range", "pc",
        "-an",
        "-f", "matroska"
        ])
      },
      segment: {
        filename: "segment-000002.mkv",
        frameCount: 7,
        fps: 23.976,
        codec: "ffv1",
        container: "matroska",
        pixelFormat: "bgra",
        colorRange: "pc",
        alpha: "preserved",
        intraOnly: true
      }
    });
    expect(plan.command.args.filter((value) => value === "-i")).toHaveLength(1);
    expect(plan.command.args.at(-1)).toBe(join(root, "segment-000002.mkv"));
  });

  it("permits only the exact store-owned partial target and pins Matroska for that extension", async () => {
    const root = await scratch("intermediate-partial-command");
    const temporaryOutputPath = join(root, ".segment-000002.mkv.partial");
    const plan = buildLosslessSegmentIntermediateCommand({
      segmentDirectory: root,
      segmentIndex: 1,
      frameCount: 2,
      fps: FPS,
      temporaryOutputPath
    });

    expect(plan.command.args.slice(-3)).toEqual(["-f", "matroska", temporaryOutputPath]);
    expect(() => buildLosslessSegmentIntermediateCommand({
      segmentDirectory: root,
      segmentIndex: 1,
      frameCount: 2,
      fps: FPS,
      temporaryOutputPath: join(root, ".segment-000001.mkv.partial")
    })).toThrow(/deterministic canonical or temporary/);
    expect(() => buildLosslessSegmentIntermediateCommand({
      segmentDirectory: root,
      segmentIndex: 1,
      frameCount: 2,
      fps: FPS,
      temporaryOutputPath: join(root, "nested", ".segment-000002.mkv.partial")
    })).toThrow(/owned same-directory/);
    expect(() => buildLosslessSegmentIntermediateCommand({
      segmentDirectory: root,
      segmentIndex: 1,
      frameCount: 2,
      fps: FPS,
      temporaryOutputPath: join(root, ".segment-000002.mkv")
    })).toThrow(/deterministic canonical or temporary/);
  });

  it("admits only tightly specified raw RGBA GPU checkpoints and preserves alpha concat delivery", () => {
    const root = join(tmpdir(), "shellx-motion-gpu-segment-command");
    const raw = buildLosslessSegmentIntermediateCommand({
      segmentDirectory: root,
      segmentIndex: 0,
      frameCount: 2,
      fps: 30,
      frameFormat: "rgba",
      width: 64,
      height: 36
    });
    expect(raw.command.args).toEqual(expect.arrayContaining([
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "64x36", "-framerate", "30", "-i", "pipe:0"
    ]));
    expect(() => buildLosslessSegmentIntermediateCommand({
      segmentDirectory: root, segmentIndex: 0, frameCount: 1, fps: 30, frameFormat: "rgba"
    })).toThrow(/positive integer dimensions/);

    const final = buildEncodeImageSequenceCommand({
      framesDir: join(root, "frames"), fps: 30, durationMs: 34, outputPath: join(root, "delivery.webm"),
      preset: "webm-vp9-alpha", inputRoots: [root], outputRoots: [root]
    });
    const rawFinal = rawVideoCommandFromImageSequence(final, { width: 64, height: 36, fps: 30 });
    const concat = buildSegmentConcatFinalCommand({
      canonicalCommand: rawFinal,
      preset: "webm-vp9-alpha",
      segmentDirectory: root,
      concatListPath: join(root, "segments.ffconcat"),
      segmentFilenames: [losslessSegmentFilename(0)],
      frameCount: 2
    });
    expect(concat.command.args).toEqual(expect.arrayContaining([
      "-safe", "1", "-f", "concat", "-protocol_whitelist", "file", "-i", join(root, "segments.ffconcat"), "-pix_fmt", "yuva420p"
    ]));
    expect(concat.command.args).not.toContain("rawvideo");
  });

  it("preserves canonical final audio, codec, colour, muxer, frame-cap and output args byte-for-byte", async () => {
    const root = await scratch("audio-parity");
    const framesDir = join(root, "frames");
    const audioPath = join(root, "sound.wav");
    const outputPath = join(root, "delivery.mp4");
    const canonical = buildEncodeImageSequenceCommand({
      framesDir,
      fps: FPS,
      durationMs: 2_000,
      outputPath,
      preset: "mp4-h264",
      inputRoots: [root],
      outputRoots: [root],
      audio: { path: audioPath, startMs: 120, volume: 0.7, fadeInMs: 40 }
    });
    const concatListPath = join(root, "segments.ffconcat");
    const plan = buildSegmentConcatFinalCommand({
      canonicalCommand: canonical,
      preset: "mp4-h264",
      segmentDirectory: root,
      concatListPath,
      segmentFilenames: [losslessSegmentFilename(0), losslessSegmentFilename(1)],
      frameCount: 4
    });
    const canonicalTail = canonical.args.slice(canonical.args.indexOf("-frames:v"));
    const concatTail = plan.command.args.slice(plan.command.args.indexOf("-frames:v"));

    expect(plan.command).toMatchObject({ shell: false });
    expect(plan.command.args.slice(0, 8)).toEqual([
      "-y", "-safe", "1", "-f", "concat", "-protocol_whitelist", "file", "-i"
    ]);
    expect(plan.command.args[8]).toBe(concatListPath);
    expect(concatTail).toEqual(canonicalTail);
    expect(plan.command.args).toContain(audioPath);
    expect(plan.concatList).toEqual({
      filename: "segments.ffconcat",
      contents: "file segment-000001.mkv\nfile segment-000002.mkv\n",
      segmentFilenames: ["segment-000001.mkv", "segment-000002.mkv"]
    });
  });

  it("also replaces the one canonical image2pipe input and leaves its final policy tail unchanged", async () => {
    const root = await scratch("pipe-transform");
    const canonical = image2PipeCommandFromImageSequence(buildEncodeImageSequenceCommand({
      framesDir: join(root, "frames"),
      fps: FPS,
      durationMs: 2_000,
      outputPath: join(root, "delivery.webm"),
      preset: "webm-vp9-alpha",
      inputRoots: [root],
      outputRoots: [root]
    }));
    const plan = buildSegmentConcatFinalCommand({
      canonicalCommand: canonical,
      preset: "webm-vp9-alpha",
      segmentDirectory: root,
      concatListPath: join(root, "segments.ffconcat"),
      segmentFilenames: [losslessSegmentFilename(0), losslessSegmentFilename(1)],
      frameCount: 4
    });

    expect(plan.command.args).not.toContain("pipe:0");
    expect(plan.command.args.slice(plan.command.args.indexOf("-frames:v"))).toEqual(
      canonical.args.slice(canonical.args.indexOf("-frames:v"))
    );
  });

  it("rejects GIF, non-deterministic segment names, unsafe concat-list placement, wrong output extensions and noncanonical stdin", async () => {
    const root = await scratch("refusals");
    const canonical = buildEncodeImageSequenceCommand({
      framesDir: join(root, "frames"),
      fps: FPS,
      durationMs: 2_000,
      outputPath: join(root, "delivery.mp4"),
      preset: "mp4-h264",
      inputRoots: [root],
      outputRoots: [root]
    });
    const valid = {
      canonicalCommand: canonical,
      preset: "mp4-h264" as const,
      segmentDirectory: root,
      concatListPath: join(root, "segments.ffconcat"),
      segmentFilenames: [losslessSegmentFilename(0), losslessSegmentFilename(1)],
      frameCount: 4
    };

    expect(() => buildSegmentConcatFinalCommand({ ...valid, preset: "gif" })).toThrow(/GIF final delivery/);
    expect(() => buildSegmentConcatFinalCommand({ ...valid, segmentFilenames: ["../segment-000001.mkv"] })).toThrow(/deterministic segment filenames/);
    expect(() => buildSegmentConcatFinalCommand({ ...valid, segmentFilenames: ["/segment-000001.mkv"] })).toThrow(/deterministic segment filenames/);
    expect(() => buildSegmentConcatFinalCommand({ ...valid, segmentFilenames: ["segment-000001.mp4"] })).toThrow(/deterministic segment filenames/);
    expect(() => buildSegmentConcatFinalCommand({ ...valid, concatListPath: join(root, "nested", "segments.ffconcat") })).toThrow(/owned segments\.ffconcat/);
    expect(() => buildSegmentConcatFinalCommand({ ...valid, concatListPath: join(root, "..", "segments.ffconcat") })).toThrow(/owned segments\.ffconcat/);
    expect(() => buildSegmentConcatFinalCommand({
      ...valid,
      canonicalCommand: { ...canonical, args: [...canonical.args.slice(0, -1), join(root, "wrong.webm")] }
    })).toThrow(/mp4-h264 outputs must use a .mp4 path/);
    expect(() => buildSegmentConcatFinalCommand({
      ...valid,
      canonicalCommand: { ...canonical, args: [...canonical.args, "-i", "pipe:0"] }
    })).toThrow(/canonical local-file audio inputs|stdin/);
  });

  it("refuses invalid segment metadata before a command can be constructed", async () => {
    const root = await scratch("metadata");
    expect(() => buildLosslessSegmentIntermediateCommand({ segmentDirectory: root, segmentIndex: -1, frameCount: 1, fps: FPS })).toThrow(/Segment index/);
    expect(() => buildLosslessSegmentIntermediateCommand({ segmentDirectory: root, segmentIndex: 0, frameCount: 0, fps: FPS })).toThrow(/frame count/);
    expect(() => buildLosslessSegmentIntermediateCommand({ segmentDirectory: root, segmentIndex: 0, frameCount: 1, fps: 0 })).toThrow(/FPS/);
    expect(() => buildLosslessSegmentIntermediateCommand({ segmentDirectory: "relative", segmentIndex: 0, frameCount: 1, fps: FPS })).toThrow(/absolute segment directory/);
  });

  it.skipIf(!hostFfmpegAndFfprobeAvailable)("proves FFV1 segment pixels and final MP4/WebM concat with installed FFmpeg and FFprobe (skipped only when either tool is absent)", async () => {
    const root = await scratch("real-proof");
    const segmentDirectory = join(root, "segments");
    await mkdir(segmentDirectory);
    const sourceRgba = [rgbaFrame(3), rgbaFrame(57), rgbaFrame(121), rgbaFrame(199)];
    const sourcePng = sourceRgba.map((rgba) => encodeRgbaPng(WIDTH, HEIGHT, rgba));
    const segmentPlans = [0, 1].map((segmentIndex) => buildLosslessSegmentIntermediateCommand({
      segmentDirectory,
      segmentIndex,
      frameCount: 2,
      fps: FPS
    }));

    const expectedFirst = await decodePngPipeToBgra(sourcePng.slice(0, 2));
    const expectedSecond = await decodePngPipeToBgra(sourcePng.slice(2, 4));
    await runPngPipe(segmentPlans[0].command, sourcePng.slice(0, 2));
    await runPngPipe(segmentPlans[1].command, sourcePng.slice(2, 4));

    const firstIntermediatePath = join(segmentDirectory, losslessSegmentFilename(0));
    const secondIntermediatePath = join(segmentDirectory, losslessSegmentFilename(1));
    const firstIntermediate = await probeMedia(firstIntermediatePath, { runner: realRunner, inputRoots: [segmentDirectory] });
    const secondIntermediate = await probeMedia(secondIntermediatePath, { runner: realRunner, inputRoots: [segmentDirectory] });
    for (const media of [firstIntermediate, secondIntermediate]) {
      expect(media).toMatchObject({
        codec: "ffv1",
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        color: { pixelFormat: "bgra", range: "pc" },
        alpha: { present: true, pixelFormat: "bgra" },
        audio: { present: false }
      });
      expect(media.durationMs).toBeGreaterThanOrEqual(990);
      expect(media.durationMs).toBeLessThanOrEqual(1_010);
    }

    const decodedFirst = await decodeBgraFrames(firstIntermediatePath, 2);
    const decodedSecond = await decodeBgraFrames(secondIntermediatePath, 2);
    expect(decodedFirst).toEqual(expectedFirst);
    expect(decodedSecond).toEqual(expectedSecond);
    // Boundary proof: the final source frame in segment one and first source frame in segment two
    // remain their distinct original bytes after independent FFV1 decode.
    expect(alphaPlane(decodedFirst.subarray(decodedFirst.length / 2)).equals(alphaPlane(expectedFirst.subarray(expectedFirst.length / 2)))).toBe(true);
    expect(alphaPlane(decodedSecond.subarray(0, WIDTH * HEIGHT * 4)).equals(alphaPlane(expectedSecond.subarray(0, WIDTH * HEIGHT * 4)))).toBe(true);

    for (const expectation of [
      { preset: "mp4-h264" as const, filename: "delivery.mp4", codec: "h264", alpha: false },
      { preset: "webm-vp9-alpha" as const, filename: "delivery.webm", codec: "vp9", alpha: true }
    ]) {
      const outputPath = join(root, expectation.filename);
      const canonical = buildEncodeImageSequenceCommand({
        framesDir: join(root, "unused-frames"),
        fps: FPS,
        durationMs: 2_000,
        outputPath,
        preset: expectation.preset,
        inputRoots: [root],
        outputRoots: [root]
      });
      const concatListPath = join(segmentDirectory, "segments.ffconcat");
      const plan = buildSegmentConcatFinalCommand({
        canonicalCommand: canonical,
        preset: expectation.preset,
        segmentDirectory,
        concatListPath,
        segmentFilenames: [losslessSegmentFilename(0), losslessSegmentFilename(1)],
        frameCount: 4
      });
      await writeFile(concatListPath, plan.concatList.contents, "utf8");
      await runCommand(plan.command);

      const media = await probeMedia(outputPath, { runner: realRunner, inputRoots: [root] });
      expect(media.codec).toBe(expectation.codec);
      expect(media.width).toBe(WIDTH);
      expect(media.height).toBe(HEIGHT);
      expect(media.fps).toBe(FPS);
      expect(media.durationMs).toBeGreaterThanOrEqual(1_990);
      expect(media.durationMs).toBeLessThanOrEqual(2_010);
      expect(media.alpha.present).toBe(expectation.alpha);
    }
  });
});

const realRunner: FfmpegRunner = async (command) => {
  const result = await runCommand(command);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8")
  };
};

async function runPngPipe(command: FfmpegCommand, pngFrames: Buffer[]): Promise<void> {
  await runCommand(command, Buffer.concat(pngFrames));
}

async function decodeBgraFrames(path: string, frameCount: number): Promise<Buffer> {
  const result = await runCommand({
    executable: "ffmpeg",
    args: [
      "-v", "error",
      "-protocol_whitelist", "file",
      "-i", path,
      "-map", "0:v:0",
      "-frames:v", String(frameCount),
      "-pix_fmt", "bgra",
      "-f", "rawvideo",
      "pipe:1"
    ],
    shell: false
  });
  expect(result.stdout).toHaveLength(frameCount * WIDTH * HEIGHT * 4);
  return result.stdout;
}

async function decodePngPipeToBgra(pngFrames: Buffer[]): Promise<Buffer> {
  const result = await runCommand({
    executable: "ffmpeg",
    args: [
      "-v", "error",
      "-f", "image2pipe",
      "-vcodec", "png",
      "-framerate", String(FPS),
      "-i", "pipe:0",
      "-frames:v", String(pngFrames.length),
      "-pix_fmt", "bgra",
      "-f", "rawvideo",
      "pipe:1"
    ],
    shell: false
  }, Buffer.concat(pngFrames));
  expect(result.stdout).toHaveLength(pngFrames.length * WIDTH * HEIGHT * 4);
  return result.stdout;
}

async function runCommand(command: FfmpegCommand, stdin?: Buffer): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  const child = spawn(command.executable, command.args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  if (stdin) child.stdin.end(stdin);
  else child.stdin.end();
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? -1));
  });
  const result = { exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
  return result;
}

function rgbaFrame(seed: number): Buffer {
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    const offset = pixel * 4;
    rgba[offset] = (seed + (pixel * 19)) % 256;
    rgba[offset + 1] = (seed * 3 + (pixel * 31)) % 256;
    rgba[offset + 2] = (255 - seed + (pixel * 11)) % 256;
    rgba[offset + 3] = [0, 67, 143, 255][pixel % 4];
  }
  return rgba;
}

function alphaPlane(bgraFrame: Buffer): Buffer {
  const alpha = Buffer.alloc(bgraFrame.length / 4);
  for (let pixel = 0; pixel < alpha.length; pixel += 1) alpha[pixel] = bgraFrame[pixel * 4 + 3]!;
  return alpha;
}


async function scratch(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `shellx-motion-lossless-segments-${label}-`));
  tempDirs.push(path);
  return path;
}
