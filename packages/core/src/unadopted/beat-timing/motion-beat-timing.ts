import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";

/** Reviewed pre-adoption Core seam for exact beat-addressed timing samples. */
export const MOTION_BEAT_TIMING_SCHEMA = "shellx-motion/beat-timing@1" as const;
export const MAX_MOTION_BEAT_TIMING_INPUT_BYTES = 16 * 1024;
export const MAX_MOTION_BEAT_TIMING_SEGMENTS = 32;
export const MAX_MOTION_BEAT_TIMING_TICKS_PER_BEAT = 9_600;
export const MAX_MOTION_BEAT_TIMING_TICK = 1_000_000_000;
export const MAX_MOTION_BEAT_TIMING_TIME_US = 1_000_000_000_000;
export const MAX_MOTION_BEAT_TIMING_RATIONAL_COMPONENT = 1_000_000_000;
export const MAX_MOTION_BEAT_TIMING_RATIONAL_BITS = 2_048;
export const MAX_MOTION_BEAT_TIMING_GCD_STEPS = 2_048;
export const MAX_MOTION_BEAT_TIMING_WORK_UNITS = MAX_MOTION_BEAT_TIMING_SEGMENTS * (MAX_MOTION_BEAT_TIMING_GCD_STEPS * 2 + 1);

const MIN_US_PER_BEAT = 1n;
const MAX_US_PER_BEAT = 60_000_000n;
const MAX_SNAPSHOT_RECORD_KEYS = 8;
const MAX_SNAPSHOT_TOTAL_KEYS = 200;
const MAX_SNAPSHOT_NODES = 70;
const MAX_SNAPSHOT_DEPTH = 3;

export interface MotionBeatTimingBudget {
  inputBytes: number;
  segmentCount: number;
  appliedSegmentCount: number;
  rationalAdditions: number;
  gcdSteps: number;
  peakRationalBits: number;
  workUnits: number;
  limits: {
    maxInputBytes: typeof MAX_MOTION_BEAT_TIMING_INPUT_BYTES;
    maxSegments: typeof MAX_MOTION_BEAT_TIMING_SEGMENTS;
    maxTicksPerBeat: typeof MAX_MOTION_BEAT_TIMING_TICKS_PER_BEAT;
    maxTick: typeof MAX_MOTION_BEAT_TIMING_TICK;
    maxTimeUs: typeof MAX_MOTION_BEAT_TIMING_TIME_US;
    maxRationalBits: typeof MAX_MOTION_BEAT_TIMING_RATIONAL_BITS;
    maxWorkUnits: typeof MAX_MOTION_BEAT_TIMING_WORK_UNITS;
  };
}

export interface MotionBeatTimingEvaluation {
  schema: typeof MOTION_BEAT_TIMING_SCHEMA;
  atTick: number;
  ticksPerBeat: number;
  atUs: number;
  rounding: "nearest-even";
  sourceSha256: string;
  budget: MotionBeatTimingBudget;
  fingerprint: string;
}

export type MotionBeatTimingResult = { ok: true; evaluation: MotionBeatTimingEvaluation } | { ok: false; message: string };

interface Segment { startTick: number; numerator: number; denominator: number; }
interface Request { atTick: number; ticksPerBeat: number; segments: readonly Segment[]; }
interface Rational { numerator: bigint; denominator: bigint; }
interface Arithmetic { additions: number; gcdSteps: number; peakBits: number; workUnits: number; }
interface SnapshotState { active: WeakSet<object>; nodes: number; keys: number; }

/**
 * Converts the exact beat address atTick / ticksPerBeat to an integer microsecond time. Tempo
 * segments are step changes only; their exact rational durations are summed and reduced before
 * one final round-to-nearest, ties-to-even. There is no clock, audio, meter, swing, or hidden state.
 */
