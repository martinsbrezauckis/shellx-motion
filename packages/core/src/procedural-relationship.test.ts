import { describe, expect, it } from "vitest";
import { bakeMotionProceduralRelationships } from "./procedural-relationship-bake";
import {
  detachMotionProceduralRelationship,
  setMotionProceduralRelationship,
  setMotionProceduralRelationshipEnabled,
} from "./procedural-relationship-authoring";
import { evaluateMotionProceduralLayers } from "./procedural-relationship-evaluate";
import { proceduralRelationshipGraphFingerprint } from "./procedural-relationship-fingerprint";
import { validateMotionProceduralGraph } from "./procedural-relationship-validate";
import { loadSchema, validateDocument } from "./validate";
import type { MotionDocument, MotionLayer } from "./types";
import type { MotionProceduralGraph, MotionProceduralRelationship } from "./procedural-relationship-types";

describe("deterministic procedural relationships", () => {
  it("evaluates dependency order, time, frame, audio, map, ease, distance, and seeded noise deterministically", () => {
    const motion = documentWith(graph([
      relationship("drive-x", "target", "transform.x", [
        { id: "time", type: "time", unit: "seconds" },
        { id: "two", type: "constant", value: 2 },
        { id: "out", type: "multiply", left: "time", right: "two" },
      ], "out"),
      relationship("follow-y", "target", "transform.y", [
        { id: "x", type: "property", ref: { layerId: "target", property: "transform.x" } },
        { id: "five", type: "constant", value: 5 },
        { id: "out", type: "add", left: "x", right: "five" },
      ], "out"),
      relationship("audio-opacity", "target", "opacity", [
        { id: "audio", type: "audio-envelope", envelopeId: "voice" },
        { id: "eased", type: "ease", input: "audio", easing: "ease-in-out" },
      ], "eased"),
      relationship("distance-blur", "target", "effects.blur", [
        { id: "x1", type: "constant", value: 0 }, { id: "y1", type: "constant", value: 0 },
        { id: "x2", type: "constant", value: 3 }, { id: "y2", type: "constant", value: 4 },
        { id: "distance", type: "distance", x1: "x1", y1: "y1", x2: "x2", y2: "y2" },
      ], "distance"),
      relationship("frame-rotation", "target", "transform.rotation", [
        { id: "frame", type: "frame" },
        { id: "min", type: "constant", value: 0 }, { id: "max", type: "constant", value: 12 },
        { id: "clamped", type: "clamp", input: "frame", min: "min", max: "max" },
      ], "clamped"),
      relationship("noise-scale", "target", "transform.scale", [
        { id: "time", type: "time", unit: "seconds" },
        { id: "noise", type: "noise", input: "time", seed: 42, frequency: 2 },
        { id: "in-min", type: "constant", value: -1 }, { id: "in-max", type: "constant", value: 1 },
        { id: "out-min", type: "constant", value: 0.9 }, { id: "out-max", type: "constant", value: 1.1 },
        { id: "mapped", type: "map", input: "noise", inMin: "in-min", inMax: "in-max", outMin: "out-min", outMax: "out-max", clamp: true },
      ], "mapped"),
    ], [{ id: "voice", sourceLayerId: "audio", channel: "mix", samples: [{ atMs: 0, value: 0 }, { atMs: 1000, value: 1 }] }]));

    const validation = validateMotionProceduralGraph(motion.relationships, motion);
    expect(validation.ok).toBe(true);
    expect(validation.relationshipOrder.indexOf("drive-x")).toBeLessThan(validation.relationshipOrder.indexOf("follow-y"));
    const first = evaluateMotionProceduralLayers(motion, 500);
    const second = evaluateMotionProceduralLayers(motion, 500);
    expect(second).toEqual(first);
    const target = first.layers.find((layer) => layer.id === "target")!;
    expect(target.transform).toMatchObject({ x: 1, y: 6, rotation: 12 });
    expect(target.opacity).toBe(0.5);
    expect(target.effects?.blur).toBe(5);
    expect(target.transform?.scale).toBe(first.values["noise-scale"]);
    expect(first.values["noise-scale"]).toBeGreaterThanOrEqual(0.9);
    expect(first.values["noise-scale"]).toBeLessThanOrEqual(1.1);
  });

  it("reports exact cycle, missing input, JavaScript-field, and unsupported-property paths", () => {
    const cyclic = graph([
      relationship("a", "target", "transform.x", [
        { id: "source", type: "property", ref: { layerId: "target", property: "transform.y" } },
      ], "source"),
      relationship("b", "target", "transform.y", [
        { id: "source", type: "property", ref: { layerId: "target", property: "transform.x" } },
      ], "source"),
    ]);
    const cycle = validateMotionProceduralGraph(cyclic, documentWith(cyclic));
    expect(cycle.issues).toContainEqual(expect.objectContaining({ path: "/relationships/relationships", code: "graph.cycle" }));

    const unsafe = graph([{
      ...relationship("bad", "target", "transform.x", [
        { id: "sum", type: "add", left: "missing", right: "missing", expression: "Math.random()" } as never,
      ], "sum"),
      target: { layerId: "target", property: "fill" } as never,
    }]);
    const invalid = validateMotionProceduralGraph(unsafe, documentWith(unsafe));
    expect(invalid.issues).toContainEqual(expect.objectContaining({ path: "/relationships/relationships/0/target/property", code: "property.unsupported" }));
    expect(invalid.issues).toContainEqual(expect.objectContaining({ path: "/relationships/relationships/0/nodes/0", code: "object.field" }));
    expect(invalid.issues).toContainEqual(expect.objectContaining({ path: "/relationships/relationships/0/nodes/0", code: "node.input_missing" }));
  });

  it("fingerprints semantically identical graphs independently of object key order", () => {
    const original = graph([relationship("drive", "target", "transform.x", [
      { id: "value", type: "constant", value: 12 },
    ], "value")]);
    const reordered = {
      relationships: original.relationships.map((item) => ({
        outputNodeId: item.outputNodeId,
        nodes: item.nodes.map((node) => ({ ...node })),
        target: { property: item.target.property, layerId: item.target.layerId },
        enabled: item.enabled,
        id: item.id,
      })),
      schema: original.schema,
    } as MotionProceduralGraph;
    expect(proceduralRelationshipGraphFingerprint(reordered))
      .toBe(proceduralRelationshipGraphFingerprint(original));
  });

  it("lets disabled relationships break dependency cycles while preserving readable data", () => {
    const value = graph([
      relationship("a", "target", "transform.x", [{ id: "source", type: "property", ref: { layerId: "target", property: "transform.y" } }], "source"),
      { ...relationship("b", "target", "transform.y", [{ id: "source", type: "property", ref: { layerId: "target", property: "transform.x" } }], "source"), enabled: false },
    ]);
    const validation = validateMotionProceduralGraph(value, documentWith(value));
    expect(validation.ok).toBe(true);
    expect(evaluateMotionProceduralLayers(documentWith(value), 0).values).toEqual({ a: 0 });
  });

  it("fails evaluation on dynamic divide-by-zero and map-zero-range outputs", () => {
    const divided = documentWith(graph([relationship("divide", "target", "transform.x", [
      { id: "one", type: "constant", value: 1 }, { id: "zero", type: "constant", value: 0 },
      { id: "out", type: "divide", left: "one", right: "zero" },
    ], "out")]));
    expect(() => evaluateMotionProceduralLayers(divided, 0)).toThrow("divides by zero");

    const mapped = documentWith(graph([relationship("map", "target", "transform.x", [
      { id: "value", type: "constant", value: 1 }, { id: "same", type: "constant", value: 2 },
      { id: "out-a", type: "constant", value: 0 }, { id: "out-b", type: "constant", value: 10 },
      { id: "mapped", type: "map", input: "value", inMin: "same", inMax: "same", outMin: "out-a", outMax: "out-b", clamp: true },
    ], "mapped")]));
    expect(() => evaluateMotionProceduralLayers(mapped, 0)).toThrow("zero input range");
  });

  it("authors, disables, re-enables, and detaches relationships with graph validation", () => {
    const seed = documentWith(graph([relationship("existing", "target", "transform.x", [
      { id: "one", type: "constant", value: 1 },
    ], "one")]));
    expect(() => setMotionProceduralRelationship(seed, seed.relationships!.relationships[0]))
      .toThrow("already matches");
    const blank = structuredClone(seed);
    delete blank.relationships;
    const inserted = setMotionProceduralRelationship(blank, relationship("new", "target", "transform.y", [
      { id: "two", type: "constant", value: 2 },
    ], "two"));
    expect(inserted.action).toBe("inserted");
    const disabled = setMotionProceduralRelationshipEnabled(inserted.motion, "new", false);
    expect(disabled.action).toBe("disabled");
    expect(disabled.motion.relationships?.relationships[0].enabled).toBe(false);
    expect(() => setMotionProceduralRelationshipEnabled(disabled.motion, "new", false))
      .toThrow("already disabled");
    const enabled = setMotionProceduralRelationshipEnabled(disabled.motion, "new", true);
    expect(enabled.action).toBe("enabled");
    const detached = detachMotionProceduralRelationship(enabled.motion, "new");
    expect(detached.action).toBe("detached");
    expect(detached.motion.relationships).toBeUndefined();
    expect(() => setMotionProceduralRelationship(blank, {
      ...relationship("unsafe", "target", "transform.x", [{ id: "one", type: "constant", value: 1 }], "one"),
      expression: "Math.random()",
    } as never)).toThrow("unsupported field");
    expect(() => bakeMotionProceduralRelationships(disabled.motion)).toThrow("at least one enabled relationship");
  });

  it("bakes to ordinary keyframes, detaches relationships, and fingerprints deterministically", () => {
    const motion = documentWith(graph([relationship("drive", "target", "transform.x", [
      { id: "time", type: "time", unit: "seconds" }, { id: "hundred", type: "constant", value: 100 },
      { id: "out", type: "multiply", left: "time", right: "hundred" },
    ], "out")]));
    const first = bakeMotionProceduralRelationships(motion, { endMs: 1000, sampleEveryFrames: 10 });
    const second = bakeMotionProceduralRelationships(motion, { endMs: 1000, sampleEveryFrames: 10 });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.motion.relationships).toBeUndefined();
    expect(first.motion.layers.find((layer) => layer.id === "target")?.keyframes?.["transform.x"]).toEqual([
      { atMs: 0, value: 0, easing: "linear" },
      { atMs: 333.333333, value: 33.3333, easing: "linear" },
      { atMs: 666.666667, value: 66.6667, easing: "linear" },
      { atMs: 1000, value: 100, easing: "linear" },
    ]);
    expect(motion.relationships?.relationships).toHaveLength(1);
    expect(() => bakeMotionProceduralRelationships(motion, { relationshipIds: [] }))
      .toThrow("must not be empty");
  });

  it("integrates relationship errors into the canonical motion schema validator", async () => {
    const value = documentWith(graph([relationship("bad", "missing", "transform.x", [
      { id: "one", type: "constant", value: Number.POSITIVE_INFINITY },
    ], "one")]));
    const validation = await validateDocument(await loadSchema("motion"), value);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.errors).toContainEqual({ path: "/relationships/relationships/0/target/layerId", message: "must reference an existing layer" });
      expect(validation.errors).toContainEqual({ path: "/relationships/relationships/0/nodes/0/value", message: "must be a bounded finite number" });
    }
  });
});

