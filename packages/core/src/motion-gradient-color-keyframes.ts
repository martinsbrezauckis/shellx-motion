import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { isSupportedMotionColorString } from "./color";
// This leaf deliberately shares timeline easing and color segment semantics.  The reverse import
// from timeline is safe: neither module evaluates work during module initialization.
import { interpolateGradientColorSegment, readEasingValidationError, resolveEasing } from "./timeline";
import type { MotionEasing, MotionGradient, MotionGradientColorKeyframe, MotionGradientColorKeyframes } from "./types";

/** Exact, private Core ABI for fixed-topology gradient stop color snapshots. */
export const MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA = "shellx-motion/gradient-color-keyframes@1" as const;
export const MAX_MOTION_GRADIENT_COLOR_KEYFRAMES = 32;
export const MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT = 16;
export const MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES = 128;
export const MAX_MOTION_GRADIENT_COLOR_KEYFRAME_INPUT_BYTES = 64 * 1024;
export const MAX_MOTION_GRADIENT_COLOR_KEYFRAME_WORK_UNITS = MAX_MOTION_GRADIENT_COLOR_KEYFRAMES * MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT;
export const MAX_MOTION_GRADIENT_COLOR_KEYFRAME_TIME_US = 1_000_000_000_000;

export interface MotionGradientColorKeyframeEvaluationInput {
  gradient: MotionGradient;
  atUs: number;
}

export interface MotionGradientColorKeyframeBudget {
  snapshotCount: number;
  stopCount: number;
  inputBytes: number;
  interpolationWorkUnits: number;
  limits: {
    maxSnapshots: typeof MAX_MOTION_GRADIENT_COLOR_KEYFRAMES;
    maxStops: typeof MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT;
    maxColorBytes: typeof MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES;
    maxInputBytes: typeof MAX_MOTION_GRADIENT_COLOR_KEYFRAME_INPUT_BYTES;
    maxInterpolationWorkUnits: typeof MAX_MOTION_GRADIENT_COLOR_KEYFRAME_WORK_UNITS;
  };
}

export interface MotionGradientColorKeyframeEvaluation {
  schema: typeof MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA;
  atUs: number;
  /** Canonically sampled color vector, in the existing immutable stop order. */
  colors: readonly string[];
  /** Binds kind, fixed linear/radial geometry, stop count, and ordered offsets. */
  topologySha256: string;
  /** Binds every authored timestamp, full color vector, and authored segment easing. */
  sourceSequenceSha256: string;
  budget: MotionGradientColorKeyframeBudget;
  fingerprint: string;
}

export type MotionGradientColorKeyframeEvaluationResult =
  | { ok: true; evaluation: MotionGradientColorKeyframeEvaluation }
  | { ok: false; message: string };

interface ParsedGradient {
  gradient: MotionGradient;
  keyframes: readonly MotionGradientColorKeyframe[];
  topology: Record<string, unknown>;
}

/**
 * Evaluates a fixed existing gradient topology at one exact microsecond.  It never changes a
 * gradient's kind, offsets, stop count, or geometry; callers apply only the returned color vector.
 */
