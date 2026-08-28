import { canonicalJson } from "./canonical-json";
import { interpolateGradientColorSegment, readEasingValidationError } from "./timeline";
import type { MotionEasing, MotionVec3 } from "./types";
import {
  MAX_MOTION_SCENE3D_ANIMATION_INPUT_BYTES,
  MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES,
  MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES_PER_TRACK,
  MAX_MOTION_SCENE3D_ANIMATION_PLAN_WORK_UNITS,
  MAX_MOTION_SCENE3D_ANIMATION_TIME_US,
  MAX_MOTION_SCENE3D_ANIMATION_TRACKS,
  MOTION_SCENE3D_ANIMATION_SCHEMA,
  motionScene3DAnimationLocatorKey,
  motionScene3DAnimationNumericBounds,
  motionScene3DAnimationValueKind,
  type MotionScene3DAnimationDescriptor,
  type MotionScene3DAnimationKeyframe,
  type MotionScene3DAnimationLocator,
  type MotionScene3DAnimationTrack,
  type MotionScene3DAnimationValue,
} from "./motion-scene3d-animation-types";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_EASING_BYTES = 256;

/** Reads only detached descriptor data. Source scene traversal belongs to the next admission stage. */
export function readMotionScene3DAnimationDescriptor(value: unknown): MotionScene3DAnimationDescriptor {
  const record = exactRecord(value, ["schema", "tracks"], "Scene3d animation", 2);
  if (record.schema !== MOTION_SCENE3D_ANIMATION_SCHEMA) throw new Error(`Scene3d animation schema must equal ${MOTION_SCENE3D_ANIMATION_SCHEMA}.`);
  const entries = denseArray(record.tracks, "Scene3d animation tracks", MAX_MOTION_SCENE3D_ANIMATION_TRACKS);
  if (entries.length === 0) throw new Error(`Scene3d animation tracks must contain 1..${MAX_MOTION_SCENE3D_ANIMATION_TRACKS} entries.`);
  const headers = entries.map((entry, index) => readTrackHeader(entry, index));
  const keyframeCount = headers.reduce((total, header) => total + header.keyframeCount, 0);
  const workUnits = headers.reduce((total, header) => total + header.keyframeCount * (motionScene3DAnimationValueKind(header.locator) === "vec3" ? 3 : motionScene3DAnimationValueKind(header.locator) === "color" ? 4 : 1), 0);
  if (keyframeCount > MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES) throw new Error(`Scene3d animation keyframes exceed the ${MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES}-key aggregate limit before keyframe traversal.`);
  if (workUnits > MAX_MOTION_SCENE3D_ANIMATION_PLAN_WORK_UNITS) throw new Error(`Scene3d animation keyframe work exceeds the ${MAX_MOTION_SCENE3D_ANIMATION_PLAN_WORK_UNITS}-unit aggregate limit before keyframe traversal.`);
  const tracks = headers.map((header, index) => readTrack(header, index));
  const ids = new Set<string>(), locators = new Set<string>();
  for (const track of tracks) {
    if (ids.has(track.id)) throw new Error(`Scene3d animation track id ${track.id} must be unique.`);
    ids.add(track.id);
    const locator = motionScene3DAnimationLocatorKey(track.locator);
    if (locators.has(locator)) throw new Error(`Scene3d animation locator ${track.locator.layerId}/${track.locator.scope}/${track.locator.property} must have one track authority.`);
    locators.add(locator);
  }
  const descriptor = { schema: MOTION_SCENE3D_ANIMATION_SCHEMA, tracks: Object.freeze(tracks) };
  if (Buffer.byteLength(canonicalJson(descriptor), "utf8") > MAX_MOTION_SCENE3D_ANIMATION_INPUT_BYTES) {
    throw new Error(`Scene3d animation descriptor exceeds the ${MAX_MOTION_SCENE3D_ANIMATION_INPUT_BYTES}-byte input limit.`);
  }
  return Object.freeze(descriptor);
}

interface TrackHeader { record: Record<string, unknown>; id: string; locator: MotionScene3DAnimationLocator; keyframeCount: number }