function relationship(
  id: string,
  layerId: string,
  property: MotionProceduralRelationship["target"]["property"],
  nodes: MotionProceduralRelationship["nodes"],
  outputNodeId: string,
): MotionProceduralRelationship {
  return { id, enabled: true, target: { layerId, property }, nodes, outputNodeId };
}

function graph(
  relationships: MotionProceduralRelationship[],
  audioEnvelopes?: MotionProceduralGraph["audioEnvelopes"],
): MotionProceduralGraph {
  return { schema: "shellx-motion/procedural-relationships@1", relationships, ...(audioEnvelopes ? { audioEnvelopes } : {}) };
}

function documentWith(relationships: MotionProceduralGraph): MotionDocument {
  const layers: MotionLayer[] = [
    { id: "audio", type: "audio", startMs: 0, durationMs: 2000, volume: 1 },
    { id: "source", type: "shape", startMs: 0, durationMs: 2000, transform: { x: 10, y: 20 } },
    { id: "target", type: "shape", startMs: 0, durationMs: 2000, transform: { x: 0, y: 0, scale: 1 } },
  ];
  return {
    schema: "shellx-motion/motion@1",
    id: "motion-procedural",
    name: "Procedural relationships",
    durationMs: 2000,
    fps: 30,
    width: 1920,
    height: 1080,
    relationships,
    layers,
    assets: [],
    provenance: { sourceApp: "fixture", createdBy: "test" },
  };
}
