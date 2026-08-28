import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import {
  MOTION_BEHAVIOR_MAX_COORDINATE,
  MOTION_BEHAVIOR_MAX_GRAVITY,
  MOTION_BEHAVIOR_MAX_RESTITUTION,
  MOTION_BEHAVIOR_MAX_SQUASH_AMOUNT,
  MOTION_BEHAVIOR_MAX_VELOCITY,
  MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY,
  MOTION_BEHAVIOR_MIN_COORDINATE,
  MOTION_BEHAVIOR_MIN_GRAVITY,
  MOTION_BEHAVIOR_MIN_RESTITUTION,
  MOTION_BEHAVIOR_MIN_SQUASH_AMOUNT,
  MOTION_BEHAVIOR_MIN_VELOCITY,
} from "./motion-behavior-types";
import { quantizePointValue } from "./motion-points";

/** Private, data-only Core ABI for bounded transform-behavior samples. */
export const MOTION_TRANSFORM_BEHAVIOR_SCHEMA = "shellx-motion/transform-behavior@1" as const;
export const MAX_MOTION_TRANSFORM_BEHAVIOR_INPUT_BYTES = 16 * 1024;
export const MAX_MOTION_TRANSFORM_BEHAVIOR_DURATION_US = 3_600_000_000;
export const MAX_MOTION_TRANSFORM_BEHAVIOR_IMPACTS = 8;
export const MAX_MOTION_TRANSFORM_BEHAVIOR_WORK_UNITS = 20;
const MAX_ROTATION = 360_000;
const MAX_SCALE = 64;
const MIN_SIZE = MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY;
const MAX_SNAPSHOT_RECORD_KEYS = 8;
const MAX_SNAPSHOT_TOTAL_KEYS = 24;
const MAX_SNAPSHOT_RECORDS = 4;
const MAX_SNAPSHOT_DEPTH = 3;

export interface MotionTransformBehaviorIntent {
  x: number;
  y: number;
  rotation: number;
  scale: number;
  width?: number;
  height?: number;
}
export interface MotionTransformBehaviorBudget {
  inputBytes: number;
  impactCount: number;
  sampledImpactCount: number;
  workUnits: number;
  limits: {
    maxInputBytes: typeof MAX_MOTION_TRANSFORM_BEHAVIOR_INPUT_BYTES;
    maxDurationUs: typeof MAX_MOTION_TRANSFORM_BEHAVIOR_DURATION_US;
    maxImpacts: typeof MAX_MOTION_TRANSFORM_BEHAVIOR_IMPACTS;
    maxWorkUnits: typeof MAX_MOTION_TRANSFORM_BEHAVIOR_WORK_UNITS;
  };
}
export interface MotionTransformBehaviorEvaluation {
  schema: typeof MOTION_TRANSFORM_BEHAVIOR_SCHEMA;
  atUs: number;
  localUs: number;
  transform: MotionTransformBehaviorIntent;
  sourceSha256: string;
  budget: MotionTransformBehaviorBudget;
  fingerprint: string;
}
export type MotionTransformBehaviorResult = { ok: true; evaluation: MotionTransformBehaviorEvaluation } | { ok: false; message: string };

interface BaseTransform { x: number; y: number; rotation: number; scale: number; width?: number; height?: number }
interface GravityMotion { kind: "gravity"; velocityX: number; velocityY: number; gravityY: number }
interface BounceMotion { kind: "bounce"; floorY: number; velocityY: number; gravityY: number; restitution: number }
interface SquashMotion { kind: "squash"; axis: "vertical" | "horizontal"; amount: number }
interface Input { atUs: number; startUs: number; durationUs: number; base: BaseTransform; motion?: GravityMotion | BounceMotion; squash?: SquashMotion }
interface BounceSample { y: number; impactCount: number }

/**
 * Evaluates a stateless transform intent at an exact microsecond. Coordinates
 * are px with +x right and +y down. Bounce floorY is the maximum pre-squash
 * bounce-origin/top-left y, never an inferred bottom-contact plane; optional
 * squash composes around the box centre and can move the final visible top-left.
 * Omitted base rotation and scale always emit as 0 degrees and 1 respectively.
 */
