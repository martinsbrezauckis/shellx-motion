import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import { inspectMotionRelations, removeMotionRelation, setMotionRelationEnabled, upsertMotionRelation } from "./motion-relation-authoring";
import { evaluateMotionRelationFrame } from "./motion-relation-evaluate";
import { compileMotionRelationFramePlan, compileMotionRelationStaticPlan } from "./motion-relation-plan";
import { motionRelationLaneRefusal, motionRelationStorePresent } from "./motion-relation-lane-refusal";
import { readMotionRelationStore } from "./motion-relation-read";
import { validateMotionRelations } from "./motion-relation-validate";
import type { MotionRelationBinding, MotionRelationDocument } from "./motion-relation-types";

describe("Core relation foundation", () => {
  it("reads only bounded descriptor data before accepting a persisted store", () => {
    let descriptors = 0, gets = 0, ownKeys = 0;
    const hostile = new Proxy({}, {
      ownKeys: () => { ownKeys += 1; return Array.from({ length: 10_000 }, (_, index) => `bad${index}`); },
      getOwnPropertyDescriptor: () => { descriptors += 1; return undefined; },
      get: () => { gets += 1; return undefined; },
    });
    expect(() => readMotionRelationStore(hostile)).toThrow("12-field record limit");
    expect({ ownKeys, descriptors, gets }).toEqual({ ownKeys: 1, descriptors: 0, gets: 0 });
    let reads = 0;
    const accessor = { schema: "shellx-motion/relations@1", bindings: [] as unknown[] };
    Object.defineProperty(accessor, "bindings", { enumerable: true, get() { reads += 1; return []; } });
    expect(() => readMotionRelationStore(accessor)).toThrow("enumerable data field");
    expect(reads).toBe(0);
    expect(() => readMotionRelationStore({ schema: "shellx-motion/relations@1", bindings: [attachment("a", "follow", { rotationDeg: 1 })] })).toThrow("follow requires");
  });

  it("uses a descriptor-only root presence sentinel before any lane admission", () => {
    expect(motionRelationStorePresent(document())).toBe(false);
    const relationDocument = document({ bindings: [attachment("follow", "follow")] });
    expect(motionRelationStorePresent(relationDocument)).toBe(true);
    expect(motionRelationLaneRefusal(relationDocument, "browser")).toMatchObject({ code: "motion_relations_unavailable" });
    let reads = 0;
    const hostile = {};
    Object.defineProperty(hostile, "relations", { enumerable: true, get() { reads += 1; return relationDocument.relations; } });
    expect(motionRelationStorePresent(hostile)).toBe(true);
    expect(reads).toBe(0);
  });

  it("reserves exact channel masks, rejects competing authorities and root ownership violations", () => {
    const keyed = document({ bindings: [attachment("follow", "follow")] });
    layer(keyed, "follower").keyframes = { "transform.x": [{ atMs: 0, value: 0 }] };
    expect(validateMotionRelations(keyed.relations, keyed)).toMatchObject({ ok: false, issues: [expect.objectContaining({ message: expect.stringContaining("transform.x") })] });

    const procedural = document({ bindings: [attachment("follow", "follow")] });
    procedural.relationships = { schema: "shellx-motion/procedural-relationships@1", relationships: [{ id: "drive", enabled: false, target: { layerId: "follower", property: "transform.y" }, nodes: [], outputNodeId: "none" }] };
    expect(validateMotionRelations(procedural.relations, procedural)).toMatchObject({ ok: false, issues: [expect.objectContaining({ message: expect.stringContaining("procedural") })] });

    const behavior = document({ bindings: [aim("aim")] });
    behavior.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "follower", enabled: false, kind: "transform", startUs: 0, durationUs: 1_000, motion: { kind: "gravity", velocityX: 0, velocityY: 0, gravityY: 0 } }] };
    expect(validateMotionRelations(behavior.relations, behavior)).toMatchObject({ ok: false, issues: [expect.objectContaining({ message: expect.stringContaining("behavior") })] });

    const groupChild = document({ bindings: [attachment("follow", "follow")] });
    groupChild.layers.push({ id: "group", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["follower"] });
    expect(validateMotionRelations(groupChild.relations, groupChild)).toMatchObject({ ok: false, issues: [expect.objectContaining({ message: expect.stringContaining("root-owned") })] });

    const overlap = document({ bindings: [attachment("follow", "follow"), attachment("similarity", "similarity")] });
    const overlapResult = validateMotionRelations(overlap.relations, overlap);
    expect(overlapResult.ok).toBe(false);
    if (!overlapResult.ok) expect(overlapResult.issues.some((issue) => issue.message.includes("overlaps"))).toBe(true);
    const disjoint = document({ bindings: [aim("aim"), attachment("follow", "follow")] });
    expect(validateMotionRelations(disjoint.relations, disjoint)).toMatchObject({ ok: true });
  });

  it("uses closed integer-microsecond intervals, deterministic attachment/aim math, and no hidden hold", () => {
    const motion = document({ bindings: [attachment("follow", "follow", { x: 5, y: 2 }), aim("look")] });
    const atStart = evaluateMotionRelationFrame(motion, 100);
    expect(layerFrom(atStart.layers, "follower").transform).toMatchObject({ x: 115, y: 57, rotation: -158.198591 });
    expect(atStart.samples.map((sample) => sample.id)).toEqual(["follow", "look"]);
    expect(layerFrom(evaluateMotionRelationFrame(motion, 300).layers, "follower").transform).toMatchObject({ x: 115, y: 57 });
    expect(layerFrom(evaluateMotionRelationFrame(motion, 301).layers, "follower").transform).toMatchObject({ x: 20, y: 30 });

    const similarity = document({ bindings: [attachment("attach", "similarity", { x: 10, y: 0, rotationDeg: 90, scale: 2 })] });
    expect(layerFrom(evaluateMotionRelationFrame(similarity, 100).layers, "follower").transform).toMatchObject({ x: 120, y: 55, scale: 2, rotation: 90 });

    const zeroAim = document({ bindings: [aim("look")] });
    layer(zeroAim, "leader").transform = { x: 10, y: 25, width: 10, height: 10 };
    expect(() => evaluateMotionRelationFrame(zeroAim, 100)).toThrow("zero-length");
    expect(() => evaluateMotionRelationFrame(motion, 100.5)).toThrow("safe integer microsecond");
  });

  it("orders source-to-target relation DAGs and rejects cycles regardless of enabled state", () => {
    const chain = document({ bindings: [
      attachment("first", "follow", { x: 3, y: 0 }, "leader", "middle"),
      attachment("second", "follow", { x: 4, y: 0 }, "middle", "follower"),
    ] });
    const evaluated = evaluateMotionRelationFrame(chain, 100);
    expect(evaluated.samples.map((sample) => sample.id)).toEqual(["first", "second"]);
    expect(layerFrom(evaluated.layers, "middle").transform?.x).toBe(113);
    expect(layerFrom(evaluated.layers, "follower").transform?.x).toBe(127);

    const cycle = document({ bindings: [
      attachment("first", "follow", {}, "leader", "middle"),
      attachment("second", "follow", {}, "middle", "leader"),
    ] });
    cycle.relations!.bindings[0]!.enabled = false;
    expect(validateMotionRelations(cycle.relations, cycle)).toMatchObject({ ok: false, issues: [expect.objectContaining({ message: expect.stringContaining("acyclic") })] });
  });

  it("binds static and frame identities separately and keeps Core authoring immutable", () => {
    const source = document();
    const inserted = upsertMotionRelation(source, { binding: attachment("follow", "follow") });
    expect(source.relations).toBeUndefined();
    expect(inserted.motion.relations?.bindings.map((binding) => binding.id)).toEqual(["follow"]);
    const inspection = inspectMotionRelations(inserted.motion);
    expect(Object.isFrozen(inspection.store)).toBe(true);
    const disabled = setMotionRelationEnabled(inserted.motion, { id: "follow", enabled: false });
    expect(disabled.motion.relations?.bindings[0]).toMatchObject({ enabled: false });
    expect(disabled.beforeSourceSha256).toBe(inserted.afterSourceSha256);
    const removed = removeMotionRelation(disabled.motion, { id: "follow" });
    expect(removed.motion.relations).toBeUndefined();
    expect(removed.afterSourceSha256).toBeNull();

    const relationMotion = inserted.motion;
    const first = compileMotionRelationStaticPlan(relationMotion), replay = compileMotionRelationStaticPlan(structuredClone(relationMotion));
    expect(first).toMatchObject({ ok: true }); expect(replay).toMatchObject({ ok: true });
    if (!first.ok || !replay.ok) return;
    expect(first.plan).toEqual(replay.plan);
    const frame = compileMotionRelationFramePlan(relationMotion, 100);
    expect(frame).toMatchObject({ ok: true, plan: { staticFingerprint: first.plan.fingerprint, budget: { activeBindingCount: 1 } } });

    const locked = structuredClone(relationMotion);
    layer(locked, "follower").locked = true;
    const before = canonicalJson(locked);
    expect(() => setMotionRelationEnabled(locked, { id: "follow", enabled: false })).toThrow("locked layer");
    expect(canonicalJson(locked)).toBe(before);
  });
});

