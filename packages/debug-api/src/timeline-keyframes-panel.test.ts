/**
 * Regression cover for the keyframe panel's handling of keyframes the renderer cannot read.
 *
 * A package produced by an external agent stored 309 keyframes as `{ t, v }` instead of the
 * schema's `{ atMs, value }`. The timeline evaluator drops those silently (`readNumericKeyframes`
 * requires a finite numeric `value`), so the piece never animated — but the panel reported all 309
 * as ordinary keyframes with `valueTypes: ["undefined"]`, no `firstMs`/`lastMs`, and a sort
 * comparator returning NaN. The author was told, in effect, that its animation existed.
 *
 * These tests hold the panel to reporting what is actually readable and saying so when the rest is
 * not. They live in their own file rather than in the 24k-line index.test.ts so this behaviour is
 * findable by name.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

const roots: string[] = [];

/** Write a two-layer package whose keyframes are supplied verbatim, valid or not. */
async function writePackage(keyframes: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-keyframe-panel-"));
  roots.push(root);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_keyframe_panel_probe",
    name: "Keyframe Panel Probe",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  }, null, 2), "utf8");
  await writeFile(join(root, "motion.json"), JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_keyframe_panel_probe",
    name: "Keyframe Panel Probe",
    durationMs: 2000,
    fps: 30,
    width: 640,
    height: 360,
    background: "#101820",
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    layers: [{
      id: "panel",
      type: "shape",
      shape: "rectangle",
      fill: "#172033",
      startMs: 0,
      durationMs: 2000,
      width: 320,
      height: 120,
      transform: { x: 40, y: 100, scale: 1, rotation: 0 },
      keyframes
    }]
  }, null, 2), "utf8");
  return root;
}

async function panelFor(keyframes: Record<string, unknown>): Promise<{ warnings: string[]; result: Record<string, unknown> }> {
  const packageRoot = await writePackage(keyframes);
  const dispatched = await dispatchDebugCommand("motion.timeline.keyframes.panel", { packageRoot }, { tier: "read_motion" });
  expect(dispatched.ok).toBe(true);
  if (!dispatched.ok) throw new Error("keyframe panel dispatch failed");
  return { warnings: dispatched.warnings, result: dispatched.result as Record<string, unknown> };
}

function targets(result: Record<string, unknown>): Array<Record<string, unknown>> {
  return result.targets as Array<Record<string, unknown>>;
}

describe("timeline keyframe panel value reporting", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reports the real value types for readable keyframes and warns about nothing", async () => {
    const { warnings, result } = await panelFor({
      "transform.x": [{ atMs: 0, value: 40, easing: "ease-out" }, { atMs: 700, value: 90 }],
      "style.fill": [{ atMs: 0, value: "#172033" }, { atMs: 900, value: "#13d3ff" }]
    });

    expect(warnings).toEqual([]);
    expect((result.counts as Record<string, number>).malformedKeyframes).toBe(0);
    expect(targets(result).map((row) => row.valueTypes)).toEqual([["string"], ["number"]]);
    expect(targets(result).every((row) => row.malformedKeyframes === undefined)).toBe(true);
    expect(targets(result).map((row) => [row.firstMs, row.lastMs])).toEqual([[0, 900], [0, 700]]);
  });

  it("never reports 'undefined' as a value type for keyframes written with the wrong field names", async () => {
    // The exact shape the external agent produced: `t`/`v` instead of `atMs`/`value`.
    const { warnings, result } = await panelFor({
      opacity: [{ t: 0, v: 0 }, { t: 600, v: 0.92, easing: "ease-out" }],
      "transform.x": [{ t: 0, v: -80 }, { t: 700, v: 40, easing: "back-out" }]
    });

    for (const row of targets(result)) {
      expect(row.valueTypes).toEqual([]);
      expect(row.valueTypes).not.toContain("undefined");
      expect(row.malformedKeyframes).toBe(2);
      expect(row.keyframes).toEqual([]);
      // No readable keyframe means there is no honest first/last time to report.
      expect(row.firstMs).toBeUndefined();
      expect(row.lastMs).toBeUndefined();
      // The stored count is still the truth about what the file contains.
      expect(row.keyframeCount).toBe(2);
    }
    expect((result.counts as Record<string, number>).keyframes).toBe(4);
    expect((result.counts as Record<string, number>).malformedKeyframes).toBe(4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("4 of 4 keyframes cannot be read by the renderer and will not animate");
    expect(warnings[0]).toContain('layer "panel" target "opacity"');
    expect(warnings[0]).toContain("{ atMs, value }");
  });

  it("separates readable from unreadable keyframes on the same target", async () => {
    const { warnings, result } = await panelFor({
      "transform.x": [
        { atMs: 0, value: 40 },
        { t: 350, v: 65 },
        { atMs: 700, value: 90 },
        { atMs: 900 },
        { atMs: Number.NaN, value: 12 }
      ]
    });

    const row = targets(result)[0]!;
    expect(row.keyframeCount).toBe(5);
    expect(row.malformedKeyframes).toBe(3);
    expect(row.valueTypes).toEqual(["number"]);
    expect(row.keyframes).toEqual([{ atMs: 0, value: 40 }, { atMs: 700, value: 90 }]);
    expect(row.firstMs).toBe(0);
    expect(row.lastMs).toBe(700);
    expect(warnings[0]).toContain("3 of 5 keyframes cannot be read");
  });

  it("sorts readable keyframes by time even when unreadable ones are interleaved", async () => {
    // The old comparator returned NaN as soon as one atMs was undefined, which silently disabled
    // the sort for the whole target.
    const { result } = await panelFor({
      "transform.x": [
        { atMs: 900, value: 3 },
        { t: 10, v: 1 },
        { atMs: 100, value: 1 },
        { atMs: 500, value: 2 }
      ]
    });

    expect((targets(result)[0]!.keyframes as Array<{ atMs: number }>).map((frame) => frame.atMs)).toEqual([100, 500, 900]);
  });
});
