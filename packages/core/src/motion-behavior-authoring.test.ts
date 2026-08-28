import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json";
import { inspectMotionBehaviors, readMotionBehaviorUpsertBinding, removeMotionBehavior, upsertMotionBehavior } from "./motion-behavior-authoring";
import type { MotionDocument } from "./types";

describe("motion behavior authoring", () => {
  it("inserts in canonical target order, replaces immutably, and deletes the final store", () => {
    const source = document();
    const z = upsertMotionBehavior(source, { binding: binding("z") });
    const a = upsertMotionBehavior(z.motion, { binding: binding("a") });
    expect(a.motion.behaviors?.bindings.map((entry) => entry.targetLayerId)).toEqual(["a", "z"]);
    expect(a.changedPaths).toEqual(["/behaviors/bindings/0"]);
    expect(source.behaviors).toBeUndefined();
    const replaced = upsertMotionBehavior(a.motion, { binding: { ...binding("a"), enabled: false } });
    expect(replaced.motion.behaviors?.bindings[0]).toMatchObject({ targetLayerId: "a", enabled: false });
    expect(replaced.beforeSourceSha256).toBe(a.afterSourceSha256);
    const one = removeMotionBehavior(replaced.motion, { targetLayerId: "a" });
    const empty = removeMotionBehavior(one.motion, { targetLayerId: "z" });
    expect(empty.motion.behaviors).toBeUndefined();
    expect(empty.changedPaths).toEqual(["/behaviors"]);
    expect(empty.afterSourceSha256).toBeNull();
    expect(inspectMotionBehaviors(empty.motion).staticPlan.behaviorSourceSha256).toBeNull();
  });

  it("provides immutable inspection plus deterministic behavior identity", () => {
    const first = upsertMotionBehavior(document(), { binding: binding("a") }).motion;
    const replay = upsertMotionBehavior(structuredClone(document()), { binding: binding("a") }).motion;
    const inspection = inspectMotionBehaviors(first);
    expect(inspection.store).toEqual(first.behaviors);
    expect(Object.isFrozen(inspection.store)).toBe(true);
    expect(inspection.staticPlan).toEqual(inspectMotionBehaviors(replay).staticPlan);
    const changed = upsertMotionBehavior(first, { binding: { ...binding("a"), motion: { kind: "gravity", velocityX: 2, velocityY: 0, gravityY: 0 } } });
    expect(changed.staticPlan.fingerprint).not.toBe(inspection.staticPlan.fingerprint);
  });

  it("exposes one detached exact upsert binding reader without document ownership admission", () => {
    const transform = readMotionBehaviorUpsertBinding(binding("a"));
    expect(transform).toEqual(binding("a"));
    const path = readMotionBehaviorUpsertBinding({
      targetLayerId: "a", enabled: true, kind: "path-follow", startUs: 0, durationUs: 1_000,
      easing: { type: "spring", stiffness: 100_001, damping: 100_002, mass: 100_003, initialVelocity: -100_004 },
      geometry: { schema: "shellx-motion/shape-geometry@1", kind: "path", viewBox: { x: 0, y: 0, width: 10, height: 10 }, data: "M 0 0 L 10 0 L 10 10 Z" },
    });
    expect(path).toMatchObject({ kind: "path-follow", easing: { type: "spring", stiffness: 100_001, damping: 100_002, mass: 100_003, initialVelocity: -100_004 } });
    expect(() => readMotionBehaviorUpsertBinding({ ...binding("a"), extra0: 0, extra1: 1, extra2: 2, extra3: 3, extra4: 4, extra5: 5, extra6: 6 })).toThrow("12-field record limit");
  });

  it("admits a safe long-document startUs without widening durationUs", () => {
    const source = document(3_600_000.002);
    const result = upsertMotionBehavior(source, { binding: { ...binding("a"), startUs: 3_600_000_001, durationUs: 1 } });
    expect(result.motion.behaviors?.bindings[0]).toMatchObject({ startUs: 3_600_000_001, durationUs: 1 });
    expect(source.behaviors).toBeUndefined();
  });

  it("refuses no-op, missing, invalid, and hostile inputs without mutating the source", () => {
    const source = upsertMotionBehavior(document(), { binding: binding("a") }).motion;
    const before = canonicalJson(source);
    expect(() => upsertMotionBehavior(source, { binding: binding("a") })).toThrow("did not change");
    expect(() => removeMotionBehavior(source, { targetLayerId: "missing" })).toThrow("is absent");
    expect(() => upsertMotionBehavior(source, { binding: binding("missing") })).toThrow("existing root-owned shape");
    expect(() => upsertMotionBehavior(source, { binding: binding("a"), ignored: true })).toThrow("unknown field");
    let reads = 0;
    const hostile = Object.create(null, { binding: { enumerable: true, get: () => { reads += 1; return binding("a"); } } });
    expect(() => upsertMotionBehavior(source, hostile)).toThrow("enumerable data field");
    expect(reads).toBe(0);
    expect(() => removeMotionBehavior(source, new Proxy({}, { ownKeys: () => { throw new Error("trap"); } }))).toThrow("reflection failed");
    expect(canonicalJson(source)).toBe(before);
  });

  it("keeps behavior edits behind layer and track locks while inspection stays read-only", () => {
    const withLayerBehavior = upsertMotionBehavior(document(), { binding: binding("a") }).motion;
    const layerLocked = deepFreeze({ ...withLayerBehavior, layers: withLayerBehavior.layers.map((layer) => layer.id === "a" ? { ...layer, locked: true } : layer) });
    const layerBefore = canonicalJson(layerLocked);
    expect(inspectMotionBehaviors(layerLocked).store?.bindings).toHaveLength(1);
    expect(() => upsertMotionBehavior(layerLocked, { binding: { ...binding("a"), enabled: false } })).toThrow("locked layer");
    expect(() => removeMotionBehavior(layerLocked, { targetLayerId: "a" })).toThrow("locked layer");
    expect(canonicalJson(layerLocked)).toBe(layerBefore);

    const withBehavior = upsertMotionBehavior(document(), { binding: binding("a") }).motion;
    const trackLocked = deepFreeze({
      ...withBehavior,
      tracks: [{ id: "shape-track", type: "overlay", locked: true, layerIds: ["a"] }],
    });
    const trackBefore = canonicalJson(trackLocked);
    expect(inspectMotionBehaviors(trackLocked).store?.bindings).toHaveLength(1);
    expect(() => upsertMotionBehavior(trackLocked, { binding: { ...binding("a"), enabled: false } })).toThrow("locked track");
    expect(() => removeMotionBehavior(trackLocked, { targetLayerId: "a" })).toThrow("locked track");
    expect(canonicalJson(trackLocked)).toBe(trackBefore);
  });
});

function document(durationMs = 1_000): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "behavior-authoring", name: "Behavior authoring", durationMs, fps: 30, width: 100, height: 50, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: ["a", "z"].map((id) => ({ id, type: "shape" as const, shape: "rect", fill: "#ffffff", startMs: 0, durationMs, transform: { x: 0, y: 0, width: 10, height: 10 } })),
  };
}
function binding(targetLayerId: string) {
  return { targetLayerId, enabled: true, kind: "transform" as const, startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity" as const, velocityX: 1, velocityY: 0, gravityY: 0 } };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
