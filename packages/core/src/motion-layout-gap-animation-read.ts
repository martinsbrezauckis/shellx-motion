import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { readEasingValidationError } from "./timeline";
import {
  MAX_MOTION_LAYOUT_GAP_ANIMATION_INPUT_BYTES,
  MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES,
  MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES_PER_TRACK,
  MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US,
  MAX_MOTION_LAYOUT_GAP_ANIMATION_TRACK_BYTES,
  MAX_MOTION_LAYOUT_GAP_ANIMATION_TRACKS,
  MAX_MOTION_LAYOUT_GAP_ANIMATION_WORK_UNITS,
  MOTION_LAYOUT_GAP_ANIMATION_EASINGS,
  MOTION_LAYOUT_GAP_ANIMATION_SCHEMA,
  type MotionLayoutGapAnimationDescriptor,
  type MotionLayoutGapAnimationKeyframe,
  type MotionLayoutGapAnimationTrack,
} from "./motion-layout-gap-animation-types";
import { MAX_MOTION_LAYOUT_DIMENSION } from "./motion-layout-types";
import { readMotionLayoutIdentifier } from "./motion-layout-safety";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_EASING_BYTES = 256;

/** Strict descriptor reader. Every hostile form is rejected before a getter can run. */
export function readMotionLayoutGapAnimationDescriptor(value: unknown): MotionLayoutGapAnimationDescriptor {
  const root = exactRecord(value, ["schema", "tracks"], "Layout gap animation", 2);
  if (root.schema !== MOTION_LAYOUT_GAP_ANIMATION_SCHEMA) throw new Error(`Layout gap animation schema must equal ${MOTION_LAYOUT_GAP_ANIMATION_SCHEMA}.`);
  const entries = denseArray(root.tracks, "Layout gap animation tracks", MAX_MOTION_LAYOUT_GAP_ANIMATION_TRACKS);
  if (entries.length === 0) throw new Error(`Layout gap animation tracks must contain 1..${MAX_MOTION_LAYOUT_GAP_ANIMATION_TRACKS} entries.`);
  const headers = entries.map((entry, index) => trackHeader(entry, index));
  const keyframeCount = headers.reduce((total, header) => total + header.keyframeCount, 0);
  if (keyframeCount > MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES) throw new Error(`Layout gap animation keyframes exceed the ${MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES}-key aggregate limit.`);
  if (keyframeCount > MAX_MOTION_LAYOUT_GAP_ANIMATION_WORK_UNITS) throw new Error(`Layout gap animation work exceeds the ${MAX_MOTION_LAYOUT_GAP_ANIMATION_WORK_UNITS}-unit aggregate limit.`);
  const tracks = headers.map((header, index) => readTrack(header, index));
  const ids = new Set<string>(), applications = new Set<string>();
  for (const track of tracks) {
    if (ids.has(track.id)) throw new Error(`Layout gap animation track id ${track.id} must be unique.`);
    ids.add(track.id);
    if (applications.has(track.applicationId)) throw new Error(`Layout gap animation application ${track.applicationId} must have one track authority.`);
    applications.add(track.applicationId);
  }
  const descriptor = { schema: MOTION_LAYOUT_GAP_ANIMATION_SCHEMA, tracks: Object.freeze(tracks) } as const;
  if (Buffer.byteLength(canonicalJson(descriptor), "utf8") > MAX_MOTION_LAYOUT_GAP_ANIMATION_INPUT_BYTES) throw new Error(`Layout gap animation descriptor exceeds the ${MAX_MOTION_LAYOUT_GAP_ANIMATION_INPUT_BYTES}-byte input limit.`);
  return Object.freeze(descriptor);
}

export function readMotionLayoutGapAnimationTrackForAuthoring(value: unknown): MotionLayoutGapAnimationTrack {
  return readMotionLayoutGapAnimationDescriptor({ schema: MOTION_LAYOUT_GAP_ANIMATION_SCHEMA, tracks: [value] }).tracks[0]!;
}