function readTrackHeader(value: unknown, index: number): TrackHeader {
  const label = `Scene3d animation tracks[${index}]`;
  const record = exactRecord(value, ["id", "locator", "keyframes"], label, 3);
  const id = readId(record.id, `${label}.id`), locator = readLocator(record.locator, `${label}.locator`);
  return { record, id, locator, keyframeCount: arrayLength(record.keyframes, `${label}.keyframes`, MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES_PER_TRACK) };
}

function readTrack(header: TrackHeader, index: number): MotionScene3DAnimationTrack {
  const label = `Scene3d animation tracks[${index}]`, kind = motionScene3DAnimationValueKind(header.locator);
  const values = denseArray(header.record.keyframes, `${label}.keyframes`, MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES_PER_TRACK);
  if (values.length === 0) throw new Error(`${label}.keyframes must contain 1..${MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES_PER_TRACK} entries.`);
  const keyframes = values.map((entry, keyframeIndex) => readKeyframe(entry, `${label}.keyframes[${keyframeIndex}]`, header.locator, kind));
  for (let keyframeIndex = 1; keyframeIndex < keyframes.length; keyframeIndex += 1) {
    if (keyframes[keyframeIndex - 1]!.atUs >= keyframes[keyframeIndex]!.atUs) throw new Error(`${label}.keyframes must have strictly ascending unique atUs values.`);
  }
  return Object.freeze({ id: header.id, locator: Object.freeze({ ...header.locator }), keyframes: Object.freeze(keyframes) });
}

function readLocator(value: unknown, label: string): MotionScene3DAnimationLocator {
  const record = dataRecord(value, label, 4);
  const scope = record.scope;
  if (scope === "object") {
    const exact = exactRecord(record, ["layerId", "scope", "objectId", "property"], label, 4);
    const property = exact.property;
    if (property !== "position" && property !== "rotationDeg" && property !== "scale" && property !== "emissive" && property !== "color") throw new Error(`${label}.property is not an admitted object property.`);
    return { layerId: readId(exact.layerId, `${label}.layerId`), scope, objectId: readId(exact.objectId, `${label}.objectId`), property };
  }
  const exact = exactRecord(record, ["layerId", "scope", "property"], label, 3);
  const layerId = readId(exact.layerId, `${label}.layerId`);
  if (scope === "camera") {
    if (exact.property !== "position" && exact.property !== "target" && exact.property !== "fovDeg") throw new Error(`${label}.property is not an admitted camera property.`);
    return { layerId, scope, property: exact.property };
  }
  if (scope === "lighting") {
    if (exact.property !== "ambient" && exact.property !== "direction" && exact.property !== "intensity" && exact.property !== "color") throw new Error(`${label}.property is not an admitted lighting property.`);
    return { layerId, scope, property: exact.property };
  }
  if (scope === "background" && exact.property === "color") return { layerId, scope, property: "color" };
  throw new Error(`${label}.scope must be camera, lighting, object, or background with an admitted property.`);
}

function readKeyframe(value: unknown, label: string, locator: MotionScene3DAnimationLocator, kind: ReturnType<typeof motionScene3DAnimationValueKind>): MotionScene3DAnimationKeyframe {
  const record = exactRecord(value, ["atUs", "value"], label, 3, ["easing"]);
  const result: MotionScene3DAnimationKeyframe = { atUs: readUs(record.atUs, `${label}.atUs`), value: readValue(record.value, locator, kind, `${label}.value`) };
  if (Object.hasOwn(record, "easing")) result.easing = readEasing(record.easing, `${label}.easing`);
  return Object.freeze(result);
}

function readValue(value: unknown, locator: MotionScene3DAnimationLocator, kind: ReturnType<typeof motionScene3DAnimationValueKind>, label: string): MotionScene3DAnimationValue {
  if (kind === "color") {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${label} must be an existing scene3d #RRGGBB color.`);
    return canonicalSceneColor(value, label);
  }
  const bounds = motionScene3DAnimationNumericBounds(locator);
  if (!bounds) throw new Error(`${label} does not have numeric scene3d bounds.`);
  if (kind === "number") return boundedNumber(value, bounds[0], bounds[1], label);
  const entries = denseArray(value, label, 3);
  if (entries.length !== 3) throw new Error(`${label} must contain exactly three finite values.`);
  const vector = entries.map((entry, index) => boundedNumber(entry, bounds[0], bounds[1], `${label}[${index}]`)) as MotionVec3;
  if (locator.scope === "lighting" && locator.property === "direction" && vector.every((entry) => entry === 0)) throw new Error(`${label} must not be the zero lighting direction.`);
  return Object.freeze(vector) as unknown as MotionVec3;
}

