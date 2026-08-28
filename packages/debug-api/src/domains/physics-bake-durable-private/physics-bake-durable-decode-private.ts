import { canonicalJson, canonicalJsonSha256, hashBuffer } from "@shellx-motion/core";
import type {
  PhysicsBakeRapierBodyState,
  PhysicsBakeRapierBodyStateObservation,
  PhysicsBakeRapierContactEvent,
  PhysicsBakeRapierContactObservation,
} from "../physics-bake-rapier-private/physics-bake-rapier-types-private.js";
import type { PhysicsBakeDurableBodyObservation, PhysicsBakeDurableBodySegment, PhysicsBakeDurableContactObservation, PhysicsBakeDurableContactSegment, PhysicsBakeDurableManifest, PhysicsBakeDurableSegment } from "./physics-bake-durable-types-private.js";

const BODY_MAGIC = Buffer.from("SXMPB3B1", "ascii"), CONTACT_MAGIC = Buffer.from("SXMPB3C1", "ascii"), BODY_CHANNELS = 13;

export function decodePhysicsBakeDurableSegments(manifest: PhysicsBakeDurableManifest, bytesByPath: ReadonlyMap<string, Buffer>): Readonly<{ bodyStateObservations: readonly PhysicsBakeRapierBodyStateObservation[]; contactObservations: readonly PhysicsBakeRapierContactObservation[] }> {
  for (const segment of manifest.segments) {
    const bytes = bytesByPath.get(segment.path);
    if (!bytes || bytes.byteLength !== segment.byteLength || hashBuffer(bytes) !== segment.sha256) fail(`segment '${segment.path}' bytes differ from its manifest identity`);
  }
  const bodyStateObservations = frozen(manifest.bodyObservations.map((entry) => decodeBodyObservation(entry, manifest, bytesByPath))), contactObservations = frozen(manifest.contactObservations.map((entry) => decodeContactObservation(entry, manifest, bytesByPath)));
  const observations = frozen({ bodyState: bodyStateObservations, contacts: contactObservations });
  if (canonicalJsonSha256(observations) !== manifest.source.observationsSha256) fail("decoded observation identity differs from C7B2");
  if (Buffer.byteLength(canonicalJson(observations), "utf8") !== manifest.compression.sourceObservationBytes) fail("decoded observation byte count differs from the compression evidence");
  const primary = bodyStateObservations.find((entry) => entry.id === manifest.primaryBodyObservationId)!;
  const terminal = primary.samples.at(-1)?.states ?? [], ids = new Set(terminal.map((state) => state.bodyId)), expected = manifest.finalStates.filter((state) => ids.has(state.bodyId));
  if (canonicalJson(terminal) !== canonicalJson(expected)) fail("primary terminal states differ from the manifest final states");
  return frozen({ bodyStateObservations, contactObservations });
}

function decodeBodyObservation(observation: PhysicsBakeDurableBodyObservation, manifest: PhysicsBakeDurableManifest, bytesByPath: ReadonlyMap<string, Buffer>): PhysicsBakeRapierBodyStateObservation {
  const samples: Array<{ step: number; states: readonly PhysicsBakeRapierBodyState[] }> = []; let expectedStart = 0;
  for (const path of observation.segmentPaths) {
    const descriptor = segment(manifest, path, "body-state"), bytes = bytesByPath.get(path)!;
    if (!bytes.subarray(0, 8).equals(BODY_MAGIC) || bytes.readUInt16LE(8) !== 1 || bytes.readUInt16LE(10) !== observation.bodyIds.length || bytes.readUInt16LE(12) !== descriptor.sampleCount || bytes.readUInt16LE(14) !== BODY_CHANNELS) fail(`body segment '${path}' header is invalid`);
    const expectedBytes = 16 + descriptor.sampleCount * (2 + observation.bodyIds.length * BODY_CHANNELS * 4);
    if (bytes.byteLength !== expectedBytes || descriptor.sampleStart !== expectedStart || descriptor.bodyCount !== observation.bodyIds.length || descriptor.stateCount !== descriptor.sampleCount * observation.bodyIds.length) fail(`body segment '${path}' range is invalid`);
    let offset = 16;
    for (let sampleIndex = 0; sampleIndex < descriptor.sampleCount; sampleIndex += 1) {
      const step = bytes.readUInt16LE(offset); offset += 2; const states: PhysicsBakeRapierBodyState[] = [];
      for (const bodyId of observation.bodyIds) { const decoded = readState(bytes, offset, bodyId); states.push(decoded.state); offset = decoded.offset; }
      samples.push(frozen({ step, states: frozen(states) }));
    }
    const sliced = samples.slice(expectedStart);
    if (sliced[0]?.step !== descriptor.firstStep || sliced.at(-1)?.step !== descriptor.lastStep) fail(`body segment '${path}' step range is invalid`);
    expectedStart += descriptor.sampleCount;
  }
  if (samples.length !== observation.sampleCount || samples.length * observation.bodyIds.length !== observation.stateCount || samples[0]?.step !== 0) fail(`body observation '${observation.id}' sample totals are invalid`);
  for (let index = 1; index < samples.length; index += 1) if (samples[index]!.step <= samples[index - 1]!.step || samples[index]!.step % observation.sampleEverySteps !== 0) fail(`body observation '${observation.id}' steps are invalid`);
  const result = frozen({ id: observation.id, sampleEverySteps: observation.sampleEverySteps, samples: frozen(samples) });
  if (canonicalJsonSha256(result) !== observation.sourceSha256) fail(`body observation '${observation.id}' is not lossless`);
  return result;
}

