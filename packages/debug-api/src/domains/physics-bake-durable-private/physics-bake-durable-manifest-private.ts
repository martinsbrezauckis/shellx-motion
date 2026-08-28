import { canonicalJson, canonicalJsonSha256, compareCodeUnits, hashBuffer } from "@shellx-motion/core";
import {
  PHYSICS_BAKE_RAPIER_PACKAGE,
  PHYSICS_BAKE_RAPIER_VERSION,
} from "../physics-bake-rapier-private/physics-bake-rapier-types-private.js";
import {
  PHYSICS_BAKE_DURABLE_CAPS,
  PHYSICS_BAKE_DURABLE_CODEC,
  PHYSICS_BAKE_DURABLE_MANIFEST_SCHEMA,
  PHYSICS_BAKE_DURABLE_RECEIPT_SCHEMA,
  type PhysicsBakeDurableManifest,
  type PhysicsBakeDurableReceipt,
} from "./physics-bake-durable-types-private.js";

const SHA = /^[a-f0-9]{64}$/u, ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function serializedPhysicsBakeDurableManifest(value: PhysicsBakeDurableManifest): Buffer { return Buffer.from(`${canonicalJson(value)}\n`, "utf8"); }
export function serializedPhysicsBakeDurableReceipt(value: PhysicsBakeDurableReceipt): Buffer { return Buffer.from(`${canonicalJson(value)}\n`, "utf8"); }

