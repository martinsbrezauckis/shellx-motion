import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveExportPreset } from "../packages/renderer-ffmpeg/src/index";
import { rawVideoCommandFromImageSequence } from "../packages/renderer-ffmpeg/src/streaming-command-input";
import {
  FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT,
  createSyntheticFrameSet,
  decodedFrameEvidence,
  existingFfmpegInputArgs,
  existingFfmpegOutputArgs,
  frameDurationUs,
  frameTimestampUs,
  timestampEvidence,
} from "./frame-video-encoder-benchmark-contract.mjs";
import { parseFrameVideoEncoderBenchmarkArgs } from "./frame-video-encoder-benchmark.mjs";

describe("isolated frame-to-video encoder benchmark contract", () => {
  it("generates byte-identical bounded RGBA inputs with exact integer frame times", () => {
    const first = createSyntheticFrameSet("opaque");
    const repeated = createSyntheticFrameSet("opaque");
    const alpha = createSyntheticFrameSet("alpha");
    expect(first.sha256).toBe(repeated.sha256);
    expect(first.frameSha256).toEqual(repeated.frameSha256);
    expect(first.byteLength).toBe(320 * 180 * 4 * 60);
    expect(first.frameSha256).toHaveLength(60);
    expect(first.timestampUs.slice(0, 5)).toEqual([0, 33_333, 66_666, 100_000, 133_333]);
    expect(first.durationUs.slice(0, 5)).toEqual([33_333, 33_333, 33_334, 33_333, 33_333]);
    expect(frameTimestampUs(59)).toBe(1_966_666);
    expect(frameDurationUs(59)).toBe(33_334);
    expect(alpha.sha256).not.toBe(first.sha256);
    expect(new Set(Array.from(alpha.bytes).filter((_entry, index) => index % 4 === 3)).size).toBeGreaterThan(32);
    expect(() => createSyntheticFrameSet("unknown")).toThrow("Unknown");
    expect(() => frameTimestampUs(60)).toThrow("outside");
  });

  it("uses the existing raw-RGBA handoff and exact Motion VP9 preset arguments", () => {
    const base = {
      executable: "ffmpeg",
      shell: false as const,
      args: ["-framerate", "30", "-start_number", "1", "-i", "/frames/%06d.png", "/out.webm"],
    };
    const raw = rawVideoCommandFromImageSequence(base, { width: 320, height: 180, fps: 30 });
    expect(raw.args.slice(2, -1)).toEqual(existingFfmpegInputArgs());
    expect(existingFfmpegOutputArgs("opaque")).toEqual(resolveExportPreset("webm-vp9").outputArgs);
    expect(existingFfmpegOutputArgs("alpha")).toEqual(resolveExportPreset("webm-vp9-alpha").outputArgs);
  });

  it("measures decoded RGB, alpha, hashes, frame count, and container timestamp drift", () => {
    const contract = { ...FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT, width: 2, height: 1, frameCount: 2 };
    const source = Buffer.from([10, 20, 30, 40, 100, 110, 120, 255, 50, 60, 70, 80, 200, 210, 220, 255]);
    const decoded = Buffer.from([11, 18, 33, 40, 100, 110, 120, 255, 55, 65, 75, 255, 200, 210, 220, 255]);
    const evidence = decodedFrameEvidence(source, decoded, contract);
    expect(evidence).toMatchObject({
      decodedFrameCount: 2,
      frameCountExact: true,
      rgb: { maximumAbsoluteError: 5 },
      alpha: { maximumAbsoluteError: 175, nonOpaqueDecodedPixels: 1, hasDecodedTransparency: true },
    });
    expect(evidence.decodedFrameSha256).toHaveLength(2);
    const times = timestampEvidence([0, 33_333, 66_666], [
      { best_effort_timestamp_time: "0.000000" },
      { best_effort_timestamp_time: "0.033000" },
      { best_effort_timestamp_time: "0.067000" },
    ]);
    expect(times).toMatchObject({ maximumAbsoluteDriftUs: 334, withinContainerTolerance: true, monotonic: true });
    expect(timestampEvidence([0, 33_333], [{ best_effort_timestamp_time: "0" }]).withinContainerTolerance).toBe(false);
  });

  it("requires literal absolute tool inputs and keeps the candidate outside production surfaces", () => {
    const parsed = parseFrameVideoEncoderBenchmarkArgs([
      "--browser", "/tools/chrome",
      "--mediabunny-bundle", "/scratch/mediabunny.mjs",
      "--out-dir", "/scratch/run-1",
      "--source-revision", "abcdef1",
      "--ffmpeg", "ffmpeg",
      "--ffprobe", "ffprobe",
    ]);
    expect(parsed).toMatchObject({ browser: "/tools/chrome", mediabunnyBundle: "/scratch/mediabunny.mjs", outDir: "/scratch/run-1", sourceRevision: "abcdef1" });
    expect(() => parseFrameVideoEncoderBenchmarkArgs(["--browser", "chrome"])).toThrow();
    expect(() => parseFrameVideoEncoderBenchmarkArgs(["--script", "return globalThis"])).toThrow();
    const rootManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies: Record<string, string> };
    expect(rootManifest.scripts["encoder:benchmark:isolated"]).toBe("node scripts/frame-video-encoder-benchmark.mjs");
    expect(rootManifest.dependencies ?? {}).not.toHaveProperty("mediabunny");
    expect(rootManifest.devDependencies).not.toHaveProperty("mediabunny");
    const source = [
      readFileSync(new URL("./frame-video-encoder-benchmark-contract.mjs", import.meta.url), "utf8"),
      readFileSync(new URL("./frame-video-encoder-benchmark-browser.mjs", import.meta.url), "utf8"),
      readFileSync(new URL("./frame-video-encoder-benchmark.mjs", import.meta.url), "utf8"),
    ].join("\n");
    expect(source).not.toMatch(/packages\/(?:connectors|debug-api|debug-server|cli)\/src/u);
    expect(source).toContain('cdp.send("Browser.getVersion")');
    expect(source).not.toContain('toolVersion(options.browser, ["--version"])');
    expect(FRAME_VIDEO_ENCODER_BENCHMARK_CONTRACT.candidate).toEqual({
      name: "mediabunny",
      version: "1.55.2",
      license: "MPL-2.0",
      packageIntegrity: "sha512-EEx4O6qYddAdCyWPMZNDwI7uc5hewNHrPAf9jLcVhIbXoPsiqNQ+D9i1pfadmGkjN2V318jSrZljkpoziYm6Lg==",
      packageShasum: "878a623407abed1860f92f1ba7376e60dbecbd37",
    });
  });
});
