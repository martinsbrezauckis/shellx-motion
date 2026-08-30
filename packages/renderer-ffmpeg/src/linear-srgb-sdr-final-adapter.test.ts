import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLinearSrgbSdrFinalRoute, type LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { LinearSrgbSdrFinalWebGpuFrame, LinearSrgbSdrFinalWebGpuProducerEvidence } from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";
import type { FfmpegCommand, FfmpegRunner } from "./index.js";
import {
  claimLinearSrgbSdrFinalPreparation,
  executeLinearSrgbSdrFinalForTest,
  prepareLinearSrgbSdrFinalForTest,
  type LinearSrgbSdrFinalJob,
} from "./linear-srgb-sdr-final-adapter.js";
import type { StreamingFfmpegProcess, StreamingFfmpegProcessFactory } from "./streaming-process.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

describe("strict linear-sRGB SDR adapter", () => {
  it("separates output-free preparation from acquired-job GPU and private output work", async () => {
    const events: string[] = [];
    const prepared = await prepareLinearSrgbSdrFinalForTest(motion(), preflightRunner(events));
    expect(events).toEqual(["ffmpeg-version", "ffprobe-version", "ffmpeg-zscale-preflight"]);
    expect(prepared).toMatchObject({ schema: "shellx-motion/linear-srgb-sdr-final-preparation@1", route: { schema: "shellx-motion/linear-srgb-sdr-final-route@1" }, ffmpeg: { status: "available" } });
    expect(Object.isFrozen(prepared.route.rects)).toBe(true);
    claimLinearSrgbSdrFinalPreparation(motion(), prepared);

    const root = await scratch(), source = opaqueFrame(), outputPath = join(root, "work.mp4"), decodedPath = join(root, "decoded.rgba");
    let containmentReports = 0;
    const result = await executeLinearSrgbSdrFinalForTest({ preparation: prepared, outputPath, decodedPath, job: job(root, () => {
      containmentReports += 1;
      if (containmentReports > 1) throw new Error("duplicate containment report");
    }) }, services({ source, events }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(events.slice(3)).toEqual(["gpu-produce", "encode-start", "encode-write", "encode-write", "encode-end", "probe-start", "probe-end", "inverse-start", "inverse-end"]);
    expect(await readFile(outputPath)).toEqual(Buffer.from("bounded-private-mp4"));
    await expect(readFile(decodedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.evidence).toMatchObject({
      routeFingerprint: prepared.route.fingerprint,
      preparationFingerprint: prepared.fingerprint,
      retainedFrame: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), byteLength: 16, repeatedFrames: 2 },
      media: { codec: "h264", color: { transfer: "bt709", range: "tv" } },
      comparison: { accepted: true },
      cleanup: { browserTerminal: true, encoderExitCode: 0, probeExitCode: 0, inverseExitCode: 0, decodedFrameRemoved: true },
    });
    expect(JSON.stringify(result.evidence)).not.toContain(root);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(containmentReports).toBe(1);
  });

  it("refuses a stale preparation before producer or output allocation", async () => {
    const prepared = await prepareLinearSrgbSdrFinalForTest(motion(), preflightRunner([]));
    const events: string[] = [];
    const changed = { ...motion(), name: "changed" };
    expect(() => claimLinearSrgbSdrFinalPreparation(changed, prepared)).toThrow(/stale/u);
    expect(events).toEqual([]);
  });

  it("fails closed and removes both private artifacts when decoded comparison rejects", async () => {
    const prepared = await prepareLinearSrgbSdrFinalForTest(motion(), preflightRunner([]));
    claimLinearSrgbSdrFinalPreparation(motion(), prepared);
    const root = await scratch(), outputPath = join(root, "work.mp4"), decodedPath = join(root, "decoded.rgba");
    const result = await executeLinearSrgbSdrFinalForTest({ preparation: prepared, outputPath, decodedPath, job: job(root) }, services({ source: opaqueFrame(), decoded: Buffer.from([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]), events: [] }));
    expect(result).toMatchObject({ ok: false, code: "linear_srgb_sdr_final_failed" });
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(decodedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses non-opaque producer bytes before the encoder starts", async () => {
    const prepared = await prepareLinearSrgbSdrFinalForTest(motion(), preflightRunner([]));
    claimLinearSrgbSdrFinalPreparation(motion(), prepared);
    const root = await scratch(), events: string[] = [], source = opaqueFrame(); source[3] = 1;
    const result = await executeLinearSrgbSdrFinalForTest({ preparation: prepared, outputPath: join(root, "work.mp4"), decodedPath: join(root, "decoded.rgba"), job: job(root) }, services({ source, events }));
    expect(result).toMatchObject({ ok: false, code: "linear_srgb_sdr_final_refused" });
    expect(events).toEqual(["gpu-produce"]);
  });

  it("refuses artifact paths outside the admitted job scratch root", async () => {
    const prepared = await prepareLinearSrgbSdrFinalForTest(motion(), preflightRunner([]));
    claimLinearSrgbSdrFinalPreparation(motion(), prepared);
    const root = await scratch(), events: string[] = [];
    const result = await executeLinearSrgbSdrFinalForTest({ preparation: prepared, outputPath: join(root, "..", "escape.mp4"), decodedPath: join(root, "decoded.rgba"), job: job(root) }, services({ source: opaqueFrame(), events }));
    expect(result).toMatchObject({ ok: false, code: "linear_srgb_sdr_final_refused" });
    expect(events).toEqual([]);
  });

  it("consumes output-free preparation authority exactly once", async () => {
    const prepared = await prepareLinearSrgbSdrFinalForTest(motion(), preflightRunner([]));
    claimLinearSrgbSdrFinalPreparation(motion(), prepared);
    const root = await scratch(), source = opaqueFrame();
    const first = await executeLinearSrgbSdrFinalForTest({ preparation: prepared, outputPath: join(root, "first.mp4"), decodedPath: join(root, "first.rgba"), job: job(root) }, services({ source, events: [] }));
    expect(first.ok).toBe(true);
    const second = await executeLinearSrgbSdrFinalForTest({ preparation: prepared, outputPath: join(root, "second.mp4"), decodedPath: join(root, "second.rgba"), job: job(root) }, services({ source, events: [] }));
    expect(second).toMatchObject({ ok: false, code: "linear_srgb_sdr_final_refused" });
  });
});

function motion() {
  return {
    schema: "shellx-motion/motion@1" as const, id: "strict-sdr", name: "strict SDR", durationMs: 1_000, fps: 2, width: 2, height: 2, background: "#101820",
    colorPipeline: { schema: "shellx-motion/color-pipeline@1" as const, intent: "linear-srgb-sdr@1" as const }, assets: [], provenance: { sourceApp: "test", createdBy: "strict-adapter-test" },
    layers: [{ id: "rect", type: "shape" as const, shape: "rect" as const, startMs: 0, durationMs: 1_000, fill: "#ff0040", opacity: 0.4, transform: { x: 0, y: 0, width: 1, height: 1 } }],
  };
}

function route(): LinearSrgbSdrFinalRoute {
  const result = resolveLinearSrgbSdrFinalRoute(motion(), { target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264" });
  if (!result.ok) throw new Error(result.refusal.message);
  return result.route;
}

function preflightRunner(events: string[]): FfmpegRunner {
  return async (command) => {
    if (command.args[0] === "-version") { events.push(command.executable.includes("ffprobe") ? "ffprobe-version" : "ffmpeg-version"); return { exitCode: 0, stdout: `${command.executable} version test\n`, stderr: "" }; }
    events.push("ffmpeg-zscale-preflight"); return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function services(input: { source: Buffer; decoded?: Buffer; events: string[] }) {
  const admittedRoute = route();
  const evidence = producerEvidence(admittedRoute, input.source);
  return {
    createProducer: () => ({ ok: true as const, producer: {
      get evidence() { return evidence; },
      async produce() { input.events.push("gpu-produce"); return frame(admittedRoute, input.source); },
    } }),
    startProcess: processFactory(input),
  };
}

function processFactory(input: { source: Buffer; decoded?: Buffer; events: string[] }): StreamingFfmpegProcessFactory {
  return async ({ command, reportProcessContainment }) => {
    reportProcessContainment({ schema: "shellx-motion/process-containment@1", mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor" });
    const kind = command.executable.includes("ffprobe") ? "probe" : command.args.includes("rawvideo") && command.args.includes("pipe:0") ? "encode" : "inverse";
    input.events.push(`${kind}-start`);
    let ended = false;
    const result = async () => {
      if (ended) return { exitCode: 0, stdout: "", stderr: "" };
      ended = true; input.events.push(`${kind}-end`);
      if (kind === "encode") await writeFile(command.args.at(-1)!, Buffer.from("bounded-private-mp4"), { flag: "wx", mode: 0o600 });
      if (kind === "inverse") await writeFile(command.args.at(-1)!, input.decoded ?? input.source, { flag: "wx", mode: 0o600 });
      return kind === "probe" ? { exitCode: 0, stdout: probeJson(), stderr: "" } : { exitCode: 0, stdout: "", stderr: "" };
    };
    return {
      closed: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      async write(bytes) { expect(kind).toBe("encode"); expect(bytes).toEqual(input.source); input.events.push("encode-write"); return { backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16_384 }; },
      end: result,
      abort: result,
    } satisfies StreamingFfmpegProcess;
  };
}

function frame(current: LinearSrgbSdrFinalRoute, rgba8Srgb: Buffer): LinearSrgbSdrFinalWebGpuFrame {
  return { schema: "shellx-motion/linear-srgb-sdr-final-webgpu-frame@1", routeFingerprint: current.fingerprint, documentFingerprint: current.documentFingerprint, width: 2, height: 2, bytesPerRow: 8, rgba8SrgbSha256: sha256(rgba8Srgb), rgba8Srgb };
}

function producerEvidence(current: LinearSrgbSdrFinalRoute, source: Buffer): LinearSrgbSdrFinalWebGpuProducerEvidence {
  return {
    schema: "shellx-motion/linear-srgb-sdr-final-webgpu-producer@1", routeFingerprint: current.fingerprint, documentFingerprint: current.documentFingerprint,
    pipeline: { schema: "shellx-motion/linear-srgb-sdr-final-webgpu-pipeline@1", implementationSha256: "a".repeat(64), workingTarget: "rgba16float", publicationTarget: "rgba8unorm", publicationUsage: "COPY_SRC", composition: "premultiplied-linear-srgb-normal-source-over", frameBoundary: "straight-srgb-rgba8" },
    runtime: null, readback: { bytesPerRow: 256, paddedByteLength: 512, tightByteLength: 16, mapOperations: 1, mappedBufferUnmapped: true, mappedBufferDestroyed: true }, retainedFrame: { bytes: 16, sha256: sha256(source) }, cleanup: { state: "complete", resourcesReleased: true, pageClosed: true, runtimeClosed: true }, fingerprint: "b".repeat(64),
  };
}

function probeJson(): string { return JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv", width: 2, height: 2, avg_frame_rate: "2/1", nb_frames: "2", duration: "1.000000" }], format: { duration: "1.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" } }); }
function opaqueFrame(): Buffer { return Buffer.from([16, 24, 32, 255, 24, 32, 40, 255, 32, 40, 48, 255, 40, 48, 56, 255]); }
function job(root: string, reportProcessContainment: LinearSrgbSdrFinalJob["reportProcessContainment"] = () => {}): LinearSrgbSdrFinalJob { return { admission: "pre-acquired", signal: new AbortController().signal, scratchRoot: root, maxProcessTreeRssBytes: 128 * 1024 * 1024, watchProcess() {}, reportProcessContainment }; }
async function scratch(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "shellx-motion-linear-sdr-adapter-")); roots.push(root); return root; }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
