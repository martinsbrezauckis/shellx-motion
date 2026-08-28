import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { MAX_MOTION_SHAPE_GEOMETRY_PATH_BYTES, MAX_MOTION_SHAPE_GEOMETRY_POINTS, MOTION_SHAPE_GEOMETRY_SCHEMA, resolveMotionShapeGeometry } from "./motion-shape-geometry";
import { readEasingValidationError, resolveEasing } from "./timeline";
import type { MotionEasing, MotionLayer, MotionShapeGeometry, MotionShapeGeometryKeyframe, MotionShapeGeometryKeyframes, MotionShapeGeometryPoint, MotionShapeGeometryViewBox } from "./types";

/** Exact, private Core ABI for fixed-topology v1 geometry snapshots. */
export const MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA = "shellx-motion/shape-geometry-keyframes@1" as const;
export const MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES = 32;
export const MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INPUT_BYTES = 64 * 1024;
export const MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INTERPOLATION_SCALARS = 1_024;
export const MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_TIME_US = 1_000_000_000_000;

export type MotionShapeGeometrySnapshotKeyframe = MotionShapeGeometryKeyframe;

export interface MotionShapeGeometrySnapshotKeyframes {
  schema: typeof MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA;
  atUs: number;
  keyframes: readonly MotionShapeGeometryKeyframe[];
}

export interface MotionShapeGeometryKeyframeBudget {
  keyframeCount: number;
  inputBytes: number;
  interpolationScalars: number;
  limits: {
    maxKeyframes: typeof MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES;
    maxInputBytes: typeof MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INPUT_BYTES;
    maxInterpolationScalars: typeof MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INTERPOLATION_SCALARS;
  };
}

export interface MotionShapeGeometryKeyframeEvaluation {
  schema: typeof MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA;
  atUs: number;
  geometry: MotionShapeGeometry;
  geometryFingerprint: string;
  sourceSequenceSha256: string;
  budget: MotionShapeGeometryKeyframeBudget;
  fingerprint: string;
}

export type MotionShapeGeometryKeyframeEvaluationResult =
  | { ok: true; evaluation: MotionShapeGeometryKeyframeEvaluation }
  | { ok: false; message: string };

interface ParsedKeyframe extends MotionShapeGeometrySnapshotKeyframe { path?: PathTemplate }
interface PreflightKeyframe { atUs: number; geometry: Record<string, unknown>; easing?: unknown }
interface PathOperation { command: string; values: number[] }
interface PathTemplate { operations: PathOperation[]; scalarCount: number }

/**
 * Evaluates fixed-topology geometry keyframes with Motion's normal segment
 * easing rules. It is deliberately a pure leaf: callers receive a new frozen
 * geometry record or a refusal; authored snapshot objects are never changed.
 */
