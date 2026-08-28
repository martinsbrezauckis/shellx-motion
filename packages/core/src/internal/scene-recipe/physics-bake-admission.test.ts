import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../canonical-json";
import { compilePhysicsBakeAdmissionPlan, readPhysicsBakeAdmissionPlan } from "./physics-bake-admission";
import { readPhysicsBakeRecipe } from "./physics-bake-admission-read";
import { PHYSICS_BAKE_ADMISSION_CAPS, PHYSICS_BAKE_SCHEMA } from "./physics-bake-admission-types";

describe("C7B1 provider-neutral deterministic simulation admission", () => {
  it("compiles a closed-volume ball recipe into exact bounded provider-free evidence", () => {
    const recipe = bingoFixture(), first = compilePhysicsBakeAdmissionPlan(recipe), replay = compilePhysicsBakeAdmissionPlan(structuredClone(recipe));
    expect(replay).toEqual(first);
    expect(Buffer.from(canonicalJson(replay))).toEqual(Buffer.from(canonicalJson(first)));
    expect(first.schedule).toEqual({ startUs: 0, endUs: 5_000_000, stepsPerSecond: 120, stepDuration: { numeratorUs: 1_000_000, denominator: 120 }, stepCount: 600 });
    expect(first.budget).toMatchObject({ materialCount: 2, bodyCount: 16, dynamicBodyCount: 10, staticBodyCount: 6, constraintCount: 0, actionCount: 2, eventCount: 1, observationCount: 2, stepCount: 600, bodySteps: 9_600, bodyStateSampleCount: 3_010, contactEventUpperBound: 1_200 });
    expect(first.evidence).toEqual({ providerNeutral: true, providerSelected: false, providerInvoked: false, exactRationalSchedule: true, f32Inputs: true, stableOrderedIds: true, packageRead: false, packageWritten: false, rendererInvoked: false, pixels: false });
    expect(first.recipe.world.gravity[1]).toBe(Math.fround(-9.81));
    expect(first.recipe.bodies[0]!.position[0]).toBe(0);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.recipe.bodies[0]!.collider)).toBe(true);
    expect([first.fingerprint, compilePhysicsBakeAdmissionPlan(wallFixture(5, 9)).fingerprint]).toEqual(["1e9d6c273c050499e56da45a8244a945ee9012126134afb171b6aeeff21d2bf3", "85facc2e95c5eca1e407fbf8f0383534e5f295fcd172a1e697f896c6f4ce692b"]);
    const { fingerprint: _fingerprint, ...payload } = first;
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.budget.planBytes).toBe(Buffer.byteLength(canonicalJson(payload), "utf8"));
    expect(readPhysicsBakeAdmissionPlan(first)).toEqual(first);
    expect(() => readPhysicsBakeAdmissionPlan({ ...first, fingerprint: "0".repeat(64) })).toThrow(/exact compiler-minted plan/i);
  });

  it("admits a generated brick wall, world tether, exact actions, events and observations without simulating", () => {
    const plan = compilePhysicsBakeAdmissionPlan(wallFixture(5, 9));
    expect(plan.budget).toMatchObject({ bodyCount: 47, dynamicBodyCount: 46, staticBodyCount: 1, constraintCount: 1, actionCount: 2, eventCount: 1, observationCount: 2, stepCount: 600, bodySteps: 28_200, bodyStateSampleCount: 13_846, contactEventUpperBound: 1_200 });
    expect(plan.recipe.constraints[0]).toMatchObject({ id: "tether", bodyA: "sphere", bodyB: null, restLength: Math.fround(4) });
    expect(plan.recipe.actions).toEqual([
      { id: "impact", kind: "impulse", atStep: 30, bodyId: "sphere", vector: [Math.fround(-180), 0, 0] },
      { id: "push", kind: "force", startStep: 60, endStep: 90, bodyId: "sphere", vector: [Math.fround(-20), 0, 0] },
    ]);
    expect(plan.recipe.events[0]).toEqual({ id: "first-hit", kind: "collision-pair", bodyA: "brick-r00-c00", bodyB: "sphere", phases: ["start", "stop"] });
    expect(plan.recipe.observations.map((entry) => entry.kind)).toEqual(["body-state", "contact-pairs"]);
    expect(plan.evidence.providerInvoked).toBe(false);
  });

  it("refuses hostile data and package, provider, runtime, path or renderer authority fields", () => {
    const hostile = bingoFixture(); let reads = 0;
    Object.defineProperty(hostile, "bodies", { enumerable: true, get() { reads += 1; return []; } });
    expect(() => readPhysicsBakeRecipe(hostile)).toThrow(/enumerable data field/i);
    expect(reads).toBe(0);
    for (const field of ["provider", "wasmModule", "binaryPath", "outputPath", "renderer", "threadCount", "callback", "url"]) {
      expect(() => readPhysicsBakeRecipe({ ...bingoFixture(), [field]: field })).toThrow(`unknown field '${field}'`);
    }
    const sparse = bingoFixture(); sparse.bodies = new Array(2); sparse.bodies[1] = bingoFixture().bodies[0];
    expect(() => readPhysicsBakeRecipe(sparse)).toThrow(/dense/i);
  });

  it("enforces exact rational schedule, f32 values, strict ids and closed collider/body unions", () => {
    expect(() => readPhysicsBakeRecipe({ ...bingoFixture(), endUs: 5_000_001 })).toThrow(/whole number of fixed steps/i);
    expect(() => readPhysicsBakeRecipe({ ...bingoFixture(), stepsPerSecond: 241 })).toThrow(/15..240/);
    const order = bingoFixture(); order.bodies = [...order.bodies].reverse(); expect(() => readPhysicsBakeRecipe(order)).toThrow(/body ids.*ascending/i);
    const collider = bingoFixture(); collider.bodies[0].collider = { kind: "sphere", radius: 0.2, size: [1, 1, 1] }; expect(() => readPhysicsBakeRecipe(collider)).toThrow(/unknown field 'size'/i);
    const staticVelocity = bingoFixture(); staticVelocity.bodies[10].linearVelocity = [0, 0, 0]; expect(() => readPhysicsBakeRecipe(staticVelocity)).toThrow(/unknown field 'linearVelocity'/i);
    const deadDensity = bingoFixture(); deadDensity.materials[0].density = 1; expect(() => readPhysicsBakeRecipe(deadDensity)).toThrow(/unknown field 'density'/i);
    const quaternion = bingoFixture(); quaternion.bodies[0].rotation = [0, 0, 0, 0.5]; expect(() => readPhysicsBakeRecipe(quaternion)).toThrow(/unit quaternion/i);
    const nonFinite = bingoFixture(); nonFinite.world.gravity = [0, Number.NaN, 0]; expect(() => readPhysicsBakeRecipe(nonFinite)).toThrow(/finite/i);
  });

  it("binds constraints, dynamic actions, collision pairs and observations to exact declared ids", () => {
    const constraint = wallFixture(3, 5); constraint.constraints[0].bodyA = "missing"; expect(() => readPhysicsBakeRecipe(constraint)).toThrow(/declared body/i);
    const sameEndpoint = wallFixture(3, 5); sameEndpoint.constraints[0].bodyB = "sphere"; expect(() => readPhysicsBakeRecipe(sameEndpoint)).toThrow(/distinct bodies/i);
    const staticAction = wallFixture(3, 5); staticAction.actions[0].bodyId = "ground"; expect(() => readPhysicsBakeRecipe(staticAction)).toThrow(/dynamic body/i);
    const actionTime = wallFixture(3, 5); actionTime.actions[1].endStep = 600; expect(() => readPhysicsBakeRecipe(actionTime)).toThrow(/0..599/);
    const eventOrder = wallFixture(3, 5); [eventOrder.events[0].bodyA, eventOrder.events[0].bodyB] = [eventOrder.events[0].bodyB, eventOrder.events[0].bodyA]; expect(() => readPhysicsBakeRecipe(eventOrder)).toThrow(/ascending and distinct/i);
    const observation = wallFixture(3, 5); observation.observations[1].eventIds = ["missing"]; expect(() => readPhysicsBakeRecipe(observation)).toThrow(/declared event/i);
  });

  it("enforces list, step and aggregate body-step caps before any provider work", () => {
    const tooManyBodies = bingoFixture(); tooManyBodies.bodies = Array.from({ length: PHYSICS_BAKE_ADMISSION_CAPS.bodies + 1 }, (_entry, index) => dynamicBody(`ball-${String(index).padStart(3, "0")}`, [0, 0, 0])); expect(() => readPhysicsBakeRecipe(tooManyBodies)).toThrow(/1..256 entries/i);
    const tooManySteps = bingoFixture(); tooManySteps.endUs = 61_000_000; expect(() => readPhysicsBakeRecipe(tooManySteps)).toThrow(/7200-step cap/i);
    const aggregate = bingoFixture(); aggregate.endUs = 60_000_000; aggregate.bodies = Array.from({ length: 256 }, (_entry, index) => dynamicBody(`ball-${String(index).padStart(3, "0")}`, [0, 0, 0])); aggregate.constraints = []; aggregate.actions = []; aggregate.events = []; aggregate.observations = [{ id: "body-states", kind: "body-state", bodyIds: aggregate.bodies.map((entry: any) => entry.id), sampleEverySteps: 120 }]; expect(() => compilePhysicsBakeAdmissionPlan(aggregate)).toThrow(/1500000-body-step cap/i);
    const actions = bingoFixture(); actions.actions = Array.from({ length: PHYSICS_BAKE_ADMISSION_CAPS.actions + 1 }, (_entry, index) => ({ id: `action-${String(index).padStart(3, "0")}`, kind: "impulse", atStep: 0, bodyId: "ball-00", vector: [1, 0, 0] })); expect(() => readPhysicsBakeRecipe(actions)).toThrow(/0..512 entries/i);
    const bodySamples = bingoFixture(); bodySamples.endUs = 40_000_000; bodySamples.bodies = Array.from({ length: 256 }, (_entry, index) => dynamicBody(`ball-${String(index).padStart(3, "0")}`, [0, 0, 0])); bodySamples.actions = []; bodySamples.events = []; bodySamples.observations = [{ id: "body-states", kind: "body-state", bodyIds: bodySamples.bodies.map((entry: any) => entry.id), sampleEverySteps: 1 }]; expect(() => compilePhysicsBakeAdmissionPlan(bodySamples)).toThrow(/body-state-sample cap/i);
  });

  it("keeps the packed-private compiler outside package, process, renderer and provider execution authority", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    const sources = ["physics-bake-admission-types.ts", "physics-bake-admission-read.ts", "physics-bake-admission.ts"].map((name) => readFileSync(new URL(name, import.meta.url), "utf8")).join("\n");
    expect(manifest.exports["./internal/scene-recipe"]).toBe("./src/internal/scene-recipe/scene-recipe.ts");
    expect(manifest.publishConfig.exports["./internal/scene-recipe"]).toEqual({ types: "./dist/internal/scene-recipe/scene-recipe.d.ts", default: "./dist/internal/scene-recipe/scene-recipe.js" });
    expect(sources).not.toMatch(/node:fs|node:child_process|renderer-browser|sourcePackageRoot|outputPackageRoot|fetch\(|process\.|@dimforge|rapier|jolt|cannon-es/u);
  });
});

