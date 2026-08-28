import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import {
  MOTION_LAYOUT_APPLICATION_SCHEMA,
  type MotionDocument,
  type MotionLayoutApplicationRecord,
  type MotionLayoutApplicationSnapshot
} from "./types";
import type { MotionLayout, MotionLayoutRepeater } from "./motion-layout";
import { validateMotionLayoutCompileRequest } from "./motion-layout-validate";
import { utf8Bytes } from "./motion-layout-safety";

export const MAX_MOTION_LAYOUT_APPLICATIONS = 16;
export const MAX_MOTION_LAYOUT_APPLICATION_BYTES = 128 * 1024;
export const MAX_MOTION_LAYOUT_APPLICATION_TOTAL_BYTES = 512 * 1024;

export function createMotionLayoutApplication(input: Omit<MotionLayoutApplicationRecord, "schema" | "id" | "fingerprint">): MotionLayoutApplicationRecord {
  const payload = { schema: MOTION_LAYOUT_APPLICATION_SCHEMA, ...structuredClone(input) };
  const id = `layout-${canonicalJsonSha256(payload).slice(0, 24)}`;
  const record: MotionLayoutApplicationRecord = { ...payload, id, fingerprint: "" };
  const application = { ...record, fingerprint: motionLayoutApplicationFingerprint(record) };
  assertApplicationByteSize(application);
  return application;
}

/** Canonical record binding; the fingerprint deliberately excludes itself. */
export function motionLayoutApplicationFingerprint(record: MotionLayoutApplicationRecord): string {
  const { fingerprint: _fingerprint, ...payload } = record;
  return canonicalJsonSha256(payload);
}

/** Reads exact bounded declarative records; compare them against host authority before removal. */
export function readMotionLayoutApplications(motion: MotionDocument): MotionLayoutApplicationRecord[] {
  const value = motion.layoutApplications;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MOTION_LAYOUT_APPLICATIONS) {
    throw new Error(`Motion layoutApplications must contain 0..${MAX_MOTION_LAYOUT_APPLICATIONS} records.`);
  }
  const ids = new Set<string>();
  const applications = value.map((entry, index) => {
    const application = asApplication(entry, `/layoutApplications/${index}`);
    if (ids.has(application.id)) throw new Error(`Motion layout application id is duplicated: ${application.id}.`);
    ids.add(application.id);
    if (motionLayoutApplicationFingerprint(application) !== application.fingerprint) {
      throw new Error(`Motion layout application ${application.id} has an invalid fingerprint.`);
    }
    assertApplicationByteSize(application);
    return application;
  });
  if (utf8Bytes(canonicalJson(applications)) > MAX_MOTION_LAYOUT_APPLICATION_TOTAL_BYTES) {
    throw new Error(`Motion layoutApplications exceed the ${MAX_MOTION_LAYOUT_APPLICATION_TOTAL_BYTES}-byte aggregate cap.`);
  }
  return applications;
}

export function withoutMotionLayoutApplication(motion: MotionDocument, applicationId: string): MotionDocument {
  const applications = readMotionLayoutApplications(motion).filter((application) => application.id !== applicationId);
  if (applications.length > 0) return { ...motion, layoutApplications: applications };
  const { layoutApplications: _layoutApplications, ...withoutApplications } = motion;
  return withoutApplications;
}

export function sameMotionLayoutSnapshot(left: MotionLayoutApplicationSnapshot, right: MotionLayoutApplicationSnapshot): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function asApplication(value: unknown, path: string): MotionLayoutApplicationRecord {
  const record = plainRecord(value, path);
  exactKeys(record, ["schema", "id", "fingerprint", "groupId", "layoutFingerprint", "childLayerIds", "materializedChildLayerIds", "layout", "repeaters", "patches", "trackPatches", "generatedLayers"], path);
  if (record.schema !== MOTION_LAYOUT_APPLICATION_SCHEMA) throw new Error(`${path}/schema must equal ${MOTION_LAYOUT_APPLICATION_SCHEMA}.`);
  const id = identifier(record.id, `${path}/id`);
  const fingerprint = sha256(record.fingerprint, `${path}/fingerprint`);
  const groupId = identifier(record.groupId, `${path}/groupId`);
  const layoutFingerprint = sha256(record.layoutFingerprint, `${path}/layoutFingerprint`);
  const childLayerIds = identifiers(record.childLayerIds, `${path}/childLayerIds`, 1, 256);
  const materializedChildLayerIds = identifiers(record.materializedChildLayerIds, `${path}/materializedChildLayerIds`, 1, 256);
  const layout = plainRecord(record.layout, `${path}/layout`) as unknown as MotionLayout;
  const repeaters = dataArray(record.repeaters, `${path}/repeaters`, 16) as MotionLayoutRepeater[];
  const patches = patchesValue(record.patches, `${path}/patches`);
  const trackPatches = trackPatchesValue(record.trackPatches, `${path}/trackPatches`);
  const generatedLayers = generatedLayersValue(record.generatedLayers, `${path}/generatedLayers`);
  assertApplicationLayout(layout, repeaters, groupId, childLayerIds, path);
  return { schema: MOTION_LAYOUT_APPLICATION_SCHEMA, id, fingerprint, groupId, layoutFingerprint, childLayerIds, materializedChildLayerIds, layout, repeaters, patches, trackPatches, generatedLayers };
}

