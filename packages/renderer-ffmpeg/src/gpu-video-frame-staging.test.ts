import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareGpuVideoFrameStaging, requestedGpuVideoAudioAssetRefs } from "./gpu-video-frame-staging";
import { plannedPcmBytesForDuration } from "./gpu-video-staging-budget";
import { createGovernedFfmpegRunner, type FfmpegCommand, type FfmpegProcessResult, type FfmpegRunner } from "./index";

const hostFfmpegAvailable = ["ffmpeg", "ffprobe"].every((tool) => spawnSync(tool, ["-version"], { stdio: "ignore" }).status === 0);
const tempDirs: string[] = [];
let stagingNumber = 0;

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.allSettled(tempDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("GPU video frame staging", () => {
  it("decodes an immutable package video once and serves one exact RGBA frame at a time", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-stage-")); await mkdir(join(root, "assets"), { mode: 0o700 });
    tempDirs.push(root);
    await writeFile(join(root, "assets", "clip.mp4"), "bounded-video-fixture", { mode: 0o600 });
    const pkg = videoPackage(root);
    pkg.motion.layers[0]!.includeAudio = true;
    const configuredFfmpegPath = join(root, "configured-ffmpeg-not-path");
    await writeFile(configuredFfmpegPath, "test executable, never spawned\n", { mode: 0o700 });
    const configuredFfmpeg = await realpath(configuredFfmpegPath);
    vi.stubEnv("SHELLX_MOTION_FFMPEG", configuredFfmpeg);
    const commands: FfmpegCommand[] = []; let rawPath = "";
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isImmutableMediaProbe(command)) return successfulProbe(2, 1, 1_000);
      const outputPath = command.args.at(-1)!;
      if (outputPath.endsWith(".rgba")) {
        rawPath = outputPath;
        await writeFile(rawPath, Buffer.from([1,2,3,255,4,5,6,255, 7,8,9,255,10,11,12,255]), { mode: 0o600 });
      } else {
        await writeFile(outputPath, Buffer.from("RIFF-immutable-pcm-wave"), { mode: 0o600 });
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const stagingRoot = await staging(root);
    const prepared = await prepareGpuVideoFrameStaging({ pkg, runner, preflight: stagingRoot });
    expect(prepared).toBeDefined(); if (!prepared) return;
    const decode = commands.find((command) => command.args.at(-1)?.endsWith(".rgba"))!;
    expect(decode).toMatchObject({ executable: configuredFfmpeg, shell: false });
    expect(decode.args).toEqual(expect.arrayContaining(["-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-frames:v", "2", "-f", "rawvideo"]));
    expect(prepared.inputHashes["assets/clip.mp4"]).toMatch(/^[a-f0-9]{64}$/);
    expect([...prepared.mediaSnapshots.values()][0]?.path.startsWith(stagingRoot.stagingRoot)).toBe(true);
    const probe = commands.find(isImmutableMediaProbe)!;
    const snapshotPath = probe.args[probe.args.indexOf("-i") + 1]!;
    expect(probe).toMatchObject({ shell: false });
    expect(probe.args).toEqual(expect.arrayContaining(["-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", snapshotPath]));
    expect(snapshotPath).toBe([...prepared.mediaSnapshots.values()][0]?.path);
    expect(decode.args).toContain(snapshotPath);
    expect([...prepared.audioSnapshots.values()][0]).toMatchObject({ sourcePath: join(root, "assets", "clip.mp4"), path: expect.stringMatching(/\.wav$/), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(rawPath.startsWith(stagingRoot.stagingRoot)).toBe(true);
    expect([...prepared.audioSnapshots.values()][0]?.path.startsWith(stagingRoot.stagingRoot)).toBe(true);
    const audioDecode = commands.find((command) => command.args.at(-1)?.endsWith(".wav"))!;
    expect(audioDecode).toMatchObject({ executable: configuredFfmpeg, shell: false });
    expect(audioDecode.args).toEqual(expect.arrayContaining(["-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-map", "0:a:0", "-c:a", "pcm_s16le"]));
    const provider = await prepared.openProvider();
    const first = await provider.frameAt(0, new AbortController().signal); const second = await provider.frameAt(500, new AbortController().signal);
    const firstRgba = Buffer.from([1,2,3,255,4,5,6,255]);
    const secondRgba = Buffer.from([7,8,9,255,10,11,12,255]);
    expect(first.frames[0]).toMatchObject({ layerId: "clip", sourceAtMs: 100, resource: { width: 2, height: 1 }, upload: { rgba: firstRgba, decodedSha256: createHash("sha256").update(firstRgba).digest("hex") } });
    expect(second.frames[0]).toMatchObject({ layerId: "clip", sourceAtMs: 600, upload: { rgba: secondRgba, decodedSha256: createHash("sha256").update(secondRgba).digest("hex") } });
    expect(provider.evidence).toMatchObject({ mode: "immutable-ffmpeg-rgba-stream", decodedFrameCount: 2, peakInMemoryFrames: 1, stagedDecodedBytes: 16, stagedFrameCount: 2 });
    await provider.close(); await prepared.release();
    await expect(lstat(rawPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(stagingRoot.stagingRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readdir(stagingRoot.stagingRoot)).resolves.toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("refuses undeclared and keyframed-rate video sources before starting FFmpeg", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-refuse-")); await mkdir(join(root, "assets"), { mode: 0o700 });
    tempDirs.push(root);
    await writeFile(join(root, "assets", "clip.mp4"), "bounded-video-fixture", { mode: 0o600 });
    let calls = 0; const runner: FfmpegRunner = async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; };
    const undeclared = videoPackage(root); undeclared.manifest.assets = [];
    await expect(prepareGpuVideoFrameStaging({ pkg: undeclared, runner })).rejects.toThrow("declared package asset");
    const keyframed = videoPackage(root); keyframed.motion.layers[0].keyframes = { playbackRate: [{ atMs: 0, value: 1 }] };
    await expect(prepareGpuVideoFrameStaging({ pkg: keyframed, runner })).rejects.toThrow("keyframed playbackRate");
    expect(calls).toBe(0);
    await rm(root, { recursive: true, force: true });
  });

  it("decodes full-source loops as bounded immutable monotonic segments", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-loop-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    await writeFile(join(root, "assets", "clip.mp4"), "bounded-video-fixture", { mode: 0o600 });
    const pkg = videoPackage(root);
    pkg.motion.durationMs = 1_500;
    pkg.motion.layers[0] = { ...pkg.motion.layers[0]!, durationMs: 1_500, trimStartMs: 0, loop: true };
    const commands: FfmpegCommand[] = [];
    let decodeIndex = 0;
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isImmutableMediaProbe(command)) return successfulProbe(2, 1, 1_000);
      const frameCount = Number(command.args[command.args.indexOf("-frames:v") + 1]);
      await writeFile(command.args.at(-1)!, Buffer.alloc(8 * frameCount, ++decodeIndex), { mode: 0o600 });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const prepared = await prepareGpuVideoFrameStaging({ pkg, runner, preflight: await staging(root) });
    expect(prepared).toBeDefined(); if (!prepared) return;
    const decodes = commands.filter((command) => command.args.at(-1)?.endsWith(".rgba"));
    expect(decodes).toHaveLength(2);
    expect(decodes.map((command) => command.args[command.args.indexOf("-frames:v") + 1])).toEqual(["2", "1"]);
    expect(decodes.every((command) => command.args[command.args.indexOf("-vf") + 1]?.includes("tpad=stop_mode=clone"))).toBe(true);
    const provider = await prepared.openProvider();
    expect((await provider.frameAt(0, new AbortController().signal)).frames[0]).toMatchObject({ sourceAtMs: 0 });
    expect((await provider.frameAt(500, new AbortController().signal)).frames[0]).toMatchObject({ sourceAtMs: 500 });
    expect((await provider.frameAt(1_000, new AbortController().signal)).frames[0]).toMatchObject({ sourceAtMs: 0 });
    expect(provider.evidence).toMatchObject({ decodedFrameCount: 3, stagedFrameCount: 3, stagedDecodedBytes: 24 });
    await provider.close();
    await prepared.release();
  });

  it("stages one full PCM source for two differently trimmed and timed layers", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-audio-semantics-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    await writeFile(join(root, "assets", "clip.mp4"), "bounded-video-fixture", { mode: 0o600 });
    const pkg = videoPackage(root);
    pkg.motion.durationMs = 2_000;
    pkg.motion.layers[0] = { ...pkg.motion.layers[0]!, includeAudio: true, durationMs: 400, trimStartMs: 250, trimDurationMs: 500, playbackRate: 1.5 };
    pkg.motion.layers.push({ ...pkg.motion.layers[0]!, id: "clip-later", startMs: 500, durationMs: 400, trimStartMs: 0, trimDurationMs: 750, playbackRate: 0.5 });
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isImmutableMediaProbe(command)) return successfulProbe(2, 1, 2_000);
      const output = command.args.at(-1)!;
      await writeFile(output, output.endsWith(".rgba")
        ? Buffer.alloc(8 * Number(command.args[command.args.indexOf("-frames:v") + 1]))
        : Buffer.from("RIFF-full-source-pcm"), { mode: 0o600 });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const prepared = await prepareGpuVideoFrameStaging({ pkg, runner, preflight: await staging(root) });
    expect(prepared).toBeDefined(); if (!prepared) return;
    const pcm = commands.filter((command) => command.args.at(-1)?.endsWith(".wav"));
    expect(pcm).toHaveLength(1);
    expect(pcm[0]!.args).not.toContain("-ss");
    expect(pcm[0]!.args).not.toContain("-t");
    expect(prepared.ledger.plannedPcmBytes).toBe(plannedPcmBytesForDuration(2_000));
    expect(prepared.audioSnapshots).toHaveLength(1);
    await prepared.release();
  });

  it("does not stage PCM for a video source omitted from the effective encoder audio mix", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-muted-audio-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    await writeFile(join(root, "assets", "clip.mp4"), "bounded-video-fixture", { mode: 0o600 });
    const pkg = videoPackage(root); pkg.motion.layers[0]!.includeAudio = true;
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isImmutableMediaProbe(command)) return successfulProbe(2, 1, 1_000);
      const output = command.args.at(-1)!;
      await writeFile(output, Buffer.alloc(16), { mode: 0o600 });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const prepared = await prepareGpuVideoFrameStaging({ pkg, runner, audioSourcePaths: [], preflight: await staging(root) });
    expect(prepared).toBeDefined(); if (!prepared) return;
    expect(commands.some((command) => command.args.at(-1)?.endsWith(".wav"))).toBe(false);
    expect(prepared.audioSnapshots.size).toBe(0);
    expect(prepared.ledger.plannedPcmBytes).toBe(0);
    await prepared.release();
  });

  it("stages requested audio from a visually hidden group video resolved through assetId without decoding RGBA frames", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-hidden-video-audio-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    const source = join(root, "assets", "clip.mp4");
    await writeFile(source, "bounded-video-fixture", { mode: 0o600 });
    const pkg = videoPackage(root);
    pkg.motion.assets = [{ id: "clip_asset", source: { path: "assets/clip.mp4", mimeType: "video/mp4" } }];
    pkg.motion.layers[0] = { ...pkg.motion.layers[0]!, assetId: "clip_asset", assetRef: undefined, includeAudio: true };
    pkg.motion.layers.unshift({ id: "hidden-scene", type: "group", visible: false, startMs: 0, durationMs: 1_000, childLayerIds: ["clip"] });
    const commands: FfmpegCommand[] = [];
    const configuredFfmpegPath = join(root, "configured-ffmpeg-hidden-audio-not-path");
    await writeFile(configuredFfmpegPath, "test executable, never spawned\n", { mode: 0o700 });
    const configuredFfmpeg = await realpath(configuredFfmpegPath);
    vi.stubEnv("SHELLX_MOTION_FFMPEG", configuredFfmpeg);
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isImmutableMediaProbe(command)) return successfulProbe(2, 1, 1_000);
      await writeFile(command.args.at(-1)!, Buffer.from("RIFF-hidden-video-pcm"), { mode: 0o600 });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    expect(requestedGpuVideoAudioAssetRefs(pkg, [source])).toEqual(["assets/clip.mp4"]);
    const prepared = await prepareGpuVideoFrameStaging({ pkg, runner, audioSourcePaths: [source], preflight: await staging(root) });
    expect(prepared).toBeDefined(); if (!prepared) return;
    expect(prepared.videos.size).toBe(0);
    expect(prepared.audioSnapshots.size).toBe(1);
    expect(prepared.ledger.plannedRgbaBytes).toBe(0);
    expect(prepared.ledger.plannedPcmBytes).toBe(plannedPcmBytesForDuration(1_000));
    expect(commands.some((command) => command.args.at(-1)?.endsWith(".rgba"))).toBe(false);
    const pcm = commands.filter((command) => command.args.at(-1)?.endsWith(".wav"));
    expect(pcm).toHaveLength(1);
    expect(pcm[0]).toMatchObject({ executable: configuredFfmpeg, shell: false });
    await prepared.release();
  });

  it.skipIf(!hostFfmpegAvailable)("proves real immutable H.264/AAC decode into exact RGBA frames and private PCM", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-real-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    const sourcePath = join(root, "assets", "clip.mp4");
    const runner = createGovernedFfmpegRunner({ scratchRoot: root, operation: "test.gpu-video-real" });
    const generated = await runner({
      executable: "ffmpeg",
      shell: false,
      args: [
        "-v", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=16x16:rate=2:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath
      ]
    });
    expect(generated.exitCode).toBe(0);
    const pkg = videoPackage(root);
    pkg.motion.layers[0]!.trimStartMs = 0;
    pkg.motion.layers[0]!.includeAudio = true;
    const prepared = await prepareGpuVideoFrameStaging({ pkg, runner, preflight: await staging(root) });
    expect(prepared).toBeDefined();
    if (!prepared) return;
    const provider = await prepared.openProvider();
    const first = await provider.frameAt(0, new AbortController().signal);
    const second = await provider.frameAt(500, new AbortController().signal);
    expect(first.frames[0]?.upload.rgba).toHaveLength(16 * 16 * 4);
    expect(second.frames[0]?.upload.rgba).toHaveLength(16 * 16 * 4);
    expect(first.frames[0]?.upload.sha256).not.toBe(second.frames[0]?.upload.sha256);
    expect(first.frames[0]?.upload.decodedSha256).toBe(first.frames[0]?.upload.sha256);
    expect(second.frames[0]?.upload.decodedSha256).toBe(second.frames[0]?.upload.sha256);
    const audio = [...prepared.audioSnapshots.values()][0]!;
    expect(audio.path).toMatch(/\.wav$/);
    expect((await lstat(audio.path)).size).toBeGreaterThan(44);
    expect(provider.evidence).toMatchObject({ sourceCount: 1, decodedFrameCount: 2, peakInMemoryFrames: 1, stagedDecodedBytes: 2_048 });
    await provider.close();
    await prepared.release();
    await expect(lstat(audio.path)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(root, { recursive: true, force: true });
  }, 45_000);

  it.skipIf(!hostFfmpegAvailable)("repeats exact decoded pixels across a real immutable full-source loop", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-real-loop-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    const sourcePath = join(root, "assets", "clip.mp4");
    const runner = createGovernedFfmpegRunner({ scratchRoot: root, operation: "test.gpu-video-real-loop" });
    const generated = await runner({
      executable: "ffmpeg", shell: false, args: [
        "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=16x16:rate=2:duration=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", sourcePath
      ]
    });
    expect(generated.exitCode).toBe(0);
    const pkg = videoPackage(root);
    pkg.motion.durationMs = 1_500;
    pkg.motion.layers[0] = { ...pkg.motion.layers[0]!, durationMs: 1_500, trimStartMs: 0, loop: true };
    const prepared = await prepareGpuVideoFrameStaging({ pkg, runner, preflight: await staging(root) });
    expect(prepared).toBeDefined(); if (!prepared) return;
    const provider = await prepared.openProvider();
    const first = (await provider.frameAt(0, new AbortController().signal)).frames[0]!;
    const middle = (await provider.frameAt(500, new AbortController().signal)).frames[0]!;
    const repeated = (await provider.frameAt(1_000, new AbortController().signal)).frames[0]!;
    expect(first.upload.sha256).not.toBe(middle.upload.sha256);
    expect(repeated.upload.sha256).toBe(first.upload.sha256);
    expect(repeated.sourceAtMs).toBe(0);
    await provider.close();
    await prepared.release();
  }, 45_000);

  it("rejects a source-only over-cap before copying or probing", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-budget-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    const source = join(root, "assets", "clip.mp4");
    await writeFile(source, "bounded-video-fixture", { mode: 0o600 });
    const pkg = videoPackage(root);
    let calls = 0;
    const runner: FfmpegRunner = async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; };
    const bytes = (await stat(source)).size;
    const preflight = await staging(root, bytes - 1);
    await expect(prepareGpuVideoFrameStaging({ pkg, runner, preflight })).rejects.toThrow("aggregate operation budget");
    expect(calls).toBe(0);
    await expect(readdir(preflight.stagingRoot)).resolves.toEqual([]);
  });

  it("rejects a post-probe full budget before decoding and cleans the immutable snapshot", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-post-probe-budget-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    const source = join(root, "assets", "clip.mp4");
    await writeFile(source, "bounded-video-fixture", { mode: 0o600 });
    const pkg = videoPackage(root);
    const bytes = (await stat(source)).size;
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      commands.push(command);
      if (isImmutableMediaProbe(command)) return successfulProbe(2, 1, 1_000);
      throw new Error("decoder must not run after aggregate budget refusal");
    };
    const preflight = await staging(root, bytes + 15);
    await expect(prepareGpuVideoFrameStaging({ pkg, runner, preflight })).rejects.toThrow("aggregate operation budget");
    expect(commands.filter(isImmutableMediaProbe)).toHaveLength(1);
    expect(commands.filter((command) => command.args.at(-1)?.endsWith(".rgba") || command.args.at(-1)?.endsWith(".wav"))).toHaveLength(0);
    await expect(readdir(preflight.stagingRoot)).resolves.toEqual([]);
  });

  it("cleans only its owned files after decoder failure and leaves the caller-owned root intact", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-cleanup-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    await writeFile(join(root, "assets", "clip.mp4"), "bounded-video-fixture", { mode: 0o600 });
    const pkg = videoPackage(root);
    const preflight = await staging(root);
    const runner: FfmpegRunner = async (command) => isImmutableMediaProbe(command)
      ? successfulProbe(2, 1, 1_000)
      : { exitCode: 1, stdout: "", stderr: "" };
    await expect(prepareGpuVideoFrameStaging({ pkg, runner, preflight })).rejects.toThrow("decoder failed");
    await expect(lstat(preflight.stagingRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readdir(preflight.stagingRoot)).resolves.toEqual([]);
  });

  it("rejects invalid or test-mismatched immutable probes before decoder launch", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-probe-refusal-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    await writeFile(join(root, "assets", "clip.mp4"), "bounded-video-fixture", { mode: 0o600 });
    const pkg = videoPackage(root);
    const invalidPreflight = await staging(root);
    let decoderCalls = 0;
    const invalidRunner: FfmpegRunner = async (command) => {
      if (isImmutableMediaProbe(command)) return { exitCode: 0, stdout: "not json", stderr: "" };
      decoderCalls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(prepareGpuVideoFrameStaging({ pkg, runner: invalidRunner, preflight: invalidPreflight })).rejects.toThrow("invalid JSON");
    expect(decoderCalls).toBe(0);
    await expect(readdir(invalidPreflight.stagingRoot)).resolves.toEqual([]);

    const mismatchPreflight = await staging(root);
    mismatchPreflight.media = [{ assetRef: "assets/clip.mp4", width: 3, height: 1 }];
    await expect(prepareGpuVideoFrameStaging({ pkg, runner: async (command) => isImmutableMediaProbe(command) ? successfulProbe(2, 1, 1_000) : { exitCode: 0, stdout: "", stderr: "" }, preflight: mismatchPreflight })).rejects.toThrow("does not match test media facts");
    await expect(readdir(mismatchPreflight.stagingRoot)).resolves.toEqual([]);
  });

  it("cleans snapshots when cancellation is observed after probing and before decode", async () => {
    const root = await mkdtemp(join(process.cwd(), ".scratch-motion-gpu-video-abort-"));
    tempDirs.push(root);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    await writeFile(join(root, "assets", "clip.mp4"), "bounded-video-fixture", { mode: 0o600 });
    const pkg = videoPackage(root);
    const preflight = await staging(root);
    const controller = new AbortController();
    let decodes = 0;
    const runner: FfmpegRunner = async (command) => {
      if (isImmutableMediaProbe(command)) {
        controller.abort(new Error("test GPU video staging abort"));
        return successfulProbe(2, 1, 1_000);
      }
      decodes += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(prepareGpuVideoFrameStaging({ pkg, runner, preflight, signal: controller.signal })).rejects.toThrow("test GPU video staging abort");
    expect(decodes).toBe(0);
    await expect(readdir(preflight.stagingRoot)).resolves.toEqual([]);
  });
});

