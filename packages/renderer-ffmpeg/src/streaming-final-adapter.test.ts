import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMotionPackage, type MotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  planStreamingFinalCommand,
  renderStreamingFinal,
  type FfmpegCommand,
  type FfmpegProcessResult,
  type FfmpegRunner,
  type StreamingFinalToolPolicy
} from "./index";
import type { StreamingFfmpegProcessFactory } from "./streaming-process";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("renderStreamingFinal", () => {
  it("renders a loaded native package through one admitted stream and writes a Core receipt frameTransport block", async () => {
    const root = await motionPackage("native-stream", visibleLayers());
    const outputPath = join(root, "out.mp4");
    const pkg = await loadMotionPackage(root);
    const planned = planStreamingFinalCommand({
      fps: pkg.motion.fps,
      width: pkg.motion.width,
      height: pkg.motion.height,
      durationMs: pkg.motion.durationMs,
      outputPath,
      inputRoots: [root],
      outputRoots: [root]
    });
    const result = await renderStreamingFinal({
      pkg,
      frameLane: "native",
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      quality: { minDurationMs: 0 },
      toolPolicy: toolPolicy(outputPath)
    });

    expect(result).toMatchObject({ ok: true, command: { shell: false }, transport: {
      delivery: "streamed", frameLane: "native", frameCount: 1, retainedFrameCount: 0,
      encoderHandoff: { encoderHandoffSourceFramesRetained: 0, attempts: [{ outcome: "succeeded" }] },
      producer: { frameLane: "native", evidence: { producer: { emittedFrameCount: 1 }, session: { cleanupState: "closed" } } }
    } });
    if (!result.ok) return;
    expect(planned).toMatchObject({ ok: true, transport: { delivery: "streamed" } });
    if (planned.ok) expect(result.command).toEqual(planned.command);
    const output = result.receipt.output as { frameTransport: { producer: { evidence: { terminal: { lastFrameReceipt: Record<string, unknown> } } } } };
    expect(result.receipt).toMatchObject({ schema: "shellx-motion/receipt@1", operation: "render.final", lane: "ffmpeg" });
    expect(result.receipt.output).toMatchObject({ path: outputPath });
    expect(output.frameTransport).toMatchObject({ delivery: "streamed", retainedFrameCount: 0 });
    expect(output.frameTransport.producer.evidence.terminal.lastFrameReceipt).not.toHaveProperty("output");
  });

  it("renders a browser lane with bounded, path-sanitized transport evidence", async () => {
    const root = await motionPackage("browser-stream", visibleLayers());
    const outputPath = join(root, "out.mp4");
    const result = await renderStreamingFinal({
      pkg: await loadMotionPackage(root),
      frameLane: "browser",
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      quality: { minDurationMs: 0 },
      toolPolicy: toolPolicy(outputPath)
    });

    expect(result).toMatchObject({ ok: true, transport: {
      delivery: "streamed", frameLane: "browser", frameCount: 1, retainedFrameCount: 0,
      producer: { frameLane: "browser", evidence: {
        session: { state: "closed", cleanup: "complete" },
        processMonitoring: { measurement: "conservative-fallback-not-exact-per-job", encoderContainmentCoversChromium: false },
        terminalFrame: { index: 0, atMs: 0 }
      } }
    } });
    if (!result.ok || result.transport.producer.frameLane !== "browser") return;
    expect(result.receipt.output).toMatchObject({ scriptExecution: { detectedClass: "data-only", activeMode: "data-only" } });
    expect(result.transport.producer.evidence.scriptExecution).toMatchObject({ activeMode: "data-only" });
    expect(result.transport.producer.evidence.terminalFrame?.output).not.toHaveProperty("path");
    expect(result.transport.producer.evidence.terminalFrame?.receipt).not.toHaveProperty("output");
  }, 45_000);

  it("renders a strict mixed shape and points GPU final through raw RGBA with bounded producer evidence", async () => {
    const root = await motionPackage("gpu-stream", [
      { id: "plate", type: "shape", shape: "rect", fill: "#204060", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 16, height: 16 } },
      { id: "orb", type: "shape", shape: "ellipse", fill: "#ff8040", startMs: 0, durationMs: 1_000, transform: { x: 4, y: 2, width: 8, height: 12 } },
      {
        id: "points", type: "points", startMs: 0, durationMs: 1_000, color: "#ffffff",
        pointCloud: { points: [{ x: 4, y: 4, size: 4 }, { x: 12, y: 12, size: 4, color: "#00ffff" }] }
      }
    ]);
    const outputPath = join(root, "gpu.mp4");
    const policy = toolPolicy(outputPath);
    policy.gpu = { openRuntime: fakeGpuOpenRuntime() };
    const result = await renderStreamingFinal({
      pkg: await loadMotionPackage(root), frameLane: "gpu", outputPath,
      inputRoots: [root], outputRoots: [root], quality: { minDurationMs: 0 }, toolPolicy: policy
    });

    expect(result).toMatchObject({ ok: true, command: { args: expect.arrayContaining([
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "16x16", "-framerate", "1", "-i", "pipe:0"
    ]) }, transport: {
      delivery: "streamed", frameLane: "gpu", retainedFrameCount: 0,
      encoderHandoff: { frameFormat: "rgba", maxRgbaBytesPerFrame: 1024 },
      producer: { frameLane: "gpu", evidence: {
        schema: "shellx-motion/gpu-streaming-producer@1",
        gpu: { adapterFingerprint: "0".repeat(64) },
        sessionResources: { schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 1 },
        processMonitoring: { encoderContainmentCoversChromium: true },
        session: { state: "closed", cleanup: "complete" }
      } }
    } });
    if (!result.ok) return;
    expect(result.receipt.output).toMatchObject({ frameTransport: { frameLane: "gpu", producer: { evidence: {
      provenance: {
        pipelineCatalog: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        staticPlan: { schema: "shellx-motion/gpu-scene-static-plan@1", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), geometryReuse: "not-claimed" },
        staticScene: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        resourceBudget: { expectedFrames: 1, observedFrames: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
      }
    } } } });
    expect(result.receipt.inputHashes).toMatchObject({
      "gpu-pipeline-catalog": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-static-plan": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-static-plan-document": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-static-plan-resources": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-static-scene": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-static-inputs": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-resource-budget": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-adapter": "0".repeat(64),
      "gpu-runtime": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-session-resources": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-readback-transport": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-containment": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-frame-sequence": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-frame-plan-sequence": expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(result.transport).not.toHaveProperty("effectModules");
    expect(result.receipt.inputHashes).not.toHaveProperty("gpu-effect-module-catalog");
  });

  it("stages explicit audio from a visually hidden grouped GPU video before final PCM handoff", async () => {
    const root = await motionPackage("gpu-hidden-group-video-audio", [
      { id: "hidden-scene", type: "group", visible: false, startMs: 0, durationMs: 1_000, childLayerIds: ["clip"] },
      {
        id: "clip", type: "video", assetId: "clip_asset", includeAudio: true,
        startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 16, height: 16 }
      }
    ]);
    const assets = join(root, "assets");
    await mkdir(assets, { mode: 0o700 });
    const videoPath = join(assets, "clip.mp4");
    await writeFile(videoPath, "immutable-video-with-audio", { mode: 0o600 });
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.assets = ["assets/clip.mp4"];
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const motionPath = join(root, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.assets = [{ id: "clip_asset", source: { path: "assets/clip.mp4", mimeType: "video/mp4" } }];
    await writeFile(motionPath, `${JSON.stringify(motion)}\n`);
    const outputPath = join(root, "gpu-video.mp4");
    const runnerCommands: FfmpegCommand[] = [];
    const processCommands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      runnerCommands.push(command);
      if (command.executable === "ffprobe" && command.args.includes("stream=width,height")) {
        return { exitCode: 0, stdout: JSON.stringify({ streams: [{ width: 16, height: 16 }] }), stderr: "" };
      }
      const target = command.args.at(-1) ?? "";
      if (command.executable === "ffmpeg" && target.endsWith(".wav")) {
        await writeFile(target, Buffer.from("RIFF-immutable-pcm-wave"), { mode: 0o600 });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.executable === "ffprobe" && command.args.includes("-show_streams")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              { codec_type: "video", codec_name: "h264", width: 16, height: 16, avg_frame_rate: "1/1", duration: "1", pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" },
              { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, channel_layout: "stereo", duration: "1" }
            ],
            format: { duration: "1", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await renderStreamingFinal({
      pkg: await loadMotionPackage(root), frameLane: "gpu", outputPath,
      audio: { path: videoPath, layerId: "clip", durationMs: 1_000 },
      inputRoots: [root], outputRoots: [root], quality: { minDurationMs: 0 },
      toolPolicy: { forceSoftwareEncode: true, runner, processFactory: processFactory(outputPath, { commands: processCommands }), gpu: { openRuntime: fakeGpuOpenRuntime(), testVideoStaging: { runner, media: [{ assetRef: "assets/clip.mp4", width: 16, height: 16 }] } } }
    });

    expect(result).toMatchObject({ ok: true, transport: { producer: { frameLane: "gpu", evidence: {
      video: null,
      videoStaging: { ledger: { plannedRgbaBytes: 0, plannedPcmBytes: expect.any(Number) } }
    } } } });
    expect(runnerCommands.filter((command) => command.executable === "ffmpeg")).toHaveLength(1);
    expect(runnerCommands.some((command) => command.args.at(-1)?.endsWith(".rgba"))).toBe(false);
    const encode = processCommands.at(-1)!;
    expect(encode.args).toEqual(expect.arrayContaining(["-protocol_whitelist", "file", "-format_whitelist", "wav"]));
    expect(encode.args.some((arg) => arg.endsWith(".wav"))).toBe(true);
    expect(encode.args).not.toContain(videoPath);
    if (result.ok) expect(result.receipt.output).toMatchObject({ audio: { path: videoPath } });
  });

  it("refuses a hidden grouped includeAudio source before the encoder factory can start or publish", async () => {
    const root = await motionPackage("gpu-hidden-group-invalid-probe", [
      { id: "hidden-scene", type: "group", visible: false, startMs: 0, durationMs: 1_000, childLayerIds: ["clip"] },
      {
        id: "clip", type: "video", assetId: "clip_asset", includeAudio: true,
        startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 16, height: 16 }
      }
    ]);
    await mkdir(join(root, "assets"), { mode: 0o700 });
    const videoPath = join(root, "assets", "clip.mp4");
    await writeFile(videoPath, "immutable-video", { mode: 0o600 });
    const manifestPath = join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.assets = ["assets/clip.mp4"];
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const motionPath = join(root, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.assets = [{ id: "clip_asset", source: { path: "assets/clip.mp4", mimeType: "video/mp4" } }];
    await writeFile(motionPath, `${JSON.stringify(motion)}\n`);
    const outputPath = join(root, "gpu-invalid-probe.mp4");
    let processStarts = 0;
    const invalidProbe: FfmpegRunner = async (command) => command.executable === "ffprobe"
      ? { exitCode: 0, stdout: "not JSON", stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };
    const result = await renderStreamingFinal({
      pkg: await loadMotionPackage(root), frameLane: "gpu", outputPath,
      audio: { path: videoPath, layerId: "clip", durationMs: 1_000 },
      inputRoots: [root], outputRoots: [root],
      toolPolicy: {
        forceSoftwareEncode: true,
        runner: invalidProbe,
        processFactory: processFactory(outputPath, { processStarts: () => { processStarts += 1; } }),
        gpu: { openRuntime: fakeGpuOpenRuntime(), testVideoStaging: { runner: invalidProbe } }
      }
    });

    expect(result).toMatchObject({ ok: false, error: { code: "gpu_video_resource_refused", message: expect.stringContaining("invalid JSON") } });
    expect(processStarts).toBe(0);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses later text without a manifest font before opening FFmpeg or hardware", async () => {
    const root = await motionPackage("gpu-refusal", [{
      id: "later-text", type: "text", text: "not admitted yet", startMs: 500, durationMs: 500,
      transform: { x: 0, y: 0, width: 16, height: 16 }
    }]);
    let processStarts = 0;
    let gpuOpens = 0;
    const outputPath = join(root, "gpu.mp4");
    const policy = toolPolicy(outputPath, { processStarts: () => { processStarts += 1; } });
    policy.gpu = { openRuntime: async () => { gpuOpens += 1; return fakeGpuOpenRuntimeResult(); } };
    const result = await renderStreamingFinal({
      pkg: await loadMotionPackage(root), frameLane: "gpu", outputPath,
      inputRoots: [root], outputRoots: [root], toolPolicy: policy
    });
    expect(result).toMatchObject({ ok: false, error: { code: "gpu_unsupported_feature", layerId: "later-text" } });
    expect(processStarts).toBe(0);
    expect(gpuOpens).toBe(0);
  });

  it("refuses undeclared static-plan assets before resource staging, FFmpeg, or Chromium launch", async () => {
    const root = process.cwd();
    const pkg: MotionPackage = {
      root,
      manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_static_resource_refusal", name: "GPU static resource refusal", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: {
        schema: "shellx-motion/motion@1", id: "motion_gpu_static_resource_refusal", name: "GPU static resource refusal", durationMs: 1_000, fps: 1, width: 16, height: 16,
        assets: [], provenance: { sourceApp: "test", createdBy: "test" },
        layers: [{ id: "outside", type: "image", assetRef: "/not-package/plate.png", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } }]
      }
    };
    const outputPath = join(root, "gpu.mp4"); let processStarts = 0; let gpuOpens = 0;
    const policy = toolPolicy(outputPath, { processStarts: () => { processStarts += 1; } });
    policy.gpu = { openRuntime: async () => { gpuOpens += 1; return fakeGpuOpenRuntimeResult(); } };
    const result = await renderStreamingFinal({ pkg, frameLane: "gpu", outputPath, inputRoots: [root], outputRoots: [root], toolPolicy: policy });
    expect(result).toMatchObject({ ok: false, error: { code: "gpu_static_plan_resource_refused", message: expect.stringContaining("declared safe package-relative") } });
    expect(processStarts).toBe(0); expect(gpuOpens).toBe(0);
  });

  it("preflights native capability and delivery text refusals before starting any FFmpeg process", async () => {
    const unsupportedRoot = await motionPackage("native-unsupported", [{
      id: "web", type: "web", source: "card.html", startMs: 0, durationMs: 1_000
    }]);
    const textRoot = await motionPackage("native-text", [{
      id: "title", type: "text", text: "Sveiks", startMs: 0, durationMs: 1_000,
      transform: { x: 0, y: 0 }, style: { color: "#ffffff", fontSize: 12 }
    }]);
    let processStarts = 0;
    let runnerCalls = 0;
    const countStarts = () => { processStarts += 1; };
    const countRunner = () => { runnerCalls += 1; };
    const policy = toolPolicy(join(unsupportedRoot, "out.mp4"), { processStarts: countStarts, runnerCalls: countRunner });
    const unsupported = await renderStreamingFinal({
      pkg: await loadMotionPackage(unsupportedRoot), frameLane: "native", outputPath: join(unsupportedRoot, "out.mp4"),
      inputRoots: [unsupportedRoot], outputRoots: [unsupportedRoot], toolPolicy: policy
    });
    const text = await renderStreamingFinal({
      pkg: await loadMotionPackage(textRoot), frameLane: "native", outputPath: join(textRoot, "out.mp4"),
      inputRoots: [textRoot], outputRoots: [textRoot], toolPolicy: toolPolicy(join(textRoot, "out.mp4"), { processStarts: countStarts, runnerCalls: countRunner })
    });

    expect(unsupported).toMatchObject({ ok: false, error: { code: "unsupported_layer", message: expect.stringContaining("Native renderer cannot render") } });
    expect(text).toMatchObject({ ok: false, error: { code: "native_text_not_deliverable", message: expect.stringContaining("Native lane cannot deliver") } });
    expect(processStarts).toBe(0);
    expect(runnerCalls).toBe(0);
  });

  it("refuses an unverified browser HTML fallback attestation before Chromium or FFmpeg work begins", async () => {
    const root = await htmlTypographyPackage();
    const outputPath = join(root, "out.mp4");
    let processStarts = 0;
    let runnerCalls = 0;

    const result = await renderStreamingFinal({
      pkg: await loadMotionPackage(root),
      frameLane: "browser",
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      toolPolicy: toolPolicy(outputPath, {
        processStarts: () => { processStarts += 1; },
        runnerCalls: () => { runnerCalls += 1; }
      })
    });

    expect(result).toMatchObject({
      ok: false,
      transport: { delivery: "streamed" },
      error: {
        code: "browser_html_typography_unverified",
        detail: { attestation: "font-fallback", scope: "html-web-canvas", layerIds: ["interactive"] }
      }
    });
    expect(processStarts).toBe(0);
    expect(runnerCalls).toBe(0);
  });

  it("keeps observed streamed-attempt evidence when an encoder fails and never materializes a fallback", async () => {
    const root = await motionPackage("native-failure", visibleLayers());
    const outputPath = join(root, "out.mp4");
    const result = await renderStreamingFinal({
      pkg: await loadMotionPackage(root), frameLane: "native", outputPath, inputRoots: [root], outputRoots: [root],
      quality: { minDurationMs: 0 }, toolPolicy: toolPolicy(outputPath, { exitCode: 1 })
    });

    expect(result).toMatchObject({ ok: false, transport: { delivery: "streamed" }, error: {
      code: "encoder_failed",
      handoff: { attempts: [{ source: "software", outcome: "failed", failure: { code: "encoder_failed" } }] },
      resources: { processContainment: { status: "enforced" } },
      producer: { frameLane: "native", evidence: { producer: { emittedFrameCount: 1 }, session: { cleanupState: "closed" } } }
    } });
  });

  it("removes failed-stage output evidence instead of remapping a deleted stream stage to the public destination", async () => {
    const root = await motionPackage("native-stage-validation-failure", visibleLayers());
    const outputPath = join(root, "out.mp4");
    const result = await renderStreamingFinal({
      pkg: await loadMotionPackage(root),
      frameLane: "native",
      outputPath,
      inputRoots: [root],
      outputRoots: [root],
      quality: { minDurationMs: 0 },
      toolPolicy: toolPolicy(outputPath, { probeWidth: 3 })
    });

    expect(result).toMatchObject({ ok: false, error: { code: "output_validation_failed" } });
    if (result.ok) throw new Error("fixture must fail final output validation");
    expect(result.error.partialOutput).toBeUndefined();
    expect(result.error.message).toContain("dimensions");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(outputPath);
    expect(serialized).not.toContain(".shellx-motion-stage");
    expect(serialized).not.toContain(createHash("sha256").update("encoded-media", "utf8").digest("hex"));
    expect(serialized).not.toContain("rendered_media");
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function toolPolicy(outputPath: string, options: {
  exitCode?: number;
  probeWidth?: number;
  processStarts?: () => void;
  runnerCalls?: () => void;
} = {}): StreamingFinalToolPolicy {
  return {
    forceSoftwareEncode: true,
    runner: ffprobeRunner(options),
    processFactory: processFactory(outputPath, options)
  };
}

function ffprobeRunner(options: { probeWidth?: number; runnerCalls?: () => void } = {}): FfmpegRunner {
  return async (command) => {
    options.runnerCalls?.();
    return command.args.includes("-show_streams")
    ? {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", codec_name: "h264", width: options.probeWidth ?? 16, height: 16, avg_frame_rate: "1/1", duration: "1", pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }],
          format: { duration: "1", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
        }),
        stderr: ""
      }
      : { exitCode: 0, stdout: "", stderr: "" };
  };
}

function processFactory(outputPath: string, options: { exitCode?: number; processStarts?: () => void; commands?: FfmpegCommand[] }): StreamingFfmpegProcessFactory {
  return async (input) => {
    options.processStarts?.();
    options.commands?.push(input.command);
    input.reportProcessContainment({ schema: "shellx-motion/process-containment@1", mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor" });
    let settled: FfmpegProcessResult | undefined;
    let resolveClosed!: (result: FfmpegProcessResult) => void;
    const closed = new Promise<FfmpegProcessResult>((resolve) => { resolveClosed = resolve; });
    const settle = (result: FfmpegProcessResult) => {
      if (!settled) {
        settled = result;
        resolveClosed(result);
      }
      return settled;
    };
    return {
      closed,
      write: async () => ({ backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16 * 1024 }),
      end: async () => {
        const exitCode = options.exitCode ?? 0;
        const stagedOutputPath = input.command.args.at(-1) ?? outputPath;
        if (exitCode === 0) await writeFile(stagedOutputPath, "encoded-media");
        return settle({ exitCode, stdout: "", stderr: exitCode === 0 ? "" : "encoder failed" });
      },
      abort: async () => settle({ exitCode: 1, stdout: "", stderr: "aborted" })
    };
  };
}

async function motionPackage(id: string, layers: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-streaming-adapter-"));
  tempDirs.push(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1", id: `pkg_${id}`, name: id, motion: "motion.json", assets: [],
    sourceApp: "shellx-motion", compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] }
  })}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1", id: `motion_${id}`, name: id, durationMs: 1_000, fps: 1, width: 16, height: 16,
    background: "#061a2c", layers, assets: [], provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  })}\n`);
  return root;
}

async function htmlTypographyPackage(): Promise<string> {
  const root = await motionPackage("html-typography", [{
    id: "interactive", type: "web", source: "card.html", startMs: 0, durationMs: 1_000
  }]);
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.quality = { maxFontFallbacks: 0 };
  manifest.assets = ["card.html"];
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await writeFile(join(root, "card.html"), "<main>Dynamic canvas or host text</main>");
  return root;
}

function visibleLayers(): unknown[] {
  return [
    { id: "background", type: "shape", shape: "rect", fill: "#061a2c", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 16, height: 16 } },
    { id: "card", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 2, y: 2, width: 12, height: 12 } }
  ];
}

type GpuOpenRuntime = NonNullable<NonNullable<StreamingFinalToolPolicy["gpu"]>["openRuntime"]>;

function fakeGpuOpenRuntime(): GpuOpenRuntime {
  return async (_images, _fonts, options) => fakeGpuOpenRuntimeResult(options.finalBrowser.maxProcessTreeRssBytes);
}



function fakeGpuOpenRuntimeResult(maxProcessTreeRssBytes: number = 512 * 1024 * 1024): Awaited<ReturnType<GpuOpenRuntime>> {
  let framesRendered = 0;
  return {
    ok: true,
    session: {
      browserProcess: {
        pid: 4_242,
        launcher: "precontained-direct-chromium",
        containment: {
          rootPid: 4_242,
          mode: "unix-process-group",
          status: "enforced",
          killTree: true,
          memoryLimit: "rss-monitor",
          maxProcessTreeRssBytes
        }
      },
      async uploadImages(images) { return { ok: true, uploaded: images.length }; },
      async resourceMetrics() { return fakeGpuSessionResources(framesRendered); },
      async render(plan) {
        const frame = plan as { width: number; height: number };
        const rgba = Buffer.alloc(frame.width * frame.height * 4, 255);
        const mappedBytesPerRow = Math.ceil((frame.width * 4) / 256) * 256;
        const mappedBytes = mappedBytesPerRow * frame.height;
        for (let offset = 0; offset < rgba.byteLength / 2; offset += 4) rgba.fill(0, offset, offset + 3);
        framesRendered += 1;
        return { ok: true, frame: {
          rgba, sha256: createHash("sha256").update(rgba).digest("hex"), width: frame.width, height: frame.height,
          evidence: {
            schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "test",
            webgpuFeatureStatus: "enabled", adapterFingerprint: "0".repeat(64),
            adapter: { cdpVendorId: 1, cdpDeviceId: 2, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null },
            limits: { maxTextureDimension2D: 4096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 }
          },
          readback: {
            schema: "shellx-motion/gpu-readback-frame@1", width: frame.width, height: frame.height,
            tightBytesPerRow: frame.width * 4, mappedBytesPerRow,
            gpuTextureToMappedReadbackBytes: mappedBytes, cdpBase64PayloadBytes: Math.ceil(mappedBytes / 3) * 4, hostBase64DecodedBytes: mappedBytes,
            allocations: { hostBase64Decode: 1, rowCompaction: mappedBytesPerRow === frame.width * 4 ? 0 : 1, straightAlpha: 0 },
            copiedBytes: { rowCompaction: mappedBytesPerRow === frame.width * 4 ? 0 : frame.width * frame.height * 4, straightAlpha: 0 },
            rowCompaction: mappedBytesPerRow === frame.width * 4 ? "bypassed-tight-stride" : "copied-padded-rows",
            straightAlpha: "in-place-owned-buffer", hostFrameElapsedNanoseconds: 0,
            hostClock: "node-process-hrtime", hostTimingScope: "admitted-frame-render-and-readback"
          }
        } };
      },
      async close() {}
    }
  };
}

function fakeGpuSessionResources(framesRendered: number) {
  return {
    schema: "shellx-motion/gpu-page-session-resources@1" as const,
    framesRendered,
    frameArenaReconfigurations: 1,
    frameTextureSlots: 1,
    frameTextureBytes: 4,
    depthTextureBytes: 0,
    readbackBytes: 4,
    frameArenaBytes: 8,
    frameTextureHighWaterSlots: 1,
    frameTextureHighWaterBytes: 4,
    frameArenaHighWaterBytes: 8,
    frameArenaReservations: framesRendered,
    frameArenaLateAllocationRefusals: 0,
    dynamicBufferSlots: 1,
    dynamicBufferBytes: 4,
    dynamicBufferHighWaterSlots: 1,
    dynamicBufferHighWaterBytes: 4,
    environmentUniformCapacitySlots: 0,
    environmentUniformBytes: 0,
    environmentUniformHighWaterSlots: 0,
    environmentUniformHighWaterBytes: 0,
    environmentUniformLateAllocationRefusals: 0,
    environmentDrawsRendered: 0,
    environmentEnvelopeReservations: 0,
    immutableImageTextures: 0,
    retainedTextSurfaces: 0,
    pointRaster: "gpu-native-instanced" as const,
    pointPositionEvaluation: "core-cpu-exact-time" as const,
    pointComputeField: "not-used" as const,
    immutablePointBufferSlots: 0,
    immutablePointBufferBytes: 0,
    immutablePointMirrorBytes: 0,
    immutablePointBufferHighWaterSlots: 0,
    immutablePointBufferHighWaterBytes: 0,
    adapterPointInstanceLimit: 0,
    computeParticleBufferSlots: 0,
    computeParticleBufferBytes: 0,
    computeParticleBufferHighWaterSlots: 0,
    computeParticleBufferHighWaterBytes: 0,
    adapterComputeParticleInstanceLimit: 0,
    computeParticleDispatches: 0,
    computeParticleAbi: "not-used" as const,
    computeParticleInstanceBytes: 0,
    computeParticleRetainedBufferCount: 0,
    computeParticleUniformBytes: 0,
    computeParticleRasterCalls: 0,
    computeParticleHeadRasterCalls: 0,
    computeParticleTrailRasterCalls: 0,
    computeParticleCapacityReconfigurations: 0,
    computeParticleLateAllocationRefusals: 0
  };
}
