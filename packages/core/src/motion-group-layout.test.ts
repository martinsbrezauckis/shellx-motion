import { describe, expect, it } from "vitest";
import { compileMotionGroupLayout } from "./motion-group-layout";
import type { MotionGroupLayoutCompileRequest, MotionGroupLayoutPlan } from "./motion-group-layout";
import type { MotionDocument, MotionLayer } from "./types";

describe("Motion group layout adapter", () => {
  it("derives direct local child boxes, timing, ownership, and source identity without mutation", () => {
    const motion = document([
      group("pack", ["first", "second"], 100, 400),
      child("first", 10, 100, 3),
      child("second", 120, 80, 5),
    ]);
    const before = structuredClone(motion);
    const result = plan(request(motion));
    expect(result.source).toEqual({
      schema: "shellx-motion/group-layout-source@1", motionId: "motion", groupId: "pack",
      groupStartMs: 100, groupDurationMs: 400, childLayerIds: ["first", "second"],
    });
    expect(result.ownership).toEqual({ schema: "shellx-motion/layout-ownership-input@1", ownerId: "pack", childIds: ["first", "second"] });
    expect(result.instances).toEqual([
      expect.objectContaining({ sourceId: "first", instanceIndex: 0, timing: { startMs: 10, durationMs: 100 }, transform: expect.objectContaining({ x: 13, y: 40, width: 30, height: 20 }) }),
      expect.objectContaining({ sourceId: "second", instanceIndex: 0, timing: { startMs: 120, durationMs: 80 }, transform: expect.objectContaining({ x: 47, y: 40, width: 30, height: 20 }) }),
    ]);
    expect(result.fingerprintInput).toContain("group-layout-fingerprint@1");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(motion).toEqual(before);
  });

  it("treats direct child reorder as semantic input and fingerprints it", () => {
    const first = document([group("pack", ["a", "b"]), child("a"), child("b")]);
    const reordered = document([group("pack", ["b", "a"]), child("a"), child("b")]);
    const before = plan(request(first));
    const after = plan(request(reordered));
    expect(before.instances.map((instance) => instance.sourceId)).toEqual(["a", "b"]);
    expect(after.instances.map((instance) => instance.sourceId)).toEqual(["b", "a"]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("refuses nested direct groups and ambiguous or animated child box semantics", () => {
    const nested = document([
      group("outer", ["inner"], 0, 300), group("inner", ["a"], 0, 200), child("a"),
    ]);
    expect(refusal(request(nested, "outer")).map((issue) => issue.code)).toContain("child.nested_group");

    const noBox = document([group("pack", ["a"]), { ...child("a"), transform: { x: 0, y: 0 } }]);
    expect(refusal(request(noBox)).map((issue) => issue.code)).toContain("child.box");

    const animated = document([group("pack", ["a"]), { ...child("a"), keyframes: { "transform.width": [{ atMs: 0, value: 30 }] } }]);
    expect(refusal(request(animated)).map((issue) => issue.code)).toContain("child.animated_box");

    const animatedOrigin = document([group("pack", ["a"]), { ...child("a"), keyframes: { "transform.originX": [{ atMs: 0, value: 0.5 }] } }]);
    expect(refusal(request(animatedOrigin)).map((issue) => issue.code)).toContain("child.animated_box");
  });

  it("rejects missing groups, duplicate ownership, stale ownership, and locks before expansion", () => {
    const normal = document([group("pack", ["a"]), child("a")]);
    expect(refusal(request(normal, "missing")).map((issue) => issue.code)).toContain("group.missing");

    const duplicate = document([group("one", ["a"]), group("two", ["a"]), child("a")]);
    expect(refusal(request(duplicate, "one"))[0]).toMatchObject({ code: "group.graph", message: expect.stringMatching(/already has group owner/) });

    const stale = document([group("pack", ["gone"])]);
    expect(refusal(request(stale))[0]).toMatchObject({ code: "group.graph", message: expect.stringMatching(/references missing child/) });

    const locked = document([{ ...group("pack", ["a"]), locked: true }, child("a")]);
    expect(refusal(request(locked)).map((issue) => issue.code)).toContain("group.locked");

    const overCap = document([group("pack", Array.from({ length: 257 }, (_value, index) => `child-${index}`))]);
    expect(refusal(request(overCap))[0]).toMatchObject({ code: "group.graph", message: expect.stringMatching(/1\.\.256/) });
  });

  it("refuses repeater sources outside direct group membership", () => {
    const motion = document([group("pack", ["a", "b"]), child("a"), child("b"), child("outside")]);
    const input = request(motion);
    input.repeaters = [{
      schema: "shellx-motion/repeater@1", sourceId: "outside", count: 2,
      transformDelta: { x: 0, y: 0, scale: 0, rotation: 0 }, opacityDelta: 0, indexTimeStaggerMs: 0,
    }];
    expect(refusal(input).map((issue) => issue.code)).toContain("repeater.source");
  });

  it("keeps generated staggered timing inside the selected group's local timeline", () => {
    const motion = document([group("pack", ["a"], 100, 300), child("a", 100, 100)]);
    const input = request(motion);
    input.repeaters = [{
      schema: "shellx-motion/repeater@1", sourceId: "a", count: 2,
      transformDelta: { x: 0, y: 0, scale: 0, rotation: 0 }, opacityDelta: 0, indexTimeStaggerMs: 101,
    }];
    expect(refusal(input).map((issue) => issue.code)).toContain("group.local_timing");
  });
});

function request(motion: MotionDocument, groupId = "pack"): MotionGroupLayoutCompileRequest {
  return {
    schema: "shellx-motion/group-layout-compile@1",
    motion,
    groupId,
    layout: {
      schema: "shellx-motion/layout@1", kind: "row", width: 100, height: 100,
      padding: { top: 10, right: 10, bottom: 10, left: 10 }, gap: 2,
      align: { x: "start", y: "center" }, distribution: "start", overflow: "clip",
    },
    repeaters: [],
  };
}

function document(layers: MotionLayer[]): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "motion", name: "Motion", durationMs: 1_000, fps: 30, width: 100, height: 100,
    layers, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  };
}

function group(id: string, childLayerIds: string[], startMs = 0, durationMs = 300): MotionLayer {
  return { id, type: "group", startMs, durationMs, childLayerIds };
}

function child(id: string, startMs = 0, durationMs = 100, x = 0): MotionLayer {
  return {
    id, type: "shape", shape: "rect", startMs, durationMs,
    transform: { x, y: 0, width: 30, height: 20, scale: 1, rotation: 0, opacity: 1 },
  };
}

function plan(value: unknown): MotionGroupLayoutPlan {
  const result = compileMotionGroupLayout(value);
  if (result.status !== "ok") throw new Error(result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
  return result.plan;
}

function refusal(value: unknown): Array<{ path: string; code: string; message: string }> {
  const result = compileMotionGroupLayout(value);
  if (result.status === "ok") throw new Error("expected refusal");
  return result.issues;
}