function assertApplicationByteSize(application: MotionLayoutApplicationRecord): void {
  if (utf8Bytes(canonicalJson(application)) > MAX_MOTION_LAYOUT_APPLICATION_BYTES) {
    throw new Error(`Motion layout application ${application.id} exceeds the ${MAX_MOTION_LAYOUT_APPLICATION_BYTES}-byte cap.`);
  }
}

function patchesValue(value: unknown, path: string): MotionLayoutApplicationRecord["patches"] {
  const items = dataArray(value, path, 256);
  const ids = new Set<string>();
  return items.map((item, index) => {
    const record = plainRecord(item, `${path}/${index}`);
    exactKeys(record, ["layerId", "before", "after"], `${path}/${index}`);
    const layerId = identifier(record.layerId, `${path}/${index}/layerId`);
    if (ids.has(layerId)) throw new Error(`${path}/${index}/layerId must be unique.`);
    ids.add(layerId);
    return { layerId, before: snapshot(record.before, `${path}/${index}/before`), after: snapshot(record.after, `${path}/${index}/after`) };
  });
}

function trackPatchesValue(value: unknown, path: string): MotionLayoutApplicationRecord["trackPatches"] {
  const items = dataArray(value, path, 256);
  const ids = new Set<string>();
  return items.map((item, index) => {
    const record = plainRecord(item, `${path}/${index}`);
    exactKeys(record, ["trackId", "beforeLayerIds", "afterLayerIds"], `${path}/${index}`);
    const trackId = identifier(record.trackId, `${path}/${index}/trackId`);
    if (ids.has(trackId)) throw new Error(`${path}/${index}/trackId must be unique.`);
    ids.add(trackId);
    return { trackId, beforeLayerIds: identifiers(record.beforeLayerIds, `${path}/${index}/beforeLayerIds`, 0, 512), afterLayerIds: identifiers(record.afterLayerIds, `${path}/${index}/afterLayerIds`, 0, 512) };
  });
}

function generatedLayersValue(value: unknown, path: string): MotionLayoutApplicationRecord["generatedLayers"] {
  const items = dataArray(value, path, 256);
  const ids = new Set<string>();
  return items.map((item, index) => {
    const record = plainRecord(item, `${path}/${index}`);
    exactKeys(record, ["id", "sourceLayerId", "instanceIndex", "layerSha256"], `${path}/${index}`);
    const id = identifier(record.id, `${path}/${index}/id`);
    if (ids.has(id)) throw new Error(`${path}/${index}/id must be unique.`);
    ids.add(id);
    if (!Number.isInteger(record.instanceIndex) || Number(record.instanceIndex) < 1 || Number(record.instanceIndex) > 128) throw new Error(`${path}/${index}/instanceIndex must be an integer within 1..128.`);
    return { id, sourceLayerId: identifier(record.sourceLayerId, `${path}/${index}/sourceLayerId`), instanceIndex: record.instanceIndex as number, layerSha256: sha256(record.layerSha256, `${path}/${index}/layerSha256`) };
  });
}

