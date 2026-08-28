/** Shared strict parsing and document-admission helpers for scene3d animation authoring. */
import {
  readMotionScene3DAnimationDocumentRoot,
  validateMotionScene3DAnimationDocument,
} from "./motion-scene3d-animation-document";
import { readMotionScene3DAnimationDescriptor } from "./motion-scene3d-animation-read";
import { motionScene3DAnimationRootPreflight } from "./motion-scene3d-animation-root-preflight";
import {
  MAX_MOTION_SCENE3D_ANIMATION_TIME_US,
  MOTION_SCENE3D_ANIMATION_SCHEMA,
  motionScene3DAnimationLocatorKey,
  type MotionScene3DAnimationDescriptor,
  type MotionScene3DAnimationKeyframe,
  type MotionScene3DAnimationLocator,
  type MotionScene3DAnimationTrack,
} from "./motion-scene3d-animation-types";
import type { MotionDocument } from "./types";
import { loadSchemaSync, validateDocumentSync } from "./validate";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function readStore(motion: MotionDocument): MotionScene3DAnimationDescriptor | null {
  const rootProblem = motionScene3DAnimationRootPreflight(motion);
  if (rootProblem) throw new Error(`Motion document scene3dAnimation is invalid: ${rootProblem.message}`);
  const root = optionalDataField(motion, "scene3dAnimation", "Motion document");
  return readMotionScene3DAnimationDocumentRoot(root, documentContext(motion)) ?? null;
}

export function withStore(motion: MotionDocument, store: MotionScene3DAnimationDescriptor | undefined, label: string): MotionDocument {
  const next = structuredClone(motion);
  if (store) next.scene3dAnimation = structuredClone(store);
  else delete next.scene3dAnimation;
  const admitted = validateMotionScene3DAnimationDocument(next.scene3dAnimation, documentContext(next));
  if (!admitted.ok) throw new Error(`${label} is invalid: ${admitted.issues[0]!.message}`);
  const validation = validateDocumentSync(loadSchemaSync("motion"), next);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new Error(`${label} is not a valid public Motion document: ${first?.path ?? "/motion"} ${first?.message ?? "unknown validation error"}.`);
  }
  return next;
}

export function readDescriptor(tracks: readonly MotionScene3DAnimationTrack[]): MotionScene3DAnimationDescriptor {
  return readMotionScene3DAnimationDescriptor({ schema: MOTION_SCENE3D_ANIMATION_SCHEMA, tracks });
}

export function readKeyframe(track: MotionScene3DAnimationTrack, value: unknown, label: string): MotionScene3DAnimationKeyframe {
  const parsed = readMotionScene3DAnimationDescriptor({
    schema: MOTION_SCENE3D_ANIMATION_SCHEMA,
    tracks: [{ id: track.id, locator: track.locator, keyframes: [value] }],
  }).tracks[0]!.keyframes[0]!;
  if (parsed.atUs > MAX_MOTION_SCENE3D_ANIMATION_TIME_US) throw new Error(`${label}.atUs exceeds the exact scene3d animation bound.`);
  return parsed;
}

export function replaceTrack(store: MotionScene3DAnimationDescriptor, index: number, track: MotionScene3DAnimationTrack): MotionScene3DAnimationDescriptor {
  return readDescriptor(store.tracks.map((candidate, candidateIndex) => candidateIndex === index ? copyTrack(track) : copyTrack(candidate)));
}

export function requireTrackIndex(store: MotionScene3DAnimationDescriptor | null, trackId: string): number {
  if (!store) throw new Error(`Scene3d animation track '${trackId}' is absent.`);
  const index = store.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) throw new Error(`Scene3d animation track '${trackId}' is absent.`);
  return index;
}

export function assertEditableSceneLayer(motion: MotionDocument, layerId: string): void {
  const layer = motion.layers.find((candidate) => candidate.id === layerId);
  if (!layer || layer.type !== "scene3d" || !layer.scene3d) throw new Error(`Scene3d animation layer '${layerId}' is absent.`);
  if (layer.locked) throw new Error(`Cannot edit locked layer: ${layerId}.`);
  const lockedTrack = (motion.tracks ?? []).find((track) => track.locked && (track.id === layer.trackId || track.layerIds?.includes(layer.id)));
  if (lockedTrack) throw new Error(`Cannot edit scene3d animation on locked track: ${lockedTrack.id}.`);
}

export function operationRecord(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || prototypeOf(value, label) !== Object.prototype) throw new Error(`${label} must be a plain object.`);
  const keys = ownKeys(value, label);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string") || expected.some((key) => !keys.includes(key))) {
    throw new Error(`${label} requires exactly ${expected.join(", ")}.`);
  }
  const result: Record<string, unknown> = {};
  for (const key of expected) Object.defineProperty(result, key, { value: requiredDataField(value, key, label), enumerable: true, configurable: true, writable: true });
  return result;
}

export function readId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} must be a safe stable id.`);
  return value;
}

export function readUs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MOTION_SCENE3D_ANIMATION_TIME_US) {
    throw new Error(`${label} must be a safe integer in 0..${MAX_MOTION_SCENE3D_ANIMATION_TIME_US} microseconds.`);
  }
  return value;
}

export function copyTrack(track: MotionScene3DAnimationTrack): MotionScene3DAnimationTrack {
  return { id: track.id, locator: cloneLocator(track.locator), keyframes: track.keyframes.map(copyKeyframe) };
}
export function copyKeyframe(keyframe: MotionScene3DAnimationKeyframe): MotionScene3DAnimationKeyframe {
  return {
    atUs: keyframe.atUs,
    value: Array.isArray(keyframe.value) ? [...keyframe.value] as MotionScene3DAnimationKeyframe["value"] : keyframe.value,
    ...(keyframe.easing === undefined ? {} : { easing: typeof keyframe.easing === "string" ? keyframe.easing : { ...keyframe.easing } }),
  };
}
export function cloneLocator(locator: MotionScene3DAnimationLocator): MotionScene3DAnimationLocator { return { ...locator }; }
export function sameLocator(left: MotionScene3DAnimationLocator, right: MotionScene3DAnimationLocator): boolean { return motionScene3DAnimationLocatorKey(left) === motionScene3DAnimationLocatorKey(right); }

function documentContext(motion: MotionDocument): { durationMs: unknown; layers: readonly unknown[] } {
  const durationMs = requiredDataField(motion, "durationMs", "Motion document");
  const layers = requiredDataField(motion, "layers", "Motion document");
  if (!Array.isArray(layers)) throw new Error("Motion document layers must be an array.");
  return { durationMs, layers };
}
function optionalDataField(value: object, key: string, label: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { throw new Error(`${label} reflection failed.`); }
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`);
  return descriptor.value;
}
function requiredDataField(value: object, key: string, label: string): unknown {
  const result = optionalDataField(value, key, label);
  if (result === undefined && !Object.hasOwn(value, key)) throw new Error(`${label} requires ${key}.`);
  return result;
}
function ownKeys(value: object, label: string): PropertyKey[] { try { return Reflect.ownKeys(value); } catch { throw new Error(`${label} reflection failed.`); } }
function prototypeOf(value: object, label: string): object | null { try { return Object.getPrototypeOf(value); } catch { throw new Error(`${label} reflection failed.`); } }
