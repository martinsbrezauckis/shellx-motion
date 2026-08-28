import { describe, expect, it } from "vitest";
import { planCutImport, type CutTargetCapabilities } from "./index";
import { hashBuffer, type MotionPackage } from "@shellx-motion/core";

describe("relations@1 Cut refusal", () => {
  it("refuses active, disabled, and malformed stores before selecting an import or render operation", () => {
    for (const relations of [relationStore(true), relationStore(false), { schema: "shellx-motion/relations@1", bindings: [] } as never]) {
      const plan = planCutImport(relationPackage(relations), target());
      expect(plan).toMatchObject({
        ok: false, mode: null, operations: [],
        unsupported: [{ layerId: "__motion_relations__", feature: "motion.relations@1", reason: "Cut import does not yet support document relations@1." }],
        receipt: { status: "failed" },
      });
    }
  });

  it("refuses a relations accessor without reading it or mislabeling its receipt input", () => {
    const pkg = relationPackage(relationStore(true)); let reads = 0;
    Object.defineProperty(pkg.motion, "relations", {
      enumerable: true,
      get() { reads += 1; return relationStore(true); },
    });

    const plan = planCutImport(pkg, target());

    expect(plan).toMatchObject({
      ok: false, mode: null, operations: [],
      unsupported: [{ layerId: "__motion_relations__", feature: "motion.relations@1" }],
    });
    expect(plan.receipt.inputHashes).toEqual(expect.objectContaining({ "relations.rootDescriptor": expect.any(String) }));
    expect(plan.receipt.inputHashes.motion).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("names a non-enumerable data root as descriptor evidence, never as motion", () => {
    const pkg = relationPackage(relationStore(true));
    Object.defineProperty(pkg.motion, "relations", { enumerable: false, value: relationStore(true) });

    const plan = planCutImport(pkg, target());

    expect(plan.receipt.inputHashes).toEqual(expect.objectContaining({ "relations.rootDescriptor": expect.any(String) }));
    expect(plan.receipt.inputHashes.motion).toBeUndefined();
  });

  it("preserves the actual motion hash when both optional roots are data properties", () => {
    const pkg = relationPackage(relationStore(true));
    expect(planCutImport(pkg, target()).receipt.inputHashes).toMatchObject({
      motion: hashBuffer(Buffer.from(JSON.stringify(pkg.motion))),
    });
  });
});

function target(): CutTargetCapabilities {
  return { targetId: "cut-test", modes: ["editable_lowering", "live_overlay", "rendered_media"], lowerableLayerTypes: ["shape"] };
}

function relationPackage(relations: NonNullable<MotionPackage["motion"]["relations"]>): MotionPackage {
  return {
    root: "/not-opened-relation-package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "cut-relation", name: "Cut relation", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["cut"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "cut-relation", name: "Cut relation", durationMs: 1_000, fps: 30, width: 100, height: 50,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [
        { id: "leader", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } },
        { id: "follower", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 20, y: 0, width: 10, height: 10 } },
      ],
      relations,
    },
  };
}

function relationStore(enabled: boolean): NonNullable<MotionPackage["motion"]["relations"]> {
  return { schema: "shellx-motion/relations@1", bindings: [{
    id: "follow", enabled, kind: "attach", mode: "follow", startUs: 0, durationUs: 1_000_000,
    source: { layerId: "leader", anchor: { x: 0, y: 0 } }, target: { layerId: "follower", anchor: { x: 0, y: 0 } },
    offset: { space: "source", x: 0, y: 0, rotationDeg: 0, scale: 1 },
  }] };
}
