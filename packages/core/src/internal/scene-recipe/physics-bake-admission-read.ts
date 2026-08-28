import {
  PHYSICS_BAKE_ADMISSION_CAPS,
  PHYSICS_BAKE_SCHEMA,
  type PhysicsBakeAction,
  type PhysicsBakeBody,
  type PhysicsBakeCollider,
  type PhysicsBakeCollisionEvent,
  type PhysicsBakeDistanceConstraint,
  type PhysicsBakeMaterial,
  type PhysicsBakeObservation,
  type PhysicsBakeQuaternion,
  type PhysicsBakeRecipe,
  type PhysicsBakeVec3,
} from "./physics-bake-admission-types";
import { exactArray, exactRecord, finite, freeze, integer, safeId, safeUs, snapshotSceneRecipeData, strictIds } from "./scene-recipe-data";

export function readPhysicsBakeRecipe(value: unknown): PhysicsBakeRecipe {
  const root = exactRecord(snapshotSceneRecipeData(value), ["schema", "id", "startUs", "endUs", "stepsPerSecond", "seed", "units", "world", "materials", "bodies", "constraints", "actions", "events", "observations"], [], "Physics bake recipe");
  if (root.schema !== PHYSICS_BAKE_SCHEMA) throw new Error(`Physics bake recipe.schema must equal ${PHYSICS_BAKE_SCHEMA}.`);
  const id = safeId(root.id, "Physics bake recipe.id"), startUs = safeUs(root.startUs, "Physics bake recipe.startUs"), endUs = safeUs(root.endUs, "Physics bake recipe.endUs");
  if (endUs <= startUs) throw new Error("Physics bake recipe.endUs must be greater than startUs.");
  const stepsPerSecond = integer(root.stepsPerSecond, "Physics bake recipe.stepsPerSecond", 15, 240);
  const durationStepsNumerator = (endUs - startUs) * stepsPerSecond;
  if (durationStepsNumerator % 1_000_000 !== 0) throw new Error("Physics bake recipe interval must contain an exact whole number of fixed steps.");
  const stepCount = durationStepsNumerator / 1_000_000;
  if (stepCount < 1 || stepCount > PHYSICS_BAKE_ADMISSION_CAPS.steps) throw new Error(`Physics bake recipe exceeds the ${PHYSICS_BAKE_ADMISSION_CAPS.steps}-step cap.`);
  const materials = exactArray(root.materials, "Physics bake recipe.materials", 1, PHYSICS_BAKE_ADMISSION_CAPS.materials).map(readMaterial);
  strictIds(materials.map((entry) => entry.id), "Physics bake material ids");
  const materialIds = new Set(materials.map((entry) => entry.id));
  const bodies = exactArray(root.bodies, "Physics bake recipe.bodies", 1, PHYSICS_BAKE_ADMISSION_CAPS.bodies).map((entry, index) => readBody(entry, index, materialIds));
  strictIds(bodies.map((entry) => entry.id), "Physics bake body ids");
  const bodyById = new Map(bodies.map((entry) => [entry.id, entry]));
  const constraints = exactArray(root.constraints, "Physics bake recipe.constraints", 0, PHYSICS_BAKE_ADMISSION_CAPS.constraints).map((entry, index) => readConstraint(entry, index, bodyById));
  strictIds(constraints.map((entry) => entry.id), "Physics bake constraint ids");
  const actions = exactArray(root.actions, "Physics bake recipe.actions", 0, PHYSICS_BAKE_ADMISSION_CAPS.actions).map((entry, index) => readAction(entry, index, stepCount, bodyById));
  strictIds(actions.map((entry) => entry.id), "Physics bake action ids");
  const events = exactArray(root.events, "Physics bake recipe.events", 0, PHYSICS_BAKE_ADMISSION_CAPS.events).map((entry, index) => readEvent(entry, index, bodyById));
  strictIds(events.map((entry) => entry.id), "Physics bake event ids");
  const eventIds = new Set(events.map((entry) => entry.id));
  const observations = exactArray(root.observations, "Physics bake recipe.observations", 1, PHYSICS_BAKE_ADMISSION_CAPS.observations).map((entry, index) => readObservation(entry, index, stepCount, bodyById, eventIds));
  strictIds(observations.map((entry) => entry.id), "Physics bake observation ids");
  return freeze({
    schema: PHYSICS_BAKE_SCHEMA,
    id,
    startUs,
    endUs,
    stepsPerSecond,
    seed: integer(root.seed, "Physics bake recipe.seed", 0, 0xffff_ffff),
    units: readUnits(root.units),
    world: readWorld(root.world),
    materials,
    bodies,
    constraints,
    actions,
    events,
    observations,
  });
}

