import { isSupportedMotionColorString } from "./color";
import { MAX_POINT_COORDINATE, MAX_POINT_SIZE, type MotionPoint, type MotionPointSamplePosition } from "./motion-points";

const MAX_POINT_INPUT_DEPTH = 32;
const MAX_POINT_INPUT_ARRAY_ITEMS = 512;
const MAX_POINT_INPUT_OBJECT_FIELDS = 512;

type PointInputData = null | boolean | number | string | PointInputArray | PointInputRecord;
interface PointInputArray extends Array<PointInputData> {}
interface PointInputRecord { [key: string]: PointInputData; }

/** Exact clone boundary for direct Core point operations; it never reads a caller-owned getter. */
export function readExactPointOperationInput(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  const record = readPointDataRecord(value, label);
  for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${label} does not support ${key}.`);
  return record;
}

export function normalizePointBase(value: unknown, label: string): MotionPoint {
  const point = readPointDataRecord(value, label);
  rejectUnknownKeys(point, ["x", "y", "color", "size", "opacity"], label);
  const normalized: MotionPoint = { x: coordinate(point.x, `${label}.x`), y: coordinate(point.y, `${label}.y`) };
  if (point.color !== undefined) {
    if (typeof point.color !== "string" || !isSupportedMotionColorString(point.color)) throw new Error(`${label}.color must be a supported static color string.`);
    normalized.color = point.color;
  }
  if (point.size !== undefined) normalized.size = pointSize(point.size, `${label}.size`);
  if (point.opacity !== undefined) normalized.opacity = unit(point.opacity, `${label}.opacity`);
  return normalized;
}

export function normalizePointSamplePositions(value: MotionPointSamplePosition[] | undefined, sampleCount: number): MotionPointSamplePosition[] | undefined {
  if (value === undefined) return undefined;
  const positions = readPointDataArray(value, "samplePositions");
  if (positions.length !== sampleCount) throw new Error(`samplePositions must contain exactly ${sampleCount} entries in authored sample order.`);
  return positions.map((position, index) => normalizePointSample(position, `samplePositions[${index}]`));
}

function normalizePointSample(value: unknown, label: string): MotionPointSamplePosition {
  const point = readPointDataRecord(value, label);
  rejectUnknownKeys(point, ["x", "y", "size", "opacity"], label);
  const normalized: MotionPointSamplePosition = { x: coordinate(point.x, `${label}.x`), y: coordinate(point.y, `${label}.y`) };
  if (point.size !== undefined) normalized.size = pointSize(point.size, `${label}.size`);
  if (point.opacity !== undefined) normalized.opacity = unit(point.opacity, `${label}.opacity`);
  return normalized;
}

function readPointDataRecord(value: unknown, label: string): Record<string, unknown> {
  const cloned = clonePointInput(value, label);
  if (Array.isArray(cloned) || typeof cloned !== "object" || cloned === null) throw new Error(`${label} must be a plain data object.`);
  return cloned;
}

function readPointDataArray(value: unknown, label: string): PointInputData[] {
  const cloned = clonePointInput(value, label);
  if (!Array.isArray(cloned)) throw new Error(`${label} must be an array.`);
  return cloned;
}

function clonePointInput(value: unknown, label: string): PointInputData {
  try {
    return cloneData(value, label, new WeakSet<object>(), 0);
  } catch (error) {
    if (error instanceof PointInputError) throw error;
    throw new Error(`${label} must be plain JSON data.`);
  }
}

function cloneData(value: unknown, label: string, ancestors: WeakSet<object>, depth: number): PointInputData {
  if (depth > MAX_POINT_INPUT_DEPTH) throw problem(`${label} exceeds the ${MAX_POINT_INPUT_DEPTH}-level data depth limit.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw problem(`${label} must be a finite number.`);
    return value;
  }
  if (Array.isArray(value)) return cloneArray(value, label, ancestors, depth);
  if (typeof value === "object") return cloneRecord(value, label, ancestors, depth);
  throw problem(`${label} must be JSON data.`);
}

function cloneRecord(value: object, label: string, ancestors: WeakSet<object>, depth: number): PointInputRecord {
  if (ancestors.has(value)) throw problem(`${label} must not contain cycles.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw problem(`${label} must be a plain data object.`);
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    const stringKeys: string[] = [];
    for (const key of keys) {
      if (typeof key !== "string") throw problem(`${label} must not contain symbol keys.`);
      stringKeys.push(key);
    }
    if (stringKeys.length > MAX_POINT_INPUT_OBJECT_FIELDS) throw problem(`${label} exceeds the ${MAX_POINT_INPUT_OBJECT_FIELDS}-field data limit.`);
    const clone = Object.create(null) as PointInputRecord;
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable) throw problem(`${label}.${key} must contain enumerable data properties only.`);
      if (!("value" in descriptor)) throw problem(`${label}.${key} must contain data properties only.`);
      Object.defineProperty(clone, key, { value: cloneData(descriptor.value, `${label}.${key}`, ancestors, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function cloneArray(value: unknown[], label: string, ancestors: WeakSet<object>, depth: number): PointInputArray {
  if (ancestors.has(value)) throw problem(`${label} must not contain cycles.`);
  ancestors.add(value);
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_POINT_INPUT_ARRAY_ITEMS) throw problem(`${label} exceeds the ${MAX_POINT_INPUT_ARRAY_ITEMS}-item data limit.`);
    const keys = Reflect.ownKeys(value);
    const stringKeys: string[] = [];
    for (const key of keys) {
      if (typeof key !== "string") throw problem(`${label} must not contain symbol keys.`);
      stringKeys.push(key);
    }
    if (stringKeys.length !== length + 1 || stringKeys.some((key) => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
      throw problem(`${label} must be a dense data array without extension fields.`);
    }
    const clone: PointInputArray = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw problem(`${label}[${index}] must be a data value.`);
      clone.push(cloneData(descriptor.value, `${label}[${index}]`, ancestors, depth + 1));
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} does not support ${key}.`);
}
function coordinate(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_POINT_COORDINATE) throw new Error(`${label} must be a finite number between -${MAX_POINT_COORDINATE} and ${MAX_POINT_COORDINATE}.`);
  return value;
}
function pointSize(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_POINT_SIZE) throw new Error(`${label} must be a finite number greater than 0 and at most ${MAX_POINT_SIZE}.`);
  return value;
}
function unit(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite number between 0 and 1.`);
  return value;
}
class PointInputError extends Error {}
function problem(message: string): PointInputError { return new PointInputError(message); }
