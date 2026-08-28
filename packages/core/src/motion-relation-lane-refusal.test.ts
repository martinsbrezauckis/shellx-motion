import { describe, expect, it } from "vitest";
import { BROWSER_CAPABILITY, GPU_CAPABILITY, matchRendererCapability, matchRendererCapabilityCards, NATIVE_CAPABILITY, renderLanesFor, unrenderablePackageRefusal } from "./capabilities";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { motionRelationLaneRefusal, motionRelationStorePresent } from "./motion-relation-lane-refusal";
import type { MotionDocument } from "./types";

describe("relations@1 cross-lane refusal", () => {
  it("refuses active and disabled stores in capability truth and strict GPU planning", () => {
    for (const enabled of [true, false]) {
      const motion = relationDocument(enabled);
      expect(motionRelationLaneRefusal(motion, "browser")).toMatchObject({
        schema: "shellx-motion/motion-relation-lane-refusal@1",
        code: "motion_relations_unavailable",
        feature: "motion.relations@1",
        message: "Browser rendering does not yet support document relations@1.",
      });
      for (const capability of [BROWSER_CAPABILITY, NATIVE_CAPABILITY, GPU_CAPABILITY]) {
        expect(matchRendererCapability(motion, capability)).toMatchObject({ ok: false, unsupported: [{ layerId: "__motion_relations__", feature: "motion.relations@1" }] });
      }
      expect(matchRendererCapabilityCards(motion).matches.every((match) => !match.ok)).toBe(true);
      expect(renderLanesFor(motion)).toEqual(["gpu"]);
      expect(unrenderablePackageRefusal(motion)).toBeNull();
      expect(compileGpuSceneStaticPlan(motion)).toMatchObject({ ok: false, failure: { message: "GPU static planning does not yet support document relations@1." } });
      expect(compileGpuScene2dPlan(motion, 0)).toMatchObject({ ok: false, failure: { message: "GPU frame planning does not yet support document relations@1." } });
    }
  });

  it("fails closed on a malformed or unreadable root without evaluating its nested data", () => {
    const malformed = relationDocument(false) as unknown as MotionDocument;
    malformed.relations = { schema: "shellx-motion/relations@1", bindings: [] } as never;
    expect(motionRelationLaneRefusal(malformed, "native")).toMatchObject({ code: "motion_relations_unavailable" });
    let reads = 0;
    const hostile = {};
    Object.defineProperty(hostile, "relations", { enumerable: true, get() { reads += 1; return malformed.relations; } });
    expect(motionRelationStorePresent(hostile)).toBe(true);
    expect(reads).toBe(0);
  });

  it("leaves documents with no relation root byte and capability compatible", () => {
    const motion = relationDocument();
    expect(motionRelationLaneRefusal(motion, "native")).toBeUndefined();
    expect(matchRendererCapability(motion, NATIVE_CAPABILITY)).toEqual({ ok: true, lane: "native", unsupported: [] });
    expect(unrenderablePackageRefusal(motion)).toBeNull();
  });
});

function relationDocument(enabled?: boolean): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "relation-lane", name: "Relation lane", durationMs: 1_000, fps: 30, width: 100, height: 50,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "leader", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } },
      { id: "follower", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 20, y: 0, width: 10, height: 10 } },
    ],
    ...(enabled === undefined ? {} : { relations: { schema: "shellx-motion/relations@1", bindings: [{
      id: "follow", enabled, kind: "attach", mode: "follow", startUs: 0, durationUs: 1_000_000,
      source: { layerId: "leader", anchor: { x: 0, y: 0 } }, target: { layerId: "follower", anchor: { x: 0, y: 0 } },
      offset: { space: "source", x: 0, y: 0, rotationDeg: 0, scale: 1 },
    }] } }),
  };
}
