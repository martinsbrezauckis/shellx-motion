import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { colorPipelineRenderPlan } from "./color-pipeline";
import { GPU_CAPABILITY, matchRendererCapability } from "./capabilities";
import {
  admitLinearSrgbSdrFinalMotion,
  composeGammaWrongEncodedSourceOver,
  composeLinearSrgbSourceOver,
  interpolateGammaWrongEncodedGradientStops,
  linearSrgbGradientPosition,
  parseCanonicalSrgbHex,
  resolveLinearSrgbSdrFinalRoute,
  sampleLinearSrgbGradient,
  type LinearSrgbSdrFinalRouteRequest,
} from "./linear-srgb-sdr-final-route";
import type { MotionDocument, MotionLayer } from "./types";

interface VectorFixture {
  schema: "shellx-motion/linear-srgb-sdr-vectors@1";
  vectors: Array<{
    name: string;
    layers: Array<{ fill: string; opacity: number }>;
    expectedStraightSrgb: Rgba;
    gammaWrongControl: Rgba & { minimumMaxChannelDelta: number };
  }>;
}
interface Rgba { r: number; g: number; b: number; a: number; }

interface GradientRampFixture {
  schema: "shellx-motion/linear-srgb-sdr-gradient-ramps@1";
  ramps: Array<{
    name: string;
    gradient: { type: "linear"; angle: number; stops: Array<{ offset: number; color: string }> } | { type: "radial"; centerX: number; centerY: number; stops: Array<{ offset: number; color: string }> };
    samples: Array<{ localX: number; localY: number; expectedStraightSrgb: Rgba; gammaWrongControl: Rgba & { minimumMaxChannelDelta: number } }>;
  }>;
}

const REQUEST: LinearSrgbSdrFinalRouteRequest = Object.freeze({
  target: "final",
  frameLane: "gpu",
  delivery: "streamed",
  finalLane: "ffmpeg",
  preset: "mp4-h264",
});

async function vectors(): Promise<VectorFixture> {
  return JSON.parse(await readFile(new URL("../../../fixtures/color-pipeline/f1-linear-srgb-sdr-vectors.json", import.meta.url), "utf8")) as VectorFixture;
}

async function catalogSample(): Promise<MotionDocument> {
  return JSON.parse(await readFile(new URL("../../../fixtures/packages/linear-srgb-sdr-final/motion.json", import.meta.url), "utf8")) as MotionDocument;
}

async function gradientRamps(): Promise<GradientRampFixture> {
  return JSON.parse(await readFile(new URL("../../../fixtures/color-pipeline/f2a-linear-srgb-sdr-gradient-ramps.json", import.meta.url), "utf8")) as GradientRampFixture;
}

function motion(overrides: Partial<MotionDocument> = {}): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "f1-linear-srgb-sdr",
    name: "Strict linear sRGB SDR",
    durationMs: 1000,
    fps: 30,
    width: 64,
    height: 48,
    background: "#000000",
    colorPipeline: { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1" },
    layers: [rect("accent", { x: 3, y: 4, width: 30, height: 20, fill: "#ff0040", opacity: 0.4 })],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "linear-srgb-sdr-final-route.test" },
    ...overrides,
  };
}

function staticMotion(overrides: Partial<MotionDocument> = {}): MotionDocument {
  const document = motion(overrides);
  return { ...document, layers: document.layers.map((layer) => ({ ...layer, durationMs: document.durationMs })) };
}

function rect(id: string, values: { x?: number; y?: number; width?: number; height?: number; fill?: string; opacity?: number } = {}): MotionLayer {
  const { x = 0, y = 0, width = 10, height = 10, fill = "#ffffff", opacity } = values;
  return {
    id,
    type: "shape",
    shape: "rect",
    startMs: 0,
    durationMs: 1000,
    fill,
    ...(opacity === undefined ? {} : { opacity }),
    transform: { x, y, width, height },
  };
}

