import { canonicalJson } from "./canonical-json";
import {
  MAX_MOTION_GRADIENT_COLOR_KEYFRAMES,
  MAX_MOTION_GRADIENT_COLOR_KEYFRAME_TIME_US,
  MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA,
  evaluateMotionGradientColorKeyframes,
  readMotionGradientColorKeyframe,
  type MotionGradientColorKeyframeEvaluation,
} from "./motion-gradient-color-keyframes";
import type { MotionDocument, MotionGradient, MotionGradientColorKeyframe, MotionGradientColorKeyframes, MotionLayer } from "./types";

export interface MotionGradientColorKeyframesInspectInput { layerId: string; }
export interface MotionGradientColorKeyframesUpsertInput { layerId: string; snapshot: MotionGradientColorKeyframe; }
export interface MotionGradientColorKeyframesDeleteInput { layerId: string; atUs: number; }
export interface MotionGradientColorKeyframesMoveInput { layerId: string; fromAtUs: number; toAtUs: number; }

export interface MotionGradientColorKeyframesInspection {
  layerId: string;
  topology: { type: "linear" | "radial"; stopCount: number; offsets: readonly number[] };
  colorKeyframes: MotionGradientColorKeyframes | null;
  evaluation: MotionGradientColorKeyframeEvaluation | null;
}

export interface MotionGradientColorKeyframesMutation {
  motion: MotionDocument;
  layerId: string;
  layer: MotionLayer;
  action: "inserted" | "replaced" | "deleted" | "moved";
  changedPaths: readonly string[];
  index: number;
  previousIndex?: number;
  evaluation: MotionGradientColorKeyframeEvaluation;
}

/**
 * Read/mutation boundary for an already valid typed Motion document.  Debug performs full-document
 * validation before its atomic commit; these direct Core helpers validate the complete gradient
 * record and never read caller-owned accessors or mutate the source document on refusal.
 */
export function inspectMotionGradientColorKeyframes(
  motion: MotionDocument,
  input: MotionGradientColorKeyframesInspectInput,
): MotionGradientColorKeyframesInspection {
  const request = operationInput(input, ["layerId"], "Gradient color keyframe inspection");
  const state = gradientState(motion, request.layerId, false);
  const topology = Object.freeze({ type: state.gradient.type, stopCount: state.gradient.stops.length, offsets: Object.freeze(state.gradient.stops.map((stop) => stop.offset)) });
  if (!state.gradient.colorKeyframes) return { layerId: state.layer.id, topology, colorKeyframes: null, evaluation: null };
  const evaluation = evaluateGradient(state.gradient, 0);
  return { layerId: state.layer.id, topology, colorKeyframes: cloneColorKeyframes(state.gradient.colorKeyframes), evaluation };
}

/** Inserts or replaces one complete color vector at its exact microsecond timestamp. */
export function upsertMotionGradientColorKeyframe(
  motion: MotionDocument,
  input: MotionGradientColorKeyframesUpsertInput,
): MotionGradientColorKeyframesMutation {
  const request = operationInput(input, ["layerId", "snapshot"], "Gradient color keyframe upsert");
  const state = gradientState(motion, request.layerId, true);
  const snapshot = readMotionGradientColorKeyframe(request.snapshot, state.gradient.stops.length);
  const previous = state.gradient.colorKeyframes?.keyframes ?? [];
  const matched = previous.findIndex((entry) => entry.atUs === snapshot.atUs);
  if (matched >= 0 && canonicalJson(previous[matched]) === canonicalJson(snapshot)) throw new Error("Gradient color keyframe upsert did not change the snapshot.");
  if (matched < 0 && previous.length >= MAX_MOTION_GRADIENT_COLOR_KEYFRAMES) throw new Error(`Gradient color keyframes cannot exceed ${MAX_MOTION_GRADIENT_COLOR_KEYFRAMES} snapshots.`);
  const keyframes = matched >= 0
    ? previous.map((entry, index) => index === matched ? copyKeyframe(snapshot) : copyKeyframe(entry))
    : [...previous.map(copyKeyframe), copyKeyframe(snapshot)];
  keyframes.sort((left, right) => left.atUs - right.atUs);
  const index = keyframes.findIndex((entry) => entry.atUs === snapshot.atUs);
  const gradient = gradientWithKeyframes(state.gradient, keyframes);
  const evaluation = evaluateGradient(gradient, snapshot.atUs);
  return commit(motion, state, gradient, matched >= 0 ? "replaced" : "inserted", index, evaluation, matched >= 0 ? [`/layers/${state.layer.id}/gradient/colorKeyframes/keyframes/${index}`] : [`/layers/${state.layer.id}/gradient/colorKeyframes/keyframes`]);
}

