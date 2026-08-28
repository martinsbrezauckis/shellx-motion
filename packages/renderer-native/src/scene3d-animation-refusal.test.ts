import { describe, expect, it, vi } from "vitest";
import { matchRendererCapability, NATIVE_CAPABILITY, type MotionPackage } from "@shellx-motion/core";

const core = vi.hoisted(() => ({ pkg: undefined as MotionPackage | undefined, loads: 0 }));
vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shellx-motion/core")>(),
  loadMotionPackage: async () => { core.loads += 1; return core.pkg as MotionPackage; },
}));

import { createNativeRenderSession, renderNativePreviewFrame } from "./index";

describe("scene3dAnimation@1 Native refusal", () => {
  it("refuses a present layout-gap root after document load and before native output allocation", async () => {
    const pkg = nativePackage(animationStore());
    delete pkg.motion.scene3dAnimation;
    pkg.motion.layoutGapAnimation = { schema: "shellx-motion/layout-gap-animation@1", tracks: [] } as never;
    core.pkg = pkg; core.loads = 0;
    expect(matchRendererCapability(pkg.motion, NATIVE_CAPABILITY)).toMatchObject({ ok: false, unsupported: [{ feature: "motion.layout-gap-animation@1" }] });
    await expect(createNativeRenderSession({ packageRoot: "/not-opened-layout-gap-package" })).rejects.toThrow("Native rendering does not yet support document layoutGapAnimation@1.");
    expect(core.loads).toBe(1);
  });

  it("refuses malformed and accessor roots after the sole document load and before asset/output allocation", async () => {
    for (const pkg of [nativePackage(animationStore()), nativePackage({ schema: "shellx-motion/scene3d-animation@1", tracks: [] } as never), accessorPackage()]) {
      core.pkg = pkg; core.loads = 0;
      expect(matchRendererCapability(pkg.motion, NATIVE_CAPABILITY)).toMatchObject({ ok: false, unsupported: [{ feature: "motion.scene3d-animation@1" }] });
      await expect(createNativeRenderSession({ packageRoot: "/not-opened-scene3d-animation-package" })).rejects.toThrow("Native rendering does not yet support document scene3dAnimation@1.");
      await expect(renderNativePreviewFrame({ packageRoot: "/not-opened-scene3d-animation-package", outputPath: "/not-opened-scene3d-animation-package/frame.png" })).rejects.toThrow("Native rendering does not yet support document scene3dAnimation@1.");
      expect(core.loads).toBe(2);
    }
    expect(accessorReads).toBe(0);
  });
});

let accessorReads = 0;

function nativePackage(scene3dAnimation: NonNullable<MotionPackage["motion"]["scene3dAnimation"]>): MotionPackage {
  return {
    root: "/not-opened-scene3d-animation-package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "native-scene3d-animation", name: "Native scene3d animation", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "native-scene3d-animation", name: "Native scene3d animation", durationMs: 1_000, fps: 30, width: 100, height: 50,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 10, height: 10 } }],
      scene3dAnimation,
    },
  };
}

function animationStore(): NonNullable<MotionPackage["motion"]["scene3dAnimation"]> {
  return { schema: "shellx-motion/scene3d-animation@1", tracks: [] } as never;
}

function accessorPackage(): MotionPackage {
  const pkg = nativePackage(animationStore());
  Object.defineProperty(pkg.motion, "scene3dAnimation", { enumerable: true, get() { accessorReads += 1; return animationStore(); } });
  return pkg;
}