function snapshot(value: unknown, path: string): MotionLayoutApplicationSnapshot {
  const record = plainRecord(value, path);
  exactKeys(record, ["transform", "timing"], path);
  const transform = plainRecord(record.transform, `${path}/transform`);
  const timing = plainRecord(record.timing, `${path}/timing`);
  const startMs = boundedInteger(timing.startMs, `${path}/timing/startMs`, 0, 3_600_000);
  const durationMs = boundedInteger(timing.durationMs, `${path}/timing/durationMs`, 1, 3_600_000);
  if (startMs + durationMs > 3_600_000) throw new Error(`${path}/timing must fit within 3600000ms.`);
  if (!validApplicationTransform(transform)) throw new Error(`${path}/transform must contain exact bounded layout transform fields and x-* data extensions only.`);
  return { transform: structuredClone(transform) as MotionLayoutApplicationSnapshot["transform"], timing: { startMs, durationMs } };
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  assertDataValue(value, path);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be a plain data object.`);
  return value as Record<string, unknown>;
}

function dataArray(value: unknown, path: string, maximum: number): unknown[] {
  assertDataValue(value, path);
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${path} must be a data array with at most ${maximum} items.`);
  return value;
}

function exactKeys(record: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${path}/${key} is not allowed.`);
  for (const key of allowed) if (!Object.hasOwn(record, key)) throw new Error(`${path}/${key} is required.`);
}
function identifier(value: unknown, path: string): string { if (typeof value !== "string" || !value || value.length > 128) throw new Error(`${path} must be a 1..128 code-unit string.`); return value; }
function sha256(value: unknown, path: string): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${path} must be a lowercase SHA-256 hex string.`); return value; }
function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number { if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${path} must be an integer within ${minimum}..${maximum}.`); return value as number; }
function identifiers(value: unknown, path: string, minimum: number, maximum: number): string[] { const items = dataArray(value, path, maximum); if (items.length < minimum) throw new Error(`${path} must contain ${minimum}..${maximum} ids.`); const ids = items.map((item, index) => identifier(item, `${path}/${index}`)); if (new Set(ids).size !== ids.length) throw new Error(`${path} must contain unique ids.`); return ids; }

function validApplicationTransform(value: Record<string, unknown>): boolean {
  const known = new Set(["x", "y", "width", "height", "scale", "rotation", "opacity"]);
  if (!boundedFinite(value.width, 0.000001, 1_000_000) || !boundedFinite(value.height, 0.000001, 1_000_000)) return false;
  if (!optionalFinite(value.x, -1_000_000, 1_000_000) || !optionalFinite(value.y, -1_000_000, 1_000_000)
    || !optionalFinite(value.scale, 0.000001, 1_000) || !optionalFinite(value.rotation, -360_000, 360_000) || !optionalFinite(value.opacity, 0, 1)) return false;
  return Object.keys(value).every((key) => known.has(key) || key.startsWith("x-"));
}
function optionalFinite(value: unknown, minimum: number, maximum: number): boolean { return value === undefined || boundedFinite(value, minimum, maximum); }
function boundedFinite(value: unknown, minimum: number, maximum: number): boolean { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum; }

function assertApplicationLayout(layout: MotionLayout, repeaters: MotionLayoutRepeater[], groupId: string, childLayerIds: string[], path: string): void {
  const result = validateMotionLayoutCompileRequest({
    schema: "shellx-motion/layout-compile@1",
    ownership: { schema: "shellx-motion/layout-ownership-input@1", ownerId: groupId, childIds: childLayerIds },
    layout,
    children: childLayerIds.map((id) => ({
      id,
      sizing: { width: { mode: "fixed", value: 1 }, height: { mode: "fixed", value: 1 } },
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      timing: { startMs: 0, durationMs: 3_600_000 }
    })),
    repeaters
  });
  if (!result.ok) {
    const first = result.issues[0];
    throw new Error(`${path}/layout or repeaters is invalid${first ? `: ${first.path} ${first.code}` : ""}.`);
  }
}

function assertDataValue(value: unknown, path: string, seen = new WeakSet<object>(), depth = 0): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error(`${path} must be finite.`); return; }
  if (!value || typeof value !== "object") throw new Error(`${path} must be JSON data.`);
  if (depth > 64 || seen.has(value)) throw new Error(`${path} must be a finite acyclic data tree.`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${path} must not contain symbol fields.`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${path}/${index} must be a dense enumerable data item.`);
      assertDataValue(descriptor.value, `${path}/${index}`, seen, depth + 1);
    }
    if (Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error(`${path} must not have non-index array fields.`);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null || Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${path} must be a plain data object.`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${path}/${key} must be an enumerable data field.`);
    assertDataValue(descriptor.value, `${path}/${key}`, seen, depth + 1);
  }
}