export function readPhysicsBakeDurableManifest(value: unknown): PhysicsBakeDurableManifest {
  const root = exact(value, ["schema", "source", "schedule", "primaryBodyObservationId", "finalStates", "finalStateSha256", "bodyObservations", "contactObservations", "segments", "compression", "evidence", "fingerprint"], "C7B3 manifest");
  if (root.schema !== PHYSICS_BAKE_DURABLE_MANIFEST_SCHEMA) fail("manifest schema is invalid");
  const source = exact(root.source, ["planFingerprint", "recipeSha256", "resultFingerprint", "providerPackage", "providerVersion", "observationsSha256", "snapshotSha256"], "C7B3 manifest source");
  for (const key of ["planFingerprint", "recipeSha256", "resultFingerprint", "observationsSha256", "snapshotSha256"] as const) sha(source[key], `source.${key}`);
  if (source.providerPackage !== PHYSICS_BAKE_RAPIER_PACKAGE || source.providerVersion !== PHYSICS_BAKE_RAPIER_VERSION) fail("provider identity differs from C7B2");
  const schedule = exact(root.schedule, ["startUs", "endUs", "stepsPerSecond", "stepCount"], "C7B3 schedule");
  integer(schedule.startUs, 0, Number.MAX_SAFE_INTEGER, "schedule.startUs"); integer(schedule.endUs, 1, Number.MAX_SAFE_INTEGER, "schedule.endUs"); integer(schedule.stepsPerSecond, 1, 240, "schedule.stepsPerSecond"); integer(schedule.stepCount, 1, 7_200, "schedule.stepCount");
  id(root.primaryBodyObservationId, "primaryBodyObservationId"); sha(root.finalStateSha256, "finalStateSha256"); sha(root.fingerprint, "fingerprint");
  if (!Array.isArray(root.finalStates) || root.finalStates.length < 1 || root.finalStates.length > 256) fail("finalStates are invalid");
  for (const state of root.finalStates) readState(state);
  const finalIds = root.finalStates.map((state) => (state as { bodyId: string }).bodyId);
  if (!ascending(finalIds) || canonicalJsonSha256(root.finalStates) !== root.finalStateSha256) fail("finalStates identity is invalid");
  if (!Array.isArray(root.segments) || root.segments.length > PHYSICS_BAKE_DURABLE_CAPS.segments) fail("segment list is invalid");
  const paths = new Set<string>();
  for (let index = 0; index < root.segments.length; index += 1) readSegment(root.segments[index], index, paths, schedule.stepCount as number);
  if (!Array.isArray(root.bodyObservations) || !Array.isArray(root.contactObservations) || root.bodyObservations.length + root.contactObservations.length > 256) fail("observation descriptors are invalid");
  for (const observation of root.bodyObservations) readBodyObservation(observation, root.segments);
  for (const observation of root.contactObservations) readContactObservation(observation, root.segments);
  const observationIds = [...root.bodyObservations, ...root.contactObservations].map((entry) => (entry as { id: string }).id), segmentRefs = [...root.bodyObservations, ...root.contactObservations].flatMap((entry) => (entry as { segmentPaths: string[] }).segmentPaths);
  if (new Set(observationIds).size !== observationIds.length || new Set(segmentRefs).size !== segmentRefs.length || segmentRefs.length !== root.segments.length || root.segments.some((entry) => !segmentRefs.includes((entry as { path: string }).path))) fail("observation or segment ownership is invalid");
  if (!root.bodyObservations.some((entry) => (entry as { id: string }).id === root.primaryBodyObservationId)) fail("primary body observation is missing");
  const compression = exact(root.compression, ["codec", "sourceObservationBytes", "segmentBytes", "savedBytes", "ratioPartsPerMillion", "lossless", "idsStoredOnce", "samplesSimplified", "valuesQuantized", "caps"], "C7B3 compression");
  if (compression.codec !== PHYSICS_BAKE_DURABLE_CODEC || compression.lossless !== true || compression.idsStoredOnce !== true || compression.samplesSimplified !== false || compression.valuesQuantized !== false || canonicalJson(compression.caps) !== canonicalJson(PHYSICS_BAKE_DURABLE_CAPS)) fail("compression contract is invalid");
  integer(compression.sourceObservationBytes, 1, PHYSICS_BAKE_DURABLE_CAPS.sourceObservationBytes, "compression.sourceObservationBytes"); integer(compression.segmentBytes, 0, PHYSICS_BAKE_DURABLE_CAPS.segmentBytes, "compression.segmentBytes"); integer(compression.savedBytes, -PHYSICS_BAKE_DURABLE_CAPS.sourceObservationBytes, PHYSICS_BAKE_DURABLE_CAPS.sourceObservationBytes, "compression.savedBytes"); integer(compression.ratioPartsPerMillion, 0, PHYSICS_BAKE_DURABLE_CAPS.sourceObservationBytes, "compression.ratioPartsPerMillion");
  const segmentBytes = root.segments.reduce((sum, entry) => sum + (entry as { byteLength: number }).byteLength, 0), sourceObservationBytes = compression.sourceObservationBytes as number;
  if (compression.segmentBytes !== segmentBytes || compression.savedBytes !== sourceObservationBytes - segmentBytes || compression.ratioPartsPerMillion !== Math.floor(segmentBytes * 1_000_000 / sourceObservationBytes)) fail("compression arithmetic is invalid");
  if (canonicalJson(root.evidence) !== canonicalJson({ rendererNeutral: true, packageRead: false, packageWritten: false, rendererInvoked: false, pixels: false })) fail("manifest evidence is invalid");
  const { fingerprint: _fingerprint, ...base } = root;
  if (canonicalJsonSha256(base) !== root.fingerprint) fail("manifest fingerprint is invalid");
  return deepFreeze(root) as unknown as PhysicsBakeDurableManifest;
}

