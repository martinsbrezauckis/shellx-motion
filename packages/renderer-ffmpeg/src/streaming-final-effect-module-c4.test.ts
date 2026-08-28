import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMotionPackage, LocalMotionJobGovernor } from "@shellx-motion/core";
import { createEffectModuleRegistryAuthority, createEffectModuleRegistryUseAuthority } from "@shellx-motion/renderer-browser/internal/effect-modules";
import { afterEach, describe, expect, it } from "vitest";
import { renderStreamingFinal, type FfmpegProcessResult, type FfmpegRunner, type StreamingFinalToolPolicy } from "./index.js";
import type { StreamingFfmpegProcessFactory } from "./streaming-process.js";

const roots: string[] = [];
// The structural seam is Windows-only because this managed WSL host intentionally
// refuses its /tmp ancestry. It never substitutes for the qualified Linux GPU native runner.
const describeC4 = process.platform === "win32" ? describe : describe.skip;
type GpuOpenRuntime = NonNullable<NonNullable<StreamingFinalToolPolicy["gpu"]>["openRuntime"]>;

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

/** Source-only direct-final lifecycle contract; all runtime and encoder values below are fakes. */
describeC4("direct final effect-module structural contract", () => {
  it("publishes only after the installed opaque lease released and receipt evidence is complete", async () => {
    const fixture = await finalFixture();
    const outputPath = join(fixture.root, "final.mp4");
    const result = await renderStreamingFinal({
      pkg: await loadMotionPackage(fixture.root), frameLane: "gpu", outputPath,
      inputRoots: [fixture.root], outputRoots: [fixture.root], quality: { minDurationMs: 0 },
      toolPolicy: policy(outputPath, finalRuntime(), processFactory(), fixture.authority)
    });
    expect(result).toMatchObject({ ok: true, transport: { effectModules: {
      schema: "shellx-motion/gpu-effect-module-final-use@1", release: "released",
      beginUse: { modules: [expect.objectContaining({ moduleId: "motion.afterimage-stack", rendererAbi: "shellx-motion/gpu-effect-module@1" })] },
      applications: [expect.objectContaining({ release: "released" })]
    } } });
    if (!result.ok) return;
    expect(await readFile(outputPath, "utf8")).toBe("encoded-media");
    expect(result.receipt.inputHashes).toMatchObject({
      "gpu-effect-module-catalog": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-effect-module-begin-use": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-effect-module-applications": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-effect-module-resources": expect.stringMatching(/^[a-f0-9]{64}$/),
      "gpu-effect-module-cleanup": expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    const serialized = JSON.stringify(result.receipt.output);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain("afterimage-manifest.json");
  });

  it("does not open Browser or encoder when a queued final is revoked before admission", async () => {
    const fixture = await finalFixture();
    const governor = oneSlotGovernor();
    let unblock!: () => void;
    let entered!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = governor.run({ lane: "ffmpeg", operation: "c4-blocker", scratchRoot: fixture.root }, async () => {
      entered(); await new Promise<void>((resolve) => { unblock = resolve; });
    });
    await active;
    let browserOpens = 0, encoderStarts = 0;
    const queued = renderStreamingFinal({
      pkg: await loadMotionPackage(fixture.root), frameLane: "gpu", outputPath: join(fixture.root, "revoked.mp4"),
      inputRoots: [fixture.root], outputRoots: [fixture.root], governor, quality: { minDurationMs: 0 },
      toolPolicy: policy(join(fixture.root, "revoked.mp4"), async (...args) => { browserOpens += 1; return await finalRuntime()(...args); }, processFactory(() => { encoderStarts += 1; }), fixture.authority)
    });
    await until(() => governor.snapshot().queuedJobs === 1);
    await fixture.registry.revoke("motion.afterimage-stack", "1.0.0");
    unblock();
    await blocker;
    const result = await queued;
    expect(result).toMatchObject({ ok: false });
    expect(browserOpens).toBe(0);
    expect(encoderStarts).toBe(0);
    await expect(readFile(join(fixture.root, "revoked.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes unpublished output after an encoder failure, after Browser runtime cleanup", async () => {
    const fixture = await finalFixture();
    const outputPath = join(fixture.root, "failed.mp4");
    let runtimeClosed = 0;
    const result = await renderStreamingFinal({
      pkg: await loadMotionPackage(fixture.root), frameLane: "gpu", outputPath,
      inputRoots: [fixture.root], outputRoots: [fixture.root], quality: { minDurationMs: 0 },
      toolPolicy: policy(outputPath, finalRuntime(() => { runtimeClosed += 1; }), processFactory(undefined, true), fixture.authority)
    });
    expect(result).toMatchObject({ ok: false });
    expect(runtimeClosed).toBe(1);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function finalFixture() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-final-effect-c4-")); roots.push(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "c4-effect", name: "C4 effect", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } })}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({ schema: "shellx-motion/motion@1", id: "c4-effect", name: "C4 effect", durationMs: 1_000, fps: 1, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [
    { id: "scope", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["plate", "afterimage"] },
    { id: "plate", type: "shape", shape: "rect", fill: "#4080ffff", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } },
    { id: "afterimage", type: "adjustment", startMs: 0, durationMs: 1_000, effectModule: { schema: "shellx-motion/effect-module-ref@1", moduleId: "motion.afterimage-stack", version: "1.0.0", parameters: { amountQ16: 32768, echoes: [{ dxPx: -2, dyPx: 3, color: "#FF80C0C0", opacityQ16: 48000 }] } } }
  ] })}\n`);
  const stateRoot = join(root, "effect-modules"), manifestPath = join(root, "afterimage-manifest.json");
  await mkdir(stateRoot, { mode: 0o700 });
  await writeFile(manifestPath, `${JSON.stringify({ schema: "shellx-motion/effect-module-manifest@1", moduleId: "motion.afterimage-stack", version: "1.0.0", displayName: "Afterimage Stack", intrinsic: "motion.afterimage-stack.v1", rendererAbi: "shellx-motion/gpu-effect-module@1", parameterSchema: "motion.afterimage-stack.parameters@1" })}\n`);
  const registry = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: async (path) => {
    const bytes = await readFile(path); return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } });
  const pending = await registry.prepareInstallFromManifestFile(manifestPath); await registry.confirmInstall(pending.confirmationId);
  return { root, registry, authority: createEffectModuleRegistryUseAuthority(registry) };
}

function policy(outputPath: string, openRuntime: GpuOpenRuntime, factory: StreamingFfmpegProcessFactory, effectModuleUseAuthority: NonNullable<StreamingFinalToolPolicy["gpu"]>["effectModuleUseAuthority"]): StreamingFinalToolPolicy {
  return { forceSoftwareEncode: true, runner: ffprobe(), processFactory: factory, gpu: { openRuntime, effectModuleUseAuthority } };
}

function ffprobe(): FfmpegRunner {
  return async (command) => command.args.includes("-show_streams")
    ? { exitCode: 0, stdout: JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 16, height: 16, avg_frame_rate: "1/1", duration: "1", pix_fmt: "yuv420p", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", color_range: "tv" }], format: { duration: "1", format_name: "mov,mp4,m4a,3gp,3g2,mj2" } }), stderr: "" }
    : { exitCode: 0, stdout: "", stderr: "" };
}

function processFactory(onStart?: () => void, failWrite = false): StreamingFfmpegProcessFactory {
  return async (input) => {
    onStart?.();
    input.reportProcessContainment({ schema: "shellx-motion/process-containment@1", mode: process.platform === "win32" ? "windows-job-object" : "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor" });
    let resolve!: (result: FfmpegProcessResult) => void;
    const closed = new Promise<FfmpegProcessResult>((done) => { resolve = done; });
    const done = (result: FfmpegProcessResult) => { resolve(result); return result; };
    return {
      closed,
      write: async () => {
        if (failWrite) throw new Error("controlled encoder input failure");
        return { backpressured: false, bufferedInputBytes: 0, inputHighWaterMarkBytes: 16 * 1024 };
      },
      end: async () => { await writeFile(input.command.args.at(-1)!, "encoded-media"); return done({ exitCode: 0, stdout: "", stderr: "" }); },
      abort: async () => done({ exitCode: 1, stdout: "", stderr: "aborted" })
    };
  };
}

function finalRuntime(onClose?: () => void): GpuOpenRuntime {
  return async (_images, _fonts, options) => {
    let applications = 0, closed = false;
    return { ok: true as const, session: {
      browserProcess: { pid: 8_004, launcher: "precontained-direct-chromium" as const, containment: { rootPid: 8_004, mode: "unix-process-group" as const, status: "enforced" as const, killTree: true, memoryLimit: "rss-monitor" as const, maxProcessTreeRssBytes: options.finalBrowser.maxProcessTreeRssBytes } },
      async uploadImages(images: readonly unknown[]) { return { ok: true as const, uploaded: images.length }; },
      async render(plan: { width: number; height: number; draws: readonly { kind: string }[] }) { if (plan.draws.some((draw) => draw.kind === "effectModule")) applications += 1; const rgba = Buffer.alloc(plan.width * plan.height * 4, 255); return { ok: true as const, frame: { rgba, sha256: createHash("sha256").update(rgba).digest("hex"), width: plan.width, height: plan.height, evidence: runtimeEvidence(), readback: readback(plan.width, plan.height) } }; },
      async resourceMetrics() { return resources(applications, closed); },
      async close() { closed = true; onClose?.(); }
    } };
  };
}

function runtimeEvidence() { return { schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "test", webgpuFeatureStatus: "enabled", adapterFingerprint: "0".repeat(64), adapter: { cdpVendorId: 1, cdpDeviceId: 1, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null }, limits: { maxTextureDimension2D: 4096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 } } as const; }
function readback(width: number, height: number) { const row = Math.ceil((width * 4) / 256) * 256, bytes = row * height; return { schema: "shellx-motion/gpu-readback-frame@1", width, height, tightBytesPerRow: width * 4, mappedBytesPerRow: row, gpuTextureToMappedReadbackBytes: bytes, cdpBase64PayloadBytes: Math.ceil(bytes / 3) * 4, hostBase64DecodedBytes: bytes, allocations: { hostBase64Decode: 1, rowCompaction: row === width * 4 ? 0 : 1, straightAlpha: 0 }, copiedBytes: { rowCompaction: row === width * 4 ? 0 : width * height * 4, straightAlpha: 0 }, rowCompaction: row === width * 4 ? "bypassed-tight-stride" : "copied-padded-rows", straightAlpha: "in-place-owned-buffer", hostFrameElapsedNanoseconds: 0, hostClock: "node-process-hrtime", hostTimingScope: "admitted-frame-render-and-readback" } as const; }
function resources(applications: number, closed: boolean) { return { schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 1, frameArenaReconfigurations: 1, frameTextureSlots: 1, frameTextureBytes: 4, depthTextureBytes: 0, readbackBytes: 4, frameArenaBytes: 8, frameTextureHighWaterSlots: 1, frameTextureHighWaterBytes: 4, frameArenaHighWaterBytes: 8, frameArenaReservations: 1, frameArenaLateAllocationRefusals: 0, dynamicBufferSlots: 1, dynamicBufferBytes: 4, dynamicBufferHighWaterSlots: 1, dynamicBufferHighWaterBytes: 4, environmentUniformCapacitySlots: 0, environmentUniformBytes: 0, environmentUniformHighWaterSlots: 0, environmentUniformHighWaterBytes: 0, environmentUniformLateAllocationRefusals: 0, environmentDrawsRendered: 0, environmentEnvelopeReservations: 0, immutableImageTextures: 0, retainedTextSurfaces: 0, pointRaster: "gpu-native-instanced", pointPositionEvaluation: "core-cpu-exact-time", pointComputeField: "not-used", immutablePointBufferSlots: 0, immutablePointBufferBytes: 0, immutablePointMirrorBytes: 0, immutablePointBufferHighWaterSlots: 0, immutablePointBufferHighWaterBytes: 0, adapterPointInstanceLimit: 0, computeParticleBufferSlots: 0, computeParticleBufferBytes: 0, computeParticleBufferHighWaterSlots: 0, computeParticleBufferHighWaterBytes: 0, adapterComputeParticleInstanceLimit: 0, computeParticleDispatches: 0, computeParticleAbi: "not-used", computeParticleInstanceBytes: 0, computeParticleRetainedBufferCount: 0, computeParticleUniformBytes: 0, computeParticleRasterCalls: 0, computeParticleHeadRasterCalls: 0, computeParticleTrailRasterCalls: 0, computeParticleCapacityReconfigurations: 0, computeParticleLateAllocationRefusals: 0, ...(closed ? { afterimageStackUniformBufferSlots: 0, afterimageStackUniformBytes: 0, afterimageStackBindGroupSlots: 0, afterimageStackPasses: applications, afterimageStackFrames: applications, afterimageStackLateAllocationRefusals: 0, afterimageStackPersistentTextureCount: 0, afterimageStackPipelineReleases: 1, afterimageStackPreparedBindGroupReleases: 1, afterimageStackArenaUniformBufferDestructions: 1 } : { afterimageStackUniformBufferSlots: 1, afterimageStackUniformBytes: 160, afterimageStackBindGroupSlots: 1, afterimageStackPasses: applications, afterimageStackFrames: applications, afterimageStackLateAllocationRefusals: 0, afterimageStackPersistentTextureCount: 0 }) } as never; }

function oneSlotGovernor(): LocalMotionJobGovernor {
  return new LocalMotionJobGovernor({ maxConcurrentJobs: 1, maxQueueDepth: 2, maxQueueWaitMs: 5_000, maxWallClockMs: 10_000, minFreeScratchBytes: 0, scratchReservationBytes: 0, maxProcessTreeRssBytes: 512 * 1024 * 1024, rssPollIntervalMs: 1_000 }, { leases: null, freeScratchBytes: async () => Number.MAX_SAFE_INTEGER });
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Timed out waiting for queued admission.");
}