export function evaluateMotionTransformBehavior(value: unknown): MotionTransformBehaviorResult {
  try {
    const raw = preflight(value);
    const rawSource = sourceRecord(raw);
    const inputBytes = Buffer.byteLength(canonicalJson({ ...rawSource, atUs: raw.atUs }), "utf8");
    if (inputBytes > MAX_MOTION_TRANSFORM_BEHAVIOR_INPUT_BYTES) throw new Error(`Transform behavior exceeds the ${MAX_MOTION_TRANSFORM_BEHAVIOR_INPUT_BYTES}-byte input limit.`);
    const input = readInput(raw);
    const localUs = input.atUs - input.startUs;
    if (localUs < 0 || localUs > input.durationUs) throw new Error("Transform behavior atUs must fall inside its closed [startUs, startUs + durationUs] interval.");
    const durationSeconds = input.durationUs / 1_000_000;
    const fullBounce = input.motion?.kind === "bounce" ? sampleBounce(input.base.y, input.motion, durationSeconds) : { y: input.base.y, impactCount: 0 };
    if (fullBounce.impactCount > MAX_MOTION_TRANSFORM_BEHAVIOR_IMPACTS) throw new Error(`Transform behavior bounce requires more than ${MAX_MOTION_TRANSFORM_BEHAVIOR_IMPACTS} impacts across its authored duration.`);
    const sampledBounce = input.motion?.kind === "bounce" ? sampleBounce(input.base.y, input.motion, localUs / 1_000_000) : undefined;
    const transform = resolveTransform(input, localUs / input.durationUs, localUs / 1_000_000, sampledBounce);
    const workUnits = behaviorWorkUnits(input, fullBounce.impactCount, sampledBounce?.impactCount ?? 0);
    if (workUnits > MAX_MOTION_TRANSFORM_BEHAVIOR_WORK_UNITS) throw new Error("Transform behavior exceeded its fixed work limit.");
    const budget = Object.freeze({
      inputBytes,
      impactCount: fullBounce.impactCount,
      sampledImpactCount: sampledBounce?.impactCount ?? 0,
      workUnits,
      limits: Object.freeze({ maxInputBytes: MAX_MOTION_TRANSFORM_BEHAVIOR_INPUT_BYTES, maxDurationUs: MAX_MOTION_TRANSFORM_BEHAVIOR_DURATION_US, maxImpacts: MAX_MOTION_TRANSFORM_BEHAVIOR_IMPACTS, maxWorkUnits: MAX_MOTION_TRANSFORM_BEHAVIOR_WORK_UNITS })
    });
    const base = { schema: MOTION_TRANSFORM_BEHAVIOR_SCHEMA, atUs: input.atUs, localUs, transform, sourceSha256: canonicalJsonSha256(rawSource), budget };
    return { ok: true, evaluation: Object.freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Transform behavior could not be evaluated." };
  }
}

/** Structural preflight snapshots descriptor values before byte accounting or motion math. */
function preflight(value: unknown): Record<string, unknown> {
  const record = strictDataSnapshot(value) as Record<string, unknown>;
  const exact = exactRecord(record, ["schema", "atUs", "startUs", "durationUs", "base"], ["motion", "squash"], "Transform behavior");
  if (exact.schema !== MOTION_TRANSFORM_BEHAVIOR_SCHEMA) throw new Error(`Transform behavior schema must equal ${MOTION_TRANSFORM_BEHAVIOR_SCHEMA}.`);
  if (typeof exact.atUs !== "number" || typeof exact.startUs !== "number" || typeof exact.durationUs !== "number") throw new Error("Transform behavior times must be numbers.");
  const motion = Object.hasOwn(exact, "motion") ? preflightMotion(exact.motion) : undefined;
  const squash = Object.hasOwn(exact, "squash") ? preflightSquash(exact.squash) : undefined;
  if (!motion && !squash) throw new Error("Transform behavior requires motion or squash.");
  return { schema: exact.schema, atUs: exact.atUs, startUs: exact.startUs, durationUs: exact.durationUs, base: preflightBase(exact.base), ...(motion ? { motion } : {}), ...(squash ? { squash } : {}) };
}

function preflightBase(value: unknown): Record<string, unknown> {
  const record = exactRecord(value, ["x", "y"], ["rotation", "scale", "width", "height"], "Transform behavior base");
  return copyNumbers(record, ["x", "y", "rotation", "scale", "width", "height"], "Transform behavior base");
}

function preflightMotion(value: unknown): Record<string, unknown> {
  const initial = dataRecord(value, "Transform behavior motion");
  if (initial.kind === "gravity") return copyNumbers(exactRecord(initial, ["kind", "velocityX", "velocityY", "gravityY"], [], "Transform behavior gravity"), ["velocityX", "velocityY", "gravityY"], "Transform behavior gravity", { kind: "gravity" });
  if (initial.kind === "bounce") return copyNumbers(exactRecord(initial, ["kind", "floorY", "velocityY", "gravityY", "restitution"], [], "Transform behavior bounce"), ["floorY", "velocityY", "gravityY", "restitution"], "Transform behavior bounce", { kind: "bounce" });
  throw new Error("Transform behavior motion kind must be gravity or bounce.");
}

function preflightSquash(value: unknown): Record<string, unknown> {
  const record = exactRecord(value, ["kind", "axis", "amount"], [], "Transform behavior squash");
  if (record.kind !== "squash" || (record.axis !== "vertical" && record.axis !== "horizontal")) throw new Error("Transform behavior squash must use kind squash and a vertical or horizontal axis.");
  return copyNumbers(record, ["amount"], "Transform behavior squash", { kind: "squash", axis: record.axis });
}

function copyNumbers(record: Record<string, unknown>, names: readonly string[], label: string, prefix: Record<string, unknown> = {}): Record<string, unknown> {
  const result: Record<string, unknown> = { ...prefix };
  for (const name of names) if (Object.hasOwn(record, name)) {
    if (typeof record[name] !== "number") throw new Error(`${label}.${name} must be a number.`);
    result[name] = record[name];
  }
  return result;
}

function readInput(raw: Record<string, unknown>): Input {
  const atUs = safeUs(raw.atUs, "Transform behavior atUs"), startUs = safeUs(raw.startUs, "Transform behavior startUs"), durationUs = positiveDurationUs(raw.durationUs);
  if (!Number.isSafeInteger(startUs + durationUs)) throw new Error("Transform behavior startUs plus durationUs exceeds safe integer microseconds.");
  const base = readBase(raw.base);
  const motion = Object.hasOwn(raw, "motion") ? readMotion(raw.motion, base) : undefined;
  const squash = Object.hasOwn(raw, "squash") ? readSquash(raw.squash, base) : undefined;
  return { atUs, startUs, durationUs, base, ...(motion ? { motion } : {}), ...(squash ? { squash } : {}) };
}

function readBase(value: unknown): BaseTransform {
  const record = value as Record<string, unknown>;
  const x = bounded(record.x, MOTION_BEHAVIOR_MIN_COORDINATE, MOTION_BEHAVIOR_MAX_COORDINATE, "Transform behavior base.x");
  const y = bounded(record.y, MOTION_BEHAVIOR_MIN_COORDINATE, MOTION_BEHAVIOR_MAX_COORDINATE, "Transform behavior base.y");
  const rotation = Object.hasOwn(record, "rotation") ? bounded(record.rotation, -MAX_ROTATION, MAX_ROTATION, "Transform behavior base.rotation") : 0;
  const scale = Object.hasOwn(record, "scale") ? bounded(record.scale, MIN_SIZE, MAX_SCALE, "Transform behavior base.scale") : 1;
  const width = Object.hasOwn(record, "width") ? bounded(record.width, MIN_SIZE, MOTION_BEHAVIOR_MAX_COORDINATE, "Transform behavior base.width") : undefined;
  const height = Object.hasOwn(record, "height") ? bounded(record.height, MIN_SIZE, MOTION_BEHAVIOR_MAX_COORDINATE, "Transform behavior base.height") : undefined;
  return { x, y, rotation, scale, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) };
}