export function createPhysicsBakeDurableReceipt(manifest: PhysicsBakeDurableManifest, manifestBytes: Buffer): PhysicsBakeDurableReceipt {
  if (manifestBytes.byteLength > PHYSICS_BAKE_DURABLE_CAPS.manifestBytes) fail("manifest exceeds its byte cap");
  const inventory = manifest.segments.map(({ path, byteLength, sha256 }) => ({ path, byteLength, sha256 })), completePaths = ["manifest.json", "receipt.json", "segments", ...manifest.segments.map((entry) => entry.path)];
  const base = {
    schema: PHYSICS_BAKE_DURABLE_RECEIPT_SCHEMA,
    source: manifest.source,
    artifact: frozen({ manifestSha256: hashBuffer(manifestBytes), manifestBytes: manifestBytes.byteLength, manifestFingerprint: manifest.fingerprint, segmentInventorySha256: canonicalJsonSha256(inventory), segmentCount: manifest.segments.length, segmentBytes: manifest.compression.segmentBytes, inventoryContractSha256: canonicalJsonSha256(frozen({ paths: completePaths, files: frozen([{ path: "manifest.json", byteLength: manifestBytes.byteLength, sha256: hashBuffer(manifestBytes) }, ...inventory]), receipt: "self-derived-from-manifest-and-segments" })), expectedEntryCount: completePaths.length }),
    compression: manifest.compression,
    publication: frozen({ absentOnly: true as const, privateStage: true as const, closedInventory: true as const, atomicDirectoryInstall: true as const, partialResume: false as const, workspaceCleanup: "not-attested" as const }),
    evidence: frozen({ providerSelectedByHost: true as const, callerSubmittedProviderResult: false as const, rendererInvoked: false as const, pixels: false as const }),
  };
  return deepFreeze({ ...base, fingerprint: canonicalJsonSha256(base) }) as PhysicsBakeDurableReceipt;
}

export function readPhysicsBakeDurableReceipt(value: unknown, expected: PhysicsBakeDurableReceipt): PhysicsBakeDurableReceipt {
  if (canonicalJson(value) !== canonicalJson(expected)) fail("receipt differs from the exact artifact-derived receipt");
  return expected;
}

function readSegment(value: unknown, index: number, paths: Set<string>, stepCount: number): void {
  const common = ["index", "path", "kind", "observationId", "byteLength", "sha256", "sampleStart", "sampleCount", "firstStep", "lastStep"], root = exact(value, [...common, ...(isKind(value, "body-state") ? ["bodyCount", "stateCount"] : ["eventCount"])], `C7B3 segment ${index}`);
  if (root.index !== index || root.path !== `segments/${String(index).padStart(6, "0")}.bin` || paths.has(root.path as string)) fail("segment path/order is invalid"); paths.add(root.path as string);
  if (root.kind !== "body-state" && root.kind !== "contact-events") fail("segment kind is invalid"); id(root.observationId, "segment.observationId"); integer(root.byteLength, 16, PHYSICS_BAKE_DURABLE_CAPS.segmentBytes, "segment.byteLength"); sha(root.sha256, "segment.sha256"); integer(root.sampleStart, 0, 200_000, "segment.sampleStart"); integer(root.sampleCount, 1, 200_000, "segment.sampleCount"); integer(root.firstStep, 0, stepCount, "segment.firstStep"); integer(root.lastStep, root.firstStep as number, stepCount, "segment.lastStep");
  if (root.kind === "body-state") { integer(root.bodyCount, 1, 256, "segment.bodyCount"); integer(root.stateCount, 1, PHYSICS_BAKE_DURABLE_CAPS.bodyStatesPerSegment, "segment.stateCount"); if (root.stateCount !== (root.bodyCount as number) * (root.sampleCount as number)) fail("body segment counts differ"); }
  else integer(root.eventCount, 1, PHYSICS_BAKE_DURABLE_CAPS.contactEventsPerSegment, "segment.eventCount");
}