export function evaluateMotionShapeGeometryKeyframes(input: unknown): MotionShapeGeometryKeyframeEvaluationResult {
  try {
    const request = exactRecord(input, ["schema", "atUs", "keyframes"], "Geometry keyframes");
    if (request.schema !== MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA) throw new Error(`Geometry keyframes schema must equal ${MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA}.`);
    const atUs = boundedUs(request.atUs, "Geometry keyframes atUs");
    const entries = boundedArray(request.keyframes, "Geometry keyframes keyframes", MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES);
    if (entries.length === 0 || entries.length > MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES) throw new Error(`Geometry keyframes must contain 1..${MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES} snapshots.`);
    const sourceKeyframes = entries.map((entry, index) => preflightKeyframe(entry, index));
    for (let index = 1; index < sourceKeyframes.length; index += 1) {
      if (sourceKeyframes[index - 1].atUs >= sourceKeyframes[index].atUs) throw new Error("Geometry keyframes require strictly ascending unique atUs values.");
    }
    const sourceSequence = { schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, keyframes: sourceKeyframes.map(keyframeInput) };
    const inputBytes = Buffer.byteLength(canonicalJson({ ...sourceSequence, atUs }), "utf8");
    if (inputBytes > MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INPUT_BYTES) throw new Error(`Geometry keyframes exceed the ${MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INPUT_BYTES}-byte input limit.`);
    const keyframes = sourceKeyframes.map((entry, index) => readKeyframe(entry, index));
    const scalarCount = validateFixedTopology(keyframes);
    if (scalarCount > MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INTERPOLATION_SCALARS) throw new Error(`Geometry keyframes exceed the ${MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INTERPOLATION_SCALARS}-scalar interpolation limit.`);
    const geometry = freezeGeometry(sampleGeometry(keyframes, atUs));
    assertSettledGeometry(geometry, "evaluated geometry");
    const budget = Object.freeze({
      keyframeCount: keyframes.length,
      inputBytes,
      interpolationScalars: scalarCount,
      limits: Object.freeze({
        maxKeyframes: MAX_MOTION_SHAPE_GEOMETRY_KEYFRAMES,
        maxInputBytes: MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INPUT_BYTES,
        maxInterpolationScalars: MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_INTERPOLATION_SCALARS
      })
    });
    const base = { schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, atUs, geometry, geometryFingerprint: canonicalJsonSha256(geometry), sourceSequenceSha256: canonicalJsonSha256(sourceSequence), budget };
    return { ok: true, evaluation: Object.freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Geometry keyframes could not be evaluated." };
  }
}

/** Returns a detached, frozen snapshot suitable for copy-on-write authoring. */
export function readMotionShapeGeometryKeyframe(value: unknown): MotionShapeGeometryKeyframe {
  const keyframe = readKeyframe(preflightKeyframe(value, 0), 0);
  return freezeKeyframe(keyframe);
}

function preflightKeyframe(value: unknown, index: number): PreflightKeyframe {
  const record = exactRecord(value, ["atUs", "geometry", "easing"], `Geometry keyframe ${index}`);
  const atUs = boundedUs(record.atUs, `Geometry keyframe ${index} atUs`);
  return { atUs, geometry: preflightGeometry(record.geometry, `Geometry keyframe ${index} geometry`), ...(Object.hasOwn(record, "easing") ? { easing: preflightEasing(record.easing, `Geometry keyframe ${index} easing`) } : {}) };
}

function readKeyframe(value: PreflightKeyframe, index: number): ParsedKeyframe {
  const geometry = readGeometry(value.geometry, `Geometry keyframe ${index} geometry`);
  assertSettledGeometry(geometry, `Geometry keyframe ${index} geometry`);
  const easing = value.easing === undefined ? undefined : readEasing(value.easing, `Geometry keyframe ${index} easing`);
  return { atUs: value.atUs, geometry, ...(easing === undefined ? {} : { easing }), ...(geometry.kind === "path" ? { path: readPathTemplate(geometry.data) } : {}) };
}

function keyframeInput(keyframe: { atUs: number; geometry: unknown; easing?: unknown }): { atUs: number; geometry: unknown; easing?: unknown } {
  return { atUs: keyframe.atUs, geometry: keyframe.geometry, ...(keyframe.easing === undefined ? {} : { easing: keyframe.easing }) };
}

/** Structural budget pass. It copies only bounded own-data JSON before semantic resolution. */
function preflightGeometry(value: unknown, label: string): Record<string, unknown> {
  const initial = dataRecord(value, label), kind = initial.kind;
  if (kind !== "line" && kind !== "polyline" && kind !== "polygon" && kind !== "arc" && kind !== "sector" && kind !== "path") throw new Error(`${label} kind is unsupported.`);
  const keys = kind === "line" || kind === "polyline" || kind === "polygon" ? ["schema", "kind", "viewBox", "points"] : kind === "path" ? ["schema", "kind", "viewBox", "data"] : ["schema", "kind", "viewBox", "center", "radius", "startAngleDeg", "sweepAngleDeg", ...(kind === "sector" ? ["innerRadius"] : [])];
  const record = exactRecord(initial, keys, label);
  if (kind === "path") {
    if (typeof record.data !== "string" || record.data.length > MAX_MOTION_SHAPE_GEOMETRY_PATH_BYTES || Buffer.byteLength(record.data, "utf8") > MAX_MOTION_SHAPE_GEOMETRY_PATH_BYTES) throw new Error(`${label} data exceeds the ${MAX_MOTION_SHAPE_GEOMETRY_PATH_BYTES}-byte payload limit.`);
    return { schema: record.schema, kind, viewBox: preflightViewBox(record.viewBox, `${label} viewBox`), data: record.data };
  }
  const viewBox = preflightViewBox(record.viewBox, `${label} viewBox`);
  if (kind === "line" || kind === "polyline" || kind === "polygon") {
    const points = boundedArray(record.points, `${label} points`, MAX_MOTION_SHAPE_GEOMETRY_POINTS).map((point, index) => preflightPoint(point, `${label} points[${index}]`));
    return { schema: record.schema, kind, viewBox, points };
  }
  const base = { schema: record.schema, kind, viewBox, center: preflightPoint(record.center, `${label} center`), radius: record.radius, startAngleDeg: record.startAngleDeg, sweepAngleDeg: record.sweepAngleDeg };
  return kind === "sector" && Object.hasOwn(record, "innerRadius") ? { ...base, innerRadius: record.innerRadius } : base;
}

function preflightViewBox(value: unknown, label: string): Record<string, unknown> { const record = exactRecord(value, ["x", "y", "width", "height"], label); return { x: record.x, y: record.y, width: record.width, height: record.height }; }
function preflightPoint(value: unknown, label: string): Record<string, unknown> { const record = exactRecord(value, ["x", "y"], label); return { x: record.x, y: record.y }; }
function preflightEasing(value: unknown, label: string): unknown {
  if (typeof value === "string") return value;
  const record = exactRecord(value, ["type", "stiffness", "damping", "mass", "initialVelocity"], label);
  return { type: record.type, stiffness: record.stiffness, damping: record.damping, ...(Object.hasOwn(record, "mass") ? { mass: record.mass } : {}), ...(Object.hasOwn(record, "initialVelocity") ? { initialVelocity: record.initialVelocity } : {}) };
}

function readGeometry(value: unknown, label: string): MotionShapeGeometry {
  const initial = dataRecord(value, label);
  const kind = initial.kind;
  if (kind !== "line" && kind !== "polyline" && kind !== "polygon" && kind !== "arc" && kind !== "sector" && kind !== "path") throw new Error(`${label} kind is unsupported.`);
  const keys = kind === "line" || kind === "polyline" || kind === "polygon"
    ? ["schema", "kind", "viewBox", "points"]
    : kind === "path" ? ["schema", "kind", "viewBox", "data"]
      : ["schema", "kind", "viewBox", "center", "radius", "startAngleDeg", "sweepAngleDeg", ...(kind === "sector" ? ["innerRadius"] : [])];
  const record = exactRecord(initial, keys, label);
  if (record.schema !== MOTION_SHAPE_GEOMETRY_SCHEMA) throw new Error(`${label} schema must equal ${MOTION_SHAPE_GEOMETRY_SCHEMA}.`);
  const viewBox = readViewBox(record.viewBox, `${label} viewBox`);
  if (kind === "line" || kind === "polyline" || kind === "polygon") {
    const points = exactArray(record.points, `${label} points`).map((point, index) => readPoint(point, `${label} points[${index}]`));
    return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind, viewBox, points } as MotionShapeGeometry;
  }
  if (kind === "path") {
    if (typeof record.data !== "string") throw new Error(`${label} data must be a string.`);
    return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind, viewBox, data: record.data };
  }
  const center = readPoint(record.center, `${label} center`);
  const radius = finite(record.radius, `${label} radius`), startAngleDeg = finite(record.startAngleDeg, `${label} startAngleDeg`), sweepAngleDeg = finite(record.sweepAngleDeg, `${label} sweepAngleDeg`);
  if (kind === "sector" && Object.hasOwn(record, "innerRadius")) return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind, viewBox, center, radius, startAngleDeg, sweepAngleDeg, innerRadius: finite(record.innerRadius, `${label} innerRadius`) };
  return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind, viewBox, center, radius, startAngleDeg, sweepAngleDeg } as MotionShapeGeometry;
}

