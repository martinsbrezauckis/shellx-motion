/** Private C7B2 bounded author-time adapter. It registers no public or Debug command. */
import RAPIER, { type EventQueue, type RigidBody, type World } from "@dimforge/rapier3d-deterministic-compat";
import { canonicalJsonSha256, compareCodeUnits, hashBuffer } from "@shellx-motion/core";
import {
  readPhysicsBakeAdmissionPlan,
  type PhysicsBakeAdmissionPlan,
  type PhysicsBakeCollisionEvent,
  type PhysicsBakeObservation,
  type PhysicsBakeQuaternion,
  type PhysicsBakeVec3,
} from "@shellx-motion/core/internal/scene-recipe";
import {
  PHYSICS_BAKE_RAPIER_PACKAGE,
  PHYSICS_BAKE_RAPIER_RESULT_SCHEMA,
  PHYSICS_BAKE_RAPIER_VERSION,
  type PhysicsBakeRapierBodyState,
  type PhysicsBakeRapierBodyStateObservation,
  type PhysicsBakeRapierContactEvent,
  type PhysicsBakeRapierContactObservation,
  type PhysicsBakeRapierOptions,
  type PhysicsBakeRapierResourceState,
  type PhysicsBakeRapierResult,
} from "./physics-bake-rapier-types-private.js";

interface RunCounters { worldsCreated: number; worldsFreed: number; eventQueuesCreated: number; eventQueuesFreed: number }
interface ProviderRun {
  readonly finalStates: readonly PhysicsBakeRapierBodyState[];
  readonly bodyStateObservations: readonly PhysicsBakeRapierBodyStateObservation[];
  readonly contactObservations: readonly PhysicsBakeRapierContactObservation[];
  readonly snapshot: Readonly<{ step: number; byteLength: number; sha256: string; resumedFinalStateSha256: string }>;
}
interface WorldAssembly {
  readonly bodies: ReadonlyMap<string, RigidBody>;
  readonly colliderBodyIds: ReadonlyMap<number, string>;
}

const resources = { activeWorlds: 0, activeEventQueues: 0, totalWorldsCreated: 0, totalWorldsFreed: 0, totalEventQueuesCreated: 0, totalEventQueuesFreed: 0 };
let initialization: Promise<void> | undefined;
let providerRunTail: Promise<void> = Promise.resolve();

export function readPhysicsBakeRapierResourceState(): PhysicsBakeRapierResourceState {
  return frozen({ ...resources });
}