function readBodyObservation(value: unknown, segments: unknown[]): void {
  const root = exact(value, ["id", "sampleEverySteps", "bodyIds", "sourceSha256", "sampleCount", "stateCount", "segmentPaths"], "C7B3 body observation"); id(root.id, "bodyObservation.id"); integer(root.sampleEverySteps, 1, 7_200, "bodyObservation.sampleEverySteps"); ids(root.bodyIds, "bodyObservation.bodyIds"); sha(root.sourceSha256, "bodyObservation.sourceSha256"); integer(root.sampleCount, 1, 200_000, "bodyObservation.sampleCount"); integer(root.stateCount, 1, 200_000, "bodyObservation.stateCount"); paths(root.segmentPaths, root.id as string, "body-state", segments);
}
function readContactObservation(value: unknown, segments: unknown[]): void {
  const root = exact(value, ["id", "sampleEverySteps", "events", "sourceSha256", "sampleCount", "eventCount", "segmentPaths"], "C7B3 contact observation"); id(root.id, "contactObservation.id"); integer(root.sampleEverySteps, 1, 7_200, "contactObservation.sampleEverySteps"); sha(root.sourceSha256, "contactObservation.sourceSha256"); integer(root.sampleCount, 0, 200_000, "contactObservation.sampleCount"); integer(root.eventCount, 0, 200_000, "contactObservation.eventCount");
  if (!Array.isArray(root.events) || root.events.length > 256) fail("contact event dictionary is invalid");
  const eventIds: string[] = [];
  for (const event of root.events) { const entry = exact(event, ["id", "bodyA", "bodyB", "phases"], "C7B3 contact event"); id(entry.id, "event.id"); id(entry.bodyA, "event.bodyA"); id(entry.bodyB, "event.bodyB"); eventIds.push(entry.id as string); if (!Array.isArray(entry.phases) || entry.phases.length < 1 || entry.phases.length > 2 || new Set(entry.phases).size !== entry.phases.length || entry.phases.some((phase) => phase !== "start" && phase !== "stop")) fail("contact event phases are invalid"); }
  if (!ascending(eventIds)) fail("contact event dictionary order is invalid");
  paths(root.segmentPaths, root.id as string, "contact-events", segments, root.eventCount === 0);
}

function readState(value: unknown): void { const root = exact(value, ["bodyId", "position", "rotation", "linearVelocity", "angularVelocity"], "C7B3 body state"); id(root.bodyId, "state.bodyId"); vector(root.position, 3, "state.position"); vector(root.rotation, 4, "state.rotation"); vector(root.linearVelocity, 3, "state.linearVelocity"); vector(root.angularVelocity, 3, "state.angularVelocity"); }
function paths(value: unknown, observationId: string, kind: string, segments: unknown[], empty = false): void { if (!Array.isArray(value) || (empty ? value.length !== 0 : value.length < 1) || new Set(value).size !== value.length || value.some((path) => typeof path !== "string")) fail("observation segment paths are invalid"); for (const path of value as string[]) { const segment = segments.find((entry) => (entry as { path?: unknown }).path === path) as { kind?: unknown; observationId?: unknown } | undefined; if (!segment || segment.kind !== kind || segment.observationId !== observationId) fail("observation segment reference is invalid"); } }
function ids(value: unknown, label: string): void { if (!Array.isArray(value) || value.length < 1 || value.length > 256) fail(`${label} is invalid`); for (const entry of value) id(entry, label); if (!ascending(value as string[])) fail(`${label} order is invalid`); }
function vector(value: unknown, length: number, label: string): void { if (!Array.isArray(value) || value.length !== length || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || Math.fround(entry) !== entry || Object.is(entry, -0))) fail(`${label} is not normalized f32 data`); }
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`); const root = value as Record<string, unknown>, actual = Reflect.ownKeys(root); if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key)) || keys.some((key) => !Object.hasOwn(root, key))) fail(`${label} has unknown or missing fields`); return root; }
function isKind(value: unknown, kind: string): boolean { return !!value && typeof value === "object" && !Array.isArray(value) && (value as { kind?: unknown }).kind === kind; }
function id(value: unknown, label: string): void { if (typeof value !== "string" || !ID.test(value)) fail(`${label} is invalid`); }
function sha(value: unknown, label: string): void { if (typeof value !== "string" || !SHA.test(value)) fail(`${label} is invalid`); }
function integer(value: unknown, min: number, max: number, label: string): void { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(`${label} is invalid`); }
function ascending(value: readonly string[]): boolean { return new Set(value).size === value.length && value.every((entry, index) => index === 0 || compareCodeUnits(value[index - 1]!, entry) < 0); }
function fail(message: string): never { throw new Error(`C7B3 ${message}.`); }
function frozen<T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
