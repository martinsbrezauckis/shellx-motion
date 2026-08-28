import { describe, expect, it } from "vitest";
import {
  addMotionParticleAnalyticTrail,
  addMotionParticleShading,
  deleteMotionParticleFieldSource,
  deleteMotionParticleOrigin,
  insertMotionParticleFieldSource,
  insertMotionParticleOrigin,
  inspectMotionParticleStructure,
  moveMotionParticleFieldSource,
  moveMotionParticleOrigin,
  removeMotionParticleAnalyticTrail,
  removeMotionParticleShading,
  replaceMotionParticleAnalyticTrail,
  replaceMotionParticleFieldSource,
  replaceMotionParticleOrigin,
  replaceMotionParticleShading,
  updateMotionParticleCollisionAxis,
} from "./motion-particle-structural";
import { MAX_PARTICLE_EMITTER_ORIGINS, MAX_PARTICLE_FIELD_V2_SOURCES } from "./particle-field-types";
import type { MotionParticleFieldSource } from "./particle-field-types";
import { loadSchema, validateDocument } from "./validate";
import type { MotionDocument, MotionParticleEmitter } from "./types";

describe("bounded structural particle authoring", () => {
  it("inspects only cloned bounded structural records and accepts a particle layer with no field", () => {
    const source = v2Motion(), before = structuredClone(source);
    const inspected = inspectMotionParticleStructure(source, { layerId: "field" });
    expect(inspected).toMatchObject({ layerId: "field", limits: { maxSources: MAX_PARTICLE_FIELD_V2_SOURCES, maxOrigins: MAX_PARTICLE_EMITTER_ORIGINS } });
    expect(inspected.field?.sources).toHaveLength(2);
    inspected.field!.sources[0]!.kind = "radial";
    expect(source).toEqual(before);

    const noField = v1Motion(); delete noField.layers[0]!.emitter!.field;
    expect(inspectMotionParticleStructure(noField, { layerId: "field" })).toMatchObject({ field: null, origins: null, trail: null, shading: null, limits: { maxSources: null, maxOrigins: null } });
    expect(inspectMotionParticleStructure(v1Motion(), { layerId: "field" }).limits).toEqual({ maxSources: 3, maxOrigins: null });
  });

  it("performs v1 source insert, replace, move, and delete with a copy-on-write source", () => {
    const source = v1Motion(), before = structuredClone(source);
    const inserted = insertMotionParticleFieldSource(source, { layerId: "field", index: 1, source: vortex() });
    expect(source).toEqual(before);
    expect(inserted).toMatchObject({ action: "source-inserted", index: 1, changedPaths: ["/layers/field/emitter/field/sources"] });

    const replaced = replaceMotionParticleFieldSource(inserted.motion, { layerId: "field", index: 0, source: vortex(0.1) });
    const moved = moveMotionParticleFieldSource(replaced.motion, { layerId: "field", fromIndex: 1, toIndex: 0 });
    const deleted = deleteMotionParticleFieldSource(moved.motion, { layerId: "field", index: 1 });
    expect(replaced.layer.emitter!.field!.sources[0]).toMatchObject({ kind: "vortex", centerX: 0.1 });
    expect(moved.layer.emitter!.field!.sources.map((entry) => entry.kind)).toEqual(["vortex", "vortex"]);
    expect(deleted.layer.emitter!.field!.sources).toHaveLength(1);
  });

  it("enforces v1/v2 source kind sets, caps, no-ops, and minimum source count before mutation", () => {
    const wrongKind = v1Motion();
    const v1Cap = v1Motion({ sources: [radial(), vortex(), radial(0.2)] });
    const v2Cap = v2Motion({ sources: [radial(), vortex(), flow(), collision()] });
    const failures: Array<[MotionDocument, () => unknown, RegExp]> = [
      [wrongKind, () => insertMotionParticleFieldSource(wrongKind, { layerId: "field", index: 1, source: flow() }), /radial or vortex/],
      [v1Cap, () => insertMotionParticleFieldSource(v1Cap, { layerId: "field", index: 3, source: radial() }), /cannot exceed 3/],
      [v2Cap, () => insertMotionParticleFieldSource(v2Cap, { layerId: "field", index: 4, source: radial() }), /cannot exceed 4/],
    ];
    for (const [motion, operation, expected] of failures) expectFailureUnchanged(motion, operation, expected);

    const single = v1Motion();
    const source = single.layers[0]!.emitter!.field!.sources[0]!;
    expectFailureUnchanged(single, () => replaceMotionParticleFieldSource(single, { layerId: "field", index: 0, source }), /did not change/);
    expectFailureUnchanged(single, () => moveMotionParticleFieldSource(single, { layerId: "field", fromIndex: 0, toIndex: 0 }), /did not change/);
    expectFailureUnchanged(single, () => deleteMotionParticleFieldSource(single, { layerId: "field", index: 0 }), /leave at least one/);
  });

  it("supports every closed v2 source kind and treats collision axis as structural rather than scalar", async () => {
    const source = v2Motion(), before = structuredClone(source);
    const inserted = insertMotionParticleFieldSource(source, { layerId: "field", index: 1, source: turbulence() });
    const replaced = replaceMotionParticleFieldSource(inserted.motion, { layerId: "field", index: 0, source: impact() });
    const moved = moveMotionParticleFieldSource(replaced.motion, { layerId: "field", fromIndex: 2, toIndex: 0 });
    const axis = updateMotionParticleCollisionAxis(moved.motion, { layerId: "field", index: 0, axis: "y" });
    expect(source).toEqual(before);
    expect(axis.layer.emitter!.field!.sources[0]).toEqual({ kind: "collision", axis: "y", position: 0.5, restitution: 0.6 });
    expect(await validateDocument(await loadSchema("motion"), axis.motion)).toEqual({ ok: true });

    expectFailureUnchanged(axis.motion, () => updateMotionParticleCollisionAxis(axis.motion, { layerId: "field", index: 0, axis: "y" }), /did not change/);
    expectFailureUnchanged(replaced.motion, () => updateMotionParticleCollisionAxis(replaced.motion, { layerId: "field", index: 0, axis: "x" }), /not a collision/);
  });

  it("adds, replaces, moves, and removes bounded v2 origins while refusing v1 and cap/minimum violations", () => {
    const source = v2Motion(), before = structuredClone(source);
    const first = insertMotionParticleOrigin(source, { layerId: "field", index: 0, origin: origin(0.2, 0.3) });
    const second = insertMotionParticleOrigin(first.motion, { layerId: "field", index: 1, origin: origin(0.8, 0.7) });
    const replaced = replaceMotionParticleOrigin(second.motion, { layerId: "field", index: 0, origin: origin(0.4, 0.5) });
    const moved = moveMotionParticleOrigin(replaced.motion, { layerId: "field", fromIndex: 1, toIndex: 0 });
    const deleted = deleteMotionParticleOrigin(moved.motion, { layerId: "field", index: 1 });
    expect(source).toEqual(before);
    expect(first.action).toBe("origin-inserted");
    expect(moved.layer.emitter!.origins!.map((entry) => entry.x)).toEqual([0.8, 0.4]);
    expect(deleted.layer.emitter!.origins).toEqual([{ x: 0.8, y: 0.7, weight: 0.5 }]);

    expectFailureUnchanged(v1Motion(), () => insertMotionParticleOrigin(v1Motion(), { layerId: "field", index: 0, origin: origin(0.2, 0.3) }), /particle-field@2/);
    expectFailureUnchanged(deleted.motion, () => deleteMotionParticleOrigin(deleted.motion, { layerId: "field", index: 0 }), /leave at least one/);
    const capped = v2Motion({ origins: Array.from({ length: 4 }, (_value, index) => origin(index / 4, 0.5)) });
    expectFailureUnchanged(capped, () => insertMotionParticleOrigin(capped, { layerId: "field", index: 4, origin: origin(0.9, 0.5) }), /cannot exceed 4/);
  });

  it("adds, replaces, and removes exact analytic trail and shading records only on v2", () => {
    const source = v2Motion(), before = structuredClone(source);
    const trail = addMotionParticleAnalyticTrail(source, { layerId: "field", trail: { durationMs: 200, samples: 2, opacity: 0.3 } });
    const trailReplaced = replaceMotionParticleAnalyticTrail(trail.motion, { layerId: "field", trail: { durationMs: 300, samples: 3 } });
    const trailRemoved = removeMotionParticleAnalyticTrail(trailReplaced.motion, { layerId: "field" });
    const shading = addMotionParticleShading(trailRemoved.motion, { layerId: "field", shading: { mode: "soft", sizeJitter: 0.2 } });
    const shadingReplaced = replaceMotionParticleShading(shading.motion, { layerId: "field", shading: { mode: "glow", glow: 0.8, opacityJitter: 0.1 } });
    const shadingRemoved = removeMotionParticleShading(shadingReplaced.motion, { layerId: "field" });
    expect(source).toEqual(before);
    expect(trailReplaced.layer.emitter!.trail).toEqual({ durationMs: 300, samples: 3 });
    expect(shadingReplaced.layer.emitter!.shading).toEqual({ mode: "glow", glow: 0.8, opacityJitter: 0.1 });
    expect(shadingRemoved.layer.emitter!.shading).toBeUndefined();

    expectFailureUnchanged(v1Motion(), () => addMotionParticleAnalyticTrail(v1Motion(), { layerId: "field", trail: { durationMs: 200, samples: 2 } }), /particle-field@2/);
    expectFailureUnchanged(trail.motion, () => addMotionParticleAnalyticTrail(trail.motion, { layerId: "field", trail: { durationMs: 200, samples: 2 } }), /already present/);
    expectFailureUnchanged(shading.motion, () => replaceMotionParticleShading(shading.motion, { layerId: "field", shading: { mode: "soft", sizeJitter: 0.2 } }), /did not change/);
  });

  it("rejects locks, plain-data violations, exact-key violations, non-particle layers, and invalid final emitter density without source mutation", () => {
    const locked = v2Motion(); locked.layers[0]!.locked = true;
    expectFailureUnchanged(locked, () => insertMotionParticleFieldSource(locked, { layerId: "field", index: 1, source: turbulence() }), /locked layer/);
    const tracked = v2Motion(); tracked.tracks = [{ id: "locked-track", type: "overlay", locked: true, layerIds: ["field"] }];
    expectFailureUnchanged(tracked, () => insertMotionParticleFieldSource(tracked, { layerId: "field", index: 1, source: turbulence() }), /locked track/);
    const invalidDensity = v2Motion(); invalidDensity.layers[0]!.emitter!.count = 1;
    expectFailureUnchanged(invalidDensity, () => insertMotionParticleFieldSource(invalidDensity, { layerId: "field", index: 1, source: turbulence() }), /requires the fixed 100000/);
    const invalidLifetime = v2Motion(); invalidLifetime.layers[0]!.emitter!.lifetimeMs = -1;
    expectFailureUnchanged(invalidLifetime, () => replaceMotionParticleFieldSource(invalidLifetime, { layerId: "field", index: 0, source: radial() }), /lifetimeMs/);
    const nonParticle = v2Motion(); nonParticle.layers[0]!.type = "shape";
    expectFailureUnchanged(nonParticle, () => inspectMotionParticleStructure(nonParticle, { layerId: "field" }), /not a particles layer/);

    const exact = v2Motion();
    expectFailureUnchanged(exact, () => insertMotionParticleFieldSource(exact, { layerId: "field", index: 1, source: { ...turbulence(), formula: "code" } as never }), /does not support formula/);
    expectFailureUnchanged(exact, () => addMotionParticleShading(exact, { layerId: "field", shading: { mode: "soft", shader: "code" } as never }), /does not support shader/);
    expectFailureUnchanged(exact, () => insertMotionParticleFieldSource(exact, { layerId: "field", index: 1, source: { ...turbulence(), scale: 5 } }), /between 0.01 and 4/);
    expectFailureUnchanged(exact, () => addMotionParticleAnalyticTrail(exact, { layerId: "field", trail: { durationMs: 200, samples: 5 } }), /integer between 2 and 4/);
    const accessor: Record<string, unknown> = { layerId: "field", index: 1 };
    Object.defineProperty(accessor, "source", { enumerable: true, get: turbulence });
    expectFailureUnchanged(exact, () => insertMotionParticleFieldSource(exact, accessor as never), /data properties only/);
    const symbolInput = { layerId: "field", index: 1, source: turbulence() } as Record<PropertyKey, unknown>;
    symbolInput[Symbol("hidden")] = "not-json";
    expectFailureUnchanged(exact, () => insertMotionParticleFieldSource(exact, symbolInput as never), /symbol keys/);
    const nestedAccessor = v2Motion(); let getterRead = false;
    Object.defineProperty(nestedAccessor.layers[0]!.emitter!.field!.sources[0]!, "strength", { enumerable: true, get: () => { getterRead = true; return 0.2; } });
    const descriptor = Object.getOwnPropertyDescriptor(nestedAccessor.layers[0]!.emitter!.field!.sources[0]!, "strength");
    expect(() => replaceMotionParticleFieldSource(nestedAccessor, { layerId: "field", index: 0, source: radial() })).toThrow(/data propert/);
    expect(Object.getOwnPropertyDescriptor(nestedAccessor.layers[0]!.emitter!.field!.sources[0]!, "strength")).toEqual(descriptor);
    expect(getterRead).toBe(false);
  });
});

