import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compilePhysicsBakeAdmissionPlan, PHYSICS_BAKE_SCHEMA } from "@shellx-motion/core/internal/scene-recipe";
import {
  bakePhysicsWithPinnedRapier,
  readPhysicsBakeRapierResourceState,
} from "./physics-bake-rapier-private.js";

describe("C7B2 pinned deterministic Rapier provider mapping", () => {
  it("bakes closed-volume balls deterministically with canonical observations and snapshot replay", async () => {
    const plan = compilePhysicsBakeAdmissionPlan(bingoFixture()), first = await bakePhysicsWithPinnedRapier(plan), replay = await bakePhysicsWithPinnedRapier(structuredClone(plan));
    expect(replay).toEqual(first);
    expect(first.provider).toEqual({ package: "@dimforge/rapier3d-deterministic-compat", expectedVersion: "0.20.0", reportedVersion: "0.20.0", flavor: "deterministic-compat", runtime: "embedded-wasm" });
    expect(first.finalStates).toHaveLength(16);
    expect(first.bodyStateObservations[0]).toMatchObject({ id: "body-states", sampleEverySteps: 2 });
    expect(first.bodyStateObservations[0]!.samples).toHaveLength(301);
    expect(first.bodyStateObservations[0]!.samples[0]!.step).toBe(0);
    expect(first.contactObservations[0]!.samples.flatMap((sample) => sample.events).some((event) => event.eventId === "ball-floor" && event.phase === "start")).toBe(true);
    expect(first.snapshot).toMatchObject({ step: 300, matchesUninterrupted: true, resumedFinalStateSha256: first.finalStateSha256 });
    expect(first.lifecycle).toEqual({ worldsCreated: 2, worldsFreed: 2, eventQueuesCreated: 1, eventQueuesFreed: 1, activeWorldsAfter: 0, activeEventQueuesAfter: 0 });
    expect(first.fingerprint).toBe("976aa71625a1ab15c8987d00cfd7fc34a93d66bdf34aa815e63ee5dcae4ab0b2");
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("maps a generated 45-brick wall, world-anchor spring, actions and selected impact events", async () => {
    const plan = compilePhysicsBakeAdmissionPlan(wallFixture(5, 9)), result = await bakePhysicsWithPinnedRapier(plan);
    expect(plan.budget).toMatchObject({ bodyCount: 47, constraintCount: 1, actionCount: 2, bodyStateSampleCount: 13_846 });
    expect(result.finalStates).toHaveLength(47);
    expect(result.contactObservations[0]!.samples.flatMap((sample) => sample.events).some((event) => event.eventId.startsWith("impact-contact-") && event.phase === "start")).toBe(true);
    expect(result.bodyStateObservations[0]!.samples.some((sample) => sample.states.some((entry, index) => {
      if (!entry.bodyId.startsWith("brick-")) return false;
      const initial = wallPosition(Math.floor(index / 9), index % 9, 9);
      return Math.hypot(entry.position[0] - initial[0], entry.position[1] - initial[1], entry.position[2] - initial[2]) > 0.1;
    }))).toBe(true);
    expect(result.snapshot.resumedFinalStateSha256).toBe(result.finalStateSha256);
    expect(result.fingerprint).toBe("a7a5d1f09ae526a20be546e3ba65b3058415192e4f9b325772f3a4b92700ae50");
  });

  it("honors CCD on a thin target and canonicalizes the provider collision pair", async () => {
    const result = await bakePhysicsWithPinnedRapier(compilePhysicsBakeAdmissionPlan(ccdFixture())), events = result.contactObservations[0]!.samples.flatMap((sample) => sample.events);
    expect(events).toContainEqual(expect.objectContaining({ eventId: "bullet-target", bodyA: "bullet", bodyB: "target", phase: "start" }));
    expect(result.finalStates.find((entry) => entry.bodyId === "bullet")!.position[0]).toBeLessThan(1);
    expect(result.snapshot.matchesUninterrupted).toBe(true);
    expect(result.fingerprint).toBe("90afb6293c712d6525716414b21765f1cdace515abaa5cd2e6b9448d1b8b1ddb");
  });

  it("refuses forged plans, cancels bounded stepping, and frees every provider resource", async () => {
    const plan = compilePhysicsBakeAdmissionPlan(wallFixture(5, 9)), before = readPhysicsBakeRapierResourceState();
    await expect(bakePhysicsWithPinnedRapier({ ...plan, fingerprint: "0".repeat(64) })).rejects.toThrow(/exact compiler-minted plan/i);
    expect(readPhysicsBakeRapierResourceState()).toEqual(before);
    const already = new AbortController(); already.abort(new Error("already cancelled"));
    await expect(bakePhysicsWithPinnedRapier(plan, { signal: already.signal })).rejects.toThrow("already cancelled");
    expect(readPhysicsBakeRapierResourceState()).toEqual(before);
    const controller = new AbortController(), pending = bakePhysicsWithPinnedRapier(plan, { signal: controller.signal });
    setImmediate(() => controller.abort(new Error("test cancellation")));
    await expect(pending).rejects.toThrow("test cancellation");
    expect(readPhysicsBakeRapierResourceState()).toMatchObject({ activeWorlds: 0, activeEventQueues: 0 });
  });

  it("keeps the pinned provider inside the private host adapter and exact dependency receipt", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string>; exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    const source = readFileSync(new URL("./physics-bake-rapier-private.ts", import.meta.url), "utf8"), publicIndex = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(manifest.dependencies["@dimforge/rapier3d-deterministic-compat"]).toBe("0.20.0");
    expect(manifest.exports["./internal/physics-bake-rapier"]).toBe("./src/internal/physics-bake-rapier.ts");
    expect(manifest.publishConfig.exports["./internal/physics-bake-rapier"]).toEqual({ types: "./dist/internal/physics-bake-rapier.d.ts", default: "./dist/internal/physics-bake-rapier.js" });
    expect(publicIndex).not.toMatch(/physics-bake-rapier/u);
    expect(source).not.toMatch(/node:fs|node:child_process|sourcePackageRoot|outputPackageRoot|renderer-browser|fetch\(|process\.|\.wasm["']/u);
  });
});

function bingoFixture(): any {
  const balls = Array.from({ length: 10 }, (_entry, index) => dynamicBody(`ball-${String(index).padStart(2, "0")}`, [(index % 5 - 2) * 0.55, 0.6 + Math.floor(index / 5) * 0.55, 0]));
  return {
    schema: PHYSICS_BAKE_SCHEMA,
    id: "bingo",
    startUs: 0,
    endUs: 5_000_000,
    stepsPerSecond: 120,
    seed: 42,
    units: { length: "meter", angle: "radian", time: "second", upAxis: "y", forwardAxis: "-z" },
    world: { gravity: [0, -9.81, 0] },
    materials: [{ id: "ball", friction: 0.35, restitution: 0.82 }, { id: "wall", friction: 0.5, restitution: 0.55 }],
    bodies: [...balls, staticBody("wall-back", [0, 2, -2.5], [5, 4, 0.2]), staticBody("wall-floor", [0, 0, 0], [5, 0.2, 5]), staticBody("wall-front", [0, 2, 2.5], [5, 4, 0.2]), staticBody("wall-left", [-2.5, 2, 0], [0.2, 4, 5]), staticBody("wall-right", [2.5, 2, 0], [0.2, 4, 5]), staticBody("wall-top", [0, 4, 0], [5, 0.2, 5])],
    constraints: [],
    actions: [{ id: "force", kind: "force", startStep: 120, endStep: 180, bodyId: "ball-00", vector: [2, 0, 0] }, { id: "impulse", kind: "impulse", atStep: 0, bodyId: "ball-01", vector: [0.5, 1, 0] }],
    events: [{ id: "ball-floor", kind: "collision-pair", bodyA: "ball-00", bodyB: "wall-floor", phases: ["start", "stop"] }],
    observations: [{ id: "body-states", kind: "body-state", bodyIds: balls.map((entry) => entry.id), sampleEverySteps: 2 }, { id: "contacts", kind: "contact-pairs", eventIds: ["ball-floor"], sampleEverySteps: 4 }],
  };
}

function wallFixture(rows: number, columns: number): any {
  const bricks = Array.from({ length: rows }, (_row, row) => Array.from({ length: columns }, (_column, column) => dynamicBody(`brick-r${String(row).padStart(2, "0")}-c${String(column).padStart(2, "0")}`, wallPosition(row, column, columns), "brick", { kind: "box", size: [1, 0.5, 0.5] }))).flat();
  return {
    schema: PHYSICS_BAKE_SCHEMA,
    id: "wrecking-wall",
    startUs: 0,
    endUs: 5_000_000,
    stepsPerSecond: 120,
    seed: 7,
    units: { length: "meter", angle: "radian", time: "second", upAxis: "y", forwardAxis: "-z" },
    world: { gravity: [0, -9.81, 0] },
    materials: [{ id: "brick", friction: 0.65, restitution: 0.08 }, { id: "sphere", friction: 0.4, restitution: 0.15 }],
    bodies: [...bricks, { ...staticBody("ground", [0, 0, 0], [20, 0.2, 8]), materialRef: "brick" }, dynamicBody("sphere", [8, 4, 0], "sphere", { kind: "sphere", radius: 1 }, 80, true)],
    constraints: [{ id: "tether", kind: "distance", bodyA: "sphere", bodyB: null, anchorA: [0, 0, 0], anchorB: [8, 8, 0], restLength: 4, stiffness: 2_000, damping: 80 }],
    actions: [{ id: "impact", kind: "impulse", atStep: 30, bodyId: "sphere", vector: [-920, 0, 0] }, { id: "push", kind: "force", startStep: 60, endStep: 90, bodyId: "sphere", vector: [-20, 0, 0] }],
    events: bricks.map((brick, index) => ({ id: `impact-contact-${String(index).padStart(2, "0")}`, kind: "collision-pair", bodyA: brick.id, bodyB: "sphere", phases: ["start", "stop"] })),
    observations: [{ id: "body-states", kind: "body-state", bodyIds: [...bricks.map((entry) => entry.id), "sphere"], sampleEverySteps: 2 }, { id: "contacts", kind: "contact-pairs", eventIds: bricks.map((_brick, index) => `impact-contact-${String(index).padStart(2, "0")}`), sampleEverySteps: 2 }],
  };
}

function ccdFixture(): any {
  return {
    schema: PHYSICS_BAKE_SCHEMA,
    id: "thin-target-ccd",
    startUs: 0,
    endUs: 1_000_000,
    stepsPerSecond: 120,
    seed: 1,
    units: { length: "meter", angle: "radian", time: "second", upAxis: "y", forwardAxis: "-z" },
    world: { gravity: [0, 0, 0] },
    materials: [{ id: "bullet", friction: 0, restitution: 0.1 }, { id: "target", friction: 0, restitution: 0.1 }],
    bodies: [dynamicBody("bullet", [-4, 0, 0], "bullet", { kind: "sphere", radius: 0.1 }, 1, true, [40, 0, 0]), { ...staticBody("target", [0, 0, 0], [0.02, 4, 4]), materialRef: "target" }],
    constraints: [],
    actions: [],
    events: [{ id: "bullet-target", kind: "collision-pair", bodyA: "bullet", bodyB: "target", phases: ["start", "stop"] }],
    observations: [{ id: "body-states", kind: "body-state", bodyIds: ["bullet"], sampleEverySteps: 1 }, { id: "contacts", kind: "contact-pairs", eventIds: ["bullet-target"], sampleEverySteps: 1 }],
  };
}

function wallPosition(row: number, column: number, columns: number): readonly number[] { return [(column - (columns - 1) / 2) * 1.05, 0.3 + row * 0.55, 0]; }
function dynamicBody(id: string, position: readonly number[], materialRef = "ball", collider: any = { kind: "sphere", radius: 0.2 }, mass = 1, ccd = false, linearVelocity: readonly number[] = [0, 0, 0]): any { return { id, kind: "dynamic", collider, materialRef, position, rotation: [0, 0, 0, 1], collisionGroup: 1, collisionMask: 0xffff, mass, linearVelocity, angularVelocity: [0, 0, 0], ccd }; }
function staticBody(id: string, position: readonly number[], size: readonly number[]): any { return { id, kind: "static", collider: { kind: "box", size }, materialRef: "wall", position, rotation: [0, 0, 0, 1], collisionGroup: 1, collisionMask: 0xffff }; }