/** Revalidates a C7B1 plan, invokes only the host-pinned provider, and returns canonical bake data. */
export async function bakePhysicsWithPinnedRapier(value: unknown, options: PhysicsBakeRapierOptions = {}): Promise<PhysicsBakeRapierResult> {
  throwIfAborted(options.signal);
  const plan = readPhysicsBakeAdmissionPlan(value);
  throwIfAborted(options.signal);
  await initializeProvider();
  throwIfAborted(options.signal);
  const reportedVersion = RAPIER.version();
  if (reportedVersion !== PHYSICS_BAKE_RAPIER_VERSION) throw new Error(`C7B2 requires ${PHYSICS_BAKE_RAPIER_PACKAGE}@${PHYSICS_BAKE_RAPIER_VERSION}; provider reported ${reportedVersion}.`);
  return await withProviderRun(options.signal, async () => {
    const counters: RunCounters = { worldsCreated: 0, worldsFreed: 0, eventQueuesCreated: 0, eventQueuesFreed: 0 };
    const run = await executeProvider(plan, options.signal, counters);
    if (counters.worldsCreated !== counters.worldsFreed || counters.eventQueuesCreated !== counters.eventQueuesFreed || resources.activeWorlds !== 0 || resources.activeEventQueues !== 0) throw new Error("C7B2 provider resources did not return to the terminal zero-active state.");
    const observations = frozen({ bodyState: run.bodyStateObservations, contacts: run.contactObservations });
    const payload = {
      schema: PHYSICS_BAKE_RAPIER_RESULT_SCHEMA,
      admission: frozen({ planFingerprint: plan.fingerprint, recipeSha256: plan.recipeSha256 }),
      provider: frozen({ package: PHYSICS_BAKE_RAPIER_PACKAGE, expectedVersion: PHYSICS_BAKE_RAPIER_VERSION, reportedVersion: PHYSICS_BAKE_RAPIER_VERSION, flavor: "deterministic-compat" as const, runtime: "embedded-wasm" as const }),
      schedule: plan.schedule,
      finalStates: run.finalStates,
      finalStateSha256: canonicalJsonSha256(run.finalStates),
      bodyStateObservations: run.bodyStateObservations,
      contactObservations: run.contactObservations,
      observationsSha256: canonicalJsonSha256(observations),
      snapshot: frozen({ ...run.snapshot, matchesUninterrupted: true as const }),
      lifecycle: frozen({ ...counters, activeWorldsAfter: 0 as const, activeEventQueuesAfter: 0 as const }),
      evidence: frozen({ providerSelectedByHost: true as const, recipeSelectedProvider: false as const, exactPinnedVersion: true as const, fixedStep: true as const, stableBodyOrder: true as const, canonicalEventOrder: true as const, providerRandomnessUsed: false as const, snapshotResumeMatched: true as const, motionPackageRead: false as const, motionPackageWritten: false as const, rendererInvoked: false as const, pixels: false as const }),
    };
    return frozen({ ...payload, fingerprint: canonicalJsonSha256(payload) });
  });
}

async function initializeProvider(): Promise<void> {
  initialization ??= RAPIER.init().catch((error: unknown) => { initialization = undefined; throw error; });
  await initialization;
}

async function withProviderRun<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
  const previous = providerRunTail;
  let release!: () => void;
  providerRunTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { throwIfAborted(signal); return await task(); }
  finally { release(); }
}

async function executeProvider(plan: PhysicsBakeAdmissionPlan, signal: AbortSignal | undefined, counters: RunCounters): Promise<ProviderRun> {
  let world: World | undefined, eventQueue: EventQueue | undefined, restored: World | undefined;
  try {
    world = createWorld(plan, counters);
    const assembly = assembleWorld(world, plan);
    eventQueue = plan.recipe.events.length > 0 ? createEventQueue(counters) : undefined;
    const bodyStateObservations = initializeBodyStateObservations(plan, assembly.bodies);
    const selectedEvents: PhysicsBakeRapierContactEvent[] = [];
    const midpointStep = Math.floor(plan.schedule.stepCount / 2);
    let snapshot: Uint8Array | undefined;
    for (let step = 0; step < plan.schedule.stepCount; step += 1) {
      if (step === midpointStep) snapshot = world.takeSnapshot();
      await boundedYield(step, signal);
      applyStepActions(plan, assembly.bodies, step);
      world.step(eventQueue);
      if (eventQueue) drainSelectedEvents(eventQueue, assembly.colliderBodyIds, plan.recipe.events, step + 1, selectedEvents);
      sampleBodyStates(plan, assembly.bodies, step + 1, bodyStateObservations);
    }
    if (!snapshot) throw new Error("C7B2 failed to capture the midpoint provider snapshot.");
    const finalStates = statesFor(plan.recipe.bodies.map((entry) => entry.id), assembly.bodies);
    const finalStateSha256 = canonicalJsonSha256(finalStates);
    restored = createRestoredWorld(snapshot, counters);
    restored.timestep = 1 / plan.schedule.stepsPerSecond;
    const restoredBodies = new Map<string, RigidBody>();
    for (const [id, body] of assembly.bodies) {
      const reopened = restored.getRigidBody(body.handle);
      if (!reopened) throw new Error(`C7B2 snapshot omitted admitted body '${id}'.`);
      restoredBodies.set(id, reopened);
    }
    for (let step = midpointStep; step < plan.schedule.stepCount; step += 1) {
      await boundedYield(step - midpointStep, signal);
      applyStepActions(plan, restoredBodies, step);
      restored.step();
    }
    const resumedFinalStateSha256 = canonicalJsonSha256(statesFor(plan.recipe.bodies.map((entry) => entry.id), restoredBodies));
    if (resumedFinalStateSha256 !== finalStateSha256) throw new Error("C7B2 snapshot-resumed final state differs from uninterrupted simulation.");
    return frozen({
      finalStates,
      bodyStateObservations: finishBodyStateObservations(bodyStateObservations),
      contactObservations: buildContactObservations(plan, selectedEvents),
      snapshot: frozen({ step: midpointStep, byteLength: snapshot.byteLength, sha256: hashBuffer(Buffer.from(snapshot)), resumedFinalStateSha256 }),
    });
  } finally {
    try {
      if (eventQueue) freeEventQueue(eventQueue, counters);
    } finally {
      try {
        if (restored) freeWorld(restored, counters);
      } finally {
        if (world) freeWorld(world, counters);
      }
    }
  }
}

