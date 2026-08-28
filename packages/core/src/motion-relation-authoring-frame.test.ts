import { describe, expect, it } from "vitest";
import { compileMotionRelationAuthoringFramePlan, compileMotionRelationAuthoringFramePlanFromEvaluation, evaluateMotionRelationAuthoringFrame, motionRelationLegacyAtMs } from "./motion-relation-authoring-frame";
import type { MotionRelationDocument } from "./motion-relation-types";

describe("relation authoring frame composition", () => {
  it("joins ordinary keyframes before relations on the exact integer-millisecond bridge", () => {
    const motion = document();
    leader(motion).keyframes = { "transform.x": [{ atMs: 0, value: 10 }, { atMs: 4, value: 30 }] };

    const frame = evaluateMotionRelationAuthoringFrame(motion, 2_000);

    expect(layer(frame.layers, "follower").transform).toMatchObject({ x: 20, y: 5 });
    expect(frame.samples).toMatchObject([{ id: "follow", transform: { x: 20, y: 5 } }]);
    expect(motionRelationLegacyAtMs(2_000, motion)).toBe(2);
    expect(() => evaluateMotionRelationAuthoringFrame(motion, 2_001)).toThrow("whole-millisecond");
  });

  it("joins the bounded procedural scalar graph before relation source sampling", () => {
    const motion = document();
    motion.relationships = {
      schema: "shellx-motion/procedural-relationships@1",
      relationships: [{
        id: "drive-leader", enabled: true, target: { layerId: "leader", property: "transform.x" },
        nodes: [{ id: "value", type: "constant", value: 42 }], outputNodeId: "value",
      }],
    };

    expect(layer(evaluateMotionRelationAuthoringFrame(motion, 2_000).layers, "follower").transform).toMatchObject({ x: 42, y: 5 });
  });

  it("joins an exact behavior overlay before relation source sampling", () => {
    const motion = document();
    motion.behaviors = {
      schema: "shellx-motion/behaviors@1",
      bindings: [{
        targetLayerId: "leader", enabled: true, kind: "transform", startUs: 0, durationUs: 4_000,
        motion: { kind: "gravity", velocityX: 1_000, velocityY: 0, gravityY: 0 },
      }],
    };

    expect(layer(evaluateMotionRelationAuthoringFrame(motion, 2_000).layers, "follower").transform).toMatchObject({ x: 12, y: 5 });
  });

  it("derives the relation frame identity from one already-owned authoring evaluation", () => {
    const motion = document();
    const evaluation = evaluateMotionRelationAuthoringFrame(motion, 2_000);
    expect(compileMotionRelationAuthoringFramePlanFromEvaluation(motion, evaluation)).toEqual(compileMotionRelationAuthoringFramePlan(motion, 2_000));
  });

  it("refuses forged, cross-document, and stale evaluation authority", () => {
    const motion = document();
    const evaluation = evaluateMotionRelationAuthoringFrame(motion, 2_000);
    expect(compileMotionRelationAuthoringFramePlanFromEvaluation(motion, { ...evaluation })).toEqual({
      ok: false,
      message: "Motion relation authoring frame planning requires an exact Core-issued authoring evaluation.",
    });
    expect(compileMotionRelationAuthoringFramePlanFromEvaluation(structuredClone(motion), evaluation)).toEqual({
      ok: false,
      message: "Motion relation authoring frame evaluation is stale for this Motion document or playhead.",
    });
    motion.name = "changed";
    expect(compileMotionRelationAuthoringFramePlanFromEvaluation(motion, evaluation)).toEqual({
      ok: false,
      message: "Motion relation authoring frame evaluation is stale for this Motion document or playhead.",
    });

    const snapshotMotion = document();
    const snapshot = evaluateMotionRelationAuthoringFrame(snapshotMotion, 2_000);
    snapshot.layers[1]!.transform!.x = 999;
    expect(compileMotionRelationAuthoringFramePlanFromEvaluation(snapshotMotion, snapshot)).toEqual({
      ok: false,
      message: "Motion relation authoring frame evaluation is stale for this Motion document or playhead.",
    });
  });
});

function document(): MotionRelationDocument {
  return {
    schema: "shellx-motion/motion@1", id: "relation-authoring-frame", name: "Relation authoring frame", durationMs: 10, fps: 30, width: 320, height: 180, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "leader", type: "shape", shape: "rect", startMs: 0, durationMs: 10, transform: { x: 10, y: 5, width: 10, height: 10 } },
      { id: "follower", type: "shape", shape: "rect", startMs: 0, durationMs: 10, transform: { x: 0, y: 0, width: 10, height: 10 } },
    ],
    relations: {
      schema: "shellx-motion/relations@1",
      bindings: [{
        id: "follow", enabled: true, kind: "attach", mode: "follow", startUs: 0, durationUs: 4_000,
        source: { layerId: "leader", anchor: { x: 0, y: 0 } }, target: { layerId: "follower", anchor: { x: 0, y: 0 } },
        offset: { space: "world", x: 0, y: 0, rotationDeg: 0, scale: 1 },
      }],
    },
  };
}
function leader(motion: MotionRelationDocument) { return layer(motion.layers, "leader"); }
function layer(layers: readonly MotionRelationDocument["layers"][number][], id: string) {
  const result = layers.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing ${id}`);
  return result;
}
