import { describe, expect, it } from "vitest";
import { planCutImport, type CutTargetCapabilities } from "./index";
import { hashBuffer, type MotionPackage } from "@shellx-motion/core";

describe("scene3dAnimation@1 Cut refusal", () => {
  it("refuses a present layout-gap root before Cut inspects package motion or selects a route", () => {
    const pkg = scene3dAnimationPackage();
    delete pkg.motion.scene3dAnimation;
    pkg.motion.layoutGapAnimation = { schema: "shellx-motion/layout-gap-animation@1", tracks: [] } as never;
    const plan = planCutImport(pkg, target());
    expect(plan).toMatchObject({ ok: false, mode: null, operations: [], unsupported: [{ layerId: "__layout_gap_animation__", feature: "motion.layout-gap-animation@1", reason: "Cut import does not yet support document layoutGapAnimation@1." }], receipt: { status: "failed" } });
  });

  it("refuses a malformed present root before selecting import or render operations", () => {
    const plan = planCutImport(scene3dAnimationPackage(), target());
    expect(plan).toMatchObject({
      ok: false, mode: null, operations: [],
      unsupported: [{ layerId: "__scene3d_animation__", feature: "motion.scene3d-animation@1", reason: "Cut import does not yet support document scene3dAnimation@1." }],
      receipt: { status: "failed" },
    });
  });

  it("treats an accessor root as present without reading it", () => {
    const pkg = scene3dAnimationPackage(); let reads = 0;
    Object.defineProperty(pkg.motion, "scene3dAnimation", { enumerable: true, get() { reads += 1; return { schema: "shellx-motion/scene3d-animation@1", tracks: [] }; } });
    const plan = planCutImport(pkg, target());
    expect(plan).toMatchObject({ ok: false, mode: null, operations: [], unsupported: [{ feature: "motion.scene3d-animation@1" }] });
    expect(plan.receipt.inputHashes).toEqual(expect.objectContaining({ "scene3dAnimation.rootDescriptor": expect.any(String) }));
    expect(plan.receipt.inputHashes.motion).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("names a non-enumerable data root as descriptor evidence, never as motion", () => {
    const pkg = scene3dAnimationPackage();
    Object.defineProperty(pkg.motion, "scene3dAnimation", {
      enumerable: false,
      value: { schema: "shellx-motion/scene3d-animation@1", tracks: [] },
    });

    const plan = planCutImport(pkg, target());

    expect(plan.receipt.inputHashes).toEqual(expect.objectContaining({ "scene3dAnimation.rootDescriptor": expect.any(String) }));
    expect(plan.receipt.inputHashes.motion).toBeUndefined();
  });

  it("hashes the actual data root, and names descriptor-only reflection evidence honestly", () => {
    const data = scene3dAnimationPackage();
    expect(planCutImport(data, target()).receipt.inputHashes).toMatchObject({ motion: hashBuffer(Buffer.from(JSON.stringify(data.motion))) });

    const reflected = scene3dAnimationPackage();
    reflected.motion = new Proxy(reflected.motion, { getOwnPropertyDescriptor(target, key) { if (key === "scene3dAnimation") throw new Error("reflection blocked"); return Reflect.getOwnPropertyDescriptor(target, key); } });
    const plan = planCutImport(reflected, target());
    expect(plan.receipt.inputHashes).toEqual(expect.objectContaining({ "scene3dAnimation.rootDescriptor": expect.any(String) }));
    expect(plan.receipt.inputHashes.motion).toBeUndefined();
  });
});

function target(): CutTargetCapabilities {
  return { targetId: "cut-test", modes: ["editable_lowering", "live_overlay", "rendered_media"], lowerableLayerTypes: ["shape"] };
}

function scene3dAnimationPackage(): MotionPackage {
  return {
    root: "/not-opened-scene3d-animation-package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "cut-scene3d-animation", name: "Cut scene3d animation", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["cut"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "cut-scene3d-animation", name: "Cut scene3d animation", durationMs: 1_000, fps: 30, width: 100, height: 50,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } }],
      scene3dAnimation: { schema: "shellx-motion/scene3d-animation@1", tracks: [] } as never,
    },
  };
}