/** Deletes one exact timestamp but never leaves an invalid empty keyframe record. */
export function deleteMotionGradientColorKeyframe(
  motion: MotionDocument,
  input: MotionGradientColorKeyframesDeleteInput,
): MotionGradientColorKeyframesMutation {
  const request = operationInput(input, ["layerId", "atUs"], "Gradient color keyframe delete");
  const state = gradientState(motion, request.layerId, true);
  const atUs = exactUs(request.atUs, "Gradient color keyframe delete atUs");
  const previous = state.gradient.colorKeyframes?.keyframes;
  if (!previous) throw new Error("Gradient color keyframes are absent.");
  const index = previous.findIndex((entry) => entry.atUs === atUs);
  if (index < 0) throw new Error(`Gradient color keyframe atUs ${atUs} was not found.`);
  if (previous.length <= 1) throw new Error("Gradient color keyframe delete must retain at least one snapshot.");
  const keyframes = previous.filter((_entry, entryIndex) => entryIndex !== index).map(copyKeyframe);
  const gradient = gradientWithKeyframes(state.gradient, keyframes);
  const evaluation = evaluateGradient(gradient, atUs);
  return commit(motion, state, gradient, "deleted", index, evaluation, [`/layers/${state.layer.id}/gradient/colorKeyframes/keyframes/${index}`]);
}

/** Moves one ordered snapshot by assigning a new unique exact microsecond timestamp. */
export function moveMotionGradientColorKeyframe(
  motion: MotionDocument,
  input: MotionGradientColorKeyframesMoveInput,
): MotionGradientColorKeyframesMutation {
  const request = operationInput(input, ["layerId", "fromAtUs", "toAtUs"], "Gradient color keyframe move");
  const state = gradientState(motion, request.layerId, true);
  const fromAtUs = exactUs(request.fromAtUs, "Gradient color keyframe move fromAtUs");
  const toAtUs = exactUs(request.toAtUs, "Gradient color keyframe move toAtUs");
  if (fromAtUs === toAtUs) throw new Error("Gradient color keyframe move did not change the timestamp.");
  const previous = state.gradient.colorKeyframes?.keyframes;
  if (!previous) throw new Error("Gradient color keyframes are absent.");
  const previousIndex = previous.findIndex((entry) => entry.atUs === fromAtUs);
  if (previousIndex < 0) throw new Error(`Gradient color keyframe atUs ${fromAtUs} was not found.`);
  if (previous.some((entry) => entry.atUs === toAtUs)) throw new Error(`Gradient color keyframe atUs ${toAtUs} already exists.`);
  const keyframes = previous.map((entry, index) => copyKeyframe(index === previousIndex ? { ...entry, atUs: toAtUs } : entry));
  keyframes.sort((left, right) => left.atUs - right.atUs);
  const index = keyframes.findIndex((entry) => entry.atUs === toAtUs);
  const gradient = gradientWithKeyframes(state.gradient, keyframes);
  const evaluation = evaluateGradient(gradient, toAtUs);
  return commit(motion, state, gradient, "moved", index, evaluation, [`/layers/${state.layer.id}/gradient/colorKeyframes/keyframes`], previousIndex);
}

interface GradientState { layerIndex: number; layer: MotionLayer; gradient: MotionGradient; }

