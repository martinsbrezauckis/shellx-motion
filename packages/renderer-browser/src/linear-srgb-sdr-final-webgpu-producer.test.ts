import { webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeGammaWrongEncodedLayers,
  composeGammaWrongEncodedSourceOver,
  composeLinearSrgbLayers,
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
  LINEAR_SRGB_SDR_FINAL_WEBGPU_LIMITS,
  LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE,
  LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER,
  linearSrgbSdrPublicationDitherEligible,
  linearSrgbSdrPublicationDitherOffset,
} from "./linear-srgb-sdr-final-webgpu-contract";
import {
  LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE,
  LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL,
} from "./linear-srgb-sdr-final-f2a-gradient-webgpu-contract";
import {
  LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PIPELINE,
} from "./linear-srgb-sdr-final-f2b-screen-webgpu-contract";
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
  LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PAGE_EXPECTED_PIPELINE_SHA256,
} from "./linear-srgb-sdr-final-webgpu-page";
import { createLinearSrgbSdrFinalWebGpuProducer, linearSrgbSdrFinalReferenceFrame, linearSrgbSdrPublicationGradientCoverage } from "./linear-srgb-sdr-final-webgpu-producer";

const REQUEST: LinearSrgbSdrFinalRouteRequest = Object.freeze({ target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264" });
const PAGE_STATE = "__shellxMotionLinearSrgbSdrFinalWebGpuV1";
const MUTATED_GLOBALS = ["GPUTextureUsage", "GPUBufferUsage", "GPUMapMode", "btoa"] as const;
const ORIGINAL_GLOBALS = new Map(MUTATED_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

function route(background: string, layers: ReadonlyArray<{ fill: string; opacity: number; blendMode?: "screen" }>): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "strict-colour", name: "Strict colour", durationMs: 1_000, fps: 30, width: 2, height: 2,
    background, colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: layers.map((layer, index): MotionLayer => ({ id: `rect-${index}`, type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, fill: layer.fill, opacity: layer.opacity, ...(layer.blendMode ? { blendMode: layer.blendMode } : {}), transform: { x: 0, y: 0, width: 2, height: 2 } })),
  };
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

function gradientRoute(): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "strict-gradient", name: "Strict gradient", durationMs: 1_000, fps: 30, width: 4, height: 2,
    background: "#000000", colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "ramp", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 1, gradient: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] }, transform: { x: 0, y: 0, width: 4, height: 2 } }],
  };
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

function gradientWithFlatOverlayRoute(opacity: number, blendMode?: "screen", fill = "#204060"): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "strict-gradient-overlay", name: "Strict gradient overlay", durationMs: 1_000, fps: 30, width: 4, height: 2,
    background: "#000000", colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "ramp", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 1, gradient: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] }, transform: { x: 0, y: 0, width: 4, height: 2 } },
      { id: "flat-overlay", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity, fill, ...(blendMode ? { blendMode } : {}), transform: { x: 0, y: 0, width: 4, height: 2 } },
    ],
  };
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

function mixedGradientRoute(): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "strict-mixed-gradient", name: "Strict mixed gradient", durationMs: 1_000, fps: 30, width: 4, height: 2,
    background: "#000000", colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "flat", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 1, fill: "#204060", transform: { x: 0, y: 0, width: 1, height: 2 } },
      { id: "ramp", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 1, gradient: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] }, transform: { x: 1, y: 0, width: 3, height: 2 } },
    ],
  };
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

function screenGradientRoute(): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "strict-screen-gradient", name: "Strict screen gradient", durationMs: 1_000, fps: 30, width: 4, height: 2,
    background: "#101820", colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "base", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 0.35, fill: "#204080", transform: { x: 0, y: 0, width: 4, height: 2 } },
      { id: "screen-ramp", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 0.45, blendMode: "screen", gradient: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#ff0040" }, { offset: 1, color: "#0066ff" }] }, transform: { x: 0, y: 0, width: 4, height: 2 } },
    ],
  };
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