function bingoFixture(): any {
  const balls = Array.from({ length: 10 }, (_entry, index) => dynamicBody(`ball-${String(index).padStart(2, "0")}`, [index === 0 ? -0 : (index % 5 - 2) * 0.55, 0.6 + Math.floor(index / 5) * 0.55, 0]));
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
    observations: [{ id: "body-states", kind: "body-state", bodyIds: balls.map((entry) => entry.id), sampleEverySteps: 2 }, { id: "contacts", kind: "contact-pairs", eventIds: ["ball-floor"], sampleEverySteps: 1 }],
  };
}

function wallFixture(rows: number, columns: number): any {
  const bricks = Array.from({ length: rows }, (_row, row) => Array.from({ length: columns }, (_column, column) => dynamicBody(`brick-r${String(row).padStart(2, "0")}-c${String(column).padStart(2, "0")}`, [(column - (columns - 1) / 2) * 1.05, 0.3 + row * 0.55, 0], "brick", { kind: "box", size: [1, 0.5, 0.5] }))).flat();
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
    actions: [{ id: "impact", kind: "impulse", atStep: 30, bodyId: "sphere", vector: [-180, 0, 0] }, { id: "push", kind: "force", startStep: 60, endStep: 90, bodyId: "sphere", vector: [-20, 0, 0] }],
    events: [{ id: "first-hit", kind: "collision-pair", bodyA: bricks[0].id, bodyB: "sphere", phases: ["start", "stop"] }],
    observations: [{ id: "body-states", kind: "body-state", bodyIds: [...bricks.map((entry) => entry.id), "sphere"], sampleEverySteps: 2 }, { id: "contacts", kind: "contact-pairs", eventIds: ["first-hit"], sampleEverySteps: 1 }],
  };
}

function dynamicBody(id: string, position: readonly number[], materialRef = "ball", collider: any = { kind: "sphere", radius: 0.2 }, mass = 1, ccd = false): any { return { id, kind: "dynamic", collider, materialRef, position, rotation: [0, 0, 0, 1], collisionGroup: 1, collisionMask: 0xffff, mass, linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0], ccd }; }
function staticBody(id: string, position: readonly number[], size: readonly number[]): any { return { id, kind: "static", collider: { kind: "box", size }, materialRef: "wall", position, rotation: [0, 0, 0, 1], collisionGroup: 1, collisionMask: 0xffff }; }
