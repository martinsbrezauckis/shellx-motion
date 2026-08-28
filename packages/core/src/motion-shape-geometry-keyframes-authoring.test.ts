import { describe, expect, it } from "vitest";
import {
  deleteMotionShapeGeometryKeyframe,
  inspectMotionShapeGeometryKeyframes,
  moveMotionShapeGeometryKeyframe,
  upsertMotionShapeGeometryKeyframe,
} from "./motion-shape-geometry-keyframes-authoring";
import {
  MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES,
  MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA,
} from "./motion-shape-geometry-keyframes";
import { evaluateMotionShapeGeometryLayerAtUs } from "./motion-shape-geometry-keyframes-at-us";
import { MOTION_SHAPE_GEOMETRY_SCHEMA } from "./motion-shape-geometry";
import { buildMotionPublicSchema } from "./motion-public-schema";
import { validateAgainstPublishedSchema } from "./published-schema-check";
import { listRendererCapabilityCards, matchRendererCapabilityCards, renderLanesFor } from "./capabilities";
import { effectiveLayerAtMs } from "./timeline";
import { loadSchema, validateDocument } from "./validate";
import type { MotionDocument, MotionLayer } from "./types";

const VIEW_BOX = { x: 0, y: 0, width: 100, height: 100 };

function geometry(y = 0): Record<string, unknown> {
  return {
    schema: MOTION_SHAPE_GEOMETRY_SCHEMA,
    kind: "line",
    viewBox: VIEW_BOX,
    points: [{ x: 0, y }, { x: 100, y }],
  };
}

function snapshot(atUs: number, y = 0, easing?: unknown): Record<string, unknown> {
  return { atUs, geometry: geometry(y), ...(easing === undefined ? {} : { easing }) };
}

function layer(extras: Record<string, unknown> = {}): MotionLayer {
  return {
    id: "shape", type: "shape", startMs: 0, durationMs: 1_000,
    geometry: geometry() as unknown as MotionLayer["geometry"],
    style: { stroke: "#ffffff", strokeWidth: 2, strokeLinejoin: "miter", strokeLinecap: "butt" },
    ...extras,
  };
}

function motion(value: MotionLayer = layer()): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "geometry-keys", name: "Geometry keys", durationMs: 1_000, fps: 25, width: 100, height: 100,
    layers: [value, { id: "other", type: "text", text: "unchanged", startMs: 0, durationMs: 1_000 }], assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  };
}