function decodeContactObservation(observation: PhysicsBakeDurableContactObservation, manifest: PhysicsBakeDurableManifest, bytesByPath: ReadonlyMap<string, Buffer>): PhysicsBakeRapierContactObservation {
  const samples: Array<{ step: number; events: readonly PhysicsBakeRapierContactEvent[] }> = []; let expectedStart = 0, totalEvents = 0;
  for (const path of observation.segmentPaths) {
    const descriptor = segment(manifest, path, "contact-events"), bytes = bytesByPath.get(path)!;
    if (!bytes.subarray(0, 8).equals(CONTACT_MAGIC) || bytes.readUInt16LE(8) !== 1 || bytes.readUInt16LE(10) !== descriptor.sampleCount || bytes.readUInt32LE(12) !== descriptor.eventCount || bytes.byteLength !== 16 + descriptor.eventCount * 7 || descriptor.sampleStart !== expectedStart) fail(`contact segment '${path}' header or range is invalid`);
    let offset = 16, currentStep = -1, current: PhysicsBakeRapierContactEvent[] = [], decodedSamples = 0;
    for (let index = 0; index < descriptor.eventCount; index += 1) {
      const bucketStep = bytes.readUInt16LE(offset), eventStep = bytes.readUInt16LE(offset + 2), eventIndex = bytes.readUInt16LE(offset + 4), phaseByte = bytes.readUInt8(offset + 6); offset += 7;
      const definition = observation.events[eventIndex], phase = phaseByte === 1 ? "start" as const : phaseByte === 0 ? "stop" as const : undefined;
      if (!definition || !phase || !definition.phases.includes(phase) || eventStep > bucketStep || bucketStep > manifest.schedule.stepCount) fail(`contact segment '${path}' event is invalid`);
      if (bucketStep !== currentStep) { if (current.length > 0) { samples.push(frozen({ step: currentStep, events: frozen(current) })); decodedSamples += 1; } currentStep = bucketStep; current = []; }
      current.push(frozen({ eventId: definition.id, bodyA: definition.bodyA, bodyB: definition.bodyB, phase, step: eventStep }));
    }
    if (current.length > 0) { samples.push(frozen({ step: currentStep, events: frozen(current) })); decodedSamples += 1; }
    if (decodedSamples !== descriptor.sampleCount || samples[expectedStart]?.step !== descriptor.firstStep || samples.at(-1)?.step !== descriptor.lastStep) fail(`contact segment '${path}' sample range is invalid`);
    expectedStart += decodedSamples; totalEvents += descriptor.eventCount;
  }
  if (samples.length !== observation.sampleCount || totalEvents !== observation.eventCount) fail(`contact observation '${observation.id}' totals are invalid`);
  for (let index = 1; index < samples.length; index += 1) if (samples[index]!.step <= samples[index - 1]!.step || samples[index]!.step % observation.sampleEverySteps !== 0) fail(`contact observation '${observation.id}' steps are invalid`);
  const result = frozen({ id: observation.id, sampleEverySteps: observation.sampleEverySteps, samples: frozen(samples) });
  if (canonicalJsonSha256(result) !== observation.sourceSha256) fail(`contact observation '${observation.id}' is not lossless`);
  return result;
}

function segment(manifest: PhysicsBakeDurableManifest, path: string, kind: "body-state"): PhysicsBakeDurableBodySegment;
function segment(manifest: PhysicsBakeDurableManifest, path: string, kind: "contact-events"): PhysicsBakeDurableContactSegment;
function segment(manifest: PhysicsBakeDurableManifest, path: string, kind: PhysicsBakeDurableSegment["kind"]): PhysicsBakeDurableSegment { const value = manifest.segments.find((entry) => entry.path === path); if (!value || value.kind !== kind) fail(`segment '${path}' descriptor is missing`); return value; }
function readState(bytes: Buffer, start: number, bodyId: string): { state: PhysicsBakeRapierBodyState; offset: number } { let offset = start; const values: number[] = []; for (let index = 0; index < BODY_CHANNELS; index += 1) { const value = bytes.readFloatLE(offset); if (!Number.isFinite(value) || Object.is(value, -0)) fail("body segment contains invalid f32 state"); values.push(value); offset += 4; } return { state: frozen({ bodyId, position: frozen(values.slice(0, 3)) as PhysicsBakeRapierBodyState["position"], rotation: frozen(values.slice(3, 7)) as PhysicsBakeRapierBodyState["rotation"], linearVelocity: frozen(values.slice(7, 10)) as PhysicsBakeRapierBodyState["linearVelocity"], angularVelocity: frozen(values.slice(10, 13)) as PhysicsBakeRapierBodyState["angularVelocity"] }), offset }; }
function fail(message: string): never { throw new Error(`C7B3 ${message}.`); }
function frozen<T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