function createWorld(plan: PhysicsBakeAdmissionPlan, counters: RunCounters): World {
  const [x, y, z] = plan.recipe.world.gravity, world = new RAPIER.World({ x, y, z });
  world.timestep = 1 / plan.schedule.stepsPerSecond;
  counters.worldsCreated += 1; resources.activeWorlds += 1; resources.totalWorldsCreated += 1;
  return world;
}

function createRestoredWorld(snapshot: Uint8Array, counters: RunCounters): World {
  const world = RAPIER.World.restoreSnapshot(snapshot);
  counters.worldsCreated += 1; resources.activeWorlds += 1; resources.totalWorldsCreated += 1;
  return world;
}

function createEventQueue(counters: RunCounters): EventQueue {
  const queue = new RAPIER.EventQueue(true);
  counters.eventQueuesCreated += 1; resources.activeEventQueues += 1; resources.totalEventQueuesCreated += 1;
  return queue;
}

function freeWorld(world: World, counters: RunCounters): void {
  world.free(); counters.worldsFreed += 1; resources.activeWorlds -= 1; resources.totalWorldsFreed += 1;
}

function freeEventQueue(queue: EventQueue, counters: RunCounters): void {
  queue.free(); counters.eventQueuesFreed += 1; resources.activeEventQueues -= 1; resources.totalEventQueuesFreed += 1;
}

function assembleWorld(world: World, plan: PhysicsBakeAdmissionPlan): WorldAssembly {
  const materials = new Map(plan.recipe.materials.map((entry) => [entry.id, entry])), bodies = new Map<string, RigidBody>(), colliderBodyIds = new Map<number, string>();
  const eventBodyIds = new Set(plan.recipe.events.flatMap((entry) => [entry.bodyA, entry.bodyB]));
  for (const body of plan.recipe.bodies) {
    const descriptor = body.kind === "dynamic" ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed();
    descriptor.setTranslation(...body.position).setRotation(quaternion(body.rotation));
    if (body.kind === "dynamic") descriptor.setLinvel(...body.linearVelocity).setAngvel(vector(body.angularVelocity)).setCcdEnabled(body.ccd);
    const rigidBody = world.createRigidBody(descriptor), material = materials.get(body.materialRef)!;
    const collider = body.collider.kind === "sphere" ? RAPIER.ColliderDesc.ball(body.collider.radius) : RAPIER.ColliderDesc.cuboid(Math.fround(body.collider.size[0] / 2), Math.fround(body.collider.size[1] / 2), Math.fround(body.collider.size[2] / 2));
    collider.setFriction(material.friction).setRestitution(material.restitution).setCollisionGroups(interactionGroups(body.collisionGroup, body.collisionMask));
    if (body.kind === "dynamic") collider.setMass(body.mass);
    if (eventBodyIds.has(body.id)) collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const createdCollider = world.createCollider(collider, rigidBody);
    bodies.set(body.id, rigidBody); colliderBodyIds.set(createdCollider.handle, body.id);
  }
  for (const constraint of plan.recipe.constraints) {
    const bodyA = bodies.get(constraint.bodyA)!;
    let bodyB: RigidBody;
    if (constraint.bodyB === null) bodyB = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    else bodyB = bodies.get(constraint.bodyB)!;
    world.createImpulseJoint(RAPIER.JointData.spring(constraint.restLength, constraint.stiffness, constraint.damping, vector(constraint.anchorA), vector(constraint.anchorB)), bodyA, bodyB, true);
  }
  return frozen({ bodies, colliderBodyIds });
}

