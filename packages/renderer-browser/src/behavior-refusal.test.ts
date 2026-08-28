import { describe, expect, it } from "vitest";
import { buildGeneratedMotionHtml, createMotionBrowserRenderSession, preflightBrowserPackage } from "./index";
import type { MotionPackage } from "@shellx-motion/core";

describe("behavior Phase 1 browser refusal", () => {
  it("refuses active and disabled stores before HTML lowering, package reads, or browser launch", async () => {
    for (const enabled of [true, false]) {
      const pkg = behaviorPackage(enabled);
      await expect(buildGeneratedMotionHtml(pkg, 0)).rejects.toThrow("Browser rendering does not yet support document behaviors@1.");
      await expect(preflightBrowserPackage(pkg)).resolves.toEqual({
        ok: false, htmlEntries: [], blockedOrigins: [], warnings: ["Browser rendering does not yet support document behaviors@1."],
      });
      let launches = 0;
      await expect(createMotionBrowserRenderSession(pkg, {
        launchBrowser: async () => { launches += 1; throw new Error("browser launch must not run"); },
      })).rejects.toThrow("Browser rendering does not yet support document behaviors@1.");
      expect(launches).toBe(0);
    }
  });
});

function behaviorPackage(enabled: boolean): MotionPackage {
  return {
    root: "/not-opened-behavior-package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "browser-behavior", name: "Browser behavior", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "browser-behavior", name: "Browser behavior", durationMs: 1_000, fps: 30, width: 100, height: 50,
      assets: [], provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{ id: "shape", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000 }],
      behaviors: { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "shape", enabled, kind: "transform", startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 } }] },
    },
  };
}
