import { describe, expect, it } from "vitest";
import { matchRendererCapability, rendererCapabilityForLane, requiredLayerFeatures } from "./capabilities";
import { setTimelineLayerRichControl } from "./rich-controls";
import { effectiveLayerAtMs, upsertLayerKeyframe } from "./timeline";
import { loadSchema, validateDocument } from "./validate";
import type { MotionDocument, MotionLayer } from "./types";

describe("bounded path reveal", () => {
  it("accepts one stroked path, samples independent crossing tracks as an empty window, and refuses native", async () => {
    const layer = revealLayer({ start: 0.2, end: 0.8 });
    layer.keyframes = {
      "pathReveal.start": [{ atMs: 0, value: 0.2 }],
      "pathReveal.end": [{ atMs: 0, value: 0.8 }]
    };
    const motion = motionWith(layer);
    expect(await validateDocument(await loadSchema("motion"), motion)).toEqual({ ok: true });
    expect(requiredLayerFeatures(layer)).toEqual(expect.arrayContaining(["shape.path", "shape.path.reveal"]));
    expect(matchRendererCapability(motion, rendererCapabilityForLane("browser"))).toMatchObject({ ok: true, lane: "browser", unsupported: [] });
    const native = matchRendererCapability(motion, rendererCapabilityForLane("native"));
    expect(native).toMatchObject({ ok: false, lane: "native" });
    expect(native.unsupported).toEqual(expect.arrayContaining([
      expect.objectContaining({ layerId: "trace", feature: "shape.path.reveal" })
    ]));

    const withStart = upsertLayerKeyframe(layer, { target: "pathReveal.start", atMs: 500, value: 0.9 }).layer;
    const crossed = upsertLayerKeyframe(withStart, { target: "pathReveal.end", atMs: 500, value: 0.3 }).layer;
    expect(effectiveLayerAtMs(crossed, 500).pathReveal).toEqual({ start: 0.9, end: 0.3 });
  });

  it("rejects multi-subpath, missing visible stroke, and out-of-range scalars while preserving legacy paths", async () => {
    const schema = await loadSchema("motion");
    const legacy = revealLayer(undefined);
    expect(await validateDocument(schema, motionWith(legacy))).toEqual({ ok: true });

    const multi = revealLayer({ start: 0, end: 1 });
    multi["x-path"] = "M 0 50 H 40 M 60 50 H 100";
    const invisible = revealLayer({ start: 0, end: 1 });
    invisible.style = { stroke: "transparent", strokeWidth: 4 };
    const outside = revealLayer({ start: -0.01, end: 1 });

    for (const layer of [multi, invisible, outside]) {
      const result = await validateDocument(schema, motionWith(layer));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "/layers/0/pathReveal" })
      ]));
    }
  });

  it("rejects supported CSS Color 4 zero-alpha slash syntax while retaining a nonzero control", async () => {
    const schema = await loadSchema("motion");
    const rgbZeroAlpha = revealLayer({ start: 0, end: 1 });
    rgbZeroAlpha.style = { stroke: "rgb(120 255 255 / 0)", strokeWidth: 4 };
    const hslZeroAlpha = revealLayer({ start: 0, end: 1 });
    hslZeroAlpha.style = { stroke: "hsl(190 100% 50% / 0)", strokeWidth: 4 };
    const visibleControl = revealLayer({ start: 0, end: 1 });
    visibleControl.style = { stroke: "rgb(120 255 255 / 50%)", strokeWidth: 4 };

    for (const layer of [rgbZeroAlpha, hslZeroAlpha]) {
      const result = await validateDocument(schema, motionWith(layer));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "/layers/0/pathReveal", message: expect.stringContaining("non-transparent") })
      ]));
    }
    expect(await validateDocument(schema, motionWith(visibleControl))).toEqual({ ok: true });
  });

  it("lets the existing rich control initialize and edit either scalar without a two-field transaction", () => {
    const source = motionWith(revealLayer(undefined));
    const start = setTimelineLayerRichControl(source, { layerId: "trace", path: "pathReveal.start", value: 0.75 });
    expect(start.layer.pathReveal).toEqual({ start: 0.75, end: 1 });
    expect(source.layers[0].pathReveal).toBeUndefined();
    const end = setTimelineLayerRichControl(start.motion, { layerId: "trace", path: "pathReveal.end", value: 0.25 });
    expect(end.layer.pathReveal).toEqual({ start: 0.75, end: 0.25 });
    expect(() => setTimelineLayerRichControl(motionWith({ ...revealLayer(undefined), type: "text" }), {
      layerId: "trace", path: "pathReveal.end", value: 0.5
    })).toThrow("requires a shape path or freeform layer");
  });

  it("bounds path-reveal keyframes independently", () => {
    const layer = revealLayer({ start: 0, end: 1 });
    expect(() => upsertLayerKeyframe(layer, { target: "pathReveal.start", atMs: 0, value: -0.01 })).toThrow("between 0 and 1");
    expect(() => upsertLayerKeyframe(layer, { target: "pathReveal.end", atMs: 0, value: 1.01 })).toThrow("between 0 and 1");
  });
});

function revealLayer(pathReveal: MotionLayer["pathReveal"]): MotionLayer {
  return {
    id: "trace",
    type: "shape",
    shape: "path",
    startMs: 0,
    durationMs: 1_000,
    transform: { x: 0, y: 0, width: 100, height: 100 },
    "x-path": "M 0 50 H 100",
    "x-path-viewBox": "0 0 100 100",
    style: { fill: "transparent", stroke: "#8dfcff", strokeWidth: 4, strokeLinecap: "round" },
    ...(pathReveal ? { pathReveal } : {})
  };
}

function motionWith(layer: MotionLayer): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "path_reveal_probe",
    name: "Path reveal probe",
    durationMs: 1_000,
    fps: 30,
    width: 100,
    height: 100,
    background: "#000000",
    assets: [],
    layers: [layer],
    provenance: { sourceApp: "shellx-motion", createdBy: "path-reveal-test" }
  };
}
