import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { resolveLinearSrgbSdrFinalRoute, type LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { LinearSrgbSdrFinalWebGpuProducerEvidence } from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";
import { probeMedia, type FfmpegCommand, type FfmpegRunner } from "./index.js";
import { claimLinearSrgbSdrFinalPreparation, executeLinearSrgbSdrFinalForTest, prepareLinearSrgbSdrFinalForTest, type LinearSrgbSdrFinalJob } from "./linear-srgb-sdr-final-adapter.js";
import { compareLinearSrgbSdrFinalFrames } from "./linear-srgb-sdr-final-compare.js";
import {
  linearSrgbSdrFinalEncodeCommand,
  linearSrgbSdrFinalInverseDecodeCommand,
  preflightLinearSrgbSdrFinalFfmpeg,
} from "./linear-srgb-sdr-final-ffmpeg-contract.js";
import { startStreamingFfmpegProcess } from "./streaming-process.js";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("strict linear-sRGB SDR native FFmpeg qualification", () => {
  it.skipIf(process.env.MOTION_LINEAR_SDR_NATIVE_QUALIFICATION !== "1")("proves the exact forward tags, inverse, comparison, and rejecting control", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-linear-sdr-native-"));
    roots.push(root);
    const output = join(root, "strict.mp4");
    const decodedPath = join(root, "decoded.rgba");
    const width = 256, height = 144, fps = 30, frameCount = 30;
    const source = fixture(width, height);

    const preflight = await preflightLinearSrgbSdrFinalFfmpeg({ runner: textRunner });
    expect(preflight.status).toBe("available");
    await run(linearSrgbSdrFinalEncodeCommand({ width, height, fps, frameCount }, output), Buffer.concat(Array.from({ length: frameCount }, () => source)));
    const media = await probeMedia(output, { runner: textRunner, inputRoots: [root] });
    expect(media).toMatchObject({
      codec: "h264", width, height, fps,
      color: { pixelFormat: "yuv420p", space: "bt709", transfer: "bt709", primaries: "bt709", range: "tv" },
      alpha: { present: false },
      audio: { present: false, streamCount: 0 },
    });
    expect(media.container.split(",")).toContain("mp4");
    expect(media.durationMs).toBeGreaterThanOrEqual(995);
    expect(media.durationMs).toBeLessThanOrEqual(1_005);

    await run(linearSrgbSdrFinalInverseDecodeCommand(output, decodedPath));
    const decoded = await readFile(decodedPath);
    const comparison = compareLinearSrgbSdrFinalFrames({ width, height, source, decoded });
    expect(comparison.accepted, JSON.stringify(comparison.rgb)).toBe(true);

    const transferBypassControl = Buffer.from(decoded);
    for (let offset = 0; offset < transferBypassControl.byteLength; offset += 4) {
      transferBypassControl[offset] = Math.round(255 * Math.sqrt(transferBypassControl[offset]! / 255));
      transferBypassControl[offset + 1] = Math.round(255 * Math.sqrt(transferBypassControl[offset + 1]! / 255));
      transferBypassControl[offset + 2] = Math.round(255 * Math.sqrt(transferBypassControl[offset + 2]! / 255));
    }
    expect(compareLinearSrgbSdrFinalFrames({ width, height, source, decoded: transferBypassControl }).accepted).toBe(false);
  }, 60_000);

  it.skipIf(process.env.MOTION_LINEAR_SDR_NATIVE_QUALIFICATION !== "1")("runs the two-phase private adapter through real FFmpeg processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-linear-sdr-adapter-native-"));
    roots.push(root);
    const motion = strictMotion(), route = strictRoute(motion), source = fixture(256, 144);
    const preparation = await prepareLinearSrgbSdrFinalForTest(motion, textRunner);
    claimLinearSrgbSdrFinalPreparation(motion, preparation);
    const evidence = producerEvidence(route, source);
    const result = await executeLinearSrgbSdrFinalForTest({ preparation, outputPath: join(root, "work.mp4"), decodedPath: join(root, "decoded.rgba"), job: nativeJob(root) }, {
      createProducer: () => ({ ok: true, producer: { get evidence() { return evidence; }, async produce() { return { schema: "shellx-motion/linear-srgb-sdr-final-webgpu-frame@1", routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint, width: 256, height: 144, bytesPerRow: 1_024, rgba8SrgbSha256: sha256(source), rgba8Srgb: source }; } } }),
      startProcess: startStreamingFfmpegProcess,
    });
    expect(result.ok, result.ok ? undefined : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toMatchObject({ media: { codec: "h264", color: { transfer: "bt709", range: "tv" } }, comparison: { accepted: true }, retainedFrame: { repeatedFrames: 30 }, cleanup: { decodedFrameRemoved: true } });
    expect((await readFile(result.privateOutputPath)).byteLength).toBeGreaterThan(0);
  }, 60_000);
});

