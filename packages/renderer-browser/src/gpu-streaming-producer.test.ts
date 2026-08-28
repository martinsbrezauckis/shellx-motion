import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentScriptExecutionEvidenceForDataOnly, canonicalJson, canonicalJsonSha256, compileGpuSceneStaticPlan, encodeRgbaPng, loadMotionPackage, scene3dMeshGeometrySha256, type MotionPackage } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  createGpuStreamingFrameProducer as createGpuStreamingFrameProducerImpl,
  GpuStreamingProducerContainmentError,
  GpuStreamingProducerRuntimeError,
  type GpuStreamingFrameSink
} from "./gpu-streaming-producer";
import { DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS } from "./gpu-frame-renderer";
import type { GpuStreamingFrameProducerInput } from "./gpu-streaming-producer-types";
import type { GpuHybridCaptureBinding } from "./gpu-browser-hybrid";
import { containedGpuJob, fakeGpuRuntime, fakeGpuSessionResources } from "./gpu-streaming-producer.test-support";

const fixtureRoot = fileURLToPath(new URL("../../../fixtures/packages/gpu-points-preview", import.meta.url));

function staticPlanFor(pkg: MotionPackage) {
  const staticPlan = compileGpuSceneStaticPlan(pkg.motion); if (!staticPlan.ok) throw new Error(staticPlan.failure.message);
  return staticPlan.plan;
}

function createGpuStreamingFrameProducer(input: Omit<GpuStreamingFrameProducerInput, "staticPlan">) {
  return createGpuStreamingFrameProducerImpl({ ...input, staticPlan: staticPlanFor(input.pkg) });
}