function gradientState(motion: MotionDocument, layerIdValue: unknown, editable: boolean): GradientState {
  const layerId = typeof layerIdValue === "string" ? layerIdValue.trim() : "";
  if (!layerId) throw new Error("Gradient color keyframe layerId must be a non-empty string.");
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex < 0) throw new Error(`Motion layer not found: ${layerId}.`);
  const layer = motion.layers[layerIndex]!;
  if (layer.type !== "shape" || !layer.gradient) throw new Error(`Motion layer ${layerId} does not own a structured gradient.`);
  if (editable && layer.locked) throw new Error(`Cannot edit locked layer: ${layerId}.`);
  const lockedTrack = editable ? (motion.tracks ?? []).find((track) => track.locked && (track.id === layer.trackId || track.layerIds?.includes(layer.id))) : undefined;
  if (lockedTrack) throw new Error(`Cannot edit gradient color keyframes on locked track: ${lockedTrack.id}.`);
  return { layerIndex, layer, gradient: layer.gradient };
}

function operationInput(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || safelyArray(value, label) || !samePlainPrototype(value, label)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const keys = reflectedKeys(value, label);
  if (keys.length > allowed.length) throw new Error(`${label} exceeds the ${allowed.length}-field payload limit.`);
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") throw new Error(`${label} must not contain symbol keys.`);
    const descriptor = reflectedDescriptor(value, key, `${label}.${key}`);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`);
    Object.defineProperty(record, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
  }
  const unknown = Object.getOwnPropertyNames(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`);
  for (const key of allowed) if (!Object.hasOwn(record, key)) throw new Error(`${label} requires ${key}.`);
  return record;
}

function safelyArray(value: unknown, label: string): boolean {
  try { return Array.isArray(value); } catch { throw new Error(`${label} cannot be reflected safely.`); }
}
function samePlainPrototype(value: object, label: string): boolean {
  try { return Object.getPrototypeOf(value) === Object.prototype; } catch { throw new Error(`${label} cannot be reflected safely.`); }
}
function reflectedKeys(value: object, label: string): PropertyKey[] {
  try { return Reflect.ownKeys(value); } catch { throw new Error(`${label} cannot be reflected safely.`); }
}
function reflectedDescriptor(value: object, key: PropertyKey, label: string): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) throw new Error(`${label} must be present.`);
    return descriptor;
  } catch (error) {
    if (error instanceof Error && /must be present\.$/.test(error.message)) throw error;
    throw new Error(`${label} cannot be reflected safely.`);
  }
}

function exactUs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MOTION_GRADIENT_COLOR_KEYFRAME_TIME_US) throw new Error(`${label} must be a safe integer microsecond within the declared bound.`);
  return value;
}

function gradientWithKeyframes(gradient: MotionGradient, keyframes: readonly MotionGradientColorKeyframe[]): MotionGradient {
  return {
    ...structuredClone(gradient),
    colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes: keyframes.map(copyKeyframe) },
  };
}

function evaluateGradient(gradient: MotionGradient, atUs: number): MotionGradientColorKeyframeEvaluation {
  const result = evaluateMotionGradientColorKeyframes({ gradient, atUs });
  if (!result.ok) throw new Error(`Gradient color keyframe mutation is invalid: ${result.message}`);
  return result.evaluation;
}

function commit(
  motion: MotionDocument,
  state: GradientState,
  gradient: MotionGradient,
  action: MotionGradientColorKeyframesMutation["action"],
  index: number,
  evaluation: MotionGradientColorKeyframeEvaluation,
  changedPaths: readonly string[],
  previousIndex?: number,
): MotionGradientColorKeyframesMutation {
  const layer = { ...structuredClone(state.layer), gradient };
  return {
    motion: { ...motion, layers: motion.layers.map((candidate, index) => index === state.layerIndex ? layer : structuredClone(candidate)) },
    layerId: layer.id,
    layer,
    action,
    changedPaths,
    index,
    ...(previousIndex === undefined ? {} : { previousIndex }),
    evaluation,
  };
}

function copyKeyframe(value: MotionGradientColorKeyframe): MotionGradientColorKeyframe {
  return { atUs: value.atUs, colors: [...value.colors], ...(value.easing === undefined ? {} : { easing: typeof value.easing === "string" ? value.easing : { ...value.easing } }) };
}

function cloneColorKeyframes(value: MotionGradientColorKeyframes): MotionGradientColorKeyframes {
  return { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes: value.keyframes.map(copyKeyframe) };
}