function readViewBox(value: unknown, label: string): MotionShapeGeometryViewBox {
  const record = exactRecord(value, ["x", "y", "width", "height"], label);
  return { x: finite(record.x, `${label}.x`), y: finite(record.y, `${label}.y`), width: finite(record.width, `${label}.width`), height: finite(record.height, `${label}.height`) };
}

function readPoint(value: unknown, label: string): MotionShapeGeometryPoint {
  const record = exactRecord(value, ["x", "y"], label);
  return { x: finite(record.x, `${label}.x`), y: finite(record.y, `${label}.y`) };
}

function readEasing(value: unknown, label: string): MotionEasing {
  if (typeof value === "string") {
    const problem = readEasingValidationError(value);
    if (problem) throw new Error(`${label} ${problem}.`);
    return value;
  }
  const record = exactRecord(value, ["type", "stiffness", "damping", "mass", "initialVelocity"], label);
  if (record.type !== "spring") throw new Error(`${label} must be a supported easing.`);
  const easing: MotionEasing = {
    type: "spring",
    stiffness: finite(record.stiffness, `${label}.stiffness`),
    damping: finite(record.damping, `${label}.damping`),
    ...(Object.hasOwn(record, "mass") ? { mass: finite(record.mass, `${label}.mass`) } : {}),
    ...(Object.hasOwn(record, "initialVelocity") ? { initialVelocity: finite(record.initialVelocity, `${label}.initialVelocity`) } : {})
  };
  const problem = readEasingValidationError(easing);
  if (problem) throw new Error(`${label} ${problem}.`);
  return easing;
}