function readMotion(value: unknown, base: BaseTransform): GravityMotion | BounceMotion {
  const record = value as Record<string, unknown>;
  if (record.kind === "gravity") {
    const velocityX = bounded(record.velocityX, MOTION_BEHAVIOR_MIN_VELOCITY, MOTION_BEHAVIOR_MAX_VELOCITY, "Transform behavior gravity.velocityX");
    const velocityY = bounded(record.velocityY, MOTION_BEHAVIOR_MIN_VELOCITY, MOTION_BEHAVIOR_MAX_VELOCITY, "Transform behavior gravity.velocityY");
    const gravityY = bounded(record.gravityY, MOTION_BEHAVIOR_MIN_GRAVITY, MOTION_BEHAVIOR_MAX_GRAVITY, "Transform behavior gravity.gravityY");
    if (velocityX === 0 && velocityY === 0 && gravityY === 0) throw new Error("Transform behavior gravity must change the transform.");
    return { kind: "gravity", velocityX, velocityY, gravityY };
  }
  const floorY = bounded(record.floorY, MOTION_BEHAVIOR_MIN_COORDINATE, MOTION_BEHAVIOR_MAX_COORDINATE, "Transform behavior bounce.floorY");
  const velocityY = bounded(record.velocityY, MOTION_BEHAVIOR_MIN_VELOCITY, MOTION_BEHAVIOR_MAX_VELOCITY, "Transform behavior bounce.velocityY");
  const gravityY = bounded(record.gravityY, MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY, MOTION_BEHAVIOR_MAX_GRAVITY, "Transform behavior bounce.gravityY");
  const restitution = bounded(record.restitution, MOTION_BEHAVIOR_MIN_RESTITUTION, MOTION_BEHAVIOR_MAX_RESTITUTION, "Transform behavior bounce.restitution");
  if (base.y > floorY) throw new Error("Transform behavior bounce base.y cannot start below floorY.");
  if (base.y === floorY && velocityY >= 0 && restitution !== 0) throw new Error("Transform behavior bounce on floorY requires upward velocity or zero restitution.");
  return { kind: "bounce", floorY, velocityY, gravityY, restitution };
}