export function evaluateMotionBeatTiming(value: unknown): MotionBeatTimingResult {
  try {
    const snapshot = strictDataSnapshot(value);
    const inputBytes = Buffer.byteLength(canonicalJson(snapshot), "utf8");
    if (inputBytes > MAX_MOTION_BEAT_TIMING_INPUT_BYTES) throw new Error(`Beat timing exceeds the ${MAX_MOTION_BEAT_TIMING_INPUT_BYTES}-byte input limit.`);
    const request = readRequest(snapshot);
    const arithmetic: Arithmetic = { additions: 0, gcdSteps: 0, peakBits: 1, workUnits: 0 };
    const { total, appliedSegmentCount } = accumulate(request, arithmetic);
    const atUs = roundNearestEven(total);
    if (atUs > MAX_MOTION_BEAT_TIMING_TIME_US) throw new Error(`Beat timing exceeds the ${MAX_MOTION_BEAT_TIMING_TIME_US}-microsecond output limit.`);
    const budget = Object.freeze({
      inputBytes, segmentCount: request.segments.length, appliedSegmentCount, rationalAdditions: arithmetic.additions,
      gcdSteps: arithmetic.gcdSteps, peakRationalBits: arithmetic.peakBits, workUnits: arithmetic.workUnits,
      limits: Object.freeze({ maxInputBytes: MAX_MOTION_BEAT_TIMING_INPUT_BYTES, maxSegments: MAX_MOTION_BEAT_TIMING_SEGMENTS, maxTicksPerBeat: MAX_MOTION_BEAT_TIMING_TICKS_PER_BEAT, maxTick: MAX_MOTION_BEAT_TIMING_TICK, maxTimeUs: MAX_MOTION_BEAT_TIMING_TIME_US, maxRationalBits: MAX_MOTION_BEAT_TIMING_RATIONAL_BITS, maxWorkUnits: MAX_MOTION_BEAT_TIMING_WORK_UNITS })
    });
    const sourceSha256 = canonicalJsonSha256(sourceRecord(request));
    const base = { schema: MOTION_BEAT_TIMING_SCHEMA, atTick: request.atTick, ticksPerBeat: request.ticksPerBeat, atUs, rounding: "nearest-even" as const, sourceSha256, budget };
    return { ok: true, evaluation: Object.freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Beat timing could not be evaluated." };
  }
}

function readRequest(value: unknown): Request {
  const record = exactRecord(value, ["schema", "atTick", "ticksPerBeat", "tempoSegments"], "Beat timing");
  if (record.schema !== MOTION_BEAT_TIMING_SCHEMA) throw new Error(`Beat timing schema must equal ${MOTION_BEAT_TIMING_SCHEMA}.`);
  const atTick = boundedInteger(record.atTick, 0, MAX_MOTION_BEAT_TIMING_TICK, "Beat timing atTick");
  const ticksPerBeat = boundedInteger(record.ticksPerBeat, 1, MAX_MOTION_BEAT_TIMING_TICKS_PER_BEAT, "Beat timing ticksPerBeat");
  const entries = exactArray(record.tempoSegments, "Beat timing tempoSegments");
  if (entries.length === 0 || entries.length > MAX_MOTION_BEAT_TIMING_SEGMENTS) throw new Error(`Beat timing tempoSegments must contain 1..${MAX_MOTION_BEAT_TIMING_SEGMENTS} entries.`);
  const segments = entries.map((entry, index) => readSegment(entry, index));
  if (segments[0]!.startTick !== 0) throw new Error("Beat timing tempoSegments must start at tick 0.");
  for (let index = 1; index < segments.length; index += 1) if (segments[index - 1]!.startTick >= segments[index]!.startTick) throw new Error("Beat timing tempoSegments require strictly ascending unique startTick values.");
  return { atTick, ticksPerBeat, segments };
}

function readSegment(value: unknown, index: number): Segment {
  const record = exactRecord(value, ["startTick", "microsecondsPerBeat"], `Beat timing tempoSegments[${index}]`);
  const ratio = exactRecord(record.microsecondsPerBeat, ["numerator", "denominator"], `Beat timing tempoSegments[${index}].microsecondsPerBeat`);
  const numerator = boundedInteger(ratio.numerator, 1, MAX_MOTION_BEAT_TIMING_RATIONAL_COMPONENT, `Beat timing tempoSegments[${index}].microsecondsPerBeat.numerator`);
  const denominator = boundedInteger(ratio.denominator, 1, MAX_MOTION_BEAT_TIMING_RATIONAL_COMPONENT, `Beat timing tempoSegments[${index}].microsecondsPerBeat.denominator`);
  const duration = BigInt(numerator), divisor = BigInt(denominator);
  if (duration < MIN_US_PER_BEAT * divisor || duration > MAX_US_PER_BEAT * divisor) throw new Error("Beat timing microsecondsPerBeat must resolve within 1..60000000 microseconds per beat.");
  return { startTick: boundedInteger(record.startTick, 0, MAX_MOTION_BEAT_TIMING_TICK, `Beat timing tempoSegments[${index}].startTick`), numerator, denominator };
}

function accumulate(request: Request, arithmetic: Arithmetic): { total: Rational; appliedSegmentCount: number } {
  let total: Rational = { numerator: 0n, denominator: 1n }, appliedSegmentCount = 0;
  for (let index = 0; index < request.segments.length; index += 1) {
    const segment = request.segments[index]!;
    if (segment.startTick >= request.atTick) break;
    const nextStart = request.segments[index + 1]?.startTick ?? request.atTick;
    const endTick = Math.min(request.atTick, nextStart);
    if (endTick <= segment.startTick) continue;
    const contribution: Rational = { numerator: BigInt(endTick - segment.startTick) * BigInt(segment.numerator), denominator: BigInt(request.ticksPerBeat) * BigInt(segment.denominator) };
    total = addRational(total, contribution, arithmetic);
    appliedSegmentCount += 1;
  }
  return { total, appliedSegmentCount };
}

/** Reduces after every addition, so equivalent same-tempo segmentation cannot change the total. */
function addRational(left: Rational, right: Rational, arithmetic: Arithmetic): Rational {
  consumeWork(arithmetic);
  arithmetic.additions += 1;
  const shared = gcd(left.denominator, right.denominator, arithmetic);
  const leftScale = right.denominator / shared, rightScale = left.denominator / shared;
  const numerator = left.numerator * leftScale + right.numerator * rightScale;
  const denominator = left.denominator * leftScale;
  assertRationalBounds(numerator, denominator, arithmetic);
  const factor = gcd(numerator, denominator, arithmetic);
  const reduced = { numerator: numerator / factor, denominator: denominator / factor };
  assertRationalBounds(reduced.numerator, reduced.denominator, arithmetic);
  return reduced;
}

function gcd(left: bigint, right: bigint, arithmetic: Arithmetic): bigint {
  let a = left < 0n ? -left : left, b = right < 0n ? -right : right, steps = 0;
  while (b !== 0n) {
    if (steps >= MAX_MOTION_BEAT_TIMING_GCD_STEPS) throw new Error(`Beat timing exceeded the ${MAX_MOTION_BEAT_TIMING_GCD_STEPS}-step gcd limit.`);
    const remainder = a % b;
    a = b; b = remainder; steps += 1; arithmetic.gcdSteps += 1; consumeWork(arithmetic);
  }
  return a;
}

function consumeWork(arithmetic: Arithmetic): void {
  arithmetic.workUnits += 1;
  if (arithmetic.workUnits > MAX_MOTION_BEAT_TIMING_WORK_UNITS) throw new Error(`Beat timing exceeded the ${MAX_MOTION_BEAT_TIMING_WORK_UNITS}-unit rational work limit.`);
}

function assertRationalBounds(numerator: bigint, denominator: bigint, arithmetic: Arithmetic): void {
  const bits = Math.max(bitLength(numerator), bitLength(denominator));
  if (bits > MAX_MOTION_BEAT_TIMING_RATIONAL_BITS) throw new Error(`Beat timing exceeded the ${MAX_MOTION_BEAT_TIMING_RATIONAL_BITS}-bit rational accumulator limit.`);
  arithmetic.peakBits = Math.max(arithmetic.peakBits, bits);
}

function bitLength(value: bigint): number { return (value < 0n ? -value : value).toString(2).length; }

function roundNearestEven(value: Rational): number {
  const quotient = value.numerator / value.denominator, remainder = value.numerator % value.denominator, doubled = remainder * 2n;
  const rounded = doubled > value.denominator || (doubled === value.denominator && quotient % 2n !== 0n) ? quotient + 1n : quotient;
  if (rounded > BigInt(MAX_MOTION_BEAT_TIMING_TIME_US)) return MAX_MOTION_BEAT_TIMING_TIME_US + 1;
  return Number(rounded);
}

function sourceRecord(request: Request): Record<string, unknown> {
  return { schema: MOTION_BEAT_TIMING_SCHEMA, ticksPerBeat: request.ticksPerBeat, tempoSegments: request.segments.map((segment) => ({ startTick: segment.startTick, microsecondsPerBeat: { numerator: segment.numerator, denominator: segment.denominator } })) };
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be a safe integer in ${minimum}..${maximum}.`);
  return value;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  const record = value as Record<string, unknown>, names = Object.keys(record);
  const unknown = names.find((name) => !keys.includes(name));
  if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`);
  for (const key of keys) if (!Object.hasOwn(record, key)) throw new Error(`${label} requires ${key}.`);
  return record;
}

function exactArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a dense array.`);
  return value;
}

/** Descriptor-first clone: all parsing and hashing after this point sees only fresh plain data. */
function strictDataSnapshot(value: unknown): unknown {
  return cloneData(value, { active: new WeakSet<object>(), nodes: 0, keys: 0 }, 0);
}

function cloneData(value: unknown, state: SnapshotState, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length > MAX_MOTION_BEAT_TIMING_INPUT_BYTES) throw new Error(`Beat timing exceeds the ${MAX_MOTION_BEAT_TIMING_INPUT_BYTES}-byte input limit.`);
    return value;
  }
  if (typeof value !== "object") throw new Error("Beat timing must contain only JSON data.");
  if (depth > MAX_SNAPSHOT_DEPTH) throw new Error("Beat timing data exceeds its nesting limit.");
  if (state.active.has(value)) throw new Error("Beat timing data must not contain cycles.");
  let isArray: boolean, keys: readonly PropertyKey[];
  try { isArray = Array.isArray(value); keys = Reflect.ownKeys(value); } catch { throw new Error("Beat timing data reflection failed."); }
  const keyLimit = isArray ? MAX_MOTION_BEAT_TIMING_SEGMENTS + 1 : MAX_SNAPSHOT_RECORD_KEYS;
  if (keys.length > keyLimit) throw new Error(`Beat timing data exceeds the ${keyLimit}-field ${isArray ? "array" : "record"} limit.`);
  if (state.keys + keys.length > MAX_SNAPSHOT_TOTAL_KEYS) throw new Error(`Beat timing data exceeds the ${MAX_SNAPSHOT_TOTAL_KEYS}-field aggregate limit.`);
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value); } catch { throw new Error("Beat timing data reflection failed."); }
  if (prototype !== (isArray ? Array.prototype : Object.prototype) && prototype !== null) throw new Error("Beat timing must contain only plain data objects and arrays.");
  if (keys.some((key) => typeof key !== "string")) throw new Error("Beat timing data must not contain symbol fields.");
  if (state.nodes >= MAX_SNAPSHOT_NODES) throw new Error(`Beat timing data exceeds the ${MAX_SNAPSHOT_NODES}-node limit.`);
  state.active.add(value); state.nodes += 1; state.keys += keys.length;
  try { return isArray ? cloneArray(value, keys, state, depth) : cloneRecord(value, keys, state, depth); } finally { state.active.delete(value); }
}

function cloneRecord(value: object, keys: readonly PropertyKey[], state: SnapshotState, depth: number): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = readDescriptor(value, key);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Beat timing data.${String(key)} must be an enumerable data field.`);
    Object.defineProperty(snapshot, key, { value: cloneData(descriptor.value, state, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return snapshot;
}

function cloneArray(value: object, keys: readonly PropertyKey[], state: SnapshotState, depth: number): unknown[] {
  const lengthDescriptor = readDescriptor(value, "length");
  if (!("value" in lengthDescriptor) || lengthDescriptor.enumerable || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_MOTION_BEAT_TIMING_SEGMENTS) throw new Error(`Beat timing arrays must have length 0..${MAX_MOTION_BEAT_TIMING_SEGMENTS}.`);
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1 || !keys.includes("length")) throw new Error("Beat timing arrays must be dense and contain no extension fields.");
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) throw new Error("Beat timing arrays must be dense and contain no extension fields.");
    const descriptor = readDescriptor(value, key);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Beat timing data.${key} must be an enumerable data field.`);
    Object.defineProperty(snapshot, index, { value: cloneData(descriptor.value, state, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return snapshot;
}

function readDescriptor(value: object, key: PropertyKey): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) throw new Error("missing");
    return descriptor;
  } catch { throw new Error("Beat timing data reflection failed."); }
}
