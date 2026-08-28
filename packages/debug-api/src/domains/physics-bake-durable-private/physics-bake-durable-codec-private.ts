import { canonicalJson, canonicalJsonSha256, hashBuffer } from "@shellx-motion/core";
import type { PhysicsBakeAdmissionPlan } from "@shellx-motion/core/internal/scene-recipe";
import type {
  PhysicsBakeRapierBodyState,
  PhysicsBakeRapierBodyStateObservation,
  PhysicsBakeRapierContactObservation,
  PhysicsBakeRapierResult,
} from "../physics-bake-rapier-private/physics-bake-rapier-types-private.js";
import {
  PHYSICS_BAKE_DURABLE_CAPS,
  PHYSICS_BAKE_DURABLE_CODEC,
  PHYSICS_BAKE_DURABLE_MANIFEST_SCHEMA,
  type PhysicsBakeDurableBodyObservation,
  type PhysicsBakeDurableBodySegment,
  type PhysicsBakeDurableContactObservation,
  type PhysicsBakeDurableContactSegment,
  type PhysicsBakeDurableManifest,
  type PhysicsBakeDurablePrepared,
  type PhysicsBakeDurableSegment,
} from "./physics-bake-durable-types-private.js";

const BODY_MAGIC = Buffer.from("SXMPB3B1", "ascii"), CONTACT_MAGIC = Buffer.from("SXMPB3C1", "ascii"), BODY_CHANNELS = 13;

/** Losslessly lowers one host-produced C7B2 result into deterministic renderer-neutral segments. */
export function compilePhysicsBakeDurableArtifact(plan: PhysicsBakeAdmissionPlan, result: PhysicsBakeRapierResult): PhysicsBakeDurablePrepared {
  assertSource(plan, result);
  const dynamicIds = plan.recipe.bodies.filter((body) => body.kind === "dynamic").map((body) => body.id);
  const primary = result.bodyStateObservations.filter((entry) => sameIds(entry.samples[0]?.states.map((state) => state.bodyId) ?? [], dynamicIds) && entry.samples[0]?.step === 0 && entry.samples.at(-1)?.step === plan.schedule.stepCount);
  if (primary.length !== 1) throw new Error("C7B3 requires exactly one body-state observation covering every dynamic body from step zero through the terminal step.");
  const terminal = primary[0]!.samples.at(-1)!.states, expectedTerminal = result.finalStates.filter((state) => dynamicIds.includes(state.bodyId));
  if (canonicalJson(terminal) !== canonicalJson(expectedTerminal)) throw new Error("C7B3 primary dynamic track does not match the provider terminal states.");

  const segments: Array<{ descriptor: PhysicsBakeDurableSegment; bytes: Buffer }> = [], bodyObservations: PhysicsBakeDurableBodyObservation[] = [], contactObservations: PhysicsBakeDurableContactObservation[] = [];
  for (const observation of result.bodyStateObservations) bodyObservations.push(encodeBodyObservation(observation, segments));
  for (const observation of result.contactObservations) contactObservations.push(encodeContactObservation(plan, observation, segments));
  if (segments.length > PHYSICS_BAKE_DURABLE_CAPS.segments) throw new Error(`C7B3 artifact exceeds the ${PHYSICS_BAKE_DURABLE_CAPS.segments}-segment cap.`);
  const segmentBytes = segments.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  if (segmentBytes > PHYSICS_BAKE_DURABLE_CAPS.segmentBytes) throw new Error(`C7B3 artifact exceeds the ${PHYSICS_BAKE_DURABLE_CAPS.segmentBytes}-byte segment cap.`);
  const sourceObservations = frozen({ bodyState: result.bodyStateObservations, contacts: result.contactObservations }), sourceObservationBytes = Buffer.byteLength(canonicalJson(sourceObservations), "utf8");
  if (sourceObservationBytes > PHYSICS_BAKE_DURABLE_CAPS.sourceObservationBytes) throw new Error(`C7B3 source observations exceed the ${PHYSICS_BAKE_DURABLE_CAPS.sourceObservationBytes}-byte serialization cap.`);
  const compression = frozen({ codec: PHYSICS_BAKE_DURABLE_CODEC, sourceObservationBytes, segmentBytes, savedBytes: sourceObservationBytes - segmentBytes, ratioPartsPerMillion: sourceObservationBytes === 0 ? 0 : Math.floor(segmentBytes * 1_000_000 / sourceObservationBytes), lossless: true as const, idsStoredOnce: true as const, samplesSimplified: false as const, valuesQuantized: false as const, caps: PHYSICS_BAKE_DURABLE_CAPS });
  const base = {
    schema: PHYSICS_BAKE_DURABLE_MANIFEST_SCHEMA,
    source: frozen({ planFingerprint: plan.fingerprint, recipeSha256: plan.recipeSha256, resultFingerprint: result.fingerprint, providerPackage: result.provider.package, providerVersion: result.provider.reportedVersion, observationsSha256: result.observationsSha256, snapshotSha256: result.snapshot.sha256 }),
    schedule: frozen({ startUs: plan.schedule.startUs, endUs: plan.schedule.endUs, stepsPerSecond: plan.schedule.stepsPerSecond, stepCount: plan.schedule.stepCount }),
    primaryBodyObservationId: primary[0]!.id,
    finalStates: result.finalStates,
    finalStateSha256: result.finalStateSha256,
    bodyObservations: frozen(bodyObservations), contactObservations: frozen(contactObservations), segments: frozen(segments.map((entry) => entry.descriptor)), compression,
    evidence: frozen({ rendererNeutral: true as const, packageRead: false as const, packageWritten: false as const, rendererInvoked: false as const, pixels: false as const }),
  };
  const manifest = frozen({ ...base, fingerprint: canonicalJsonSha256(base) });
  return frozen({ manifest, segments: frozen(segments.map((entry) => frozen(entry))), bodyStateObservations: result.bodyStateObservations, contactObservations: result.contactObservations });
}