function readSquash(value: unknown, base: BaseTransform): SquashMotion {
  const record = value as Record<string, unknown>;
  if (base.width === undefined || base.height === undefined) throw new Error("Transform behavior squash requires base.width and base.height.");
  return { kind: "squash", axis: record.axis as "vertical" | "horizontal", amount: bounded(record.amount, MOTION_BEHAVIOR_MIN_SQUASH_AMOUNT, MOTION_BEHAVIOR_MAX_SQUASH_AMOUNT, "Transform behavior squash.amount") };
}

function sampleBounce(baseY: number, motion: BounceMotion, seconds: number): BounceSample {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Transform behavior bounce time is non-finite.");
  if (baseY === motion.floorY && motion.velocityY === 0 && motion.restitution === 0) return { y: motion.floorY, impactCount: 0 };
  let y = baseY, velocity = motion.velocityY, remaining = seconds, impactCount = 0;
  while (true) {
    const hitSeconds = floorImpactSeconds(y, velocity, motion.gravityY, motion.floorY);
    if (hitSeconds > remaining) return { y: movementY(y, velocity, motion.gravityY, remaining), impactCount };
    y = motion.floorY;
    remaining -= hitSeconds;
    impactCount += 1;
    if (impactCount > MAX_MOTION_TRANSFORM_BEHAVIOR_IMPACTS) return { y, impactCount };
    const impactVelocity = quantized(velocity + motion.gravityY * hitSeconds, "bounce impact velocity");
    velocity = quantized(-impactVelocity * motion.restitution, "bounce reflected velocity");
    if (velocity === 0 || motion.restitution === 0 || remaining === 0) return { y, impactCount };
  }
}

function floorImpactSeconds(y: number, velocity: number, gravity: number, floorY: number): number {
  const distance = floorY - y, discriminant = velocity * velocity + 2 * gravity * distance;
  if (!Number.isFinite(discriminant) || discriminant < 0) throw new Error("Transform behavior bounce has no finite floor impact.");
  const seconds = (-velocity + Math.sqrt(discriminant)) / gravity;
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Transform behavior bounce has an invalid floor impact.");
  return seconds;
}

function resolveTransform(input: Input, progress: number, seconds: number, bounce: BounceSample | undefined): MotionTransformBehaviorIntent {
  let x = input.base.x, y = input.base.y;
  if (input.motion?.kind === "gravity") {
    x = input.base.x + input.motion.velocityX * seconds;
    y = movementY(input.base.y, input.motion.velocityY, input.motion.gravityY, seconds);
  } else if (bounce) y = bounce.y;
  let width = input.base.width, height = input.base.height;
  if (input.squash) {
    const pulse = 4 * progress * (1 - progress), multiplier = 1 + input.squash.amount * pulse;
    if (input.squash.axis === "vertical") {
      width = input.base.width! * multiplier; height = input.base.height! / multiplier;
    } else {
      width = input.base.width! / multiplier; height = input.base.height! * multiplier;
    }
    x += (input.base.width! - width) / 2;
    y += (input.base.height! - height) / 2;
  }
  const result = { x: quantizedBounded(x, MOTION_BEHAVIOR_MIN_COORDINATE, MOTION_BEHAVIOR_MAX_COORDINATE, "x"), y: quantizedBounded(y, MOTION_BEHAVIOR_MIN_COORDINATE, MOTION_BEHAVIOR_MAX_COORDINATE, "y"), rotation: input.base.rotation, scale: input.base.scale };
  return Object.freeze({ ...result, ...(width === undefined ? {} : { width: quantizedBounded(width, MIN_SIZE, MOTION_BEHAVIOR_MAX_COORDINATE, "width") }), ...(height === undefined ? {} : { height: quantizedBounded(height, MIN_SIZE, MOTION_BEHAVIOR_MAX_COORDINATE, "height") }) });
}

