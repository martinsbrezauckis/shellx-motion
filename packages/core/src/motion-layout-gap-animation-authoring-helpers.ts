import { canonicalJson } from "./canonical-json";
import {
  assertMotionLayoutGapAnimationData,
  readMotionLayoutGapAnimationDocumentRoot,
  validateMotionLayoutGapAnimationDocument,
} from "./motion-layout-gap-animation-document";
import { readMotionLayoutGapAnimationDescriptor } from "./motion-layout-gap-animation-read";
import {
  MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US,
  MOTION_LAYOUT_GAP_ANIMATION_SCHEMA,
  type MotionLayoutGapAnimationDescriptor,
  type MotionLayoutGapAnimationKeyframe,
  type MotionLayoutGapAnimationTrack,
} from "./motion-layout-gap-animation-types";
import type { MotionDocument } from "./types";
import { loadSchemaSync, validateDocumentSync } from "./validate";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function readLayoutGapAnimationStore(
  motion: MotionDocument,
): MotionLayoutGapAnimationDescriptor | null {
  assertMotionLayoutGapAnimationData(motion);
  const descriptor = Object.getOwnPropertyDescriptor(motion, "layoutGapAnimation");
  if (!descriptor) return null;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new Error("Motion document.layoutGapAnimation must be an enumerable data field.");
  }
  return readMotionLayoutGapAnimationDocumentRoot(descriptor.value, motion) ?? null;
}

export function withLayoutGapAnimationStore(
  motion: MotionDocument,
  store: MotionLayoutGapAnimationDescriptor | undefined,
  label: string,
): MotionDocument {
  assertMotionLayoutGapAnimationData(motion);
  const next = structuredClone(motion);
  if (store) next.layoutGapAnimation = structuredClone(store);
  else delete next.layoutGapAnimation;
  const admitted = validateMotionLayoutGapAnimationDocument(next.layoutGapAnimation, next);
  if (!admitted.ok) throw new Error(`${label} is invalid: ${admitted.issues[0]!.message}`);
  const validation = validateDocumentSync(loadSchemaSync("motion"), next);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new Error(
      `${label} is not a valid public Motion document: ${first?.path ?? "/motion"} ${first?.message ?? "unknown validation error"}.`,
    );
  }
  return next;
}

export function layoutGapAnimationDescriptor(
  tracks: readonly MotionLayoutGapAnimationTrack[],
): MotionLayoutGapAnimationDescriptor {
  return readMotionLayoutGapAnimationDescriptor({
    schema: MOTION_LAYOUT_GAP_ANIMATION_SCHEMA,
    tracks,
  });
}

export function replaceLayoutGapAnimationTrack(
  store: MotionLayoutGapAnimationDescriptor,
  index: number,
  track: MotionLayoutGapAnimationTrack,
): MotionLayoutGapAnimationDescriptor {
  return layoutGapAnimationDescriptor(store.tracks.map((candidate, candidateIndex) =>
    candidateIndex === index ? copyLayoutGapAnimationTrack(track) : copyLayoutGapAnimationTrack(candidate)));
}

export function requireLayoutGapAnimationTrack(
  store: MotionLayoutGapAnimationDescriptor | null,
  trackId: string,
): number {
  if (!store) throw new Error(`Layout gap animation track '${trackId}' is absent.`);
  const index = store.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) throw new Error(`Layout gap animation track '${trackId}' is absent.`);
  return index;
}

export function readLayoutGapAnimationKeyframe(
  track: MotionLayoutGapAnimationTrack,
  value: unknown,
  label: string,
): MotionLayoutGapAnimationKeyframe {
  const parsed = readMotionLayoutGapAnimationDescriptor({
    schema: MOTION_LAYOUT_GAP_ANIMATION_SCHEMA,
    tracks: [{
      id: track.id,
      applicationId: track.applicationId,
      applicationFingerprint: track.applicationFingerprint,
      childLayerIds: track.childLayerIds,
      keyframes: [value],
    }],
  }).tracks[0]!.keyframes[0]!;
  if (parsed.atUs > MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US) {
    throw new Error(`${label}.atUs exceeds the exact layout gap animation bound.`);
  }
  return parsed;
}

export function readLayoutGapAnimationOperationRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length
    || own.some((key) => typeof key !== "string")
    || keys.some((key) => !own.includes(key))) {
    throw new Error(`${label} requires exactly ${keys.join(", ")}.`);
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label}.${key} must be an enumerable data field.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function sameLayoutGapAnimationTrackBinding(
  existing: MotionLayoutGapAnimationTrack,
  incoming: MotionLayoutGapAnimationTrack,
): boolean {
  return existing.applicationId === incoming.applicationId
    && existing.applicationFingerprint === incoming.applicationFingerprint
    && canonicalJson(existing.childLayerIds) === canonicalJson(incoming.childLayerIds);
}

export function readLayoutGapAnimationId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a safe stable id.`);
  }
  return value;
}

export function readLayoutGapAnimationUs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value < 0 || value > MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US) {
    throw new Error(
      `${label} must be a safe integer in 0..${MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US} microseconds.`,
    );
  }
  return value;
}

export function copyLayoutGapAnimationTrack(
  track: MotionLayoutGapAnimationTrack,
): MotionLayoutGapAnimationTrack {
  return {
    id: track.id,
    applicationId: track.applicationId,
    applicationFingerprint: track.applicationFingerprint,
    childLayerIds: [...track.childLayerIds],
    keyframes: track.keyframes.map(copyLayoutGapAnimationKeyframe),
  };
}

export function copyLayoutGapAnimationKeyframe(
  keyframe: MotionLayoutGapAnimationKeyframe,
): MotionLayoutGapAnimationKeyframe {
  return {
    atUs: keyframe.atUs,
    value: keyframe.value,
    ...(keyframe.easing === undefined ? {} : { easing: keyframe.easing }),
  };
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