interface Header { record: Record<string, unknown>; id: string; applicationId: string; applicationFingerprint: string; childLayerIds: string[]; keyframeCount: number }
function trackHeader(value: unknown, index: number): Header {
  const label = `Layout gap animation tracks[${index}]`;
  const record = exactRecord(value, ["id", "applicationId", "applicationFingerprint", "childLayerIds", "keyframes"], label, 5);
  return {
    record,
    id: id(record.id, `${label}.id`),
    applicationId: layoutId(record.applicationId, `${label}.applicationId`),
    applicationFingerprint: sha256(record.applicationFingerprint, `${label}.applicationFingerprint`),
    childLayerIds: layoutIds(record.childLayerIds, `${label}.childLayerIds`, 1, 256),
    keyframeCount: arrayLength(record.keyframes, `${label}.keyframes`, MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES_PER_TRACK),
  };
}
function readTrack(header: Header, index: number): MotionLayoutGapAnimationTrack {
  const label = `Layout gap animation tracks[${index}]`;
  const entries = denseArray(header.record.keyframes, `${label}.keyframes`, MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES_PER_TRACK);
  if (entries.length === 0) throw new Error(`${label}.keyframes must contain 1..${MAX_MOTION_LAYOUT_GAP_ANIMATION_KEYFRAMES_PER_TRACK} entries.`);
  const keyframes = entries.map((entry, keyframeIndex) => readKeyframe(entry, `${label}.keyframes[${keyframeIndex}]`));
  for (let index = 1; index < keyframes.length; index += 1) if (keyframes[index - 1]!.atUs >= keyframes[index]!.atUs) throw new Error(`${label}.keyframes must have strictly ascending unique atUs values.`);
  const track = Object.freeze({ id: header.id, applicationId: header.applicationId, applicationFingerprint: header.applicationFingerprint, childLayerIds: Object.freeze([...header.childLayerIds]), keyframes: Object.freeze(keyframes) });
  if (Buffer.byteLength(canonicalJson(track), "utf8") > MAX_MOTION_LAYOUT_GAP_ANIMATION_TRACK_BYTES) throw new Error(`${label} exceeds the ${MAX_MOTION_LAYOUT_GAP_ANIMATION_TRACK_BYTES}-byte track limit.`);
  return track;
}
function readKeyframe(value: unknown, label: string): MotionLayoutGapAnimationKeyframe {
  const record = exactRecord(value, ["atUs", "value"], label, 3, ["easing"]);
  const keyframe: MotionLayoutGapAnimationKeyframe = { atUs: us(record.atUs, `${label}.atUs`), value: gap(record.value, `${label}.value`) };
  if (Object.hasOwn(record, "easing")) keyframe.easing = easing(record.easing, `${label}.easing`);
  return Object.freeze(keyframe);
}
function easing(value: unknown, label: string): (typeof MOTION_LAYOUT_GAP_ANIMATION_EASINGS)[number] {
  if (typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > MAX_EASING_BYTES
    || !MOTION_LAYOUT_GAP_ANIMATION_EASINGS.includes(value as never)
    || readEasingValidationError(value)) {
    throw new Error(`${label} must be a non-overshooting C2 layout gap easing.`);
  }
  return value as (typeof MOTION_LAYOUT_GAP_ANIMATION_EASINGS)[number];
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
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum) throw new Error(`${label} must contain at most ${maximum} entries.`);
  return length;
}
function id(value: unknown, label: string): string { if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe 1..64 character id.`); return value; }
function layoutId(value: unknown, label: string): string { return readMotionLayoutIdentifier(value, label); }
function layoutIds(value: unknown, label: string, minimum: number, maximum: number): string[] { const entries = denseArray(value, label, maximum); if (entries.length < minimum) throw new Error(`${label} must contain ${minimum}..${maximum} ids.`); const result = entries.map((entry, index) => layoutId(entry, `${label}[${index}]`)); if (new Set(result).size !== result.length) throw new Error(`${label} must contain unique ids.`); return result; }
function sha256(value: unknown, label: string): string { if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hex string.`); return value; }
function us(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US) throw new Error(`${label} must be a safe integer in 0..${MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US} microseconds.`); return value; }
function gap(value: unknown, label: string): number { const parsed = finite(value, label); if (parsed < 0 || parsed > MAX_MOTION_LAYOUT_DIMENSION) throw new Error(`${label} must be within 0..${MAX_MOTION_LAYOUT_DIMENSION}.`); return parsed; }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`); return Object.is(value, -0) ? 0 : value; }
function ownKeys(value: object, label: string): PropertyKey[] { try { return Reflect.ownKeys(value); } catch { throw new Error(`${label} data reflection failed.`); } }
function descriptorOf(value: object, key: PropertyKey, label: string): PropertyDescriptor { try { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor) throw new Error("missing"); return descriptor; } catch { throw new Error(`${label} data reflection failed.`); } }
function prototypeOf(value: object, label: string): object | null { try { return Object.getPrototypeOf(value); } catch { throw new Error(`${label} data reflection failed.`); } }

export function motionLayoutGapAnimationCanonicalSha256(value: MotionLayoutGapAnimationDescriptor): string { return canonicalJsonSha256(value); }