function movementY(y: number, velocity: number, gravity: number, seconds: number): number { return y + velocity * seconds + gravity * seconds * seconds / 2; }
function behaviorWorkUnits(input: Input, fullImpacts: number, sampledImpacts: number): number { return 1 + (input.motion?.kind === "bounce" ? fullImpacts + sampledImpacts + 2 : input.motion ? 1 : 0) + (input.squash ? 1 : 0); }
function sourceRecord(raw: Record<string, unknown>): Record<string, unknown> { return { schema: raw.schema, startUs: raw.startUs, durationUs: raw.durationUs, base: raw.base, ...(Object.hasOwn(raw, "motion") ? { motion: raw.motion } : {}), ...(Object.hasOwn(raw, "squash") ? { squash: raw.squash } : {}) }; }
function quantizedBounded(value: number, minimum: number, maximum: number, label: string): number { const result = quantized(value, label); if (result < minimum || result > maximum) throw new Error(`Transform behavior generated ${label} outside ${minimum}..${maximum}.`); return result; }
function quantized(value: number, label: string): number { if (!Number.isFinite(value)) throw new Error(`Transform behavior ${label} is non-finite.`); return quantizePointValue(value); }
function bounded(value: unknown, minimum: number, maximum: number, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} must be a finite number in ${minimum}..${maximum}.`); return quantized(value, label); }
function safeUs(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer microsecond.`); return value; }
function positiveDurationUs(value: unknown): number { const duration = safeUs(value, "Transform behavior durationUs"); if (duration === 0 || duration > MAX_MOTION_TRANSFORM_BEHAVIOR_DURATION_US) throw new Error(`Transform behavior durationUs must be in 1..${MAX_MOTION_TRANSFORM_BEHAVIOR_DURATION_US} microseconds.`); return duration; }

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  const record = dataRecord(value, label), allowed = [...required, ...optional], unknown = Object.getOwnPropertyNames(record).find((name) => !allowed.includes(name));
  if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`);
  for (const name of required) if (!Object.hasOwn(record, name)) throw new Error(`${label} requires ${name}.`);
  return record;
}
function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw new Error(`${label} must be a plain object.`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`);
  return value as Record<string, unknown>;
}

/**
 * Copies the complete, tiny request graph from descriptors only. Once this
 * returns, every later read/hashing step sees only fresh plain objects; caller
 * `get` traps cannot observe validation or mutate the evaluated source.
 */
function strictDataSnapshot(value: unknown): unknown {
  return cloneData(value, { active: new WeakSet<object>(), records: 0, keys: 0 }, 0);
}

function cloneData(value: unknown, state: { active: WeakSet<object>; records: number; keys: number }, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length > MAX_MOTION_TRANSFORM_BEHAVIOR_INPUT_BYTES) throw new Error(`Transform behavior exceeds the ${MAX_MOTION_TRANSFORM_BEHAVIOR_INPUT_BYTES}-byte input limit.`);
    return value;
  }
  if (typeof value !== "object") throw new Error("Transform behavior must contain only plain data objects.");
  if (depth > MAX_SNAPSHOT_DEPTH) throw new Error("Transform behavior data exceeds its nesting limit.");
  if (state.active.has(value)) throw new Error("Transform behavior data must not contain cycles.");
  let isArray: boolean, keys: readonly PropertyKey[];
  try { isArray = Array.isArray(value); keys = Reflect.ownKeys(value); } catch { throw new Error("Transform behavior data reflection failed."); }
  if (isArray) throw new Error("Transform behavior must contain only plain data objects.");
  if (keys.length > MAX_SNAPSHOT_RECORD_KEYS) throw new Error(`Transform behavior data exceeds the ${MAX_SNAPSHOT_RECORD_KEYS}-field record limit.`);
  if (state.keys + keys.length > MAX_SNAPSHOT_TOTAL_KEYS) throw new Error(`Transform behavior data exceeds the ${MAX_SNAPSHOT_TOTAL_KEYS}-field aggregate limit.`);
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value); } catch { throw new Error("Transform behavior data reflection failed."); }
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Transform behavior must contain only plain data objects.");
  if (keys.some((key) => typeof key !== "string")) throw new Error("Transform behavior data must not contain symbol fields.");
  if (state.records >= MAX_SNAPSHOT_RECORDS) throw new Error(`Transform behavior data exceeds the ${MAX_SNAPSHOT_RECORDS}-record limit.`);
  state.active.add(value); state.records += 1; state.keys += keys.length;
  try {
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { throw new Error("Transform behavior data reflection failed."); }
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`Transform behavior data.${String(key)} must be an enumerable data field.`);
      Object.defineProperty(snapshot, key, { value: cloneData(descriptor.value, state, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return snapshot;
  } finally {
    state.active.delete(value);
  }
}
