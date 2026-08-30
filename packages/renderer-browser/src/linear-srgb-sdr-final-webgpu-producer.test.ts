import { afterEach, describe, expect, it } from "vitest";
import {
  composeGammaWrongEncodedSourceOver,
  composeLinearSrgbSourceOver,
  parseCanonicalSrgbHex,
  resolveLinearSrgbSdrFinalRoute,
  type LinearSrgbSdrFinalRoute,
  type LinearSrgbSdrFinalRouteRequest,
} from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import { canonicalJsonSha256, type MotionDocument, type MotionLayer } from "@shellx-motion/core";
import {
  LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL,
  LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL,
  LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE,
} from "./linear-srgb-sdr-final-webgpu-contract";
import {
  LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE,
  LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL,
} from "./linear-srgb-sdr-final-f2a-gradient-webgpu-contract";
import {
  closeLinearSrgbSdrFinalWebGpuPage,
  openLinearSrgbSdrFinalWebGpuPage,
  prepareLinearSrgbSdrFinalWebGpuPage,
  readLinearSrgbSdrFinalWebGpuPage,
  releaseLinearSrgbSdrFinalWebGpuPage,
  renderLinearSrgbSdrFinalWebGpuPage,
  LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_EXPECTED_PIPELINE_SHA256,
  LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_EXPECTED_SHADER_SOURCE_SHA256,
  LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PAGE_EXPECTED_PIPELINE_SHA256,
  LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PAGE_EXPECTED_SHADER_SOURCE_SHA256,
} from "./linear-srgb-sdr-final-webgpu-page";
import { createLinearSrgbSdrFinalWebGpuProducer, linearSrgbSdrFinalReferenceFrame } from "./linear-srgb-sdr-final-webgpu-producer";

const REQUEST: LinearSrgbSdrFinalRouteRequest = Object.freeze({ target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264" });
const PAGE_STATE = "__shellxMotionLinearSrgbSdrFinalWebGpuV1";
const MUTATED_GLOBALS = ["GPUTextureUsage", "GPUBufferUsage", "GPUMapMode", "btoa"] as const;
const ORIGINAL_GLOBALS = new Map(MUTATED_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

function route(background: string, layers: ReadonlyArray<{ fill: string; opacity: number }>): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "strict-colour", name: "Strict colour", durationMs: 1_000, fps: 30, width: 1, height: 1,
    background, colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: layers.map((layer, index): MotionLayer => ({ id: `rect-${index}`, type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, fill: layer.fill, opacity: layer.opacity, transform: { x: 0, y: 0, width: 1, height: 1 } })),
  };
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

function gradientRoute(): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "strict-gradient", name: "Strict gradient", durationMs: 1_000, fps: 30, width: 4, height: 1,
    background: "#000000", colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "ramp", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 1, gradient: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] }, transform: { x: 0, y: 0, width: 4, height: 1 } }],
  };
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