function validateFixedTopology(keyframes: readonly ParsedKeyframe[]): number {
  const first = keyframes[0];
  let scalarCount = interpolationScalars(first);
  for (const keyframe of keyframes.slice(1)) {
    if (keyframe.geometry.kind !== first.geometry.kind) throw new Error("Geometry keyframes require one fixed geometry kind.");
    if (!sameViewBox(keyframe.geometry.viewBox, first.geometry.viewBox)) throw new Error("Geometry keyframes require one identical viewBox.");
    if ("points" in first.geometry && "points" in keyframe.geometry && keyframe.geometry.points.length !== first.geometry.points.length) throw new Error("Geometry keyframes require one fixed point count and order.");
    if (first.geometry.kind === "sector" && keyframe.geometry.kind === "sector" && Object.hasOwn(first.geometry, "innerRadius") !== Object.hasOwn(keyframe.geometry, "innerRadius")) throw new Error("Sector geometry keyframes require matching innerRadius presence.");
    if (first.geometry.kind === "path" && keyframe.geometry.kind === "path" && !samePathTemplate(first.path!, keyframe.path!)) throw new Error("Path geometry keyframes require identical parsed command and coordinate topology.");
    if (interpolationScalars(keyframe) !== scalarCount) throw new Error("Geometry keyframes require one fixed interpolation topology.");
  }
  return scalarCount;
}

