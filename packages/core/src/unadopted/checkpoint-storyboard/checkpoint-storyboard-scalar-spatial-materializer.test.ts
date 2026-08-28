import { describe, expect, it } from "vitest";
import {
  approveCheckpointStoryboardScalarSpatialMaterialization,
  compileCheckpointStoryboardScalarSpatialPlan,
  projectCheckpointStoryboardScalarSpatialMaterialization,
  readApprovedCheckpointStoryboardScalarSpatialMaterialization,
} from "./checkpoint-storyboard-scalar-spatial-materializer";
import { CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA } from "./checkpoint-storyboard-scalar-spatial-types";
import { createCheckpointStoryboard, createTransitionRecipe } from "./checkpoint-storyboard";

const HASH = "a".repeat(64);

function state(x: number, y: number, rotation: number) {
  return { objectId: "orb", state: "present" as const, properties: [
    { property: "transform.x", value: x }, { property: "transform.y", value: y },
    { property: "transform.rotation", value: rotation }, { property: "transform.scale", value: 1 }, { property: "opacity", value: 1 },
  ] };
}

function request(modes: readonly ("linear" | "auto")[] = ["auto", "auto"]) {
  const scalar = [0, 1].map((index) => createTransitionRecipe({ recipeId: `scalar-${index}`, seed: index + 2, exactBaseRequirements: [], intent: { kind: "checkpoint-keyframe", easing: "ease-in-out", targets: [{ objectId: "orb", propertyMask: ["transform.rotation"] }] } }));
  const spatial = modes.map((mode, index) => createTransitionRecipe({ recipeId: `spatial-${index}`, seed: index + 3, exactBaseRequirements: [], intent: { kind: "checkpoint-spatial-path", targets: [{ objectId: "orb", tangentMode: mode }] } }));
  const storyboard = createCheckpointStoryboard({
    seed: 1, capabilityRequirements: ["renderer.native"], objectCatalog: [{ objectId: "orb", rootShapeKind: "ellipse", propertyMask: ["transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity"] }],
    checkpoints: [{ id: "zero", atUs: 0, objects: [state(0, 0, 0)] }, { id: "middle", atUs: 1_000_000, objects: [state(50, 25, 45)] }, { id: "finish", atUs: 2_000_000, objects: [state(100, 50, 90)] }],
    edges: [
      { id: "a-zero-middle", fromCheckpointId: "zero", toCheckpointId: "middle", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar-0", "spatial-0"] },
      { id: "b-middle-finish", fromCheckpointId: "middle", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "orb" }], recipeIds: ["scalar-1", "spatial-1"] },
    ], recipes: [...scalar, ...spatial],
  });
  return {
    schema: CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA, storyboard,
    base: {
      packageId: "package-1", manifest: { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "C6B1b", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: [] } },
      motion: { schema: "shellx-motion/motion@1", id: "motion-1", name: "C6B1b", durationMs: 2_000, fps: 30, width: 1280, height: 720, layers: [{ id: "orb", type: "shape", shape: "ellipse", startMs: 0, durationMs: 2_000, transform: { x: 0, y: 0, rotation: 0, scale: 1 }, opacity: 1 }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } },
      persistedMotionSha256: HASH,
    }, objectLayerBindings: [{ objectId: "orb", layerId: "orb" }],
  };
}

function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as object)) deepFreeze(child); Object.freeze(value); } return value; }

describe("private C6B1b scalar/spatial materialization projection", () => {
  it("coalesces a three-checkpoint scalar and same-mode spatial chain with next-edge easing", () => {
    const accepted = deepFreeze(request());
    const plan = compileCheckpointStoryboardScalarSpatialPlan(accepted);
    const projection = projectCheckpointStoryboardScalarSpatialMaterialization(accepted, plan);
    expect(projection.scalar).toHaveLength(1);
    expect(projection.scalar[0]!.keyframes).toEqual([
      { atMs: 0, value: 0, easing: "ease-in-out" }, { atMs: 1_000, value: 45, easing: "ease-in-out" }, { atMs: 2_000, value: 90 },
    ]);
    expect(projection.spatial).toHaveLength(1);
    expect(projection.spatial[0]!.keyframes).toEqual([
      expect.objectContaining({ atMs: 0, x: 0, y: 0, easing: "linear", spatial: expect.objectContaining({ mode: "auto" }) }),
      expect.objectContaining({ atMs: 1_000, x: 50, y: 25, easing: "linear", spatial: expect.objectContaining({ mode: "auto" }) }),
      expect.objectContaining({ atMs: 2_000, x: 100, y: 50, spatial: expect.objectContaining({ mode: "auto" }) }),
    ]);
    expect(projection.spatial[0]!.keyframes.at(-1)).not.toHaveProperty("easing");
    const approval = approveCheckpointStoryboardScalarSpatialMaterialization(Object.freeze({ request: accepted, plan }));
    expect(readApprovedCheckpointStoryboardScalarSpatialMaterialization(approval).projection.fingerprint).toBe(projection.fingerprint);
  });

  it("refuses a linear-to-auto shared spatial checkpoint", () => {
    const accepted = deepFreeze(request(["linear", "auto"]));
    const plan = compileCheckpointStoryboardScalarSpatialPlan(accepted);
    expect(() => projectCheckpointStoryboardScalarSpatialMaterialization(accepted, plan)).toThrow(/tangent-mode discontinuity/i);
  });

  it("does not mint approval from a stale or mutable C6B1a pair", () => {
    const mutable = request(); const plan = compileCheckpointStoryboardScalarSpatialPlan(mutable);
    expect(() => approveCheckpointStoryboardScalarSpatialMaterialization({ request: mutable, plan })).toThrow(/frozen/i);
    const accepted = deepFreeze(request()); const valid = compileCheckpointStoryboardScalarSpatialPlan(accepted);
    const stale = deepFreeze({ ...structuredClone(valid), fingerprint: HASH });
    expect(() => approveCheckpointStoryboardScalarSpatialMaterialization(Object.freeze({ request: accepted, plan: stale }))).toThrow(/accepted C6B1a/i);
  });
});