function readUnits(value: unknown): PhysicsBakeRecipe["units"] {
  const root = exactRecord(value, ["length", "angle", "time", "upAxis", "forwardAxis"], [], "Physics bake recipe.units");
  if (root.length !== "meter" || root.angle !== "radian" || root.time !== "second" || root.upAxis !== "y" || root.forwardAxis !== "-z") throw new Error("Physics bake recipe.units must equal meter/radian/second/y/-z.");
  return freeze({ length: "meter" as const, angle: "radian" as const, time: "second" as const, upAxis: "y" as const, forwardAxis: "-z" as const });
}

function readWorld(value: unknown): PhysicsBakeRecipe["world"] {
  const root = exactRecord(value, ["gravity"], [], "Physics bake recipe.world");
  return freeze({ gravity: physicsVec3(root.gravity, "Physics bake recipe.world.gravity", -1_000, 1_000) });
}

function readMaterial(value: unknown, index: number): PhysicsBakeMaterial {
  const label = `Physics bake recipe.materials[${index}]`, root = exactRecord(value, ["id", "friction", "restitution"], [], label);
  return freeze({ id: safeId(root.id, `${label}.id`), friction: physicsFloat(root.friction, `${label}.friction`, 0, 4), restitution: physicsFloat(root.restitution, `${label}.restitution`, 0, 1) });
}

function readBody(value: unknown, index: number, materialIds: ReadonlySet<string>): PhysicsBakeBody {
  const label = `Physics bake recipe.bodies[${index}]`, base = exactRecord(value, ["id", "kind", "collider", "materialRef", "position", "rotation", "collisionGroup", "collisionMask"], ["mass", "linearVelocity", "angularVelocity", "ccd"], label);
  const id = safeId(base.id, `${label}.id`), materialRef = safeId(base.materialRef, `${label}.materialRef`);
  if (!materialIds.has(materialRef)) throw new Error(`${label}.materialRef does not identify a declared material.`);
  const common = {
    id,
    collider: readCollider(base.collider, `${label}.collider`),
    materialRef,
    position: physicsVec3(base.position, `${label}.position`, -10_000, 10_000),
    rotation: readQuaternion(base.rotation, `${label}.rotation`),
    collisionGroup: integer(base.collisionGroup, `${label}.collisionGroup`, 0, 0xffff),
    collisionMask: integer(base.collisionMask, `${label}.collisionMask`, 1, 0xffff),
  };
  if (base.kind === "static") {
    exactRecord(base, ["id", "kind", "collider", "materialRef", "position", "rotation", "collisionGroup", "collisionMask"], [], label);
    return freeze({ ...common, kind: "static" as const });
  }
  if (base.kind === "dynamic") {
    const root = exactRecord(base, ["id", "kind", "collider", "materialRef", "position", "rotation", "collisionGroup", "collisionMask", "mass", "linearVelocity", "angularVelocity", "ccd"], [], label);
    if (typeof root.ccd !== "boolean") throw new Error(`${label}.ccd must be boolean.`);
    return freeze({ ...common, kind: "dynamic" as const, mass: physicsFloat(root.mass, `${label}.mass`, 0.001, 100_000), linearVelocity: physicsVec3(root.linearVelocity, `${label}.linearVelocity`, -10_000, 10_000), angularVelocity: physicsVec3(root.angularVelocity, `${label}.angularVelocity`, -1_000, 1_000), ccd: root.ccd });
  }
  throw new Error(`${label}.kind must equal static or dynamic.`);
}

