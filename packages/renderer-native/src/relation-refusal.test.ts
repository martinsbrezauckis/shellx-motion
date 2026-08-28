import { describe, expect, it, vi } from "vitest";
import { matchRendererCapability, NATIVE_CAPABILITY, type MotionPackage } from "@shellx-motion/core";

const core = vi.hoisted(() => ({ pkg: undefined as MotionPackage | undefined, loads: 0 }));
vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shellx-motion/core")>(),
  loadMotionPackage: async () => { core.loads += 1; return core.pkg as MotionPackage; },
}));

import { createNativeRenderSession, renderNativePreviewFrame } from "./index";

describe("relations@1 native refusal", () => {
  it("refuses active, disabled, and malformed stores after the sole document load and before asset/output allocation", async () => {
    for (const relations of [relationStore(true), relationStore(false), { schema: "shellx-motion/relations@1", bindings: [] } as never]) {
      const pkg = relationPackage(relations);
      core.pkg = pkg; core.loads = 0;
      expect(matchRendererCapability(pkg.motion, NATIVE_CAPABILITY)).toMatchObject({ ok: false, unsupported: [{ feature: "motion.relations@1" }] });
      await expect(createNativeRenderSession({ packageRoot: "/not-opened-relation-package" })).rejects.toThrow("Native rendering does not yet support document relations@1.");
      await expect(renderNativePreviewFrame({ packageRoot: "/not-opened-relation-package", outputPath: "/not-opened-relation-package/frame.png" })).rejects.toThrow("Native rendering does not yet support document relations@1.");
      expect(core.loads).toBe(2);
    }
  });
});

function relationPackage(relations: NonNullable<MotionPackage["motion"]["relations"]>): MotionPackage {
  return {
    root: "/not-opened-relation-package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "native-relation", name: "Native relation", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "native-relation", name: "Native relation", durationMs: 1_000, fps: 30, width: 100, height: 50,
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