function applyStepActions(plan: PhysicsBakeAdmissionPlan, bodies: ReadonlyMap<string, RigidBody>, step: number): void {
  for (const body of plan.recipe.bodies) if (body.kind === "dynamic") bodies.get(body.id)!.resetForces(false);
  for (const action of plan.recipe.actions) {
    const body = bodies.get(action.bodyId)!;
    if (action.kind === "impulse" && action.atStep === step) body.applyImpulse(vector(action.vector), true);
    if (action.kind === "force" && action.startStep <= step && step <= action.endStep) body.addForce(vector(action.vector), true);
  }
}

function drainSelectedEvents(queue: EventQueue, colliderBodyIds: ReadonlyMap<number, string>, selectors: readonly PhysicsBakeCollisionEvent[], step: number, output: PhysicsBakeRapierContactEvent[]): void {
  const byPair = new Map<string, PhysicsBakeCollisionEvent[]>();
  for (const selector of selectors) {
    const key = pairKey(selector.bodyA, selector.bodyB), entries = byPair.get(key) ?? [];
    entries.push(selector); byPair.set(key, entries);
  }
  const stepEvents: PhysicsBakeRapierContactEvent[] = [];
  queue.drainCollisionEvents((leftHandle, rightHandle, started) => {
    const left = colliderBodyIds.get(leftHandle), right = colliderBodyIds.get(rightHandle);
    if (!left || !right || left === right) return;
    const [bodyA, bodyB] = left < right ? [left, right] : [right, left], phase = started ? "start" as const : "stop" as const;
    for (const selector of byPair.get(pairKey(bodyA, bodyB)) ?? []) if (selector.phases.includes(phase)) stepEvents.push(frozen({ eventId: selector.id, bodyA, bodyB, phase, step }));
  });
  stepEvents.sort(compareContactEvents); output.push(...stepEvents);
}

function initializeBodyStateObservations(plan: PhysicsBakeAdmissionPlan, bodies: ReadonlyMap<string, RigidBody>): Array<{ definition: Extract<PhysicsBakeObservation, { kind: "body-state" }>; samples: Array<{ step: number; states: readonly PhysicsBakeRapierBodyState[] }> }> {
  return plan.recipe.observations.filter((entry): entry is Extract<PhysicsBakeObservation, { kind: "body-state" }> => entry.kind === "body-state").map((definition) => ({ definition, samples: [{ step: 0, states: statesFor(definition.bodyIds, bodies) }] }));
}

function sampleBodyStates(plan: PhysicsBakeAdmissionPlan, bodies: ReadonlyMap<string, RigidBody>, step: number, observations: ReturnType<typeof initializeBodyStateObservations>): void {
  if (step > plan.schedule.stepCount) throw new Error("C7B2 body-state sample exceeded admitted schedule.");
  for (const observation of observations) if (step % observation.definition.sampleEverySteps === 0) observation.samples.push({ step, states: statesFor(observation.definition.bodyIds, bodies) });
}