export function evaluateMotionGradientColorKeyframes(input: unknown): MotionGradientColorKeyframeEvaluationResult {
  try {
    const request = exactRecord(input, ["gradient", "atUs"], "Gradient color keyframes");
    const atUs = boundedUs(request.atUs, "Gradient color keyframes atUs");
    const parsed = readGradient(request.gradient);
    const sourceSequence = {
      schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA,
      keyframes: parsed.keyframes.map((keyframe) => ({
        atUs: keyframe.atUs,
        colors: [...keyframe.colors],
        ...(keyframe.easing === undefined ? {} : { easing: keyframe.easing }),
      })),
    };
    const inputBytes = Buffer.byteLength(canonicalJson({ topology: parsed.topology, sourceSequence, atUs }), "utf8");
    if (inputBytes > MAX_MOTION_GRADIENT_COLOR_KEYFRAME_INPUT_BYTES) {
      throw new Error(`Gradient color keyframes exceed the ${MAX_MOTION_GRADIENT_COLOR_KEYFRAME_INPUT_BYTES}-byte input limit.`);
    }
    const workUnits = parsed.keyframes.length * parsed.gradient.stops.length;
    if (workUnits > MAX_MOTION_GRADIENT_COLOR_KEYFRAME_WORK_UNITS) {
      throw new Error(`Gradient color keyframes exceed the ${MAX_MOTION_GRADIENT_COLOR_KEYFRAME_WORK_UNITS}-unit interpolation limit.`);
    }
    const colors = Object.freeze(sampleColors(parsed.keyframes, atUs));
    const budget = Object.freeze({
      snapshotCount: parsed.keyframes.length,
      stopCount: parsed.gradient.stops.length,
      inputBytes,
      interpolationWorkUnits: workUnits,
      limits: Object.freeze({
        maxSnapshots: MAX_MOTION_GRADIENT_COLOR_KEYFRAMES,
        maxStops: MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT,
        maxColorBytes: MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES,
        maxInputBytes: MAX_MOTION_GRADIENT_COLOR_KEYFRAME_INPUT_BYTES,
        maxInterpolationWorkUnits: MAX_MOTION_GRADIENT_COLOR_KEYFRAME_WORK_UNITS,
      }),
    });
    const base = {
      schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA,
      atUs,
      colors,
      topologySha256: canonicalJsonSha256(parsed.topology),
      sourceSequenceSha256: canonicalJsonSha256(sourceSequence),
      budget,
    };
    return { ok: true, evaluation: Object.freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Gradient color keyframes could not be evaluated." };
  }
}

/** Runs the same exact parser without making a runtime promise for an invalid value. */
export function validateMotionGradientColorKeyframes(value: unknown): string | null {
  const result = evaluateMotionGradientColorKeyframes({ gradient: value, atUs: 0 });
  return result.ok ? null : result.message;
}

/** Returns a frozen typed snapshot after exact hostile-data validation, for COW authoring only. */
export function readMotionGradientColorKeyframe(value: unknown, expectedStopCount: number): MotionGradientColorKeyframe {
  const snapshot = readKeyframe(value, "Gradient color keyframe");
  if (snapshot.colors.length !== expectedStopCount) {
    throw new Error(`Gradient color keyframe colors must contain exactly the existing ${expectedStopCount} stops.`);
  }
  return freezeKeyframe(snapshot);
}

function readGradient(value: unknown): ParsedGradient {
  // Read the discriminator from a detached <=5-field record before choosing the exact shape.
  const initial = dataRecord(value, "Gradient color keyframes gradient", 5);
  const type = initial.type;
  if (type !== "linear" && type !== "radial") throw new Error("Gradient color keyframes gradient type must be linear or radial.");
  const allowed = type === "linear"
    ? ["type", "angle", "stops", "colorKeyframes"]
    : ["type", "centerX", "centerY", "stops", "colorKeyframes"];
  const gradient = exactRecord(initial, allowed, "Gradient color keyframes gradient", ["type", "stops", "colorKeyframes"]);
  const stops = boundedArray(gradient.stops, "Gradient color keyframes gradient stops", MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT);
  if (stops.length < 2 || stops.length > MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT) {
    throw new Error(`Gradient color keyframes gradient stops must contain 2..${MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT} entries.`);
  }
  let priorOffset = -Infinity;
  const normalizedStops = stops.map((entry, index) => {
    const stop = exactRecord(entry, ["offset", "color"], `Gradient color keyframes gradient stops[${index}]`);
    const offset = finite(stop.offset, `Gradient color keyframes gradient stops[${index}].offset`);
    if (offset < 0 || offset > 1) throw new Error(`Gradient color keyframes gradient stops[${index}].offset must be within 0..1.`);
    if (offset < priorOffset) throw new Error("Gradient color keyframes gradient stops must remain in existing offset order.");
    priorOffset = offset;
    return { offset, color: readColor(stop.color, `Gradient color keyframes gradient stops[${index}].color`) };
  });
  const keyframesRecord = exactRecord(gradient.colorKeyframes, ["schema", "keyframes"], "Gradient color keyframes record");
  if (keyframesRecord.schema !== MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA) {
    throw new Error(`Gradient color keyframes schema must equal ${MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA}.`);
  }
  const entries = boundedArray(keyframesRecord.keyframes, "Gradient color keyframes snapshots", MAX_MOTION_GRADIENT_COLOR_KEYFRAMES);
  if (entries.length === 0) throw new Error(`Gradient color keyframes must contain 1..${MAX_MOTION_GRADIENT_COLOR_KEYFRAMES} snapshots.`);
  const keyframes = entries.map((entry, index) => readKeyframe(entry, `Gradient color keyframe ${index}`));
  for (let index = 1; index < keyframes.length; index += 1) {
    if (keyframes[index - 1].atUs >= keyframes[index].atUs) throw new Error("Gradient color keyframes require strictly ascending unique atUs values.");
  }
  for (const keyframe of keyframes) {
    if (keyframe.colors.length !== normalizedStops.length) {
      throw new Error(`Gradient color keyframes require every colors vector to contain exactly ${normalizedStops.length} entries.`);
    }
  }
  const normalizedGradient: MotionGradient = type === "linear"
    ? {
      type,
      ...(Object.hasOwn(gradient, "angle") ? { angle: finite(gradient.angle, "Gradient color keyframes gradient angle") } : {}),
      stops: normalizedStops,
      colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes },
    }
    : {
      type,
      ...(Object.hasOwn(gradient, "centerX") ? { centerX: unit(gradient.centerX, "Gradient color keyframes gradient centerX") } : {}),
      ...(Object.hasOwn(gradient, "centerY") ? { centerY: unit(gradient.centerY, "Gradient color keyframes gradient centerY") } : {}),
      stops: normalizedStops,
      colorKeyframes: { schema: MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA, keyframes },
    };
  const topology = {
    type,
    ...(type === "linear" && normalizedGradient.angle !== undefined ? { angle: normalizedGradient.angle } : {}),
    ...(type === "radial" && normalizedGradient.centerX !== undefined ? { centerX: normalizedGradient.centerX } : {}),
    ...(type === "radial" && normalizedGradient.centerY !== undefined ? { centerY: normalizedGradient.centerY } : {}),
    stopCount: normalizedStops.length,
    offsets: normalizedStops.map((stop) => stop.offset),
  };
  return { gradient: normalizedGradient, keyframes, topology };
}