function isImmutableMediaProbe(command: FfmpegCommand): boolean {
  return command.args.includes("-show_streams") && command.args.includes("-show_format");
}

async function staging(root: string, maxBytes?: number): Promise<{ stagingRoot: string; media?: Array<{ assetRef: string; width: number; height: number }>; authority: { path: string; assertCurrent(): Promise<void> }; maxBytes?: number }> {
  const stagingRoot = join(root, `gpu-staging-${stagingNumber++}`);
  await mkdir(stagingRoot, { mode: 0o700 });
  return { stagingRoot, authority: { path: stagingRoot, async assertCurrent() {} }, ...(maxBytes === undefined ? {} : { maxBytes }) };
}

function successfulProbe(width: number, height: number, durationMs: number): FfmpegProcessResult {
  return { exitCode: 0, stdout: JSON.stringify({ streams: [{ codec_type: "video", width, height, duration: String(durationMs / 1_000) }], format: { duration: String(durationMs / 1_000) } }), stderr: "" };
}

function videoPackage(root: string): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_video", name: "GPU video", motion: "motion.json", assets: ["assets/clip.mp4"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_video", name: "GPU video", durationMs: 1_000, fps: 2, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000, trimStartMs: 100, transform: { width: 16, height: 16 } }] }
  };
}