function expectFailureUnchanged(motion: MotionDocument, operation: () => unknown, expected: RegExp): void {
  const before = structuredClone(motion);
  expect(operation).toThrow(expected);
  expect(motion).toEqual(before);
}

function radial(centerX = 0.5) { return { kind: "radial" as const, centerX, centerY: 0.5, strength: 0.2, softening: 0.2 }; }
function vortex(centerX = 0.8) { return { kind: "vortex" as const, centerX, centerY: 0.3, strength: -0.2, softening: 0.2 }; }
function flow() { return { kind: "flow" as const, angleDeg: 20, strength: 0.2 }; }
function turbulence() { return { kind: "turbulence" as const, scale: 1.2, strength: 0.2 }; }
function impact() { return { kind: "impact" as const, centerX: 0.3, centerY: 0.4, radius: 0.2, strength: 0.3, startProgress: 0.2, durationProgress: 0.3 }; }
function collision() { return { kind: "collision" as const, axis: "x" as const, position: 0.5, restitution: 0.6 }; }
function origin(x: number, y: number) { return { x, y, weight: 0.5 }; }

function v1Motion(field: { sources: MotionParticleFieldSource[] } = { sources: [radial()] }): MotionDocument {
  return motion({ seed: 1, count: 100, lifetimeMs: 500, shape: "circle", color: "#ffffff", field: { schema: "shellx-motion/particle-field@1", ...field } });
}

function v2Motion(overrides: Record<string, unknown> = {}): MotionDocument {
  const { sources = [flow(), collision()], ...emitterOverrides } = overrides;
  return motion({
    seed: 2, count: 100_000, lifetimeMs: 500, shape: "circle", color: "#ffffff",
    field: { schema: "shellx-motion/particle-field@2", sources },
    ...emitterOverrides,
  } as MotionParticleEmitter);
}

function motion(emitter: MotionParticleEmitter): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "particle-structural", name: "Particle structural", durationMs: 1_000, fps: 30, width: 100, height: 100,
    layers: [{ id: "field", type: "particles", startMs: 0, durationMs: 1_000, emitter }], assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  };
}