function sampleGeometry(keyframes: readonly ParsedKeyframe[], atUs: number): MotionShapeGeometry {
  const first = keyframes[0], last = keyframes[keyframes.length - 1];
  if (atUs <= first.atUs) return interpolateGeometry(first, first, 0);
  if (atUs >= last.atUs) return interpolateGeometry(last, last, 0);
  const exact = keyframes.find((keyframe) => keyframe.atUs === atUs);
  if (exact) return interpolateGeometry(exact, exact, 0);
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const left = keyframes[index], right = keyframes[index + 1];
    if (atUs < left.atUs || atUs > right.atUs) continue;
    const progress = resolveEasing(left.easing)((atUs - left.atUs) / (right.atUs - left.atUs));
    if (!Number.isFinite(progress)) throw new Error("Geometry keyframe easing produced a non-finite progress.");
    return interpolateGeometry(left, right, progress);
  }
  throw new Error("Geometry keyframes have no active segment.");
}

function interpolateGeometry(left: ParsedKeyframe, right: ParsedKeyframe, progress: number): MotionShapeGeometry {
  const geometry = left.geometry, other = right.geometry, viewBox = copyViewBox(geometry.viewBox);
  if (geometry.kind === "line" || geometry.kind === "polyline" || geometry.kind === "polygon") {
    const points = geometry.points.map((point, index) => mixPoint(point, (other as typeof geometry).points[index], progress));
    return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: geometry.kind, viewBox, points } as MotionShapeGeometry;
  }
  if (geometry.kind === "path") {
    const values = left.path!.operations.flatMap((operation) => operation.values);
    const otherValues = right.path!.operations.flatMap((operation) => operation.values);
    return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "path", viewBox, data: writePath(left.path!, values.map((value, index) => mix(value, otherValues[index], progress))) };
  }
  const arc = other as Extract<MotionShapeGeometry, { kind: "arc" | "sector" }>;
  const center = mixPoint(geometry.center, arc.center, progress);
  const fields = { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: geometry.kind, viewBox, center, radius: mix(geometry.radius, arc.radius, progress), startAngleDeg: mix(geometry.startAngleDeg, arc.startAngleDeg, progress), sweepAngleDeg: mix(geometry.sweepAngleDeg, arc.sweepAngleDeg, progress) };
  if (geometry.kind === "sector") return Object.hasOwn(geometry, "innerRadius")
    ? { ...fields, innerRadius: mix(geometry.innerRadius!, (arc as Extract<MotionShapeGeometry, { kind: "sector" }>).innerRadius!, progress) } as MotionShapeGeometry
    : fields as MotionShapeGeometry;
  return fields as MotionShapeGeometry;
}

function interpolationScalars(keyframe: ParsedKeyframe): number {
  const geometry = keyframe.geometry;
  if ("points" in geometry) return geometry.points.length * 2;
  if (geometry.kind === "path") return keyframe.path!.scalarCount;
  return geometry.kind === "sector" && Object.hasOwn(geometry, "innerRadius") ? 6 : 5;
}

function readPathTemplate(data: string): PathTemplate {
  // Geometry semantics remain owned by resolveMotionShapeGeometry -> parseGpuScenePathContour.
  // This only retains its already-admitted command/value skeleton for fixed-topology interpolation.
  const tokens = data.trim().match(/[MmLlHhVvQqCcZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6, Z: 0 };
  const operations: PathOperation[] = []; let command = "", index = 0, scalarCount = 0;
  while (index < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[index])) command = tokens[index++];
    if (!command) throw new Error("Path geometry keyframe has parameters without a command.");
    if (command === "Z" || command === "z") { operations.push({ command: command.toUpperCase(), values: [] }); command = ""; continue; }
    const count = arity[command.toUpperCase()];
    if (count === undefined || index + count > tokens.length) throw new Error("Path geometry keyframe has incomplete command parameters.");
    const values = tokens.slice(index, index + count).map(Number);
    if (values.some((item) => !Number.isFinite(item))) throw new Error("Path geometry keyframe has non-finite command parameters.");
    operations.push({ command, values }); scalarCount += values.length; index += count;
    if (command === "M") command = "L";
    if (command === "m") command = "l";
  }
  return { operations, scalarCount };
}