function encodeBodyObservation(observation: PhysicsBakeRapierBodyStateObservation, output: Array<{ descriptor: PhysicsBakeDurableSegment; bytes: Buffer }>): PhysicsBakeDurableBodyObservation {
  const bodyIds = observation.samples[0]?.states.map((state) => state.bodyId) ?? [];
  if (bodyIds.length === 0 || observation.samples.length === 0) throw new Error(`C7B3 body observation '${observation.id}' is empty.`);
  for (const sample of observation.samples) if (!sameIds(sample.states.map((state) => state.bodyId), bodyIds)) throw new Error(`C7B3 body observation '${observation.id}' changes body order.`);
  const samplesPerSegment = Math.max(1, Math.floor(PHYSICS_BAKE_DURABLE_CAPS.bodyStatesPerSegment / bodyIds.length)), segmentPaths: string[] = [];
  for (let start = 0; start < observation.samples.length; start += samplesPerSegment) {
    const samples = observation.samples.slice(start, start + samplesPerSegment), bytes = encodeBodySegment(samples, bodyIds.length), path = nextPath(output.length), descriptor: PhysicsBakeDurableBodySegment = frozen({ index: output.length, path, kind: "body-state", observationId: observation.id, byteLength: bytes.byteLength, sha256: hashBuffer(bytes), sampleStart: start, sampleCount: samples.length, firstStep: samples[0]!.step, lastStep: samples.at(-1)!.step, bodyCount: bodyIds.length, stateCount: samples.length * bodyIds.length });
    output.push({ descriptor, bytes }); segmentPaths.push(path);
  }
  return frozen({ id: observation.id, sampleEverySteps: observation.sampleEverySteps, bodyIds: frozen(bodyIds), sourceSha256: canonicalJsonSha256(observation), sampleCount: observation.samples.length, stateCount: observation.samples.length * bodyIds.length, segmentPaths: frozen(segmentPaths) });
}