function readKeyframe(value: unknown, label: string): MotionGradientColorKeyframe {
  const keyframe = exactRecord(value, ["atUs", "colors", "easing"], label, ["atUs", "colors"]);
  const colors = boundedArray(keyframe.colors, `${label} colors`, MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT).map((color, index) => readColor(color, `${label} colors[${index}]`));
  return {
    atUs: boundedUs(keyframe.atUs, `${label} atUs`),
    colors,
    ...(Object.hasOwn(keyframe, "easing") ? { easing: readEasing(keyframe.easing, `${label} easing`) } : {}),
  };
}

function sampleColors(keyframes: readonly MotionGradientColorKeyframe[], atUs: number): string[] {
  const first = keyframes[0], last = keyframes[keyframes.length - 1];
  if (atUs <= first.atUs) return first.colors.map((color) => canonicalColor(color, color, 0));
  if (atUs >= last.atUs) return last.colors.map((color) => canonicalColor(color, color, 0));
  const exact = keyframes.find((keyframe) => keyframe.atUs === atUs);
  if (exact) return exact.colors.map((color) => canonicalColor(color, color, 0));
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const left = keyframes[index], right = keyframes[index + 1];
    if (atUs < left.atUs || atUs > right.atUs) continue;
    const progress = resolveEasing(left.easing)((atUs - left.atUs) / (right.atUs - left.atUs));
    if (!Number.isFinite(progress)) throw new Error("Gradient color keyframe easing produced a non-finite progress.");
    return left.colors.map((color, colorIndex) => canonicalColor(color, right.colors[colorIndex]!, progress));
  }
  throw new Error("Gradient color keyframes have no active segment.");
}

function canonicalColor(left: string, right: string, progress: number): string {
  const value = interpolateGradientColorSegment(left, right, progress);
  if (value === null) throw new Error("Gradient color keyframe could not produce a canonical color.");
  return value;
}

function readEasing(value: unknown, label: string): MotionEasing {
  if (typeof value === "string") {
    const problem = readEasingValidationError(value);
    if (problem) throw new Error(`${label} ${problem}.`);
    return value;
  }
  const record = exactRecord(value, ["type", "stiffness", "damping", "mass", "initialVelocity"], label, ["type", "stiffness", "damping"]);
  if (record.type !== "spring") throw new Error(`${label} must be a supported easing.`);
  const easing: MotionEasing = {
    type: "spring",
    stiffness: finite(record.stiffness, `${label}.stiffness`),
    damping: finite(record.damping, `${label}.damping`),
    ...(Object.hasOwn(record, "mass") ? { mass: finite(record.mass, `${label}.mass`) } : {}),
    ...(Object.hasOwn(record, "initialVelocity") ? { initialVelocity: finite(record.initialVelocity, `${label}.initialVelocity`) } : {}),
  };
  const problem = readEasingValidationError(easing);
  if (problem) throw new Error(`${label} ${problem}.`);
  return easing;
}