function readCollider(value: unknown, label: string): PhysicsBakeCollider {
  const base = exactRecord(value, ["kind"], ["radius", "size"], label);
  if (base.kind === "sphere") { const root = exactRecord(base, ["kind", "radius"], [], label); return freeze({ kind: "sphere" as const, radius: physicsFloat(root.radius, `${label}.radius`, 0.001, 1_000) }); }
  if (base.kind === "box") { const root = exactRecord(base, ["kind", "size"], [], label); return freeze({ kind: "box" as const, size: physicsVec3(root.size, `${label}.size`, 0.001, 2_000) }); }
  throw new Error(`${label}.kind must equal sphere or box.`);
}

function readConstraint(value: unknown, index: number, bodies: ReadonlyMap<string, PhysicsBakeBody>): PhysicsBakeDistanceConstraint {
  const label = `Physics bake recipe.constraints[${index}]`, root = exactRecord(value, ["id", "kind", "bodyA", "bodyB", "anchorA", "anchorB", "restLength", "stiffness", "damping"], [], label);
  if (root.kind !== "distance") throw new Error(`${label}.kind must equal distance.`);
  const bodyA = bodyRef(root.bodyA, `${label}.bodyA`, bodies), bodyB = root.bodyB === null ? null : bodyRef(root.bodyB, `${label}.bodyB`, bodies);
  if (bodyB === bodyA) throw new Error(`${label} endpoints must identify distinct bodies or one world anchor.`);
  return freeze({ id: safeId(root.id, `${label}.id`), kind: "distance" as const, bodyA, bodyB, anchorA: physicsVec3(root.anchorA, `${label}.anchorA`, -10_000, 10_000), anchorB: physicsVec3(root.anchorB, `${label}.anchorB`, -10_000, 10_000), restLength: physicsFloat(root.restLength, `${label}.restLength`, 0, 10_000), stiffness: physicsFloat(root.stiffness, `${label}.stiffness`, 0, 1_000_000), damping: physicsFloat(root.damping, `${label}.damping`, 0, 100_000) });
}

function readAction(value: unknown, index: number, stepCount: number, bodies: ReadonlyMap<string, PhysicsBakeBody>): PhysicsBakeAction {
  const label = `Physics bake recipe.actions[${index}]`, base = exactRecord(value, ["id", "kind", "bodyId", "vector"], ["atStep", "startStep", "endStep"], label), id = safeId(base.id, `${label}.id`), bodyId = dynamicBodyRef(base.bodyId, `${label}.bodyId`, bodies), vector = physicsVec3(base.vector, `${label}.vector`, -1_000_000, 1_000_000);
  if (base.kind === "impulse") { const root = exactRecord(base, ["id", "kind", "atStep", "bodyId", "vector"], [], label); return freeze({ id, kind: "impulse" as const, atStep: integer(root.atStep, `${label}.atStep`, 0, stepCount - 1), bodyId, vector }); }
  if (base.kind === "force") { const root = exactRecord(base, ["id", "kind", "startStep", "endStep", "bodyId", "vector"], [], label), startStep = integer(root.startStep, `${label}.startStep`, 0, stepCount - 1), endStep = integer(root.endStep, `${label}.endStep`, 0, stepCount - 1); if (endStep < startStep) throw new Error(`${label}.endStep must be greater than or equal to startStep.`); return freeze({ id, kind: "force" as const, startStep, endStep, bodyId, vector }); }
  throw new Error(`${label}.kind must equal impulse or force.`);
}

function readEvent(value: unknown, index: number, bodies: ReadonlyMap<string, PhysicsBakeBody>): PhysicsBakeCollisionEvent {
  const label = `Physics bake recipe.events[${index}]`, root = exactRecord(value, ["id", "kind", "bodyA", "bodyB", "phases"], [], label);
  if (root.kind !== "collision-pair") throw new Error(`${label}.kind must equal collision-pair.`);
  const bodyA = bodyRef(root.bodyA, `${label}.bodyA`, bodies), bodyB = bodyRef(root.bodyB, `${label}.bodyB`, bodies);
  if (bodyA >= bodyB) throw new Error(`${label} body pair must be strict code-unit ascending and distinct.`);
  const phases = exactArray(root.phases, `${label}.phases`, 1, 2).map((entry) => { if (entry !== "start" && entry !== "stop") throw new Error(`${label}.phases must contain only start or stop.`); return entry; });
  if (phases.some((entry, phaseIndex) => phaseIndex > 0 && phases[phaseIndex - 1]! >= entry)) throw new Error(`${label}.phases must be strict code-unit ascending and unique.`);
  return freeze({ id: safeId(root.id, `${label}.id`), kind: "collision-pair" as const, bodyA, bodyB, phases });
}