function encodeContactObservation(plan: PhysicsBakeAdmissionPlan, observation: PhysicsBakeRapierContactObservation, output: Array<{ descriptor: PhysicsBakeDurableSegment; bytes: Buffer }>): PhysicsBakeDurableContactObservation {
  const definition = plan.recipe.observations.find((entry) => entry.kind === "contact-pairs" && entry.id === observation.id);
  if (!definition || definition.kind !== "contact-pairs") throw new Error(`C7B3 contact observation '${observation.id}' has no admitted definition.`);
  const byId = new Map(plan.recipe.events.map((entry) => [entry.id, entry])), events = definition.eventIds.map((id) => byId.get(id)!);
  const eventIndex = new Map(events.map((entry, index) => [entry.id, index])), chunks: Array<typeof observation.samples> = [];
  let current: typeof observation.samples = [], count = 0;
  for (const sample of observation.samples) {
    if (sample.events.length > PHYSICS_BAKE_DURABLE_CAPS.contactEventsPerSegment) throw new Error(`C7B3 contact sample '${observation.id}' exceeds the per-segment event cap.`);
    if (current.length > 0 && count + sample.events.length > PHYSICS_BAKE_DURABLE_CAPS.contactEventsPerSegment) { chunks.push(current); current = []; count = 0; }
    for (const event of sample.events) {
      const expected = byId.get(event.eventId);
      if (!expected || expected.bodyA !== event.bodyA || expected.bodyB !== event.bodyB || !expected.phases.includes(event.phase)) throw new Error(`C7B3 contact event '${event.eventId}' differs from its admitted selector.`);
    }
    current = [...current, sample]; count += sample.events.length;
  }
  if (current.length > 0) chunks.push(current);
  const segmentPaths: string[] = []; let sampleStart = 0;
  for (const samples of chunks) {
    const eventCount = samples.reduce((sum, sample) => sum + sample.events.length, 0), bytes = encodeContactSegment(samples, eventIndex), path = nextPath(output.length), descriptor: PhysicsBakeDurableContactSegment = frozen({ index: output.length, path, kind: "contact-events", observationId: observation.id, byteLength: bytes.byteLength, sha256: hashBuffer(bytes), sampleStart, sampleCount: samples.length, firstStep: samples[0]!.step, lastStep: samples.at(-1)!.step, eventCount });
    output.push({ descriptor, bytes }); segmentPaths.push(path); sampleStart += samples.length;
  }
  return frozen({ id: observation.id, sampleEverySteps: observation.sampleEverySteps, events: frozen(events.map((entry) => frozen({ id: entry.id, bodyA: entry.bodyA, bodyB: entry.bodyB, phases: entry.phases }))), sourceSha256: canonicalJsonSha256(observation), sampleCount: observation.samples.length, eventCount: observation.samples.reduce((sum, sample) => sum + sample.events.length, 0), segmentPaths: frozen(segmentPaths) });
}

function encodeBodySegment(samples: PhysicsBakeRapierBodyStateObservation["samples"], bodyCount: number): Buffer {
  const bytes = Buffer.allocUnsafe(16 + samples.length * (2 + bodyCount * BODY_CHANNELS * 4)); BODY_MAGIC.copy(bytes, 0); bytes.writeUInt16LE(1, 8); bytes.writeUInt16LE(bodyCount, 10); bytes.writeUInt16LE(samples.length, 12); bytes.writeUInt16LE(BODY_CHANNELS, 14); let offset = 16;
  for (const sample of samples) { bytes.writeUInt16LE(sample.step, offset); offset += 2; for (const state of sample.states) offset = writeState(bytes, offset, state); }
  return bytes;
}

function encodeContactSegment(samples: PhysicsBakeRapierContactObservation["samples"], indexes: ReadonlyMap<string, number>): Buffer {
  const eventCount = samples.reduce((sum, sample) => sum + sample.events.length, 0), bytes = Buffer.allocUnsafe(16 + eventCount * 7); CONTACT_MAGIC.copy(bytes, 0); bytes.writeUInt16LE(1, 8); bytes.writeUInt16LE(samples.length, 10); bytes.writeUInt32LE(eventCount, 12); let offset = 16;
  for (const sample of samples) for (const event of sample.events) { bytes.writeUInt16LE(sample.step, offset); bytes.writeUInt16LE(event.step, offset + 2); bytes.writeUInt16LE(indexes.get(event.eventId)!, offset + 4); bytes.writeUInt8(event.phase === "start" ? 1 : 0, offset + 6); offset += 7; }
  return bytes;
}

function writeState(bytes: Buffer, start: number, state: PhysicsBakeRapierBodyState): number { let offset = start; for (const value of [...state.position, ...state.rotation, ...state.linearVelocity, ...state.angularVelocity]) { bytes.writeFloatLE(value, offset); offset += 4; } return offset; }
function nextPath(index: number): string { return `segments/${String(index).padStart(6, "0")}.bin`; }
function sameIds(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function assertSource(plan: PhysicsBakeAdmissionPlan, result: PhysicsBakeRapierResult): void { if (result.admission.planFingerprint !== plan.fingerprint || result.admission.recipeSha256 !== plan.recipeSha256 || canonicalJson(result.schedule) !== canonicalJson(plan.schedule) || canonicalJsonSha256(result.finalStates) !== result.finalStateSha256 || canonicalJsonSha256({ bodyState: result.bodyStateObservations, contacts: result.contactObservations }) !== result.observationsSha256) throw new Error("C7B3 provider result does not match the exact admitted plan or its canonical evidence."); }
function frozen<T extends object>(value: T): Readonly<T> { if (!Object.isFrozen(value)) Object.freeze(value); return value; }