function finishBodyStateObservations(observations: ReturnType<typeof initializeBodyStateObservations>): readonly PhysicsBakeRapierBodyStateObservation[] {
  return frozen(observations.map(({ definition, samples }) => frozen({ id: definition.id, sampleEverySteps: definition.sampleEverySteps, samples: frozen(samples.map((sample) => frozen({ step: sample.step, states: sample.states }))) })));
}

function buildContactObservations(plan: PhysicsBakeAdmissionPlan, events: readonly PhysicsBakeRapierContactEvent[]): readonly PhysicsBakeRapierContactObservation[] {
  const definitions = plan.recipe.observations.filter((entry): entry is Extract<PhysicsBakeObservation, { kind: "contact-pairs" }> => entry.kind === "contact-pairs");
  return frozen(definitions.map((definition) => {
    const selected = new Set(definition.eventIds), buckets = new Map<number, PhysicsBakeRapierContactEvent[]>();
    for (const event of events) if (selected.has(event.eventId)) {
      const boundary = Math.min(plan.schedule.stepCount, Math.ceil(event.step / definition.sampleEverySteps) * definition.sampleEverySteps), bucket = buckets.get(boundary) ?? [];
      bucket.push(event); buckets.set(boundary, bucket);
    }
    const samples = [...buckets].sort(([left], [right]) => left - right).map(([step, bucket]) => frozen({ step, events: frozen([...bucket].sort(compareContactEvents)) }));
    return frozen({ id: definition.id, sampleEverySteps: definition.sampleEverySteps, samples: frozen(samples) });
  }));
}

function statesFor(bodyIds: readonly string[], bodies: ReadonlyMap<string, RigidBody>): readonly PhysicsBakeRapierBodyState[] {
  return frozen(bodyIds.map((bodyId) => {
    const body = bodies.get(bodyId);
    if (!body) throw new Error(`C7B2 provider omitted admitted body '${bodyId}'.`);
    const position = body.translation(), rotation = body.rotation(), linear = body.linvel(), angular = body.angvel();
    return frozen({ bodyId, position: vec3(position.x, position.y, position.z), rotation: quat(rotation.x, rotation.y, rotation.z, rotation.w), linearVelocity: vec3(linear.x, linear.y, linear.z), angularVelocity: vec3(angular.x, angular.y, angular.z) });
  }));
}

async function boundedYield(step: number, signal: AbortSignal | undefined): Promise<void> {
  if (step % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("C7B2 physics bake was cancelled.");
}

function interactionGroups(group: number, mask: number): number { return (((group & 0xffff) << 16) | (mask & 0xffff)) >>> 0; }
function pairKey(bodyA: string, bodyB: string): string { return `${bodyA}\u0000${bodyB}`; }
function vector(value: PhysicsBakeVec3): { x: number; y: number; z: number } { return { x: value[0], y: value[1], z: value[2] }; }
function quaternion(value: PhysicsBakeQuaternion): { x: number; y: number; z: number; w: number } { return { x: value[0], y: value[1], z: value[2], w: value[3] }; }
function normalized(value: number): number { const result = Math.fround(value); return Object.is(result, -0) ? 0 : result; }
function vec3(x: number, y: number, z: number): PhysicsBakeVec3 { return frozen([normalized(x), normalized(y), normalized(z)]) as PhysicsBakeVec3; }
function quat(x: number, y: number, z: number, w: number): PhysicsBakeQuaternion { return frozen([normalized(x), normalized(y), normalized(z), normalized(w)]) as PhysicsBakeQuaternion; }
function compareContactEvents(left: PhysicsBakeRapierContactEvent, right: PhysicsBakeRapierContactEvent): number { return left.step - right.step || compareCodeUnits(left.eventId, right.eventId) || compareCodeUnits(left.phase, right.phase) || compareCodeUnits(left.bodyA, right.bodyA) || compareCodeUnits(left.bodyB, right.bodyB); }
function frozen<T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
