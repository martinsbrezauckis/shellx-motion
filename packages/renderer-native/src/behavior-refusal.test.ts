import { describe, expect, it, vi } from "vitest";
import { matchRendererCapability, NATIVE_CAPABILITY, type MotionPackage } from "@shellx-motion/core";

const core = vi.hoisted(() => ({ pkg: undefined as MotionPackage | undefined }));
vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shellx-motion/core")>(),
  loadMotionPackage: async () => core.pkg as MotionPackage,
}));

import { createNativeRenderSession, renderNativePreviewFrame } from "./index";

describe("behavior Phase 1 native refusal", () => {
  it("refuses active and disabled stores before native output", async () => {
    for (const enabled of [true, false]) {
      const pkg = packageFor(enabled);
      core.pkg = pkg;
      expect(matchRendererCapability(pkg.motion, NATIVE_CAPABILITY)).toMatchObject({ ok: false, unsupported: [{ feature: "motion.behaviors@1" }] });
      // The mocked package loader isolates session admission from the host's output-path topology.
      // Both the direct session and convenience wrapper stop before allocation or frame output.
      await expect(createNativeRenderSession({ packageRoot: "/not-opened-behavior-package" })).rejects.toThrow("Native rendering does not yet support document behaviors@1.");
      await expect(renderNativePreviewFrame({ packageRoot: "/not-opened-behavior-package", outputPath: "/not-opened-behavior-package/frame.png" })).rejects.toThrow("Native rendering does not yet support document behaviors@1.");
    }
  });

  it("retains the absent-behavior native capability match", async () => {
    const pkg = packageFor();
    expect(matchRendererCapability(pkg.motion, NATIVE_CAPABILITY)).toEqual({ ok: true, lane: "native", unsupported: [] });
  });
});

function packageFor(enabled?: boolean): MotionPackage {
  return {
    root: "/not-opened-behavior-package",
    manifest: {
      schema: "shellx-motion/package-manifest@1", id: "native-behavior", name: "Native behavior", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] },
    },
    motion: {
    schema: "shellx-motion/motion@1", id: "native-behavior", name: "Native behavior", durationMs: 1_000, fps: 30, width: 100, height: 50,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000 }],
      ...(enabled === undefined ? {} : { behaviors: { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "shape", enabled, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 } }] } }),
    },
  };
}