function readObservation(value: unknown, index: number, stepCount: number, bodies: ReadonlyMap<string, PhysicsBakeBody>, eventIds: ReadonlySet<string>): PhysicsBakeObservation {
  const label = `Physics bake recipe.observations[${index}]`, base = exactRecord(value, ["id", "kind", "sampleEverySteps"], ["bodyIds", "eventIds"], label), id = safeId(base.id, `${label}.id`), sampleEverySteps = integer(base.sampleEverySteps, `${label}.sampleEverySteps`, 1, stepCount);
  if (base.kind === "body-state") { const root = exactRecord(base, ["id", "kind", "bodyIds", "sampleEverySteps"], [], label), bodyIds = exactArray(root.bodyIds, `${label}.bodyIds`, 1, PHYSICS_BAKE_ADMISSION_CAPS.bodies).map((entry, bodyIndex) => bodyRef(entry, `${label}.bodyIds[${bodyIndex}]`, bodies)); strictIds(bodyIds, `${label}.bodyIds`); return freeze({ id, kind: "body-state" as const, bodyIds, sampleEverySteps }); }
  if (base.kind === "contact-pairs") { const root = exactRecord(base, ["id", "kind", "eventIds", "sampleEverySteps"], [], label), refs = exactArray(root.eventIds, `${label}.eventIds`, 1, PHYSICS_BAKE_ADMISSION_CAPS.events).map((entry, eventIndex) => { const ref = safeId(entry, `${label}.eventIds[${eventIndex}]`); if (!eventIds.has(ref)) throw new Error(`${label}.eventIds does not identify declared event '${ref}'.`); return ref; }); strictIds(refs, `${label}.eventIds`); return freeze({ id, kind: "contact-pairs" as const, eventIds: refs, sampleEverySteps }); }
  throw new Error(`${label}.kind must equal body-state or contact-pairs.`);
}

function bodyRef(value: unknown, label: string, bodies: ReadonlyMap<string, PhysicsBakeBody>): string { const id = safeId(value, label); if (!bodies.has(id)) throw new Error(`${label} does not identify a declared body.`); return id; }
function dynamicBodyRef(value: unknown, label: string, bodies: ReadonlyMap<string, PhysicsBakeBody>): string { const id = bodyRef(value, label, bodies); if (bodies.get(id)!.kind !== "dynamic") throw new Error(`${label} must identify a dynamic body.`); return id; }
function physicsVec3(value: unknown, label: string, minimum: number, maximum: number): PhysicsBakeVec3 { const entries = exactArray(value, label, 3, 3); return freeze(entries.map((entry, index) => physicsFloat(entry, `${label}[${index}]`, minimum, maximum))) as unknown as PhysicsBakeVec3; }
function readQuaternion(value: unknown, label: string): PhysicsBakeQuaternion { const entries = exactArray(value, label, 4, 4).map((entry, index) => physicsFloat(entry, `${label}[${index}]`, -1, 1)), lengthSquared = entries.reduce((sum, entry) => sum + entry * entry, 0); if (Math.abs(lengthSquared - 1) > 0.0001) throw new Error(`${label} must be a unit quaternion within 0.0001 squared-length tolerance.`); return freeze(entries) as unknown as PhysicsBakeQuaternion; }
function physicsFloat(value: unknown, label: string, minimum: number, maximum: number): number { const accepted = finite(value, label, minimum, maximum), normalized = Math.fround(accepted); if (!Number.isFinite(normalized) || normalized < minimum || normalized > maximum) throw new Error(`${label} cannot be represented in the admitted f32 range.`); return Object.is(normalized, -0) ? 0 : normalized; }