function writePath(template: PathTemplate, values: readonly number[]): string {
  let offset = 0;
  return template.operations.map((operation) => {
    const parameters = values.slice(offset, offset + operation.values.length); offset += operation.values.length;
    return parameters.length ? `${operation.command} ${parameters.map(pathNumber).join(" ")}` : operation.command;
  }).join(" ");
}

function samePathTemplate(left: PathTemplate, right: PathTemplate): boolean {
  return left.operations.length === right.operations.length && left.operations.every((operation, index) => operation.command === right.operations[index].command && operation.values.length === right.operations[index].values.length);
}
function sameViewBox(left: MotionShapeGeometryViewBox, right: MotionShapeGeometryViewBox): boolean { return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height; }
function mix(left: number, right: number, progress: number): number { const value = left + (right - left) * progress; return Object.is(value, -0) ? 0 : value; }
function mixPoint(left: MotionShapeGeometryPoint, right: MotionShapeGeometryPoint, progress: number): MotionShapeGeometryPoint { return { x: mix(left.x, right.x, progress), y: mix(left.y, right.y, progress) }; }
function copyViewBox(viewBox: MotionShapeGeometryViewBox): MotionShapeGeometryViewBox { return { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height }; }
function pathNumber(value: number): string { const normalized = Object.is(value, -0) ? 0 : value; return String(normalized); }

function assertSettledGeometry(geometry: MotionShapeGeometry, label: string): void {
  const layer = { id: "geometry-keyframes", type: "shape", startMs: 0, durationMs: 1, geometry } as MotionLayer;
  const result = resolveMotionShapeGeometry(layer);
  if (!result.ok || result.geometry.source !== "v1") throw new Error(`${label} ${result.ok ? "did not resolve as v1 geometry" : result.message}`);
}

function freezeGeometry(geometry: MotionShapeGeometry): MotionShapeGeometry {
  const viewBox = Object.freeze(copyViewBox(geometry.viewBox));
  if ("points" in geometry) return Object.freeze({ ...geometry, viewBox, points: Object.freeze(geometry.points.map((point) => Object.freeze({ ...point }))) }) as MotionShapeGeometry;
  if (geometry.kind === "path") return Object.freeze({ ...geometry, viewBox });
  return Object.freeze({ ...geometry, viewBox, center: Object.freeze({ ...geometry.center }) }) as MotionShapeGeometry;
}

function freezeKeyframe(keyframe: MotionShapeGeometryKeyframe): MotionShapeGeometryKeyframe {
  return Object.freeze({
    atUs: keyframe.atUs,
    geometry: freezeGeometry(keyframe.geometry),
    ...(keyframe.easing === undefined ? {} : { easing: typeof keyframe.easing === "string" ? keyframe.easing : Object.freeze({ ...keyframe.easing }) }),
  });
}

function exactRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  const record = dataRecord(value, label), names = Object.getOwnPropertyNames(record);
  const unknown = names.find((name) => !allowed.includes(name));
  if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`);
  for (const key of allowed) if (!Object.hasOwn(record, key) && key !== "easing" && key !== "mass" && key !== "initialVelocity" && key !== "innerRadius") throw new Error(`${label} requires ${key}.`);
  return record;
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw new Error(`${label} must be a plain object.`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`);
  }
  return value as Record<string, unknown>;
}

function exactArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) throw new Error(`${label} must be an array.`);
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== value.length + 1 || names.some((name) => name !== "length" && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= value.length))) throw new Error(`${label} must be a dense data array without extension fields.`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}[${index}] must be a data value.`);
  }
  return value;
}

function boundedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) throw new Error(`${label} must be an array.`);
  if (value.length > maximum) throw new Error(`${label} exceeds the ${maximum}-item payload limit.`);
  return exactArray(value, label);
}

function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`); return Object.is(value, -0) ? 0 : value; }
function boundedUs(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_TIME_US) throw new Error(`${label} must be a safe integer in 0..${MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_TIME_US} microseconds.`); return value; }