describe("shape geometry keyframe COW authoring", () => {
  it("persists exact-time snapshots, evaluates them through the shape-only Core hook, and leaves input unchanged", () => {
    const source = motion();
    const before = structuredClone(source);
    expect(inspectMotionShapeGeometryKeyframes(source, { layerId: "shape" })).toEqual({ layerId: "shape", geometryKeyframes: null, evaluation: null });

    const inserted = upsertMotionShapeGeometryKeyframe(source, { layerId: "shape", snapshot: snapshot(0, 0) as never });
    expect(inserted).toMatchObject({ action: "inserted", index: 0, changedPaths: ["/layers/shape/geometryKeyframes/keyframes"] });
    const second = upsertMotionShapeGeometryKeyframe(inserted.motion, { layerId: "shape", snapshot: snapshot(1_000, 20, "ease-in") as never });
    expect(second.layer.geometryKeyframes).toEqual({
      schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA,
      keyframes: [snapshot(0, 0), snapshot(1_000, 20, "ease-in")],
    });
    expect(evaluateMotionShapeGeometryLayerAtUs(second.layer, 500)).toMatchObject({ points: [{ y: 10 }, { y: 10 }] });
    expect(second.layer.geometry).toEqual(geometry());
    expect(source).toEqual(before);
    expect(second.motion.layers[1]).not.toBe(source.layers[1]);
  });

  it("replaces, moves, and deletes snapshots without allowing an empty record", () => {
    const initial = upsertMotionShapeGeometryKeyframe(motion(), { layerId: "shape", snapshot: snapshot(1_000, 10) as never });
    const replaced = upsertMotionShapeGeometryKeyframe(initial.motion, { layerId: "shape", snapshot: snapshot(1_000, 20, "ease-out") as never });
    expect(replaced).toMatchObject({ action: "replaced", index: 0 });
    const second = upsertMotionShapeGeometryKeyframe(replaced.motion, { layerId: "shape", snapshot: snapshot(2_000, 40) as never });
    const moved = moveMotionShapeGeometryKeyframe(second.motion, { layerId: "shape", fromAtUs: 2_000, toAtUs: 500 });
    expect(moved).toMatchObject({ action: "moved", previousIndex: 1, index: 0 });
    expect(moved.layer.geometryKeyframes?.keyframes.map((entry) => entry.atUs)).toEqual([500, 1_000]);
    const deleted = deleteMotionShapeGeometryKeyframe(moved.motion, { layerId: "shape", atUs: 500 });
    expect(deleted).toMatchObject({ action: "deleted", index: 0 });
    expect(() => deleteMotionShapeGeometryKeyframe(deleted.motion, { layerId: "shape", atUs: 1_000 })).toThrow("retain at least one");
  });

  it("fails closed on hostile inputs, cap overflow, and topology drift without changing the document", () => {
    const current = upsertMotionShapeGeometryKeyframe(motion(), { layerId: "shape", snapshot: snapshot(0) as never }).motion;
    const before = structuredClone(current);
    const hostile = snapshot(1);
    let getterCalls = 0;
    Object.defineProperty(hostile, "geometry", {
      configurable: true, enumerable: true,
      get: () => { getterCalls += 1; current.layers[0]!.geometry = geometry(99) as unknown as MotionLayer["geometry"]; return geometry(); },
    });
    expect(() => upsertMotionShapeGeometryKeyframe(current, { layerId: "shape", snapshot: hostile as never })).toThrow("enumerable data field");
    expect(getterCalls).toBe(0);
    expect(current).toEqual(before);

    const topologyChange = { atUs: 1, geometry: { ...geometry(), kind: "polygon", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] } };
    expect(() => upsertMotionShapeGeometryKeyframe(current, { layerId: "shape", snapshot: topologyChange as never })).toThrow("fixed geometry kind");
    expect(current).toEqual(before);

    const capped = structuredClone(current);
    capped.layers[0]!.geometryKeyframes = {
      schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA,
      keyframes: Array.from({ length: MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES }, (_value, index) => snapshot(index, index) as never),
    };
    const cappedBefore = structuredClone(capped);
    expect(() => upsertMotionShapeGeometryKeyframe(capped, { layerId: "shape", snapshot: snapshot(MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES, 40) as never })).toThrow("cannot exceed");
    expect(capped).toEqual(cappedBefore);
  });

  it("keeps generic effective layers feature-free while exact Core evaluation stays shape-only", () => {
    const staticLayer = layer();
    const staticBefore = structuredClone(staticLayer);
    expect(effectiveLayerAtMs(staticLayer, 0.5).geometry).toEqual(staticBefore.geometry);
    expect(staticLayer).toEqual(staticBefore);

    const animated = layer({ geometryKeyframes: { schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, keyframes: [snapshot(0, 0), snapshot(1_000, 20)] } });
    const animatedBefore = structuredClone(animated);
    // No generic lowerer is allowed to consume this field before a renderer-specific exact-atUs route exists.
    expect(effectiveLayerAtMs(animated, 0.5).geometry).toEqual(animatedBefore.geometry);
    expect(animated).toEqual(animatedBefore);
    expect(evaluateMotionShapeGeometryLayerAtUs(animated, 500)).toMatchObject({ points: [{ y: 10 }, { y: 10 }] });
    expect(() => evaluateMotionShapeGeometryLayerAtUs(animated, 0.1)).toThrow("safe integer");
    expect(() => evaluateMotionShapeGeometryLayerAtUs({ ...animated, type: "text" }, 0)).toThrow("only on shape layers");
  });

  it("type-gates the field in runtime validation and publishes only the source schema definition", async () => {
    const valid = motion(layer({ geometryKeyframes: { schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, keyframes: [snapshot(0, 0), snapshot(1_000, 20)] } }));
    expect(await validateDocument(await loadSchema("motion"), valid)).toEqual({ ok: true });

    const missingGeometry = motion(layer());
    delete missingGeometry.layers[0]!.geometry;
    missingGeometry.layers[0]!.geometryKeyframes = { schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, keyframes: [snapshot(0) as never] };
    const nonShape = motion({ ...layer({ geometryKeyframes: { schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, keyframes: [snapshot(0)] } }), type: "text" });
    const mismatched = motion(layer({ geometryKeyframes: { schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, keyframes: [snapshot(0, 0), { ...snapshot(1_000, 20), geometry: { ...geometry(20), viewBox: { ...VIEW_BOX, width: 90 } } }] } }));
    for (const value of [missingGeometry, nonShape, mismatched]) expect(await validateDocument(await loadSchema("motion"), value)).toMatchObject({ ok: false });
    const nonShapeValidation = await validateDocument(await loadSchema("motion"), nonShape);
    expect(nonShapeValidation.ok).toBe(false);
    if (nonShapeValidation.ok) throw new Error("Expected non-shape geometry keyframes to be refused.");
    expect(nonShapeValidation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/layers/0/geometryKeyframes", message: expect.stringContaining("only on shape") }),
    ]));

    const schema = buildMotionPublicSchema() as { $defs: Record<string, { properties?: Record<string, unknown>; allOf?: unknown[] }> };
    expect(schema.$defs.layer.properties?.geometryKeyframes).toEqual({ $ref: "#/$defs/shapeGeometryKeyframes" });
    expect(schema.$defs.shapeGeometryKeyframes).toMatchObject({
      properties: { schema: { const: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA }, keyframes: { minItems: 1, maxItems: MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES } },
    });
    expect(validateAgainstPublishedSchema(buildMotionPublicSchema(), valid)).toEqual([]);
  });

  it("advertises geometry keyframes only to the strict GPU source route", () => {
    const animated = motion(layer({ geometryKeyframes: { schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, keyframes: [snapshot(0), snapshot(1_000, 20)] } }));
    const cards = listRendererCapabilityCards().filter((card) => card.role === "frame-producer");
    expect(cards.filter((card) => card.features.includes("shape.geometry.keyframes")).map((card) => card.lane)).toEqual(["gpu"]);
    const matches = matchRendererCapabilityCards(animated, { output: "png-frame", target: "preview" }).matches;
    for (const lane of ["native", "browser", "ffmpeg"]) {
      expect(matches.find((match) => match.lane === lane)).toMatchObject({
        ok: false,
        unsupported: expect.arrayContaining([expect.objectContaining({ layerId: "shape", feature: "shape.geometry.keyframes" })]),
      });
    }
    const gpuOnly = { ...animated, layers: [animated.layers[0]!] };
    expect(matchRendererCapabilityCards(gpuOnly, { output: "png-frame", target: "preview" }).matches.find((match) => match.lane === "gpu")).toMatchObject({ ok: true, unsupported: [] });
    expect(renderLanesFor(gpuOnly)).toEqual(["gpu"]);
  });
});