function document(relations?: { bindings: MotionRelationBinding[] }): MotionRelationDocument {
  return {
    schema: "shellx-motion/motion@1", id: "relations", name: "Relations", durationMs: 1_000, fps: 30, width: 320, height: 180, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "leader", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, transform: { x: 100, y: 50, width: 10, height: 10 } },
      { id: "middle", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } },
      { id: "follower", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, transform: { x: 20, y: 30, width: 10, height: 10 } },
    ],
    ...(relations ? { relations: { schema: "shellx-motion/relations@1", bindings: relations.bindings } } : {}),
  };
}
function attachment(
  id: string,
  mode: "follow" | "similarity",
  offset: Partial<{ x: number; y: number; rotationDeg: number; scale: number }> = {},
  sourceLayerId = "leader",
  targetLayerId = "follower",
): Extract<MotionRelationBinding, { kind: "attach" }> {
  return {
    id, enabled: true, kind: "attach", mode, startUs: 100, durationUs: 200,
    source: { layerId: sourceLayerId, anchor: { x: 10, y: 5 } },
    target: { layerId: targetLayerId, anchor: { x: 0, y: 0 } },
    offset: { space: "source", x: offset.x ?? 0, y: offset.y ?? 0, rotationDeg: offset.rotationDeg ?? 0, scale: offset.scale ?? 1 },
  };
}
function aim(id: string): Extract<MotionRelationBinding, { kind: "aim" }> {
  return {
    id, enabled: true, kind: "aim", startUs: 100, durationUs: 200,
    source: { layerId: "leader", anchor: { x: 10, y: 5 } },
    target: { layerId: "follower", anchor: { x: 0, y: 0 } },
    rotationOffsetDeg: 0,
  };
}
function layer(document: MotionRelationDocument, id: string) { return layerFrom(document.layers, id); }
function layerFrom(layers: readonly MotionRelationDocument["layers"][number][], id: string) {
  const result = layers.find((item) => item.id === id);
  if (!result) throw new Error(`Missing ${id}`);
  return result;
}
