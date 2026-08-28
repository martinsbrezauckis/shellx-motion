import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import { detachMotionRelation, upsertMotionRelation } from "./motion-relation-authoring";
import { bakeMotionRelation, MAX_MOTION_RELATION_BAKE_KEYFRAMES, MAX_MOTION_RELATION_BAKE_SAMPLES } from "./motion-relation-bake";
import { motionRelationLaneRefusal } from "./motion-relation-lane-refusal";
import { validateMotionRelations } from "./motion-relation-validate";
import type { MotionRelationDocument } from "./motion-relation-types";

describe("relation sampled bake and detach", () => {
  it("atomically materializes a full inclusive millisecond grid as linear ordinary keyframes", () => {
    const source = document();
    layer(source, "leader").keyframes = { "transform.x": [{ atMs: 0, value: 10 }, { atMs: 4, value: 30 }] };
    const result = bakeMotionRelation(source, { id: "follow", sampleEveryUs: 2_000 });
    const follower = layer(result.motion, "follower");

    expect(source.relations).toBeDefined();
    expect(result).toMatchObject({ relationId: "follow", startUs: 0, endUs: 4_000, sampleEveryUs: 2_000, sampleCount: 3, keyframeCount: 6, bakeSemantics: "sampled_not_equivalent_between_samples" });
    expect(follower.keyframes).toMatchObject({
      "transform.x": [{ atMs: 0, value: 10, easing: "linear" }, { atMs: 2, value: 20, easing: "linear" }, { atMs: 4, value: 30, easing: "linear" }],
      "transform.y": [{ atMs: 0, value: 5, easing: "linear" }, { atMs: 2, value: 5, easing: "linear" }, { atMs: 4, value: 5, easing: "linear" }],
    });
    expect(result.motion.relations).toBeUndefined();
    expect(validateMotionRelations(result.motion.relations, result.motion)).toMatchObject({ ok: true });
    expect(motionRelationLaneRefusal(result.motion, "browser")).toBeUndefined();
  });

  it("refuses non-representable sample strides, disabled relations, and over-budget grids before COW output", () => {
    expect(() => bakeMotionRelation(document(), { id: "follow", sampleEveryUs: 1_001 })).toThrow("whole-millisecond");
    const disabled = document();
    disabled.relations!.bindings[0]!.enabled = false;
    expect(() => bakeMotionRelation(disabled, { id: "follow", sampleEveryUs: 1_000 })).toThrow("enabled");

    const oversized = document(3_600, 3_600_000);
    expect(() => bakeMotionRelation(oversized, { id: "follow", sampleEveryUs: 1_000 })).toThrow(`${MAX_MOTION_RELATION_BAKE_SAMPLES}`);
    expect(MAX_MOTION_RELATION_BAKE_KEYFRAMES).toBe(14_400);
  });

  it("refuses before, after, and partial relation intervals without changing the source", () => {
    for (const [label, startUs, durationUs] of [
      ["before", 1_000, 3_000],
      ["after", 0, 3_000],
      ["partial", 1_000, 2_000],
    ] as const) {
      const source = document();
      source.relations!.bindings[0]!.startUs = startUs;
      source.relations!.bindings[0]!.durationUs = durationUs;
      const before = canonicalJson(source);
      expect(() => bakeMotionRelation(source, { id: "follow", sampleEveryUs: 1_000 }), label)
        .toThrow("full document coverage exactly (startUs=0 and endUs=4000)");
      expect(canonicalJson(source), label).toBe(before);
    }
  });

  it("respects target layer and track locks and leaves inputs unchanged on refusal", () => {
    const locked = document();
    layer(locked, "follower").locked = true;
    const before = canonicalJson(locked);
    expect(() => bakeMotionRelation(locked, { id: "follow", sampleEveryUs: 1_000 })).toThrow("locked layer");
    expect(canonicalJson(locked)).toBe(before);

    const tracked = document();
    tracked.tracks = [{ id: "track", name: "Track", layerIds: ["follower"], locked: true }] as never;
    expect(() => bakeMotionRelation(tracked, { id: "follow", sampleEveryUs: 1_000 })).toThrow("locked track");
  });

  it("checks both old and new relation targets and keeps detach transform-preserving", () => {
    const moving = document();
    layer(moving, "follower").locked = true;
    const before = canonicalJson(moving);
    expect(() => upsertMotionRelation(moving, { binding: follow("follow", "middle") })).toThrow("locked layer");
    expect(canonicalJson(moving)).toBe(before);

    const detachable = document();
    const transforms = canonicalJson(detachable.layers);
    const detached = detachMotionRelation(detachable, { id: "follow" });
    expect(detached.action).toBe("detached");
    expect(detached.motion.relations).toBeUndefined();
    expect(canonicalJson(detached.motion.layers)).toBe(transforms);
  });
});

function document(durationMs = 4, relationDurationUs = 4_000): MotionRelationDocument {
  return {
    schema: "shellx-motion/motion@1", id: "relation-bake", name: "Relation bake", durationMs, fps: 30, width: 320, height: 180, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "leader", type: "shape", shape: "rect", startMs: 0, durationMs, transform: { x: 10, y: 5, width: 10, height: 10 } },
      { id: "middle", type: "shape", shape: "rect", startMs: 0, durationMs, transform: { x: 30, y: 5, width: 10, height: 10 } },
      { id: "follower", type: "shape", shape: "rect", startMs: 0, durationMs, transform: { x: 0, y: 0, width: 10, height: 10 } },
    ],
    relations: { schema: "shellx-motion/relations@1", bindings: [follow("follow", "follower", relationDurationUs)] },
  };
}
function follow(id: string, targetLayerId: string, durationUs = 4_000) {
  return {
    id, enabled: true, kind: "attach" as const, mode: "follow" as const, startUs: 0, durationUs,
    source: { layerId: "leader", anchor: { x: 0, y: 0 } }, target: { layerId: targetLayerId, anchor: { x: 0, y: 0 } },
    offset: { space: "world" as const, x: 0, y: 0, rotationDeg: 0, scale: 1 },
  };
}
function layer(document: MotionRelationDocument, id: string) {
  const result = document.layers.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing ${id}`);
  return result;
}