const textRunner: FfmpegRunner = async (command) => {
  const result = await run(command);
  return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
};

async function run(command: FfmpegCommand, stdin?: Buffer): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  const child = spawn(command.executable, command.args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(stdin);
  const exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? -1)); });
  const result = { exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
  return result;
}

function fixture(width: number, height: number): Buffer {
  const frame = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgb = x >= 17 && x < 96 && y >= 15 && y < 55 ? [255, 0, 64]
        : x >= 101 && x < 222 && y >= 37 && y < 119 ? [0, 102, 255]
          : (x === 133 || y === 91) ? [235, 235, 235]
            : y >= 113 ? [8, 8, 8]
              : [16, 24, 32];
      const offset = (y * width + x) * 4;
      frame[offset] = rgb[0]!; frame[offset + 1] = rgb[1]!; frame[offset + 2] = rgb[2]!; frame[offset + 3] = 255;
    }
  }
  return frame;
}

function strictMotion() {
  return { schema: "shellx-motion/motion@1" as const, id: "native-strict-sdr", name: "native strict SDR", durationMs: 1_000, fps: 30, width: 256, height: 144, background: "#101820", colorPipeline: { schema: "shellx-motion/color-pipeline@1" as const, intent: "linear-srgb-sdr@1" as const }, assets: [], layers: [], provenance: { sourceApp: "qualification", createdBy: "linear-sdr-native-test" } };
}

function strictRoute(motion: ReturnType<typeof strictMotion>): LinearSrgbSdrFinalRoute {
  const result = resolveLinearSrgbSdrFinalRoute(motion, { target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264" });
  if (!result.ok) throw new Error(result.refusal.message);
  return result.route;
}

function producerEvidence(route: LinearSrgbSdrFinalRoute, source: Buffer): LinearSrgbSdrFinalWebGpuProducerEvidence {
  return { schema: "shellx-motion/linear-srgb-sdr-final-webgpu-producer@1", routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint, pipeline: { schema: "shellx-motion/linear-srgb-sdr-final-webgpu-pipeline@1", implementationSha256: "a".repeat(64), workingTarget: "rgba16float", publicationTarget: "rgba8unorm", publicationUsage: "COPY_SRC", composition: "premultiplied-linear-srgb-normal-source-over", frameBoundary: "straight-srgb-rgba8" }, runtime: null, readback: { bytesPerRow: 1_024, paddedByteLength: 147_456, tightByteLength: 147_456, mapOperations: 1, mappedBufferUnmapped: true, mappedBufferDestroyed: true }, retainedFrame: { bytes: source.byteLength, sha256: sha256(source) }, cleanup: { state: "complete", resourcesReleased: true, pageClosed: true, runtimeClosed: true }, fingerprint: "b".repeat(64) };
}

function nativeJob(root: string): LinearSrgbSdrFinalJob { return { admission: "pre-acquired", signal: new AbortController().signal, scratchRoot: root, maxProcessTreeRssBytes: 512 * 1024 * 1024, watchProcess() {}, reportProcessContainment() {} }; }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
