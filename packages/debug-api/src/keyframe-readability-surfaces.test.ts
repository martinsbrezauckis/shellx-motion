/**
 * The two Debug API surfaces that were telling an author its animation existed when it did not.
 *
 * `motion.package.validate` once answered `valid: true` for a package storing keyframes as `{ t, v }`.
 * It now stops at structural stage one, while the timeline panel separately explains why those
 * keyframes cannot animate. Validation must not imply semantic/renderability work after structural
 * failure.
 *
 * `motion.timeline.easing.panel` is the keyframe panel's twin (fixed in fcd41d8): it mapped every
 * stored entry through, so it sorted on a NaN comparator, emitted `atMs: undefined` usage refs, and
 * reported `keyframeUsage: 309` for a package whose keyframes animate nothing.
 *
 * Both directions are pinned in each case: the broken package is refused/flagged with the correct
 * form named, and a correctly authored package produces exactly the reading it produced before.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The shape the external agent produced: `t`/`v` where the schema says `atMs`/`value`. */
const UNREADABLE_KEYFRAMES = {
  opacity: [{ t: 0, v: 0 }, { t: 600, v: 0.92, easing: "ease-out" }],
  "transform.x": [{ t: 0, v: -80 }, { t: 700, v: 40, easing: "back-out" }]
};

const READABLE_KEYFRAMES = {
  opacity: [{ atMs: 0, value: 0 }, { atMs: 600, value: 0.92, easing: "ease-out" }],
  "transform.x": [{ atMs: 0, value: -80 }, { atMs: 700, value: 40, easing: "back-out" }]
};

async function writePackage(keyframes: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-keyframe-surfaces-"));
  roots.push(root);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_keyframe_surfaces",
    name: "Keyframe Surfaces Probe",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  }, null, 2), "utf8");
  await writeFile(join(root, "motion.json"), JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_keyframe_surfaces",
    name: "Keyframe Surfaces Probe",
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

describe("motion.package.validate refuses animation the engine cannot run", () => {
  it("refuses a package whose keyframes fail structural stage one", async () => {
    const packageRoot = await writePackage(UNREADABLE_KEYFRAMES);

    const result = await dispatchDebugCommand("motion.package.validate", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_motion_document");
    const body = result.result as Record<string, unknown>;
    expect(body.valid).toBe(false);
    expect(body.validation).toMatchObject({ structural: "failed", semantic: "not_run", renderability: "not_proven" });
    expect(body.schemaErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/layers/0/keyframes/opacity/0/atMs" }),
      expect.objectContaining({ path: "/layers/0/keyframes/transform.x/0/value" }),
    ]));
  });

  it("refuses when only part of one track is unreadable", async () => {
    const packageRoot = await writePackage({
      "transform.x": [{ atMs: 0, value: 40 }, { t: 350, v: 65 }, { atMs: 700, value: 90 }]
    });

    const result = await dispatchDebugCommand("motion.package.validate", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const body = result.result as Record<string, unknown>;
    expect(body.validation).toMatchObject({ structural: "failed", semantic: "not_run" });
  });

  it("still validates a correctly authored package, with no new warning", async () => {
    const packageRoot = await writePackage(READABLE_KEYFRAMES);

    const result = await dispatchDebugCommand("motion.package.validate", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatchObject({ ok: true, valid: true });
    expect(result.warnings).toEqual([]);
  });

  it("still validates a package with no keyframes at all", async () => {
    const packageRoot = await writePackage({});

    const result = await dispatchDebugCommand("motion.package.validate", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });
});

describe("motion.timeline.easing.panel excludes easing that never runs", () => {
  it("counts unreadable keyframes out of usage and says so once", async () => {
    const packageRoot = await writePackage(UNREADABLE_KEYFRAMES);

    const result = await dispatchDebugCommand("motion.timeline.easing.panel", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.result as Record<string, unknown>;
    const counts = body.counts as Record<string, number>;
    // Previously: usage 4, keyframeUsage 4, and two presets reported as "used" by keyframes that
    // cannot animate. `ease-out`/`back-out` on an unreadable keyframe is easing that never runs.
    expect(counts.usage).toBe(0);
    expect(counts.keyframeUsage).toBe(0);
    expect(counts.usedPresets).toBe(0);
    expect(counts.unreadableKeyframes).toBe(4);
    expect((body.usage as { total: number }).total).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("4 keyframes across 2 targets are excluded from this panel");
    expect(result.warnings[0]).toContain("{ atMs, value }");
  });

  it("never emits a usage ref with an undefined atMs", async () => {
    const packageRoot = await writePackage({
      "transform.x": [{ atMs: 700, value: 40, easing: "ease-out" }, { t: 0, v: -80, easing: "back-out" }]
    });

    const result = await dispatchDebugCommand("motion.timeline.easing.panel", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const presets = (result.result as Record<string, unknown>).presets as Array<{ usedBy: Array<{ atMs?: number }> }>;
    const refs = presets.flatMap((preset) => preset.usedBy);
    expect(refs).toHaveLength(1);
    expect(refs.every((ref) => typeof ref.atMs === "number" && Number.isFinite(ref.atMs))).toBe(true);
  });

  it("reads a correctly authored package exactly as before, with no warning", async () => {
    const packageRoot = await writePackage(READABLE_KEYFRAMES);

    const result = await dispatchDebugCommand("motion.timeline.easing.panel", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const counts = (result.result as Record<string, unknown>).counts as Record<string, number>;
    expect(counts.usage).toBe(4);
    expect(counts.keyframeUsage).toBe(4);
    expect(counts.unreadableKeyframes).toBe(0);
    expect(result.warnings).toEqual([]);
  });
});
