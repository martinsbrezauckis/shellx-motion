import { describe, expect, it } from "vitest";
import { GPU_CAPABILITY, matchRendererCapability, matchRendererCapabilityCards, renderLanesFor, unrenderablePackageRefusal } from "./capabilities";
import { compileGpuSceneRelationsFramePlan, compileGpuSceneRelationsStaticPlan, GPU_SCENE_RELATIONS_FRAME_PLAN_SCHEMA, GPU_SCENE_RELATIONS_STATIC_PLAN_SCHEMA } from "./gpu-scene-relations-composition";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { evaluateMotionRelationAuthoringFrame } from "./motion-relation-authoring-frame";
import type { MotionDocument } from "./types";

describe("strict GPU relation preview composition", () => {
  it("binds one exact relation authoring frame to a fresh legacy GPU scene without changing no-feature fingerprints", () => {
    const motion = relationDocument();
    const staticPlan = compileGpuSceneRelationsStaticPlan(motion);
    expect(staticPlan).toMatchObject({ ok: true, plan: { schema: GPU_SCENE_RELATIONS_STATIC_PLAN_SCHEMA, endpointLayerIds: ["follower", "leader"] } });
    if (!staticPlan.ok) return;
    const base = structuredClone(motion); delete base.relations;
    const legacy = compileGpuSceneStaticPlan(base);
    expect(legacy).toMatchObject({ ok: true });
    if (legacy.ok) expect(staticPlan.plan.basePlan.fingerprint).toBe(legacy.plan.fingerprint);

    const frame = compileGpuSceneRelationsFramePlan(motion, staticPlan.plan, 500_000);
    expect(frame).toMatchObject({
      ok: true,
      plan: {
        schema: GPU_SCENE_RELATIONS_FRAME_PLAN_SCHEMA,
        atUs: 500_000,
        relationFramePlan: { atUs: 500_000, samples: [{ id: "follow", targetLayerId: "follower" }] },
      },
    });
    if (!frame.ok) return;
    expect(frame.plan.frame.draws.find((draw) => draw.id === "follower")).toMatchObject({ kind: "rect", x: 30, y: 8 });
  });

  it("refuses forged or stale wrappers and nonrepresentable times before supplied resources are touched", () => {
    const motion = relationDocument();
    const staticPlan = compileGpuSceneRelationsStaticPlan(motion);
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok) return;
    let resourceReads = 0;
    const resources = new Proxy({}, { get() { resourceReads += 1; throw new Error("resources must not be read"); } });
    expect(compileGpuSceneRelationsFramePlan(motion, { ...staticPlan.plan }, 500_000, resources)).toEqual({
      ok: false,
      failure: { code: "gpu_resource_refused", message: "GPU relation preview composition requires an exact Core-issued static execution wrapper." },
    });
    const stale = structuredClone(motion); stale.layers[0] = { ...stale.layers[0]!, name: "changed" };
    expect(compileGpuSceneRelationsFramePlan(stale, staticPlan.plan, 500_000, resources)).toEqual({
      ok: false,
      failure: { code: "gpu_resource_refused", message: "GPU relation preview static execution wrapper is stale for this Motion document." },
    });
    expect(compileGpuSceneRelationsFramePlan(motion, staticPlan.plan, 500_001, resources)).toEqual({
      ok: false,
      failure: { code: "gpu_invalid_time", message: "GPU relation preview composition atUs cannot round-trip through the legacy GPU millisecond ABI." },
    });
    expect(resourceReads).toBe(0);
  });

  it("passes one resolved keyframe/procedural/behavior relation snapshot without reapplying target transitions", () => {
    const motion = relationDocument();
    motion.layers.push(
      { id: "keyframed", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 2, y: 20, width: 4, height: 4 }, keyframes: { "transform.x": [{ atMs: 0, value: 2 }, { atMs: 1_000, value: 20 }] } },
      { id: "procedural", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 2, y: 28, width: 4, height: 4 } },
    );
    motion.layers[0] = {
      ...motion.layers[0]!,
      transform: { ...motion.layers[0]!.transform!, x: 0 },
    };
    motion.layers[1] = {
      ...motion.layers[1]!,
      transitions: { in: { type: "slide", direction: "right", durationMs: 1_000, distance: 7 } },
    };
    motion.relationships = {
      schema: "shellx-motion/procedural-relationships@1",
      relationships: [{
        id: "source-procedural", enabled: true, target: { layerId: "procedural", property: "transform.x" },
        nodes: [{ id: "constant", type: "constant", value: 12 }], outputNodeId: "constant",
      }],
    };
    motion.behaviors = {
      schema: "shellx-motion/behaviors@1",
      bindings: [{
        targetLayerId: "leader", enabled: true, kind: "transform", startUs: 0, durationUs: 1_000_000,
        motion: { kind: "gravity", velocityX: 1_000, velocityY: 0, gravityY: 0 },
      }],
    };
    const authoritative = evaluateMotionRelationAuthoringFrame(motion, 500_000);
    const expected = authoritative.layers.find((layer) => layer.id === "follower")?.transform?.x;
    expect(expected).toBeTypeOf("number");
    const staticPlan = compileGpuSceneRelationsStaticPlan(motion);
    expect(staticPlan.ok).toBe(true); if (!staticPlan.ok || typeof expected !== "number") return;
    const frame = compileGpuSceneRelationsFramePlan(motion, staticPlan.plan, 500_000);
    expect(frame.ok).toBe(true); if (!frame.ok) return;
    expect(frame.plan.frame.draws.find((draw) => draw.id === "follower")).toMatchObject({ x: expected });
  });

  it("refuses hidden endpoints and all resource-bearing or non-shape scope before GPU planning", () => {
    const hidden = relationDocument(); hidden.layers[0]!.visible = false;
    expect(compileGpuSceneRelationsStaticPlan(hidden)).toMatchObject({ ok: false, failure: { message: expect.stringContaining("visible root-owned") } });

    const hiddenUnrelated = relationDocument(); hiddenUnrelated.layers.push({ id: "hidden", type: "shape", shape: "rect", fill: "#ffffff", visible: false, startMs: 0, durationMs: 1_000 });
    expect(compileGpuSceneRelationsStaticPlan(hiddenUnrelated)).toMatchObject({ ok: false, failure: { message: expect.stringContaining("visible root-owned") } });

    const resource = relationDocument(); resource.assets.push({ id: "font", path: "fonts/ui.ttf" });
    expect(compileGpuSceneRelationsStaticPlan(resource)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("declared resources") } });

    const group = relationDocument(); group.layers.push({ id: "group", type: "group", childLayerIds: [], startMs: 0, durationMs: 1_000 });
    expect(compileGpuSceneRelationsStaticPlan(group)).toMatchObject({ ok: false, failure: { message: expect.stringContaining("refuses groups") } });
  });

  it("keeps generic relations unavailable while only explicit GPU preview capability selects the strict wrapper", () => {
    const motion = relationDocument();
    expect(matchRendererCapability(motion, GPU_CAPABILITY)).toMatchObject({ ok: false, unsupported: [{ feature: "motion.relations@1" }] });
    expect(matchRendererCapabilityCards(motion)).toMatchObject({ recommendedLane: null });
    expect(matchRendererCapabilityCards(motion).matches.every((match) => !match.ok)).toBe(true);
    expect(matchRendererCapabilityCards(motion, { target: "preview", output: "png-frame" }).matches.find((match) => match.lane === "gpu")).toMatchObject({ ok: true });
    expect(matchRendererCapabilityCards(motion, { target: "preview" }).matches.find((match) => match.lane === "gpu")).toMatchObject({ ok: false });
    for (const output of ["png", "raw-rgba"]) {
      expect(matchRendererCapabilityCards(motion, { target: "preview", output }).matches.find((match) => match.lane === "gpu")).toMatchObject({
        ok: false,
        unsupported: [expect.objectContaining({
          feature: "motion.relations@1.strict-browser-gpu-preview",
          reason: expect.stringContaining(`only png-frame output, not ${output}`),
        })],
      });
    }
    expect(matchRendererCapabilityCards(motion, { target: "final", output: "raw-rgba" }).matches.find((match) => match.lane === "gpu")).toMatchObject({ ok: false });
    expect(renderLanesFor(motion)).toEqual(["gpu"]);
    expect(unrenderablePackageRefusal(motion)).toBeNull();
  });
});

function relationDocument(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "gpu-relations", name: "GPU relations", durationMs: 1_000, fps: 30, width: 100, height: 50,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "leader", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 30, y: 8, width: 10, height: 10 } },
      { id: "follower", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } },
    ],
    relations: {
      schema: "shellx-motion/relations@1",
      bindings: [{
        id: "follow", enabled: true, kind: "attach", mode: "follow", startUs: 0, durationUs: 1_000_000,
        source: { layerId: "leader", anchor: { x: 0, y: 0 } }, target: { layerId: "follower", anchor: { x: 0, y: 0 } },
        offset: { space: "world", x: 0, y: 0, rotationDeg: 0, scale: 1 },
      }],
    },
  };
}