describe("GPU streamed frame producer", () => {
  it("passes the bounded first-frame default to every strict GPU final frame", async () => {
    const pkg = resourceMetricsPackage();
    const staticPlan = staticPlanFor(pkg);
    const observedTimeouts: Array<number | undefined> = [];
    const producer = createGpuStreamingFrameProducerImpl({
      pkg,
      staticPlan,
      openRuntime: async () => {
        const opened = fakeGpuRuntime(() => {});
        if (!opened.ok) return opened;
        const render = opened.session.render.bind(opened.session);
        opened.session.render = async (plan, options) => {
          observedTimeouts.push(options?.timeoutMs);
          return await render(plan, options);
        };
        return opened;
      }
    });

    await producer.produce({ async write() {} }, containedGpuJob());
    expect(observedTimeouts).toEqual(Array.from({ length: 2 }, () => DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS));
    expect(producer.evidence).not.toHaveProperty("effectModules");
    expect(producer.evidence.provenance.staticPlan).not.toHaveProperty("effectModules");
    expect(producer.evidence.sessionResources).not.toHaveProperty("afterimageStackUniformBufferSlots");
    expect(canonicalJson(producer.evidence.provenance.staticPlan)).toBe(canonicalJson({
      schema: staticPlan.schema, fingerprint: staticPlan.fingerprint, documentFingerprint: staticPlan.documentFingerprint,
      canonicalFrameCount: staticPlan.canonicalFrameCount, resourceReferencesSha256: canonicalJsonSha256(staticPlan.resources),
      resourceReferenceCount: staticPlan.resources.length, maxima: staticPlan.maxima, geometryReuse: "not-claimed"
    }));
  });

  it("renders the canonical timeline through one session and one raw buffer at a time", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    let opens = 0;
    let closes = 0;
    let activeWrites = 0;
    let peakWrites = 0;
    const frames: Array<{ index: number; atMs: number; format: string; strideBytes: number; bytes: number }> = [];
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openRuntime: async () => {
        opens += 1;
        return fakeGpuRuntime(() => { closes += 1; });
      }
    });
    const sink: GpuStreamingFrameSink = {
      async write(frame) {
        activeWrites += 1;
        peakWrites = Math.max(peakWrites, activeWrites);
        frames.push({ index: frame.index, atMs: frame.atMs, format: frame.format, strideBytes: frame.strideBytes, bytes: frame.rgba.byteLength });
        await Promise.resolve();
        activeWrites -= 1;
      }
    };

    const watched: number[] = [];
    await producer.produce(sink, containedGpuJob(new AbortController().signal, watched));

    expect(opens).toBe(1);
    expect(closes).toBe(1);
    expect(watched).toEqual([4_242]);
    expect(frames).toHaveLength(30);
    expect(frames[0]).toEqual({ index: 0, atMs: 0, format: "rgba", strideBytes: 96 * 4, bytes: 96 * 64 * 4 });
    expect(frames.at(-1)).toEqual({ index: 29, atMs: 967, format: "rgba", strideBytes: 96 * 4, bytes: 96 * 64 * 4 });
    expect(peakWrites).toBe(1);
    expect(producer.metrics).toMatchObject({
      delivery: "streamed-raw-rgba",
      frameCount: 30,
      emittedFrames: 30,
      activeFrameHandoffs: 0,
      peakConcurrentFrameHandoffs: 1,
      activeRgbaBuffers: 0,
      peakRgbaBuffers: 1,
      retainedFrameCount: 0,
      sessionFrameCacheEntries: 0
    });
    expect(producer.evidence).toMatchObject({
      schema: "shellx-motion/gpu-streaming-producer@1",
      inputHashes: {
        "manifest.json": expect.stringMatching(/^[a-f0-9]{64}$/),
        "motion.json": expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      frameSequenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      framePlanSequenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      readback: {
        schema: "shellx-motion/gpu-readback-transport@1",
        transport: {
          framesObserved: 30,
          allocations: { hostBase64Decode: 30, rowCompaction: 30, straightAlpha: 0 },
          rowCompaction: { tightRowFrames: 0, paddedRowFrames: 30, copiedBytes: 96 * 64 * 4 * 30, allocationCount: 30 },
          straightAlpha: { inPlaceOwnedBufferFrames: 30, copiedBytes: 0, allocationCount: 0 }
        },
        timing: { observational: true, framesObserved: 30, totalNanoseconds: 0, minNanoseconds: 0, maxNanoseconds: 0 }
      },
      gpu: { adapterFingerprint: "0".repeat(64) },
      sessionResources: { schema: "shellx-motion/gpu-page-session-resources@1", framesRendered: 30 },
      typography: { authority: "manifest-font-face-browser-shaped", shaping: "canvas-2d", fallbackPolicy: "manifest-bound-required", fontProbe: "font-face-load-and-font-set-check", fontAssets: [] },
      runtimeLifecycle: { browserSession: "single-per-render", device: "persistent-per-render", pipelines: "fixed-reused" },
      processMonitoring: {
        mode: "precontained-direct-chromium",
        chromiumRootPid: 4_242,
        watchedRoot: "precontained-chromium-root",
        rssScope: "precontained-chromium-tree",
        measurement: "exact-precontained-chromium-root-pid",
        watchRegistered: true,
        containment: { rootPid: 4_242, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 512 * 1024 * 1024 },
        encoderContainmentCoversChromium: true
      },
      session: { state: "closed", cleanup: "complete" }
    });
    expect(Object.isFrozen(producer.evidence.sessionResources)).toBe(true);
    expect(producer.evidence.provenance.staticPlan).toMatchObject({
      schema: "shellx-motion/gpu-scene-static-plan@1",
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      documentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      canonicalFrameCount: 30,
      resourceReferenceCount: 0,
      geometryReuse: "not-claimed"
    });
  });

  it("closes the hardware session and preserves the runtime refusal", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    let closes = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openRuntime: async () => fakeGpuRuntime(() => { closes += 1; }, {
        code: "gpu_device_lost",
        message: "device lost in test"
      })
    });

    await expect(producer.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({
      name: "GpuStreamingProducerRuntimeError",
      code: "gpu_device_lost",
      message: "device lost in test"
    });
    expect(closes).toBe(1);
    expect(producer.evidence.session).toEqual({ state: "closed", cleanup: "complete" });
  });

  it("attests persistent session resource counters after the final frame and before close", async () => {
    const pkg = resourceMetricsPackage();
    let closed = false;
    let metricsRead = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openRuntime: async () => {
        const opened = fakeGpuRuntime(() => { closed = true; });
        if (!opened.ok) return opened;
        const resourceMetrics = opened.session.resourceMetrics!;
        opened.session.resourceMetrics = async () => {
          metricsRead += 1;
          expect(closed).toBe(false);
          return await resourceMetrics();
        };
        return opened;
      }
    });

    await producer.produce({ async write() {} }, containedGpuJob());
    expect(metricsRead).toBe(1);
    expect(producer.evidence.sessionResources).toMatchObject({
      schema: "shellx-motion/gpu-page-session-resources@1",
      framesRendered: 2
    });
    expect(Object.isFrozen(producer.evidence.sessionResources)).toBe(true);
  });

  it("refuses successful frame delivery when persistent session metrics are missing", async () => {
    const pkg = resourceMetricsPackage();
    let closes = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openRuntime: async () => {
        const opened = fakeGpuRuntime(() => { closes += 1; });
        if (!opened.ok) return opened;
        opened.session.resourceMetrics = undefined;
        return opened;
      }
    });

    await expect(producer.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_session_resources_invalid" });
    expect(closes).toBe(1);
    expect(producer.evidence.sessionResources).toBeNull();
  });

  it("refuses persistent session metrics whose frame count differs from canonical delivery", async () => {
    const pkg = resourceMetricsPackage();
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openRuntime: async () => {
        const opened = fakeGpuRuntime(() => {});
        if (!opened.ok) return opened;
        opened.session.resourceMetrics = async () => fakeGpuSessionResources(1);
        return opened;
      }
    });

    await expect(producer.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_session_resources_frame_mismatch" });
    expect(producer.evidence.sessionResources).toBeNull();
  });

  it("refuses a missing pre-acquired job without opening hardware", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    let opens = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openRuntime: async () => {
        opens += 1;
        return fakeGpuRuntime(() => {});
      }
    });
    await expect(producer.produce({ async write() {} }, {
      admission: "not-acquired" as "pre-acquired",
      signal: new AbortController().signal,
      scratchRoot: "/test/scratch",
      maxProcessTreeRssBytes: 512 * 1024 * 1024,
      watchProcess() {}
    })).rejects.toThrow("requires a pre-acquired job context");
    expect(opens).toBe(0);
  });

  it("fails closed for a missing or document-mismatched static plan before resource or browser work", async () => {
    const pkg: MotionPackage = {
      root: fixtureRoot,
      manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_static_plan", name: "GPU static plan", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_static_plan", name: "GPU static plan", durationMs: 1_000, fps: 1, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [] }
    };
    let opens = 0;
    const openRuntime = async () => { opens += 1; return fakeGpuRuntime(() => {}); };
    const missing = createGpuStreamingFrameProducerImpl({ pkg, openRuntime } as unknown as GpuStreamingFrameProducerInput);
    await expect(missing.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_static_plan_invalid" });
    const compiled = compileGpuSceneStaticPlan(pkg.motion); if (!compiled.ok) throw new Error(compiled.failure.message);
    const mismatchedPlan = Object.freeze({ ...compiled.plan, documentFingerprint: "0".repeat(64) });
    const mismatched = createGpuStreamingFrameProducerImpl({ pkg, staticPlan: mismatchedPlan, openRuntime });
    await expect(mismatched.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_static_plan_invalid" });
    expect(opens).toBe(0);
  });

  it("fails GPU final before opening Chromium when the admitted job has no pre-launch bounds", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    let opens = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openRuntime: async () => {
        opens += 1;
        return fakeGpuRuntime(() => {});
      }
    });

    await expect(producer.produce({ async write() {} }, {
      admission: "pre-acquired",
      signal: new AbortController().signal,
      scratchRoot: "",
      maxProcessTreeRssBytes: 0,
      watchProcess() {}
    })).rejects.toBeInstanceOf(GpuStreamingProducerContainmentError);
    expect(opens).toBe(0);
    expect(producer.evidence.processMonitoring).toMatchObject({
      chromiumRootPid: "unavailable",
      watchRegistered: false,
      containment: null,
      encoderContainmentCoversChromium: false,
      reasonCode: "final_launch_context_unavailable"
    });
  });

  it("refuses a runtime that does not expose the exact Chromium browser-server PID and closes it", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    let closes = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openRuntime: async () => {
        const opened = fakeGpuRuntime(() => { closes += 1; });
        if (!opened.ok) return opened;
        return {
          ok: true,
          session: {
            ...opened.session,
            browserProcess: undefined as unknown as typeof opened.session.browserProcess
          }
        };
      }
    });

    await expect(producer.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({
      name: "GpuStreamingProducerContainmentError",
      code: "gpu_process_containment_unavailable"
    });
    expect(closes).toBe(1);
    expect(producer.evidence.processMonitoring).toMatchObject({
      chromiumRootPid: "unavailable",
      containment: null,
      encoderContainmentCoversChromium: false,
      reasonCode: "browser_pid_unavailable"
    });
  });

  it("closes the exact browser runtime after an admitted job abort", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);
    const controller = new AbortController();
    let closes = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openRuntime: async () => fakeGpuRuntime(() => { closes += 1; })
    });

    await expect(producer.produce({
      async write() { controller.abort(new Error("operator cancelled")); }
    }, containedGpuJob(controller.signal))).rejects.toThrow("operator cancelled");
    expect(closes).toBe(1);
    expect(producer.evidence.session).toEqual({ state: "closed", cleanup: "complete" });
  });

  it("snapshots one package PNG, uploads it once, and renders image draw plans", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-gpu-stream-image-")); await mkdir(join(root, "assets"), { mode: 0o700 });
    await writeFile(join(root, "assets", "hero.png"), encodeRgbaPng(2, 1, Buffer.from([255, 0, 0, 255, 0, 255, 0, 255])), { mode: 0o600 });
    const packageWithImage: MotionPackage = {
      root, manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_image", name: "GPU image", motion: "motion.json", assets: ["assets/hero.png"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_image", name: "GPU image", durationMs: 1_000, fps: 1, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "hero", type: "image", assetRef: "assets/hero.png", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } }] }
    };
    let uploaded = 0; let imageDraws = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg: packageWithImage,
      openRuntime: async (images) => {
        uploaded = images.length; expect(images[0]).toMatchObject({ width: 2, height: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
        const runtime = fakeGpuRuntime(() => {}); if (!runtime.ok) return runtime;
        const render = runtime.session.render.bind(runtime.session);
        runtime.session.render = async (plan, options) => { const frame = plan as { draws: Array<{ kind: string }> }; imageDraws += frame.draws.filter((draw) => draw.kind === "image").length; return await render(plan, options); };
        return runtime;
      }
    });
    await producer.produce({ async write() {} }, containedGpuJob());
    expect(uploaded).toBe(1); expect(imageDraws).toBe(1);
    expect(producer.evidence.inputHashes["assets/hero.png"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("opens one exact font session and emits browser-shaped text draws", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-gpu-stream-text-")); await mkdir(join(root, "assets"), { mode: 0o700 });
    const font = Buffer.from("bounded-font-fixture"); await writeFile(join(root, "assets", "brand.woff2"), font, { mode: 0o600 });
    const packageWithText: MotionPackage = {
      root, manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_text", name: "GPU text", motion: "motion.json", assets: ["assets/brand.woff2"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_text", name: "GPU text", durationMs: 1_000, fps: 1, width: 64, height: 32, assets: [{ id: "brand", type: "font", family: "Brand Sans", source: { path: "assets/brand.woff2", mimeType: "font/woff2" }, weight: 700 }], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "title", type: "text", text: "GPU", startMs: 0, durationMs: 1_000, transform: { width: 64, height: 32 }, style: { fontFamily: "Brand Sans", fontSize: 20, fontWeight: 700, color: "#ffffff" } }] }
    };
    let uploaded = 0; let textDraws = 0;
    const producer = createGpuStreamingFrameProducer({ pkg: packageWithText, openRuntime: async (_images, fonts) => {
      uploaded = fonts.length; expect(fonts[0]).toMatchObject({ family: "Brand Sans", bytes: font, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const runtime = fakeGpuRuntime(() => {}); if (!runtime.ok) return runtime; const render = runtime.session.render.bind(runtime.session);
      runtime.session.render = async (plan, options) => { const frame = plan as { draws: Array<{ kind: string }> }; textDraws += frame.draws.filter((draw) => draw.kind === "text").length; return await render(plan, options); }; return runtime;
    } });
    await producer.produce({ async write() {} }, containedGpuJob());
    expect(uploaded).toBe(1); expect(textDraws).toBe(1); expect(producer.evidence.inputHashes["assets/brand.woff2"]).toMatch(/^[a-f0-9]{64}$/);
    expect(producer.evidence.typography).toMatchObject({ authority: "manifest-font-face-browser-shaped", shaping: "canvas-2d", fallbackPolicy: "manifest-bound-required", fontAssets: [{ resourceId: expect.stringMatching(/^font-/), assetRef: "assets/brand.woff2", family: "Brand Sans", weight: 700, style: "normal", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
  });

  it("carries isolated temporal groups through the final raw-RGBA producer", async () => {
    const pkg: MotionPackage = {
      root: fixtureRoot,
      manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_blur", name: "GPU blur", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_blur", name: "GPU blur", durationMs: 1_000, fps: 2, width: 64, height: 32, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "sweep", type: "shape", shape: "rect", fill: "#ff8040", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 8, width: 12, height: 12 }, keyframes: { "transform.x": [{ atMs: 0, value: 0 }, { atMs: 1_000, value: 48 }] }, effects: { motionBlur: { samples: 4, shutterAngle: 180 }, glow: { radius: 3, color: "#ff804080" } } }] }
    };
    const plans: Array<Array<{ kind: string; id: string }>> = [];
    const producer = createGpuStreamingFrameProducer({ pkg, openRuntime: async () => { const runtime=fakeGpuRuntime(()=>{});if(!runtime.ok)return runtime;const render=runtime.session.render.bind(runtime.session);runtime.session.render=async(plan,options)=>{plans.push((plan as {draws:Array<{kind:string;id:string}>}).draws);return await render(plan,options);};return runtime; } });
    await producer.produce({ async write() {} }, containedGpuJob());
    expect(plans).toHaveLength(2);
    expect(plans.every((draws) => draws.map((draw) => draw.kind).join(",") === "motionBlurStart,rect,rect,rect,rect,motionBlurEnd")).toBe(true);
    expect(plans[0][0]).toMatchObject({ kind: "motionBlurStart", id: "sweep.motion-blur" });
    expect(producer.evidence.framePlanSequenceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("carries nested local-time precompositions through final raw-RGBA production", async () => {
    const pkg: MotionPackage = {
      root: fixtureRoot,
      manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_group", name: "GPU group", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_group", name: "GPU group", durationMs: 1_000, fps: 2, width: 64, height: 32, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [
        { id: "outer", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["child", "inner"], transform: { x: 4, scale: 1.25 } },
        { id: "child", type: "shape", shape: "rect", fill: "#ff8040", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 8, width: 12, height: 12 }, keyframes: { "transform.x": [{ atMs: 0, value: 0 }, { atMs: 1_000, value: 40 }] } },
        { id: "inner", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["orb"] },
        { id: "orb", type: "shape", shape: "ellipse", fill: "#4080ff", startMs: 0, durationMs: 1_000, transform: { x: 24, y: 8, width: 12, height: 12 } }
      ] }
    };
    const plans: Array<Array<{ kind: string; id: string }>> = [];
    const producer = createGpuStreamingFrameProducer({ pkg, openRuntime: async () => { const runtime=fakeGpuRuntime(()=>{});if(!runtime.ok)return runtime;const render=runtime.session.render.bind(runtime.session);runtime.session.render=async(plan,options)=>{plans.push((plan as {draws:Array<{kind:string;id:string}>}).draws);return await render(plan,options);};return runtime; } });
    await producer.produce({ async write() {} }, containedGpuJob());
    expect(plans).toHaveLength(2);
    expect(plans.every((draws)=>draws.map((draw)=>draw.kind).join(",")==="groupStart,rect,groupStart,ellipse,groupEnd,groupEnd")).toBe(true);
    expect(plans[0][0]).toMatchObject({kind:"groupStart",id:"outer.group"});
    expect(producer.evidence.framePlanSequenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(producer.evidence.provenance).toMatchObject({
      pipelineCatalog: {
        schema: "shellx-motion/gpu-pipeline-catalog@1",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        entries: expect.arrayContaining([
          { id: "page.primitives", implementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          { id: "page.material", implementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          { id: "page.scene3d", implementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
        ])
      },
      staticScene: {
        schema: "shellx-motion/gpu-static-scene-fingerprint@1",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        inputHashesSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      resourceBudget: {
        schema: "shellx-motion/gpu-resource-budget-evidence@1",
        expectedFrames: 2,
        observedFrames: 2,
        maxima: { groupCount: 2, groupMaxDepth: 2, rectangleCount: 2 },
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
  });

  it("does not finalize provenance resource evidence after a terminal frame failure", async () => {
    const pkg: MotionPackage = {
      root: fixtureRoot,
      manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_provenance_failure", name: "GPU provenance failure", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: {
        schema: "shellx-motion/motion@1", id: "motion_gpu_provenance_failure", name: "GPU provenance failure",
        durationMs: 1_000, fps: 2, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
        layers: [{ id: "plate", type: "shape", shape: "rect", fill: "#204060", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } }]
      }
    };
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openRuntime: async () => fakeGpuRuntime(() => {}, { code: "gpu_device_lost", message: "test device loss" })
    });

    await expect(producer.produce({ async write() {} }, containedGpuJob())).rejects.toMatchObject({ code: "gpu_device_lost" });
    expect(producer.evidence.provenance).toMatchObject({
      pipelineCatalog: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      staticScene: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      resourceBudget: null
    });
    expect(producer.evidence.frameSequenceSha256).toBeNull();
    expect(producer.evidence.framePlanSequenceSha256).toBeNull();
  });

  it("streams source-bound animated glTF geometry through one persistent session with static provenance", async () => {
    const geometry={positions:[0,0,0, 1,0,0, 0,1,0],normals:[0,0,1, 0,0,1, 0,0,1],indices:[0,1,2]};
    const pkg:MotionPackage={root:fixtureRoot,manifest:{schema:"shellx-motion/package-manifest@1",id:"pkg_gpu_scene3d",name:"GPU scene3d",motion:"motion.json",assets:[],sourceApp:"test",compatibility:{lanes:["gpu"],hosts:["motion"]}},motion:{schema:"shellx-motion/motion@1",id:"motion_gpu_scene3d",name:"GPU scene3d",durationMs:1_000,fps:2,width:64,height:36,assets:[],provenance:{sourceApp:"test",createdBy:"test"},layers:[{id:"world",type:"scene3d",startMs:0,durationMs:1_000,scene3d:{schema:"shellx-motion/scene3d@2",backgroundColor:"#001020",camera:{position:[0,1,5],target:[0,0,0],fovDeg:45,near:.1,far:100,orbitDegPerSecond:20},lighting:{ambient:.2,direction:[0,-1,-1],intensity:1,color:"#ffffff"},objects:[{id:"mesh",primitive:"mesh",position:[0,0,0],rotationDeg:[0,0,0],spinDegPerSecond:[0,90,0],scale:1,color:"#ff8040",geometry,source:{format:"gltf",meshIndex:0,primitiveIndex:0,geometrySha256:scene3dMeshGeometrySha256(geometry)}}]}}]}};
    const plans:Array<{kind:string;model:number[];vertices:number[]}>=[];let opens=0,closes=0;
    const producer=createGpuStreamingFrameProducer({pkg,openRuntime:async()=>{opens+=1;const runtime=fakeGpuRuntime(()=>{closes+=1;});if(!runtime.ok)return runtime;const render=runtime.session.render.bind(runtime.session);runtime.session.render=async(plan,options)=>{const draw=(plan as {draws:Array<{kind:string;objects?:Array<{model:number[];vertices:number[]}>}>}).draws[0];plans.push({kind:draw.kind,model:[...(draw.objects?.[0]?.model??[])],vertices:[...(draw.objects?.[0]?.vertices??[])]});return await render(plan,options);};return runtime;}});
    await producer.produce({async write(){}},containedGpuJob());
    expect(opens).toBe(1);expect(closes).toBe(1);expect(plans).toHaveLength(2);expect(plans.map((plan)=>plan.kind)).toEqual(["scene3d","scene3d"]);expect(plans[0].vertices).toEqual([0,0,0,0,0,1,1,0,0,0,0,1,0,1,0,0,0,1]);expect(plans[0].model).not.toEqual(plans[1].model);expect(producer.evidence.framePlanSequenceSha256).toMatch(/^[a-f0-9]{64}$/);expect(producer.evidence.provenance.staticScene).toMatchObject({inputHashesSha256:expect.stringMatching(/^[a-f0-9]{64}$/),pipelineCatalogSha256:expect.stringMatching(/^[a-f0-9]{64}$/)});
  });

  it("streams animated fixed-data environments through final raw-RGBA production", async () => {
    const pkg:MotionPackage={root:fixtureRoot,manifest:{schema:"shellx-motion/package-manifest@1",id:"pkg_gpu_weather",name:"GPU weather",motion:"motion.json",assets:[],sourceApp:"test",compatibility:{lanes:["gpu"],hosts:["motion"]}},motion:{schema:"shellx-motion/motion@1",id:"motion_gpu_weather",name:"GPU weather",durationMs:1_000,fps:2,width:64,height:36,assets:[],provenance:{sourceApp:"test",createdBy:"test"},layers:[{id:"storm",type:"environment",startMs:0,durationMs:1_000,transform:{width:64,height:36},environment:{schema:"shellx-motion/environment@1",kind:"rain",seed:19,quality:"cinematic",mode:"overlay",intensity:.8,wind:.2,dropSpeed:1.4,dropLength:1,depthLayers:4,color:"#bdebff",backgroundColor:"#050a12",lightColor:"#7dd3fc",accentColor:"#fb7185",ground:{horizon:.43,wetness:.9,roughness:.24,rippleAmount:.78,splashAmount:.64,reflectionStrength:.88},atmosphere:{mist:.44,lensDroplets:.34}},keyframes:{"environment.intensity":[{atMs:0,value:.2},{atMs:1_000,value:.8}]}}]}};
    const plans:Array<{kind:string;timeSeconds:number;intensity:number}>=[];
    const producer=createGpuStreamingFrameProducer({pkg,openRuntime:async()=>{const runtime=fakeGpuRuntime(()=>{});if(!runtime.ok)return runtime;const render=runtime.session.render.bind(runtime.session);runtime.session.render=async(plan,options)=>{const draw=(plan as {draws:Array<{kind:string;timeSeconds?:number;parameters?:number[]}>}).draws[0];plans.push({kind:draw.kind,timeSeconds:draw.timeSeconds??-1,intensity:draw.parameters?.[0]??-1});return await render(plan,options);};return runtime;}});
    await producer.produce({async write(){}},containedGpuJob());
    expect(plans).toEqual([{kind:"environment",timeSeconds:0,intensity:.2},{kind:"environment",timeSeconds:.5,intensity:.5}]);
    expect(producer.evidence.framePlanSequenceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uploads one bounded decoded video texture per canonical frame and binds decoder evidence", async () => {
    const pkg: MotionPackage = {
      root: fixtureRoot,
      manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_video", name: "GPU video", motion: "motion.json", assets: ["assets/clip.mp4"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_video", name: "GPU video", durationMs: 1_000, fps: 2, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "clip", type: "video", assetRef: "assets/clip.mp4", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } }] }
    };
    const uploads: string[][] = []; const plans: string[][] = []; let closes = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openVideoProvider: async () => ({
        inputHashes: { "assets/clip.mp4": "c".repeat(64) },
        evidence: { schema: "shellx-motion/gpu-video-frame-provider@1", mode: "test", sourceCount: 1, decodedFrameCount: 2, peakInMemoryFrames: 1, stagedDecodedBytes: 128, stagedFrameCount: 2, sources: [{ layerId: "clip", assetRef: "assets/clip.mp4", sha256: "c".repeat(64), width: 2, height: 2 }] },
        async frameAt(atMs) { const rgba=Buffer.alloc(16,atMs===0?1:2),sha256=createHash("sha256").update(rgba).digest("hex");return {atMs,frames:[{layerId:"clip",assetRef:"assets/clip.mp4",sourceAtMs:atMs,resource:{layerId:"clip",resourceId:"video-clip",assetRef:"assets/clip.mp4",width:2,height:2,sha256,sourceAtMs:atMs},upload:{id:"video-clip",width:2,height:2,rgba,sha256,decodedSha256:sha256}}]}; },
        async close() { closes += 1; }
      }),
      openRuntime: async () => { const runtime=fakeGpuRuntime(()=>{});if(!runtime.ok)return runtime;runtime.session.uploadImages=async(images)=>{uploads.push(images.map((image)=>image.sha256));return{ok:true,uploaded:images.length};};const render=runtime.session.render.bind(runtime.session);runtime.session.render=async(plan,options)=>{plans.push((plan as {draws:Array<{kind:string}>}).draws.map((draw)=>draw.kind));return await render(plan,options);};return runtime; }
    });
    await producer.produce({ async write() {} }, containedGpuJob());
    expect(uploads).toHaveLength(2); expect(new Set(uploads.flat()).size).toBe(2); expect(plans).toEqual([["image"],["image"]]); expect(closes).toBe(1);
    expect(producer.evidence).toMatchObject({ inputHashes: { "assets/clip.mp4": "c".repeat(64) }, video: { mode: "test", decodedFrameCount: 2, stagedFrameCount: 2 } });
  });

  it("injects exact-time governed browser captures as GPU textures with hybrid evidence", async () => {
    const pkg: MotionPackage = {
      root: fixtureRoot,
      manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_hybrid", name: "GPU hybrid", motion: "motion.json", assets: ["surfaces/card.html"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_hybrid", name: "GPU hybrid", durationMs: 1_000, fps: 2, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "back", type: "shape", shape: "rect", fill: "#ff0000", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } }, { id: "card", type: "html", source: "surfaces/card.html", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } }, { id: "front", type: "shape", shape: "rect", fill: "#00ff00", startMs: 0, durationMs: 1_000, transform: { width: 16, height: 16 } }] }
    };
    const binding: GpuHybridCaptureBinding = Object.freeze({
      schema: "shellx-motion/gpu-hybrid-capture@1", classification: "gpu-hybrid", producer: "governed-browser-surface", browserOwnership: "borrowed-gpu-runtime", captureScope: "declared-browser-source-document",
      layerId: "card", source: "surfaces/card.html", sourceDocument: Object.freeze({ schema: "shellx-motion/gpu-hybrid-html-policy@1", policy: "strict-data-only-html", source: "surfaces/card.html", sourceSha256: "b".repeat(64), byteLength: 42 }), browser: Object.freeze({ name: "chromium", version: "test-browser" }),
      scriptExecution: Object.freeze(agentScriptExecutionEvidenceForDataOnly(pkg.motion)),
      network: Object.freeze({ policy: "host-approved-origins", allowPrivateNetwork: false, resolutionTimeoutMs: 1_000, approvedOrigins: [], pins: [], responsePolicy: { maxResponseBytes: 1_024, maxAggregateBytes: 1_024, maxConcurrentResponses: 1, contentTypes: "bounded-render-media" as const } }),
      inputHashes: Object.freeze({ "surfaces/card.html": "b".repeat(64) }), typography: "browser-html-canvas-unverified"
    });
    const captureTimes: number[] = []; const uploads: string[][] = []; const draws: Array<{ kind: string; resourceId?: string }> = [];
    let captureClosed = 0; let runtimeClosed = 0;
    const producer = createGpuStreamingFrameProducer({
      pkg,
      openHybridCapture: async () => ({
        sourceSnapshot: { sourceSnapshotSha256: binding.sourceDocument.sourceSha256, sourceByteLength: binding.sourceDocument.byteLength },
        get binding() { return binding; },
        async capture(atMs) {
          captureTimes.push(atMs);
          const rgba = Buffer.alloc(16 * 16 * 4, atMs === 0 ? 0x11 : 0x22);
          const sha256 = createHash("sha256").update(rgba).digest("hex");
          const pngSha256 = createHash("sha256").update(`capture:${atMs}`).digest("hex");
          return { atMs, pngSha256, binding, texture: { id: "browser-surface-card", width: 16, height: 16, rgba, sha256: pngSha256, decodedSha256: sha256 } };
        },
        async close() { captureClosed += 1; }
      }),
      openRuntime: async () => {
        const opened = fakeGpuRuntime(() => { runtimeClosed += 1; }); if (!opened.ok) return opened;
        const render = opened.session.render.bind(opened.session);
        opened.session.uploadImages = async (images) => { uploads.push(images.map((image) => image.id)); return { ok: true, uploaded: images.length }; };
        opened.session.render = async (plan, options) => { for (const draw of (plan as { draws: Array<{ kind: string; id: string; resourceId?: string }> }).draws) draws.push({ kind: `${draw.kind}:${draw.id}`, resourceId: draw.resourceId }); return await render(plan, options); };
        return opened;
      }
    });

    await producer.produce({ async write() {} }, containedGpuJob());

    expect(captureTimes).toEqual([0, 500]);
    expect(uploads).toEqual([["browser-surface-card"], ["browser-surface-card"]]);
    expect(draws).toEqual([{ kind: "rect:back" }, { kind: "image:card", resourceId: "browser-surface-card" }, { kind: "rect:front" }, { kind: "rect:back" }, { kind: "image:card", resourceId: "browser-surface-card" }, { kind: "rect:front" }]);
    expect(captureClosed).toBe(1); expect(runtimeClosed).toBe(1);
    expect(producer.evidence.hybrid).toMatchObject({ classification: "gpu-hybrid", producer: "governed-browser-surface", browserOwnership: "borrowed-gpu-runtime", captureScope: "declared-browser-source-document", layerId: "card", source: "surfaces/card.html", sourceDocument: { policy: "strict-data-only-html", sourceSha256: "b".repeat(64) }, capturedFrames: 2, captureFrameSequenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), exactCaptureLedgerSequenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), typography: "browser-html-canvas-unverified", inputHashes: { "surfaces/card.html": "b".repeat(64) } });
    const sourceSha256 = "b".repeat(64);
    const expectedCaptureSequence = createHash("sha256");
    for (const [index, atMs] of [0, 500].entries()) {
      const pngSha256 = createHash("sha256").update(`capture:${atMs}`).digest("hex");
      const decodedSha256 = createHash("sha256").update(Buffer.alloc(16 * 16 * 4, atMs === 0 ? 0x11 : 0x22)).digest("hex");
      expect(pngSha256).not.toBe(sourceSha256);
      expect(decodedSha256).not.toBe(sourceSha256);
      expect(decodedSha256).not.toBe(pngSha256);
      expectedCaptureSequence.update(canonicalJson({ index, atMs, pngSha256, rgbaSha256: decodedSha256 }));
    }
    expect(producer.evidence.hybrid?.captureFrameSequenceSha256).toBe(expectedCaptureSequence.digest("hex"));
    const exactLedger = producer.rangeEvidence?.directHybridLedger;
    expect(exactLedger).toMatchObject({ startFrameIndex: 0, endFrameIndexExclusive: 2, captureCount: 2, entries: [
      { index: 0, atMs: 0, atUs: 0, resourceId: "browser-surface-card", width: 16, height: 16 },
      { index: 1, atMs: 500, atUs: 500_000, resourceId: "browser-surface-card", width: 16, height: 16 },
    ] });
    expect(exactLedger?.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.requestFingerprint) && /^[a-f0-9]{64}$/.test(entry.pngSha256) && /^[a-f0-9]{64}$/.test(entry.decodedRgbaSha256))).toBe(true);
    expect(producer.evidence.hybrid?.exactCaptureLedgerSequenceSha256).toBe(exactLedger?.sequenceSha256);
    expect(producer.evidence.inputHashes["surfaces/card.html"]).toBe("b".repeat(64));
    expect(producer.evidence.provenance.staticScene?.inputHashesSha256).toMatch(/^[a-f0-9]{64}$/);
  });

});

function resourceMetricsPackage(): MotionPackage {
  return {
    root: fixtureRoot,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_resource_metrics", name: "GPU resource metrics", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion_gpu_resource_metrics", name: "GPU resource metrics", durationMs: 1_000, fps: 2, width: 16, height: 16, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [] }
  };
}