function gradientRect(id: string, gradient: GradientRampFixture["ramps"][number]["gradient"], values: { x?: number; y?: number; width?: number; height?: number; opacity?: number } = {}): MotionLayer {
  const { x = 0, y = 0, width = 10, height = 10, opacity } = values;
  return {
    id, type: "shape", shape: "rect", startMs: 0, durationMs: 1000,
    gradient,
    ...(opacity === undefined ? {} : { opacity }),
    transform: { x, y, width, height },
  };
}

function admitted(document: MotionDocument, request: LinearSrgbSdrFinalRouteRequest = REQUEST) {
  const result = resolveLinearSrgbSdrFinalRoute(document, request);
  if (!result.ok) throw new Error(result.refusal.message);
  return result.route;
}

function expectRefusal(document: MotionDocument, request: LinearSrgbSdrFinalRouteRequest = REQUEST): void {
  const result = resolveLinearSrgbSdrFinalRoute(document, request);
  expect(result).toMatchObject({ ok: false, refusal: { code: "linear_srgb_sdr_final_unsupported" } });
}

describe("strict linear-srgb-sdr final route", () => {
  it("materializes a detached deep-frozen Motion snapshot before route field reads or fingerprints", () => {
    const source = motion();
    const admission = admitLinearSrgbSdrFinalMotion(source);
    expect(admission.ok).toBe(true);
    if (!admission.ok) throw new Error(admission.message);
    source.layers[0]!.fill = "#ffffff";
    expect(admission.motion.layers[0]?.fill).toBe("#ff0040");
    expect(Object.isFrozen(admission.motion)).toBe(true);
    expect(Object.isFrozen(admission.motion.layers)).toBe(true);
    expect(Object.isFrozen(admission.motion.layers[0]!)).toBe(true);
  });

  it("refuses accessors and reflection-failing proxy Motion data without executing a getter", () => {
    const getter = motion() as unknown as Record<string, unknown>;
    let getterReads = 0;
    Object.defineProperty(getter, "colorPipeline", { enumerable: true, get() { getterReads += 1; return undefined; } });
    expectRefusal(getter as unknown as MotionDocument, { ...REQUEST, target: "preview" } as never);
    expect(getterReads).toBe(0);
    expectRefusal(getter as unknown as MotionDocument);
    expect(getterReads).toBe(0);

    let reflections = 0;
    const proxy = new Proxy(motion(), { ownKeys() { reflections += 1; throw new Error("hostile reflection"); } });
    expectRefusal(proxy);
    expect(reflections).toBe(1);
  });

  it("creates an immutable canonical GPU-to-FFmpeg plan while direct GPU matching remains closed", () => {
    const source = motion();
    const before = structuredClone(source);
    const route = admitted(source);

    expect(route).toMatchObject({
      schema: "shellx-motion/linear-srgb-sdr-final-route@1",
      admission: {
        target: "final", frameLane: "gpu", delivery: "streamed", finalLane: "ffmpeg", preset: "mp4-h264",
        composition: "normal-source-over-document-order", working: "premultiplied-linear-srgb-rgba16float", frameBoundary: "straight-srgb-rgba8",
      },
      canvas: { width: 64, height: 48, background: { hex: "#000000" } },
      rects: [{ id: "accent", x: 3, y: 4, width: 30, height: 20, fill: { hex: "#ff0040" }, opacity: 0.4 }],
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.rects)).toBe(true);
    expect(source).toEqual(before);

    const reordered = {
      layers: source.layers, width: source.width, name: source.name, schema: source.schema, id: source.id,
      fps: source.fps, durationMs: source.durationMs, height: source.height, background: source.background,
      assets: source.assets, provenance: source.provenance, colorPipeline: source.colorPipeline,
    } as MotionDocument;
    expect(admitted(reordered).fingerprint).toBe(route.fingerprint);
    expect(admitted(motion({ layers: [rect("accent", { x: 3, y: 4, width: 30, height: 20, fill: "#ff0040", opacity: 0.41 })] })).fingerprint).not.toBe(route.fingerprint);

    expect(colorPipelineRenderPlan(source).admission).toBe("strict-route-available");
    expect(matchRendererCapability(source, GPU_CAPABILITY)).toMatchObject({ ok: false, unsupported: [expect.objectContaining({ feature: "color-pipeline:linear-srgb-sdr@1" })] });
  });

  it("keeps the public catalog package on the exact strict route", async () => {
    const sample = await catalogSample();
    const route = admitted(sample);
    expect(route.canvas).toMatchObject({ width: 1280, height: 720, durationMs: 2000, fps: 30 });
    expect(route.rects).toHaveLength(8);
    expect(route.rects.map((rect) => rect.id)).toEqual([
      "stage", "near_black", "highlight", "cyan_base", "magenta_overlay", "amber_overlay", "shadow_patch", "mid_patch",
    ]);
  });

  it("refuses every lane, delivery, target, and preset deviation before later route work", () => {
    for (const request of [
      { ...REQUEST, target: "preview" }, { ...REQUEST, frameLane: "browser" }, { ...REQUEST, delivery: "materialized" },
      { ...REQUEST, finalLane: "native" }, { ...REQUEST, preset: "mp4-hevc" }, { ...REQUEST, extra: true },
    ]) expectRefusal(motion(), request as never);
    expectRefusal(motion({ colorPipeline: undefined }));
  });

  it("returns a typed refusal for every malformed or extended colorPipeline declaration", () => {
    const declarations: unknown[] = [
      undefined, null, [], "linear-srgb-sdr@1",
      { schema: "shellx-motion/color-pipeline@1" },
      { intent: "linear-srgb-sdr@1" },
      { schema: "wrong", intent: "linear-srgb-sdr@1" },
      { schema: "shellx-motion/color-pipeline@1", intent: "legacy-encoded-sdr@0.2.65" },
      { schema: "shellx-motion/color-pipeline@1", intent: "linear-srgb-sdr@1", extra: true },
    ];
    for (const colorPipeline of declarations) {
      const document = motion({ colorPipeline } as never);
      expect(() => resolveLinearSrgbSdrFinalRoute(document, REQUEST)).not.toThrow();
      expectRefusal(document);
    }
  });

  it("requires non-empty root id/name and exactly sourceApp/createdBy provenance", () => {
    const documents: MotionDocument[] = [
      motion({ id: 42 as never }),
      motion({ name: "" }),
      motion({ provenance: [] as never }),
      motion({ provenance: "f1" as never }),
      motion({ provenance: { sourceApp: "", createdBy: "f1" } }),
      motion({ provenance: { sourceApp: "shellx-motion", createdBy: "" } }),
      motion({ provenance: { sourceApp: "shellx-motion", createdBy: "f1", workflow: "extra" } }),
    ];
    for (const document of documents) expectRefusal(document);
  });

  it("uses the shared document frame and pixel-frame budget before future allocation", () => {
    const atF1AndSharedBoundary = staticMotion({ width: 1_920, height: 1_080, fps: 120, durationMs: 300_000 });
    expect(admitted(atF1AndSharedBoundary).canvas).toMatchObject({ width: 1_920, height: 1_080, fps: 120, durationMs: 300_000 });

    const oneFrameOver = resolveLinearSrgbSdrFinalRoute(staticMotion({ width: 1_920, height: 1_080, fps: 120, durationMs: 300_001 }), REQUEST);
    expect(oneFrameOver).toMatchObject({ ok: false, refusal: { message: expect.stringContaining("36000 frames") } });
    expectRefusal(staticMotion({ fps: 1_000_000, durationMs: 1_000 }));
    expectRefusal(staticMotion({ fps: 1, durationMs: 36_000_001 }));
  });

  it("refuses assets, timeline authority, non-rect layers, aliases, transforms, styles, and out-of-bounds geometry", () => {
    const ordinary = rect("accent");
    const cases: MotionDocument[] = [
      motion({ assets: [{ id: "asset" }] }),
      motion({ audio: {} as never }), motion({ scenes: [] }), motion({ tracks: [] }),
      motion({ layers: [{ ...ordinary, type: "group", childLayerIds: [] }] }),
      motion({ layers: [{ ...ordinary, shape: "ellipse" }] }),
      motion({ layers: [{ ...ordinary, startMs: 1 }] }),
      motion({ layers: [{ ...ordinary, durationMs: 999 }] }),
      motion({ layers: [{ ...ordinary, width: 10 } as never] }),
      motion({ layers: [{ ...ordinary, color: "#ffffff" } as never] }),
      motion({ layers: [{ ...ordinary, geometry: {} } as never] }),
      motion({ layers: [{ ...ordinary, style: { fill: "#ffffff" } } as never] }),
      motion({ layers: [{ ...ordinary, gradient: {} } as never] }),
      motion({ layers: [{ ...ordinary, effects: {} } as never] }),
      motion({ layers: [{ ...ordinary, mask: {} } as never] }),
      motion({ layers: [{ ...ordinary, keyframes: {} } as never] }),
      motion({ layers: [{ ...ordinary, transform: { ...ordinary.transform!, scale: 1 } }] }),
      motion({ layers: [{ ...ordinary, transform: { x: 0, y: 0, width: 10.5, height: 10 } }] }),
      motion({ layers: [{ ...ordinary, transform: { x: 60, y: 0, width: 10, height: 10 } }] }),
      motion({ layers: Array.from({ length: 65 }, (_, index) => rect(`rect-${index}`)) }),
    ];
    for (const document of cases) expectRefusal(document);
  });

  it("accepts only lower-case six-digit fills and top-level bounded opacity as the source alpha", () => {
    expect(admitted(motion({ layers: [rect("alpha", { fill: "#112233", opacity: 0.4 })] })).rects[0]?.opacity).toBe(0.4);
    expect(admitted(motion({ layers: [rect("opaque", { fill: "#112233" })] })).rects[0]?.opacity).toBe(1);
    for (const layer of [
      rect("upper", { fill: "#AABBCC" }), rect("alpha-hex", { fill: "#aabbcc80" }),
      rect("low", { opacity: -0.01 }), rect("high", { opacity: 1.01 }),
      { ...rect("transform-alpha"), transform: { x: 0, y: 0, width: 10, height: 10, opacity: 0.5 } } as never,
    ]) expectRefusal(motion({ layers: [layer] }));
    expect(parseCanonicalSrgbHex("#aabbcc")).toMatchObject({ r: 170 / 255, g: 187 / 255, b: 204 / 255 });
    expect(parseCanonicalSrgbHex("#abc")).toBeNull();
  });

  it("admits only static rectangular F2a linear and radial gradients on the exact strict final route", () => {
    const linear = gradientRect("linear", { type: "linear", angle: 90, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] }, { x: 1, y: 1, width: 20, height: 10, opacity: 0.6 });
    const radial = gradientRect("radial", { type: "radial", centerX: 0.5, centerY: 0.5, stops: [{ offset: 0, color: "#101820" }, { offset: 0.5, color: "#00ff40" }, { offset: 1, color: "#ffffff" }] }, { x: 24, y: 1, width: 20, height: 10 });
    const route = admitted(motion({ layers: [linear, radial] }));
    expect(route.rects).toMatchObject([
      { id: "linear", opacity: 0.6, gradient: { type: "linear", angleDeg: 90, stops: [{ offset: 0, color: { hex: "#000000" } }, { offset: 1, color: { hex: "#ffffff" } }] } },
      { id: "radial", gradient: { type: "radial", centerX: 0.5, centerY: 0.5, stops: [{ offset: 0 }, { offset: 0.5 }, { offset: 1 }] } },
    ]);
    expect(colorPipelineRenderPlan(motion({ layers: [linear, radial] })).admission).toBe("strict-route-available");
  });

  it("fails closed for every non-F2a gradient spelling, animation, paint mix, stop ambiguity, or non-rect route extension", () => {
    const valid: Extract<GradientRampFixture["ramps"][number]["gradient"], { type: "linear" }> = { type: "linear", angle: 90, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#ffffff" }] };
    const cases: MotionLayer[] = [
      { ...gradientRect("fill-and-gradient", valid), fill: "#ffffff" },
      gradientRect("missing-angle", { type: "linear", stops: valid.stops } as never),
      gradientRect("linear-center", { ...valid, centerX: 0.5 } as never),
      gradientRect("radial-angle", { type: "radial", centerX: 0.5, centerY: 0.5, angle: 90, stops: valid.stops } as never),
      gradientRect("offset-start", { ...valid, stops: [{ offset: 0.1, color: "#000000" }, { offset: 1, color: "#ffffff" }] }),
      gradientRect("offset-end", { ...valid, stops: [{ offset: 0, color: "#000000" }, { offset: 0.9, color: "#ffffff" }] }),
      gradientRect("offset-repeat", { ...valid, stops: [{ offset: 0, color: "#000000" }, { offset: 0, color: "#808080" }, { offset: 1, color: "#ffffff" }] }),
      gradientRect("color-alias", { ...valid, stops: [{ offset: 0, color: "rgb(0 0 0)" }, { offset: 1, color: "#ffffff" }] }),
      { ...gradientRect("keyframes", valid), keyframes: {} },
      { ...gradientRect("wrong-shape", valid), shape: "ellipse" },
    ];
    for (const layer of cases) expectRefusal(motion({ layers: [layer] }));
  });

  it("matches isolated F2a linear-light gradient ramps and rejects encoded-domain controls", async () => {
    const fixture = await gradientRamps();
    expect(fixture.schema).toBe("shellx-motion/linear-srgb-sdr-gradient-ramps@1");
    for (const ramp of fixture.ramps) {
      const route = admitted(motion({ layers: [gradientRect("ramp", ramp.gradient)] }));
      const rect = route.rects[0];
      if (!rect || !("gradient" in rect)) throw new Error(`fixture ${ramp.name} did not resolve to a gradient`);
      for (const sample of ramp.samples) {
        const actual = sampleLinearSrgbGradient(rect.gradient, sample.localX, sample.localY);
        const wrong = interpolateGammaWrongEncodedGradientStops(rect.gradient.stops, linearSrgbGradientPosition(rect.gradient, sample.localX, sample.localY));
        for (const channel of ["r", "g", "b", "a"] as const) {
          expect(actual[channel], `${ramp.name}:${sample.localX},${sample.localY}:${channel}`).toBeCloseTo(sample.expectedStraightSrgb[channel], 12);
          expect(wrong[channel], `${ramp.name}:${sample.localX},${sample.localY}:gamma-wrong:${channel}`).toBeCloseTo(sample.gammaWrongControl[channel], 12);
        }
        const delta = Math.max(...(["r", "g", "b"] as const).map((channel) => Math.abs(actual[channel] - wrong[channel])));
        expect(delta, `${ramp.name} must not resolve through encoded-domain interpolation`).toBeGreaterThanOrEqual(sample.gammaWrongControl.minimumMaxChannelDelta);
      }
    }
  });

  it("matches exact linear source-over vectors and rejects the gamma-wrong control", async () => {
    const fixture = await vectors();
    expect(fixture.schema).toBe("shellx-motion/linear-srgb-sdr-vectors@1");
    for (const vector of fixture.vectors) {
      const layers = vector.layers.map((layer) => {
        const parsed = parseCanonicalSrgbHex(layer.fill);
        if (!parsed) throw new Error(`fixture ${vector.name} has a non-canonical fill`);
        return { r: parsed.r, g: parsed.g, b: parsed.b, a: layer.opacity };
      });
      const actual = composeLinearSrgbSourceOver(layers);
      const wrong = composeGammaWrongEncodedSourceOver(layers);
      for (const channel of ["r", "g", "b", "a"] as const) {
        expect(actual[channel], `${vector.name}:${channel}`).toBeCloseTo(vector.expectedStraightSrgb[channel], 12);
        expect(wrong[channel], `${vector.name}:gamma-wrong:${channel}`).toBeCloseTo(vector.gammaWrongControl[channel], 12);
      }
      const maxDelta = Math.max(...(["r", "g", "b"] as const).map((channel) => Math.abs(actual[channel] - wrong[channel])));
      expect(maxDelta, `${vector.name} must fail an encoded-domain source-over implementation`).toBeGreaterThanOrEqual(vector.gammaWrongControl.minimumMaxChannelDelta);
    }
  });
});