function mixedGradientRoute(): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "strict-mixed-gradient", name: "Strict mixed gradient", durationMs: 1_000, fps: 30, width: 4, height: 1,
    background: "#000000", colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "flat", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 1, fill: "#204060", transform: { x: 0, y: 0, width: 1, height: 1 } },
      { id: "ramp", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 1, gradient: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] }, transform: { x: 1, y: 0, width: 3, height: 1 } },
    ],
  };
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[PAGE_STATE];
  for (const key of MUTATED_GLOBALS) {
    const original = ORIGINAL_GLOBALS.get(key);
    if (original) Object.defineProperty(globalThis, key, original);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

describe("strict linear-sRGB SDR WebGPU producer", () => {
  it("accepts only the admitted frozen route before any Browser runtime opener can run", () => {
    const admitted = route("#000000", [{ fill: "#000000", opacity: 0 }]);
    expect(createLinearSrgbSdrFinalWebGpuProducer(admitted)).toMatchObject({ ok: true });

    const mutable = structuredClone(admitted);
    const rejected = createLinearSrgbSdrFinalWebGpuProducer(mutable);
    expect(rejected).toMatchObject({ ok: false, refusal: { code: "linear_srgb_sdr_final_producer_refused" } });
  });

  it("reapplies Core's shared frame and pixel-frame budget to a forged but recomputed route identity", () => {
    const forged = structuredClone(route("#000000", [])) as unknown as Record<string, unknown>;
    (forged.canvas as Record<string, unknown>).fps = 121;
    forged.fingerprint = canonicalJsonSha256({ schema: forged.schema, admission: forged.admission, contract: forged.contract, canvas: forged.canvas, rects: forged.rects, documentFingerprint: forged.documentFingerprint });
    freeze(forged);
    expect(createLinearSrgbSdrFinalWebGpuProducer(forged)).toMatchObject({ ok: false, refusal: { code: "linear_srgb_sdr_final_producer_refused" } });
  });

  it("matches Core linear vectors for dark, highlight, and saturated translucent pixels while rejecting gamma-domain output", () => {
    const vectors = [
      { name: "black-near-black", background: "#000000", layers: [{ fill: "#111111", opacity: 0.5 }] },
      { name: "black-white-highlight", background: "#000000", layers: [{ fill: "#ffffff", opacity: 0.25 }] },
      { name: "saturated-translucent", background: "#101820", layers: [{ fill: "#ff0040", opacity: 0.4 }, { fill: "#0066ff", opacity: 0.45 }] },
    ] as const;
    for (const vector of vectors) {
      const admitted = route(vector.background, vector.layers);
      const actual = linearSrgbSdrFinalReferenceFrame(admitted);
      const inputs = [vector.background, ...vector.layers.map((layer) => layer.fill)].map((fill, index) => {
        const parsed = parseCanonicalSrgbHex(fill);
        if (!parsed) throw new Error("invalid test colour");
        return { r: parsed.r, g: parsed.g, b: parsed.b, a: index === 0 ? 1 : vector.layers[index - 1]!.opacity };
      });
      const expected = composeLinearSrgbSourceOver(inputs);
      const wrong = composeGammaWrongEncodedSourceOver(inputs);
      expect([...actual]).toEqual([expected.r, expected.g, expected.b, expected.a].map((channel) => Math.round(channel * 255)));
      const wrongBytes = [wrong.r, wrong.g, wrong.b].map((channel) => Math.round(channel * 255));
      const linearDelta = Math.max(...(["r", "g", "b"] as const).map((channel) => Math.abs(expected[channel] - wrong[channel])));
      expect(linearDelta, `${vector.name} gamma-domain control must fail the declared linear composition`).toBeGreaterThan(0);
      if (vector.name !== "black-near-black") expect(Math.max(...wrongBytes.map((channel, index) => Math.abs(channel - actual[index]!))), vector.name).toBeGreaterThan(0);
    }
  });

  it("keeps the float working target, explicit source-over blend, and separate encoded COPY_SRC target structurally inspectable", () => {
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE).toMatchObject({
      workingTarget: { format: "rgba16float", usage: ["RENDER_ATTACHMENT", "TEXTURE_BINDING"], blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } },
      publicationTarget: { format: "rgba8unorm", usage: ["RENDER_ATTACHMENT", "COPY_SRC"] },
      readback: { bufferUsage: ["COPY_DST", "MAP_READ"], rowAlignment: 256 },
    });
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.shaderSourceSha256).toBe(LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_EXPECTED_SHADER_SOURCE_SHA256);
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256).toBe(LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_EXPECTED_PIPELINE_SHA256);
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL).toContain("srgbDecode");
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL).toContain("linear * alpha");
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL).toContain("premultiplied.rgb / premultiplied.a");
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL).toContain("srgbEncode");
  });

  it("attests the base pipeline plus F2a pipeline for every admitted gradient route while preserving flat-only evidence", () => {
    const flat = route("#000000", [{ fill: "#ffffff", opacity: 0.5 }]);
    const gradient = gradientRoute();
    const mixed = mixedGradientRoute();
    expect(createLinearSrgbSdrFinalWebGpuProducer(flat)).toMatchObject({ ok: true, producer: { evidence: { pipeline: { schema: "shellx-motion/linear-srgb-sdr-final-webgpu-pipeline@1", implementationSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256 } } } });
    const flatProducer = createLinearSrgbSdrFinalWebGpuProducer(flat);
    if (!flatProducer.ok) throw new Error(flatProducer.refusal.message);
    expect(flatProducer.producer.evidence).not.toHaveProperty("gradientPipeline");
    for (const route of [gradient, mixed]) {
      const producer = createLinearSrgbSdrFinalWebGpuProducer(route);
      expect(producer).toMatchObject({ ok: true, producer: { evidence: {
        pipeline: { schema: "shellx-motion/linear-srgb-sdr-final-webgpu-pipeline@1", implementationSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256 },
        gradientPipeline: { schema: "shellx-motion/linear-srgb-sdr-final-f2a-gradient-webgpu-pipeline@1", implementationSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.implementationSha256 },
      } } });
    }
    expect(LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.shaderSourceSha256).toBe(LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PAGE_EXPECTED_SHADER_SOURCE_SHA256);
    expect(LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.implementationSha256).toBe(LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PAGE_EXPECTED_PIPELINE_SHA256);
    expect(LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL).toContain("decodedColor");
    expect(LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL).toContain("mix(priorColor, nextColor");
    expect(LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL).toContain("linear * alpha");
  });

  it("binds both mixed-scene pipeline identities into the completed evidence fingerprint", async () => {
    const route = mixedGradientRoute(), padded = Buffer.alloc(256), pageCalls: string[] = [];
    const producer = createLinearSrgbSdrFinalWebGpuProducer(route, {
      openRuntime: async () => ({ ok: true, session: {
        browserProcess: { pid: 42, launcher: "precontained-direct-chromium", containment: { rootPid: 42, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 64 * 1024 * 1024 } },
        page: { evaluate: async (entry: unknown) => {
          if (entry === openLinearSrgbSdrFinalWebGpuPage) { pageCalls.push("open"); return { ok: true, runtime: {} }; }
          if (entry === prepareLinearSrgbSdrFinalWebGpuPage) { pageCalls.push("prepare"); return { ok: true }; }
          if (entry === renderLinearSrgbSdrFinalWebGpuPage) { pageCalls.push("render"); return { ok: true }; }
          if (entry === readLinearSrgbSdrFinalWebGpuPage) { pageCalls.push("read"); return { ok: true, paddedBase64: padded.toString("base64"), evidence: { bytesPerRow: 256, paddedByteLength: 256, tightByteLength: 16, mappedBufferUnmapped: true, mappedBufferDestroyed: true } }; }
          if (entry === releaseLinearSrgbSdrFinalWebGpuPage) { pageCalls.push("release"); return { hadResources: true, releasedGpuBytes: 816, remainingGpuBytes: 0, releaseFailed: false }; }
          if (entry === closeLinearSrgbSdrFinalWebGpuPage) { pageCalls.push("close"); return { deviceDestroyed: true, forcedResourceRelease: false, releaseFailed: false }; }
          throw new Error("unexpected page entrypoint");
        } },
        assessRender: async () => ({ ok: true, evidence: {} }),
        close: async () => {},
      } } as never),
    });
    if (!producer.ok) throw new Error(producer.refusal.message);
    const frame = await producer.producer.produce({ admission: "pre-acquired", signal: new AbortController().signal, scratchRoot: "/tmp/strict-producer", maxProcessTreeRssBytes: 64 * 1024 * 1024, watchProcess() {} });
    expect(pageCalls).toEqual(["open", "prepare", "render", "read", "release", "close"]);
    expect(producer.producer.evidence.cleanup).toEqual({ state: "complete", resourcesReleased: true, pageClosed: true, runtimeClosed: true });
    expect(frame).toMatchObject({ width: 4, height: 1 });
    const evidence = producer.producer.evidence;
    expect(evidence).toMatchObject({
      pipeline: { schema: "shellx-motion/linear-srgb-sdr-final-webgpu-pipeline@1", implementationSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256 },
      gradientPipeline: { schema: "shellx-motion/linear-srgb-sdr-final-f2a-gradient-webgpu-pipeline@1", implementationSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.implementationSha256 },
      cleanup: { state: "complete", resourcesReleased: true, pageClosed: true, runtimeClosed: true },
    });
    expect(evidence.fingerprint).toBe(canonicalJsonSha256({ ...evidence, fingerprint: undefined }));
    expect(evidence.fingerprint).not.toBe(canonicalJsonSha256({ ...evidence, gradientPipeline: undefined, fingerprint: undefined }));
  });

  it("uses pixel-centre linear-light F2a gradient ramps in the isolated reference frame", () => {
    const frame = linearSrgbSdrFinalReferenceFrame(gradientRoute());
    expect([...frame]).toEqual([
      99, 99, 99, 255,
      165, 165, 165, 255,
      207, 207, 207, 255,
      240, 240, 240, 255,
    ]);
  });

  it("creates the separate F2a uniform/bind-group path only after every gradient identity binds", async () => {
    const destroyed: string[] = [], shaderModules: unknown[] = [], pipelines: unknown[] = [];
    let textureCount = 0, bufferCount = 0;
    const createTexture = (name: string) => ({ createView() { return { name }; }, destroy() { destroyed.push(name); } });
    const createBuffer = (name: string) => ({ destroy() { destroyed.push(name); } });
    (globalThis as Record<string, unknown>)[PAGE_STATE] = {
      device: {
        pushErrorScope() {}, async popErrorScope() { return null; },
        createShaderModule(value: unknown) { shaderModules.push(value); return {}; },
        createRenderPipeline(value: unknown) { pipelines.push(value); return { getBindGroupLayout() { return {}; } }; },
        createTexture() { return createTexture(`texture-${textureCount++}`); },
        createBuffer() { return createBuffer(`buffer-${bufferCount++}`); },
        createBindGroup() { return {}; },
        queue: { writeBuffer() {} },
      },
      limits: { maxTextureDimension2D: 2_048, maxBufferSize: 16 * 1024 * 1024 },
      lost: false,
    };
    (globalThis as Record<string, unknown>).GPUTextureUsage = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 };
    (globalThis as Record<string, unknown>).GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
    const route = gradientRoute();
    const prepared = await prepareLinearSrgbSdrFinalWebGpuPage({
      schema: "shellx-motion/linear-srgb-sdr-final-webgpu-page-input@1", routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint,
      pipelineImplementationSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256, shaderSourceSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.shaderSourceSha256,
      compositeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL, encodeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL,
      gradientPipelineImplementationSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.implementationSha256, gradientShaderSourceSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.shaderSourceSha256, gradientWgsl: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL,
      canvas: { width: route.canvas.width, height: route.canvas.height, background: { ...route.canvas.background } },
      rects: route.rects.map((rect) => "fill" in rect ? { ...rect, fill: { ...rect.fill } } : { ...rect, gradient: { ...rect.gradient, stops: rect.gradient.stops.map((stop) => ({ offset: stop.offset, color: { ...stop.color } })) } }),
    });
    expect(prepared).toEqual({ ok: true });
    expect(shaderModules).toHaveLength(4);
    expect(pipelines).toHaveLength(3);
    expect(releaseLinearSrgbSdrFinalWebGpuPage()).toEqual({ hadResources: true, releasedGpuBytes: 816, remainingGpuBytes: 0, releaseFailed: false });
    expect(destroyed).toEqual(["texture-0", "texture-1", "buffer-0", "buffer-1"]);
  });

  it("returns a complete GPU observation with adapter identity and bounded limits", async () => {
    const browser = globalThis as Record<string, unknown>;
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const originalSecure = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
    const device = { limits: { maxTextureDimension2D: 2_048, maxBufferSize: 16 * 1024 * 1024, maxStorageBufferBindingSize: 16 * 1024 * 1024 }, lost: new Promise(() => undefined), destroy() {} };
    const navigatorStub = { gpu: { requestAdapter: async () => ({ info: { vendor: "Acme", device: "GPU", architecture: "test", description: "test adapter" }, requestDevice: async () => device }) } };
    Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigatorStub });
    try {
      const opened = await openLinearSrgbSdrFinalWebGpuPage({ powerPreference: "high-performance" });
      expect(opened).toMatchObject({ ok: true, runtime: { secureContext: true, gpuApi: true, adapter: true, device: true, adapterInfo: { vendor: "Acme", device: "GPU" }, limits: { maxTextureDimension2D: 2_048, maxBufferSize: 16 * 1024 * 1024, maxStorageBufferBindingSize: 16 * 1024 * 1024 } } });
      expect(closeLinearSrgbSdrFinalWebGpuPage()).toMatchObject({ deviceDestroyed: true, forcedResourceRelease: false, releaseFailed: false });
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete browser.navigator;
      if (originalSecure) Object.defineProperty(globalThis, "isSecureContext", originalSecure); else delete browser.isSecureContext;
    }
  });

  it("closes an opened contained Browser after page admission refusal without replacing that refusal with a no-state cleanup error", async () => {
    let runtimeClosed = false, pageCloseCalls = 0;
    const producer = createLinearSrgbSdrFinalWebGpuProducer(route("#000000", []), {
      openRuntime: async () => ({ ok: true, session: {
        browserProcess: { pid: 42, launcher: "precontained-direct-chromium", containment: { rootPid: 42, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 64 * 1024 * 1024 } },
        page: { evaluate: async (entry: unknown) => {
          if (entry === openLinearSrgbSdrFinalWebGpuPage) return { ok: false, failure: { code: "gpu_api_unavailable", message: "intentional page refusal" } };
          if (entry === closeLinearSrgbSdrFinalWebGpuPage) { pageCloseCalls += 1; return closeLinearSrgbSdrFinalWebGpuPage(); }
          throw new Error("unexpected page entrypoint");
        } },
        assessRender: async () => { throw new Error("assessment must not run"); },
        close: async () => { runtimeClosed = true; },
      } } as never)
    });
    if (!producer.ok) throw new Error(producer.refusal.message);
    await expect(producer.producer.produce({ admission: "pre-acquired", signal: new AbortController().signal, scratchRoot: "/tmp/strict-producer", maxProcessTreeRssBytes: 64 * 1024 * 1024, watchProcess() {} })).rejects.toThrow("intentional page refusal");
    expect({ runtimeClosed, pageCloseCalls }).toEqual({ runtimeClosed: true, pageCloseCalls: 1 });
    expect(producer.producer.evidence.cleanup).toEqual({ state: "complete", resourcesReleased: false, pageClosed: true, runtimeClosed: true });
  });

  it("binds shader source and pipeline identity before any page resource method can execute", async () => {
    let allocations = 0;
    (globalThis as Record<string, unknown>)[PAGE_STATE] = { device: { createShaderModule() { allocations += 1; }, createRenderPipeline() { allocations += 1; }, createTexture() { allocations += 1; }, createBuffer() { allocations += 1; }, createBindGroup() { allocations += 1; }, pushErrorScope() {}, async popErrorScope() { return null; }, queue: { writeBuffer() {} } }, limits: { maxTextureDimension2D: 2_048, maxBufferSize: 16 * 1024 * 1024 }, lost: false };
    (globalThis as Record<string, unknown>).GPUTextureUsage = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 };
    (globalThis as Record<string, unknown>).GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
    const result = await prepareLinearSrgbSdrFinalWebGpuPage({
      schema: "shellx-motion/linear-srgb-sdr-final-webgpu-page-input@1", routeFingerprint: "a".repeat(64), documentFingerprint: "b".repeat(64), pipelineImplementationSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256, shaderSourceSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.shaderSourceSha256,
      compositeWgsl: `${LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL}\n// altered`, encodeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL, canvas: { width: 1, height: 1, background: { hex: "#000000", r: 0, g: 0, b: 0 } }, rects: [],
    });
    expect(result).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    expect(allocations).toBe(0);
  });

  it("encodes padded rows across a base64 chunk boundary and releases all resources after destroy failures", async () => {
    const padded = Uint8Array.from({ length: 33_024 }, (_, index) => index % 251);
    let unmapped = 0, destroyed = 0;
    (globalThis as Record<string, unknown>)[PAGE_STATE] = {
      device: {
        createBuffer() { return { async mapAsync() {}, getMappedRange() { return padded.buffer; }, unmap() { unmapped += 1; }, destroy() { destroyed += 1; } }; },
        createCommandEncoder() { return { copyTextureToBuffer() {}, finish() { return {}; } }; }, queue: { submit() {}, async onSubmittedWorkDone() {} }
      }, limits: { maxBufferSize: 16 * 1024 * 1024 }, lost: false,
      resources: { routeFingerprint: "a".repeat(64), documentFingerprint: "b".repeat(64), publication: {}, width: 1, height: 129, paddedBytesPerRow: 256, tightByteLength: 516, paddedByteLength: 33_024, rendered: true }
    };
    (globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 1, MAP_READ: 2 };
    (globalThis as Record<string, unknown>).GPUMapMode = { READ: 1 };
    (globalThis as Record<string, unknown>).btoa = (value: string) => Buffer.from(value, "latin1").toString("base64");
    const readback = await readLinearSrgbSdrFinalWebGpuPage({ schema: "shellx-motion/linear-srgb-sdr-final-webgpu-page-readback@1", routeFingerprint: "a".repeat(64), documentFingerprint: "b".repeat(64) });
    expect(readback).toMatchObject({ ok: true, evidence: { mappedByteLength: 33_024, mappedBufferUnmapped: true, mappedBufferDestroyed: true } });
    if (!readback.ok) throw new Error(readback.failure.message);
    expect(Buffer.from(readback.paddedBase64, "base64")).toEqual(Buffer.from(padded));
    expect({ unmapped, destroyed }).toEqual({ unmapped: 1, destroyed: 1 });

    const calls: string[] = [];
    (globalThis as Record<string, unknown>)[PAGE_STATE] = { resources: { working: { destroy() { calls.push("working"); throw new Error("expected"); } }, publication: { destroy() { calls.push("publication"); } }, uniform: { destroy() { calls.push("uniform"); } }, gpuBytes: 12 } };
    expect(releaseLinearSrgbSdrFinalWebGpuPage()).toEqual({ hadResources: true, releasedGpuBytes: 12, remainingGpuBytes: 0, releaseFailed: true });
    expect(calls).toEqual(["working", "publication", "uniform"]);

    const closeCalls: string[] = [];
    (globalThis as Record<string, unknown>)[PAGE_STATE] = { resources: { working: { destroy() { closeCalls.push("working"); throw new Error("expected"); } }, publication: { destroy() { closeCalls.push("publication"); } }, uniform: { destroy() { closeCalls.push("uniform"); } } }, device: { destroy() { closeCalls.push("device"); } } };
    expect(closeLinearSrgbSdrFinalWebGpuPage()).toEqual({ deviceDestroyed: true, forcedResourceRelease: true, releaseFailed: true });
    expect(closeCalls).toEqual(["working", "publication", "uniform", "device"]);
  });
});

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