function readEasing(value: unknown, label: string): MotionEasing {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_EASING_BYTES || readEasingValidationError(value)) throw new Error(`${label} must be a supported bounded easing.`);
    return value;
  }
  const record = exactRecord(value, ["type", "stiffness", "damping"], label, 5, ["mass", "initialVelocity"]);
  if (record.type !== "spring") throw new Error(`${label}.type must be spring.`);
  const easing: MotionEasing = { type: "spring", stiffness: finite(record.stiffness, `${label}.stiffness`), damping: finite(record.damping, `${label}.damping`), ...(Object.hasOwn(record, "mass") ? { mass: finite(record.mass, `${label}.mass`) } : {}), ...(Object.hasOwn(record, "initialVelocity") ? { initialVelocity: finite(record.initialVelocity, `${label}.initialVelocity`) } : {}) };
  if (readEasingValidationError(easing)) throw new Error(`${label} must be a supported easing.`);
  return Object.freeze(easing);
}

function exactRecord(value: unknown, required: readonly string[], label: string, maximum: number, optional: readonly string[] = []): Record<string, unknown> {
  const record = dataRecord(value, label, maximum), allowed = [...required, ...optional];
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${label} has unknown field '${key}'.`);
  for (const key of required) if (!Object.hasOwn(record, key)) throw new Error(`${label} requires ${key}.`);
  return record;
}

function dataRecord(value: unknown, label: string, maximum: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || prototypeOf(value, label) !== Object.prototype) throw new Error(`${label} must be a plain object.`);
  const keys = ownKeys(value, label);
  if (keys.length > maximum || keys.some((key) => typeof key !== "string")) throw new Error(`${label} exceeds the ${maximum}-field data limit.`);
  const copy: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptorOf(value, key, label);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`);
    Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
  }
  return copy;
}

function denseArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || prototypeOf(value, label) !== Array.prototype) throw new Error(`${label} must be an array.`);
  const length = arrayLength(value, label, maximum), keys = ownKeys(value, label);
  if (keys.length !== length + 1 || !keys.includes("length") || keys.some((key) => typeof key !== "string")) throw new Error(`${label} must be a dense data array.`);
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index); if (!keys.includes(key)) throw new Error(`${label} must be a dense data array.`);
    const descriptor = descriptorOf(value, key, label);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}[${index}] must be an enumerable data field.`);
    copy.push(descriptor.value);
  }
  return copy;
}

function arrayLength(value: unknown, label: string, maximum: number): number {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const descriptor = descriptorOf(value, "length", label), length = "value" in descriptor ? descriptor.value : undefined;
  if (!Number.isSafeInteger(length) || typeof length !== "number" || length < 0 || length > maximum) throw new Error(`${label} must contain at most ${maximum} entries.`);
  return length;
}

function readId(value: unknown, label: string): string { if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe 1..64 character id.`); return value; }
function canonicalSceneColor(value: string, label: string): string { const color = interpolateGradientColorSegment(value, value, 0); if (!color || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`${label} must produce an opaque canonical scene3d color.`); return color; }
function readUs(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > MAX_MOTION_SCENE3D_ANIMATION_TIME_US) throw new Error(`${label} must be a safe integer in 0..${MAX_MOTION_SCENE3D_ANIMATION_TIME_US} microseconds.`); return value; }
function boundedNumber(value: unknown, minimum: number, maximum: number, label: string): number { const result = finite(value, label); if (result < minimum || result > maximum) throw new Error(`${label} must be within ${minimum}..${maximum}.`); return result; }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`); return Object.is(value, -0) ? 0 : value; }
function ownKeys(value: object, label: string): PropertyKey[] { try { return Reflect.ownKeys(value); } catch { throw new Error(`${label} data reflection failed.`); } }
function descriptorOf(value: object, key: PropertyKey, label: string): PropertyDescriptor { try { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor) throw new Error("missing"); return descriptor; } catch { throw new Error(`${label} data reflection failed.`); } }
function prototypeOf(value: object, label: string): object | null { try { return Object.getPrototypeOf(value); } catch { throw new Error(`${label} data reflection failed.`); } }