function freezeKeyframe(value: MotionGradientColorKeyframe): MotionGradientColorKeyframe {
  return Object.freeze({
    atUs: value.atUs,
    colors: Object.freeze([...value.colors]),
    ...(value.easing === undefined ? {} : { easing: freezeEasing(value.easing) }),
  });
}

function freezeEasing(value: MotionEasing): MotionEasing {
  return typeof value === "string" ? value : Object.freeze({ ...value });
}

function readColor(value: unknown, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES || !isSupportedMotionColorString(value)) {
    throw new Error(`${label} must be a supported color string of at most ${MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES} bytes.`);
  }
  return value;
}

function exactRecord(value: unknown, allowed: readonly string[], label: string, required: readonly string[] = allowed): Record<string, unknown> {
  const record = dataRecord(value, label, allowed.length);
  const names = Object.getOwnPropertyNames(record);
  const unknown = names.find((name) => !allowed.includes(name));
  if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`);
  for (const key of required) if (!Object.hasOwn(record, key)) throw new Error(`${label} requires ${key}.`);
  return record;
}

/**
 * Snapshots a bounded own-data array. Its length descriptor is read before ownKeys or any indexed
 * descriptor, so a hostile 100k-element array stops at one bounded reflection operation.
 */
function boundedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!safeArray(value, label)) throw new Error(`${label} must be an array.`);
  const length = arrayLength(value, label, maximum);
  if (!samePrototype(value, Array.prototype, label)) throw new Error(`${label} must be an array.`);
  const keys = ownKeys(value, label);
  if (keys.some((key) => typeof key !== "string")) throw new Error(`${label} must not contain symbol keys.`);
  if (keys.length !== length + 1 || !keys.includes("length") || !Array.from({ length }, (_unused, index) => keys.includes(String(index))).every(Boolean)) {
    throw new Error(`${label} must be a dense data array without extension fields.`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = ownDescriptor(value, String(index), `${label}[${index}]`);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}[${index}] must be a data value.`);
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

/** Bounded descriptor snapshot: never returns caller-owned records or invokes property getters. */
function dataRecord(value: unknown, label: string, maximumFields: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || !samePrototype(value, Object.prototype, label) || safeArray(value, label)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const keys = ownKeys(value, label);
  if (keys.length > maximumFields) throw new Error(`${label} exceeds the ${maximumFields}-field payload limit.`);
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") throw new Error(`${label} must not contain symbol keys.`);
    const descriptor = ownDescriptor(value, key, `${label}.${key}`);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`);
    Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
  }
  return snapshot;
}

function safeArray(value: unknown, label: string): value is unknown[] {
  try { return Array.isArray(value); } catch { throw new Error(`${label} cannot be reflected safely.`); }
}
function samePrototype(value: object, expected: object | null, label: string): boolean {
  try { return Object.getPrototypeOf(value) === expected; } catch { throw new Error(`${label} cannot be reflected safely.`); }
}
function ownKeys(value: object, label: string): PropertyKey[] {
  try { return Reflect.ownKeys(value); } catch { throw new Error(`${label} cannot be reflected safely.`); }
}
function ownDescriptor(value: object, key: PropertyKey, label: string): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) throw new Error(`${label} must be present.`);
    return descriptor;
  } catch (error) {
    if (error instanceof Error && /must be present\.$/.test(error.message)) throw error;
    throw new Error(`${label} cannot be reflected safely.`);
  }
}
function arrayLength(value: unknown[], label: string, maximum: number): number {
  const descriptor = ownDescriptor(value, "length", label);
  const length = "value" in descriptor ? descriptor.value : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum) throw new Error(`${label} exceeds the ${maximum}-item payload limit.`);
  return length;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return Object.is(value, -0) ? 0 : value;
}
function unit(value: unknown, label: string): number {
  const numeric = finite(value, label);
  if (numeric < 0 || numeric > 1) throw new Error(`${label} must be within 0..1.`);
  return numeric;
}
function boundedUs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MOTION_GRADIENT_COLOR_KEYFRAME_TIME_US) {
    throw new Error(`${label} must be a safe integer in 0..${MAX_MOTION_GRADIENT_COLOR_KEYFRAME_TIME_US} microseconds.`);
  }
  return value;
}
