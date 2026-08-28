import { describe, expect, it } from "vitest";
import { buildGeneratedMotionHtml, createMotionBrowserRenderSession, loadHtmlComposition, preflightBrowserPackage, renderBrowserFrame } from "./index";
import type { MotionPackage } from "@shellx-motion/core";

describe("relations@1 browser refusal", () => {
  it("refuses active, disabled, and malformed stores before HTML lowering, package reads, or browser launch", async () => {
    for (const relation of [relationStore(true), relationStore(false), { schema: "shellx-motion/relations@1", bindings: [] } as never]) {
      const pkg = relationPackage(relation);
      await expect(buildGeneratedMotionHtml(pkg, 0)).rejects.toThrow("Browser rendering does not yet support document relations@1.");
      await expect(preflightBrowserPackage(pkg)).resolves.toEqual({
        ok: false, htmlEntries: [], blockedOrigins: [], warnings: ["Browser rendering does not yet support document relations@1."],
      });
      await expect(renderBrowserFrame(pkg, { atMs: 0, outDir: "/not-opened-relation-output" })).rejects.toThrow("Browser rendering does not yet support document relations@1.");
      let launches = 0;
      await expect(createMotionBrowserRenderSession(pkg, {
        launchBrowser: async () => { launches += 1; throw new Error("browser launch must not run"); },
      })).rejects.toThrow("Browser rendering does not yet support document relations@1.");
      expect(launches).toBe(0);
    }
  });

  it("refuses loadHtmlComposition before layer discovery or fulfillment reads", async () => {
    for (const relations of [relationStore(true), relationStore(false), { schema: "shellx-motion/relations@1", bindings: [] } as never]) {
      let readerCalls = 0;
      await expect(loadHtmlComposition(htmlRelationPackage(relations), {
        readPath: async () => { readerCalls += 1; throw new Error("HTML reader must not run"); },
      } as never)).rejects.toThrow("Browser rendering does not yet support document relations@1.");
      expect(readerCalls).toBe(0);
    }

    let relationReads = 0, readerCalls = 0;
    const pkg = htmlRelationPackage(relationStore(true));
    Object.defineProperty(pkg.motion, "relations", { enumerable: true, get() { relationReads += 1; return relationStore(true); } });
    await expect(loadHtmlComposition(pkg, {
      readPath: async () => { readerCalls += 1; throw new Error("HTML reader must not run"); },
    } as never)).rejects.toThrow("Browser rendering does not yet support document relations@1.");
    expect({ relationReads, readerCalls }).toEqual({ relationReads: 0, readerCalls: 0 });
  });
});

function relationPackage(relations: NonNullable<MotionPackage["motion"]["relations"]>): MotionPackage {
  return {
    root: "/not-opened-relation-package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "browser-relation", name: "Browser relation", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "browser-relation", name: "Browser relation", durationMs: 1_000, fps: 30, width: 100, height: 50,
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

function htmlRelationPackage(relations: NonNullable<MotionPackage["motion"]["relations"]>): MotionPackage {
  const pkg = relationPackage(relations);
  pkg.motion.layers.push({ id: "html", type: "html", source: "card.html", startMs: 0, durationMs: 1_000 });
  return pkg;
}