function blackScreenGradientOverFlatRoute(): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "strict-black-screen-gradient", name: "Strict black screen gradient", durationMs: 1_000, fps: 30, width: 4, height: 2,
    background: "#204060", colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "screen-black", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, opacity: 1, blendMode: "screen", gradient: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#000000" }] }, transform: { x: 0, y: 0, width: 4, height: 2 } }],
  };
  const resolved = resolveLinearSrgbSdrFinalRoute(motion, REQUEST);
  if (!resolved.ok) throw new Error(resolved.refusal.message);
  return resolved.route;
}

function flatOnlyRoute(): LinearSrgbSdrFinalRoute {
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "strict-flat", name: "Strict flat", durationMs: 1_000, fps: 30, width: 4, height: 2,
    background: "#204060", colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" }, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "flat", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, fill: "#406080", opacity: 1, transform: { x: 1, y: 0, width: 3, height: 2 } }],
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
      expect([...actual.subarray(0, 4)]).toEqual([expected.r, expected.g, expected.b, expected.a].map((channel) => Math.round(channel * 255)));
      const wrongBytes = [wrong.r, wrong.g, wrong.b].map((channel) => Math.round(channel * 255));
      const linearDelta = Math.max(...(["r", "g", "b"] as const).map((channel) => Math.abs(expected[channel] - wrong[channel])));
      expect(linearDelta, `${vector.name} gamma-domain control must fail the declared linear composition`).toBeGreaterThan(0);
      if (vector.name !== "black-near-black") expect(Math.max(...wrongBytes.map((channel, index) => Math.abs(channel - actual[index]!))), vector.name).toBeGreaterThan(0);
    }
  });

  it("matches F2b premultiplied linear-light screen for partial alpha, zero alpha, and the encoded-domain control", () => {
    const vectors = [
      { name: "partial", background: "#0c1420", layers: [{ fill: "#204080", opacity: 0.18 }, { fill: "#ff5020", opacity: 0.31, blendMode: "screen" as const }] },
      { name: "zero-alpha", background: "#305070", layers: [{ fill: "#ff0080", opacity: 0, blendMode: "screen" as const }] },
    ] as const;
    for (const vector of vectors) {
      const admitted = route(vector.background, vector.layers);
      const actual = linearSrgbSdrFinalReferenceFrame(admitted);
      const inputs = [
        { fill: vector.background, opacity: 1, blendMode: "normal" as const },
        ...vector.layers.map((layer) => ({ ...layer, blendMode: ("blendMode" in layer ? layer.blendMode : "normal") as "normal" | "screen" })),
      ].map((layer) => {
        const parsed = parseCanonicalSrgbHex(layer.fill);
        if (!parsed) throw new Error("invalid test colour");
        return { ...parsed, a: layer.opacity, blendMode: layer.blendMode } as const;
      });
      const expected = composeLinearSrgbLayers(inputs);
      const wrong = composeGammaWrongEncodedLayers(inputs);
      expect([...actual.subarray(0, 4)]).toEqual([expected.r, expected.g, expected.b, expected.a].map((channel) => Math.round(channel * 255)));
      if (vector.name === "partial") expect(Math.max(...(["r", "g", "b"] as const).map((channel, index) => Math.abs(Math.round(wrong[channel] * 255) - actual[index]!)))).toBeGreaterThan(0);
      else expect([...actual.subarray(0, 4)]).toEqual([0x30, 0x50, 0x70, 0xff]);
    }
  });

  it("keeps the float working target, explicit source-over blend, and separate encoded COPY_SRC target structurally inspectable", () => {
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE).toMatchObject({
      workingTarget: { format: "rgba16float", usage: ["RENDER_ATTACHMENT", "TEXTURE_BINDING"], blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } },
      publicationTarget: { format: "rgba8unorm", usage: ["RENDER_ATTACHMENT", "COPY_SRC"] },
      ditherCoverageTarget: {
        format: "r8unorm", usage: ["RENDER_ATTACHMENT", "TEXTURE_BINDING"], composition: "visible-gradient-normal-screen-compositing",
        signal: { red: "normal-gradient-opacity-or-screen-gradient-maximum-premultiplied-linear-rgb" },
        normalFlatBlend: { color: { srcFactor: "zero", dstFactor: "one-minus-src" } },
        screenFlatBlend: { color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" } },
      },
      readback: { bufferUsage: ["COPY_DST", "MAP_READ"], rowAlignment: 256 },
    });
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.shaderSourceSha256).toBe(LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_EXPECTED_SHADER_SOURCE_SHA256);
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256).toBe(LINEAR_SRGB_SDR_FINAL_WEBGPU_PAGE_EXPECTED_PIPELINE_SHA256);
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL).toContain("srgbDecode");
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL).toContain("linear * alpha");
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL).toContain("premultiplied.rgb / premultiplied.a");
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL).toContain("srgbEncode");
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL).toContain("staticSpatialDither");
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL).toContain("var value = (u32(position.x) * 0x9e3779b9u) ^ (u32(position.y) * 0x85ebca6bu);");
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL).toContain("ditherMask");
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.publicationDither).toEqual(LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER);
  });

  it("uses one deterministic, sub-one-LSB scalar only for smooth gradient publication while flats and endpoints remain byte exact", () => {
    const first = linearSrgbSdrPublicationDitherOffset(37, 19);
    expect(linearSrgbSdrPublicationDitherOffset(37, 19)).toBe(first);
    expect(linearSrgbSdrPublicationDitherOffset(38, 19)).not.toBe(first);
    expect(new Set(Array.from({ length: 1_024 }, (_, x) => linearSrgbSdrPublicationDitherOffset(x, 19))).size).toBeGreaterThan(512);
    expect(Math.abs(first) * 255).toBeLessThanOrEqual(LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER.maxRgbOffsetLsb);
    const smooth = { gradientCoverage: 0.25, encodedRgb: [0.5, 0.5, 0.5] as const, alpha: 1, neighbouringEncodedRgb: [[0.501, 0.501, 0.501] as const] };
    expect(linearSrgbSdrPublicationDitherEligible(smooth)).toBe(true);
    expect(linearSrgbSdrPublicationDitherEligible({ ...smooth, gradientCoverage: 0 })).toBe(false);
    expect(linearSrgbSdrPublicationDitherEligible({ ...smooth, encodedRgb: [0, 0, 0] })).toBe(false);
    expect(linearSrgbSdrPublicationDitherEligible({ ...smooth, encodedRgb: [1, 1, 1] })).toBe(false);
    expect(linearSrgbSdrPublicationDitherEligible({ ...smooth, encodedRgb: [0.001, 0.5, 0.5] })).toBe(false);
    expect(linearSrgbSdrPublicationDitherEligible({ ...smooth, alpha: 0 })).toBe(false);
    expect(linearSrgbSdrPublicationDitherEligible({ ...smooth, neighbouringEncodedRgb: [[0.8, 0.8, 0.8]] })).toBe(false);

    const flat = linearSrgbSdrFinalReferenceFrame(flatOnlyRoute());
    expect([...flat]).toEqual([
      0x20, 0x40, 0x60, 0xff, 0x40, 0x60, 0x80, 0xff, 0x40, 0x60, 0x80, 0xff, 0x40, 0x60, 0x80, 0xff,
      0x20, 0x40, 0x60, 0xff, 0x40, 0x60, 0x80, 0xff, 0x40, 0x60, 0x80, 0xff, 0x40, 0x60, 0x80, 0xff,
    ]);
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_LIMITS.maxReferenceWorkingBytes).toBe(1920 * 1080 * 16);
  });

  it("composes visible gradient coverage correctly through normal and colour-dependent screen flats", () => {
    expect(linearSrgbSdrPublicationGradientCoverage(gradientRoute(), 1, 0)).toBe(1);
    expect(linearSrgbSdrPublicationGradientCoverage(gradientWithFlatOverlayRoute(0), 1, 0)).toBe(1);
    expect(linearSrgbSdrPublicationGradientCoverage(gradientWithFlatOverlayRoute(0.25), 1, 0)).toBe(0.75);
    expect(linearSrgbSdrPublicationGradientCoverage(gradientWithFlatOverlayRoute(1), 1, 0)).toBe(0);
    expect(linearSrgbSdrPublicationGradientCoverage(gradientWithFlatOverlayRoute(0, "screen"), 1, 0)).toBe(1);
    expect(linearSrgbSdrPublicationGradientCoverage(gradientWithFlatOverlayRoute(1, "screen", "#000000"), 1, 0)).toBe(1);
    expect(linearSrgbSdrPublicationGradientCoverage(gradientWithFlatOverlayRoute(1, "screen", "#0000ff"), 1, 0)).toBe(1);
    expect(linearSrgbSdrPublicationGradientCoverage(gradientWithFlatOverlayRoute(1, "screen", "#ffffff"), 1, 0)).toBe(0);
    expect(linearSrgbSdrPublicationGradientCoverage(gradientWithFlatOverlayRoute(1, "screen", "#204060"), 1, 0)).toBeGreaterThan(0.98);
    expect(linearSrgbSdrPublicationGradientCoverage(gradientWithFlatOverlayRoute(1, "screen", "#204060"), 1, 0)).toBeLessThan(1);
    expect(linearSrgbSdrPublicationGradientCoverage(gradientWithFlatOverlayRoute(0.25, "screen", "#204060"), 1, 0)).toBeGreaterThan(0.99);
    const blackScreenGradient = blackScreenGradientOverFlatRoute();
    expect(linearSrgbSdrPublicationGradientCoverage(blackScreenGradient, 1, 0)).toBe(0);
    expect(linearSrgbSdrFinalReferenceFrame(blackScreenGradient)).toEqual(Buffer.from([
      0x20, 0x40, 0x60, 0xff, 0x20, 0x40, 0x60, 0xff, 0x20, 0x40, 0x60, 0xff, 0x20, 0x40, 0x60, 0xff,
      0x20, 0x40, 0x60, 0xff, 0x20, 0x40, 0x60, 0xff, 0x20, 0x40, 0x60, 0xff, 0x20, 0x40, 0x60, 0xff,
    ]));
    expect(LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL).toContain("screenOcclusion = min(min(linear.r, linear.g), linear.b) * alpha");
    expect(LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL).toContain("screenOcclusion = min(min(linear.r, linear.g), linear.b) * alpha");
    expect(LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL).toContain("gradientCoverage = select(alpha, screenGradientCoverage, layer.center.z > 0.5)");
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

  it("binds the exact F2b screen pipeline only for screen draws while retaining normal-only evidence", () => {
    const normal = mixedGradientRoute();
    const screen = screenGradientRoute();
    const normalProducer = createLinearSrgbSdrFinalWebGpuProducer(normal);
    const screenProducer = createLinearSrgbSdrFinalWebGpuProducer(screen);
    if (!normalProducer.ok || !screenProducer.ok) throw new Error("expected admitted strict producers");
    expect(normalProducer.producer.evidence).not.toHaveProperty("screenPipeline");
    expect(screenProducer.producer.evidence).toMatchObject({
      screenPipeline: {
        schema: "shellx-motion/linear-srgb-sdr-final-f2b-screen-webgpu-pipeline@1",
        implementationSha256: LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PIPELINE.implementationSha256,
        composition: "premultiplied-linear-srgb-screen",
      },
    });
    expect(LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PIPELINE.implementationSha256).toBe(LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PAGE_EXPECTED_PIPELINE_SHA256);
    expect(LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PIPELINE).toMatchObject({
      flatBlend: { color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } },
      gradientBlend: { color: { srcFactor: "one", dstFactor: "one-minus-src", operation: "add" } },
      ditherCoverageBlend: { signal: { red: "normal-gradient-opacity-or-screen-gradient-maximum-premultiplied-linear-rgb", alpha: "screen-minimum-premultiplied-linear-rgb" }, flat: { color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" } }, gradient: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } },
    });
  });

  it("binds both mixed-scene pipeline identities into the completed evidence fingerprint", async () => {
    const route = screenGradientRoute(), padded = Buffer.alloc(512), pageCalls: string[] = [];
    const producer = createLinearSrgbSdrFinalWebGpuProducer(route, {
      openRuntime: async () => ({ ok: true, session: {
        browserProcess: { pid: 42, launcher: "precontained-direct-chromium", containment: { rootPid: 42, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 64 * 1024 * 1024 } },
        page: { evaluate: async (entry: unknown) => {
          if (entry === openLinearSrgbSdrFinalWebGpuPage) { pageCalls.push("open"); return { ok: true, runtime: {} }; }
          if (entry === prepareLinearSrgbSdrFinalWebGpuPage) { pageCalls.push("prepare"); return { ok: true }; }
          if (entry === renderLinearSrgbSdrFinalWebGpuPage) { pageCalls.push("render"); return { ok: true }; }
          if (entry === readLinearSrgbSdrFinalWebGpuPage) { pageCalls.push("read"); return { ok: true, paddedBase64: padded.toString("base64"), evidence: { bytesPerRow: 256, paddedByteLength: 512, tightByteLength: 32, mappedBufferUnmapped: true, mappedBufferDestroyed: true } }; }
          if (entry === releaseLinearSrgbSdrFinalWebGpuPage) { pageCalls.push("release"); return { hadResources: true, releasedGpuBytes: 872, remainingGpuBytes: 0, releaseFailed: false }; }
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
    expect(frame).toMatchObject({ width: 4, height: 2 });
    const evidence = producer.producer.evidence;
    expect(evidence).toMatchObject({
      pipeline: { schema: "shellx-motion/linear-srgb-sdr-final-webgpu-pipeline@1", implementationSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256 },
      gradientPipeline: { schema: "shellx-motion/linear-srgb-sdr-final-f2a-gradient-webgpu-pipeline@1", implementationSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.implementationSha256 },
      screenPipeline: { schema: "shellx-motion/linear-srgb-sdr-final-f2b-screen-webgpu-pipeline@1", implementationSha256: LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PIPELINE.implementationSha256 },
      cleanup: { state: "complete", resourcesReleased: true, pageClosed: true, runtimeClosed: true },
    });
    expect(evidence.fingerprint).toBe(canonicalJsonSha256({ ...evidence, fingerprint: undefined }));
    expect(evidence.fingerprint).not.toBe(canonicalJsonSha256({ ...evidence, gradientPipeline: undefined, fingerprint: undefined }));
    expect(evidence.fingerprint).not.toBe(canonicalJsonSha256({ ...evidence, screenPipeline: undefined, fingerprint: undefined }));
  });

  it("uses pixel-centre linear-light F2a gradient ramps in the isolated reference frame", () => {
    const frame = linearSrgbSdrFinalReferenceFrame(gradientRoute());
    expect(frame).toHaveLength(32);
    expect([...frame.subarray(0, 16)]).toEqual([
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
    expect(releaseLinearSrgbSdrFinalWebGpuPage()).toEqual({ hadResources: true, releasedGpuBytes: 872, remainingGpuBytes: 0, releaseFailed: false });
    expect(destroyed).toEqual(["texture-0", "texture-1", "texture-2", "buffer-0", "buffer-1"]);
  });

  it("refuses an unbound F2b screen pipeline before any page resource allocation", async () => {
    let allocations = 0;
    (globalThis as Record<string, unknown>)[PAGE_STATE] = {
      device: {
        createShaderModule() { allocations += 1; return {}; }, createRenderPipeline() { allocations += 1; return { getBindGroupLayout() { return {}; } }; }, createTexture() { allocations += 1; return { createView() { return {}; }, destroy() {} }; }, createBuffer() { allocations += 1; return { destroy() {} }; }, createBindGroup() { allocations += 1; return {}; }, pushErrorScope() {}, async popErrorScope() { return null; }, queue: { writeBuffer() {} },
      }, limits: { maxTextureDimension2D: 2_048, maxBufferSize: 16 * 1024 * 1024 }, lost: false,
    };
    (globalThis as Record<string, unknown>).GPUTextureUsage = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 };
    (globalThis as Record<string, unknown>).GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
    const route = screenGradientRoute();
    const result = await prepareLinearSrgbSdrFinalWebGpuPage({
      schema: "shellx-motion/linear-srgb-sdr-final-webgpu-page-input@1", routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint,
      pipelineImplementationSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256, shaderSourceSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.shaderSourceSha256,
      compositeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL, encodeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL,
      gradientPipelineImplementationSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.implementationSha256, gradientShaderSourceSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.shaderSourceSha256, gradientWgsl: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL,
      screenPipelineImplementationSha256: "0".repeat(64),
      canvas: { width: route.canvas.width, height: route.canvas.height, background: { ...route.canvas.background } },
      rects: route.rects.map((rect) => "fill" in rect ? { ...rect, fill: { ...rect.fill } } : { ...rect, gradient: { ...rect.gradient, stops: rect.gradient.stops.map((stop) => ({ offset: stop.offset, color: { ...stop.color } })) } }),
    });
    expect(result).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    expect(allocations).toBe(0);
  });

  it("serializes the F2b prepare evaluator without module lexical bindings", async () => {
    const route = screenGradientRoute();
    const context = createContext({
      Array, ArrayBuffer, Float32Array, Math, Number, Object, Promise, TextEncoder, Uint8Array, crypto: webcrypto,
      GPUTextureUsage: { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 },
      GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2 },
      [PAGE_STATE]: {
        device: {
          pushErrorScope() {}, async popErrorScope() { return null; },
          createShaderModule() { return {}; }, createRenderPipeline() { return { getBindGroupLayout() { return {}; } }; },
          createTexture() { return { createView() { return {}; }, destroy() {} }; }, createBuffer() { return { destroy() {} }; }, createBindGroup() { return {}; },
          queue: { writeBuffer() {} },
        },
        limits: { maxTextureDimension2D: 2_048, maxBufferSize: 16 * 1024 * 1024 }, lost: false,
      },
    });
    const serializedPrepare = runInContext(`(${prepareLinearSrgbSdrFinalWebGpuPage.toString()})`, context) as typeof prepareLinearSrgbSdrFinalWebGpuPage;
    const input = {
      schema: "shellx-motion/linear-srgb-sdr-final-webgpu-page-input@1" as const,
      routeFingerprint: route.fingerprint, documentFingerprint: route.documentFingerprint,
      pipelineImplementationSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256, shaderSourceSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.shaderSourceSha256,
      compositeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_COMPOSITE_WGSL, encodeWgsl: LINEAR_SRGB_SDR_FINAL_WEBGPU_ENCODE_WGSL,
      gradientPipelineImplementationSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.implementationSha256, gradientShaderSourceSha256: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_PIPELINE.shaderSourceSha256, gradientWgsl: LINEAR_SRGB_SDR_FINAL_F2A_GRADIENT_WEBGPU_WGSL,
      screenPipelineImplementationSha256: LINEAR_SRGB_SDR_FINAL_F2B_SCREEN_WEBGPU_PIPELINE.implementationSha256,
      canvas: { width: route.canvas.width, height: route.canvas.height, background: { ...route.canvas.background } },
      rects: route.rects.map((rect) => "fill" in rect ? { ...rect, fill: { ...rect.fill } } : { ...rect, gradient: { ...rect.gradient, stops: rect.gradient.stops.map((stop) => ({ offset: stop.offset, color: { ...stop.color } })) } }),
    };
    await expect(serializedPrepare(input)).resolves.toEqual({ ok: true });
  });

  it("selects the matching normal or F2b screen pipeline in exact document order", async () => {
    const normalFlat = { id: "normal-flat" }, screenFlat = { id: "screen-flat" }, normalGradient = { id: "normal-gradient" }, screenGradient = { id: "screen-gradient" }, encode = { id: "encode" };
    const selected: unknown[] = [];
    const pass = { setPipeline(value: unknown) { selected.push(value); }, setBindGroup() {}, draw() {}, end() {} };
    (globalThis as Record<string, unknown>)[PAGE_STATE] = {
      device: {
        createCommandEncoder() { return { beginRenderPass() { return pass; }, finish() { return {}; } }; },
        queue: { submit() {}, async onSubmittedWorkDone() {} },
      },
      resources: {
        routeFingerprint: "a".repeat(64), documentFingerprint: "b".repeat(64), working: { createView() { return {}; } }, publication: { createView() { return {}; } }, ditherMask: { createView() { return {}; } }, composite: normalFlat, screenComposite: screenFlat, gradientComposite: normalGradient, screenGradientComposite: screenGradient, encode, encodeGroup: {}, rendered: false,
        draws: [
          { kind: "flat", blendMode: "normal", group: {} }, { kind: "flat", blendMode: "screen", group: {} },
          { kind: "gradient", blendMode: "normal", group: {} }, { kind: "gradient", blendMode: "screen", group: {} },
        ],
      },
    };
    await expect(renderLinearSrgbSdrFinalWebGpuPage({ schema: "shellx-motion/linear-srgb-sdr-final-webgpu-page-readback@1", routeFingerprint: "a".repeat(64), documentFingerprint: "b".repeat(64) })).resolves.toEqual({ ok: true });
    expect(selected).toEqual([normalFlat, screenFlat, normalGradient, screenGradient, encode]);
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

  it("retains primary page refusal and concrete close uncertainty separately", async () => {
    const primary = new Error("intentional page refusal"); let structured = false, cleanup: Error | undefined, runtimeClosed = false, pageCloseCalls = 0;
    const producer = createLinearSrgbSdrFinalWebGpuProducer(route("#000000", []), {
      openRuntime: async () => ({ ok: true, session: {
        browserProcess: { pid: 42, launcher: "precontained-direct-chromium", containment: { rootPid: 42, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 64 * 1024 * 1024 } },
        page: { evaluate: async (entry: unknown) => { if (entry === openLinearSrgbSdrFinalWebGpuPage) { if (structured) return { ok: false, failure: { code: "gpu_api_unavailable", message: "structured page refusal" } }; throw primary; } if (entry === closeLinearSrgbSdrFinalWebGpuPage) { pageCloseCalls += 1; return closeLinearSrgbSdrFinalWebGpuPage(); } throw new Error("unexpected page entrypoint"); } },
        assessRender: async () => { throw new Error("assessment must not run"); },
        close: async () => { runtimeClosed = true; if (cleanup) throw cleanup; },
      } } as never)
    });
    if (!producer.ok) throw new Error(producer.refusal.message);
    const current = { admission: "pre-acquired" as const, signal: new AbortController().signal, scratchRoot: "/tmp/strict-producer", maxProcessTreeRssBytes: 64 * 1024 * 1024, watchProcess() {} };
    await expect(producer.producer.produce(current)).rejects.toBe(primary);
    expect({ runtimeClosed, pageCloseCalls }).toEqual({ runtimeClosed: true, pageCloseCalls: 1 });
    expect(producer.producer.evidence.cleanup).toEqual({ state: "complete", resourcesReleased: false, pageClosed: true, runtimeClosed: true });
    structured = true;
    await expect(producer.producer.produce(current)).rejects.toThrow("structured page refusal");
    structured = false; cleanup = new Error("held browser close failed");
    try { await producer.producer.produce(current); throw new Error("expected cleanup aggregation"); } catch (error) {
      expect(error).toBeInstanceOf(AggregateError); const [retainedPrimary, retainedCleanup] = (error as AggregateError).errors;
      expect(retainedPrimary).toBe(primary); expect(retainedCleanup).toBeInstanceOf(AggregateError); expect((retainedCleanup as AggregateError).errors).toEqual([cleanup]);
    }
  });
  it("closes an opener that resolves after abort without page or assessment work", async () => {
    const abort = new AbortController(); let resolveDeferred!: (value: never) => void, resolveStarted!: () => void, pages = 0, assessments = 0, closes = 0;
    const deferred = new Promise<never>((resolve) => { resolveDeferred = resolve; }), started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const producer = createLinearSrgbSdrFinalWebGpuProducer(route("#000000", []), { openRuntime: async () => { resolveStarted(); return await deferred; } }); if (!producer.ok) throw new Error(producer.refusal.message);
    const pending = producer.producer.produce({ admission: "pre-acquired", signal: abort.signal, scratchRoot: "/tmp/strict-producer", maxProcessTreeRssBytes: 64 * 1024 * 1024, watchProcess() {} });
    await started; abort.abort(new Error("deferred opener abort"));
    resolveDeferred({ ok: true, session: { page: { evaluate: async () => { pages += 1; } }, assessRender: async () => { assessments += 1; return {}; }, close: async () => { closes += 1; } } } as never);
    await expect(pending).rejects.toThrow("deferred opener abort");
    expect({ pages, assessments, closes }).toEqual({ pages: 0, assessments: 0, closes: 1 });
  });
  it("retains a concrete close failure after successful readback", async () => {
    const cleanup = new Error("held close failed"), padded = Buffer.alloc(512); for (const offset of [3, 7, 259, 263]) padded[offset] = 255;
    const producer = createLinearSrgbSdrFinalWebGpuProducer(route("#000000", []), { openRuntime: async () => ({ ok: true, session: {
      browserProcess: { pid: 42, launcher: "precontained-direct-chromium", containment: { rootPid: 42, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 64 * 1024 * 1024 } },
      page: { evaluate: async (entry: unknown) => {
        if (entry === openLinearSrgbSdrFinalWebGpuPage) return { ok: true, runtime: {} }; if (entry === prepareLinearSrgbSdrFinalWebGpuPage || entry === renderLinearSrgbSdrFinalWebGpuPage) return { ok: true };
        if (entry === readLinearSrgbSdrFinalWebGpuPage) return { ok: true, paddedBase64: padded.toString("base64"), evidence: { bytesPerRow: 256, paddedByteLength: 512, tightByteLength: 16, mappedBufferUnmapped: true, mappedBufferDestroyed: true } };
        if (entry === releaseLinearSrgbSdrFinalWebGpuPage) return { hadResources: true, releasedGpuBytes: 1, remainingGpuBytes: 0, releaseFailed: false }; return { deviceDestroyed: true, forcedResourceRelease: false, releaseFailed: false };
      } }, assessRender: async () => ({ ok: true, evidence: {} }), close: async () => { throw cleanup; },
    } } as never) });
    if (!producer.ok) throw new Error(producer.refusal.message);
    try { await producer.producer.produce({ admission: "pre-acquired", signal: new AbortController().signal, scratchRoot: "/tmp/strict-producer", maxProcessTreeRssBytes: 64 * 1024 * 1024, watchProcess() {} }); throw new Error("expected cleanup failure"); } catch (error) {
      expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual([cleanup]);
    }
    expect(producer.producer.evidence.cleanup).toEqual({ state: "failed", resourcesReleased: true, pageClosed: true, runtimeClosed: false });
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
    (globalThis as Record<string, unknown>)[PAGE_STATE] = { resources: { working: { destroy() { calls.push("working"); throw new Error("expected"); } }, publication: { destroy() { calls.push("publication"); } }, ditherMask: { destroy() { calls.push("ditherMask"); } }, uniform: { destroy() { calls.push("uniform"); } }, gpuBytes: 12 } };
    expect(releaseLinearSrgbSdrFinalWebGpuPage()).toEqual({ hadResources: true, releasedGpuBytes: 12, remainingGpuBytes: 0, releaseFailed: true });
    expect(calls).toEqual(["working", "publication", "ditherMask", "uniform"]);

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
