import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { GPU_SCENE_PATH_FLATTEN_TOLERANCE, GPU_SCENE_PATH_MAX_CURVE_DEPTH, GPU_SCENE_PATH_MAX_VERTICES } from "./gpu-scene-path-contract";
import { MOTION_SHAPE_GEOMETRY_SCHEMA, resolveMotionShapeGeometry } from "./motion-shape-geometry";
import { quantizePointValue } from "./motion-points";
import { readEasingValidationError, resolveEasing } from "./timeline";
import type { MotionEasing, MotionLayer, MotionShapeGeometry, MotionShapeGeometryViewBox } from "./types";

/** Private, data-only Core ABI for a closed v1 path-follow sample. */
export const MOTION_PATH_FOLLOW_SCHEMA = "shellx-motion/path-follow@1" as const;
export const MAX_MOTION_PATH_FOLLOW_INPUT_BYTES = 16 * 1024;
export const MAX_MOTION_PATH_FOLLOW_SEGMENTS = GPU_SCENE_PATH_MAX_VERTICES;

export interface MotionPathFollowTransformIntent { x: number; y: number; rotation?: number }
export interface MotionPathFollowBudget {
  inputBytes: number;
  vertexCount: number;
  segmentCount: number;
  workUnits: number;
  limits: { maxInputBytes: typeof MAX_MOTION_PATH_FOLLOW_INPUT_BYTES; maxSegments: typeof MAX_MOTION_PATH_FOLLOW_SEGMENTS; flattenTolerance: typeof GPU_SCENE_PATH_FLATTEN_TOLERANCE; maxCurveDepth: typeof GPU_SCENE_PATH_MAX_CURVE_DEPTH };
}
export interface MotionPathFollowEvaluation {
  schema: typeof MOTION_PATH_FOLLOW_SCHEMA;
  atUs: number;
  localUs: number;
  phaseUs: number;
  transform: MotionPathFollowTransformIntent;
  pathFingerprint: string;
  sourceSha256: string;
  budget: MotionPathFollowBudget;
  fingerprint: string;
}
export type MotionPathFollowResult = { ok: true; evaluation: MotionPathFollowEvaluation } | { ok: false; message: string };

interface PathFollowInput {
  atUs: number;
  startUs: number;
  durationUs: number;
  offsetUs: number;
  direction: "forward" | "reverse";
  orientToPath: boolean;
  easing?: MotionEasing;
  geometry: Extract<MotionShapeGeometry, { kind: "path" }>;
}
interface PathPoint { x: number; y: number }
interface PathSegment { from: PathPoint; to: PathPoint; length: number; end: number }

/**
 * Samples a closed v1 path at an exact local microsecond. The only geometry
 * authority is resolveMotionShapeGeometry: this leaf consumes its bounded,
 * already-flattened contour and never reparses SVG or mutates a runtime graph.
 */
export function evaluateMotionPathFollow(value: unknown): MotionPathFollowResult {
  try {
    const input = readInput(value);
    const source = canonicalInput(input);
    const inputBytes = Buffer.byteLength(canonicalJson(source), "utf8");
    if (inputBytes > MAX_MOTION_PATH_FOLLOW_INPUT_BYTES) throw new Error(`Path follow exceeds the ${MAX_MOTION_PATH_FOLLOW_INPUT_BYTES}-byte input limit.`);
    const localUs = input.atUs - input.startUs;
    if (localUs < 0 || localUs > input.durationUs) throw new Error("Path follow atUs must fall inside its closed [startUs, startUs + durationUs] interval.");
    const path = resolveClosedPath(input.geometry);
    const segments = buildSegments(path.vertices);
    if (segments.length > MAX_MOTION_PATH_FOLLOW_SEGMENTS) throw new Error(`Path follow exceeds the ${MAX_MOTION_PATH_FOLLOW_SEGMENTS}-segment work limit.`);
    const totalLength = segments.at(-1)!.end;
    if (!Number.isFinite(totalLength) || totalLength <= 0) throw new Error("Path follow has a degenerate total path length.");
    const rawProgress = localUs / input.durationUs;
    const easedProgress = resolveEasing(input.easing)(rawProgress);
    if (!Number.isFinite(easedProgress)) throw new Error("Path follow easing produced a non-finite progress.");
    const signedUs = (input.direction === "forward" ? easedProgress : -easedProgress) * input.durationUs;
    if (!Number.isFinite(signedUs)) throw new Error("Path follow produced a non-finite local phase.");
    const phaseUs = modulo(signedUs + input.offsetUs, input.durationUs);
    const sampled = sampleSegments(segments, totalLength * (phaseUs / input.durationUs));
    const transform = Object.freeze({ x: quantized(sampled.x, "x"), y: quantized(sampled.y, "y"), ...(input.orientToPath ? { rotation: quantized(Math.atan2(sampled.tangent.y, sampled.tangent.x) * 180 / Math.PI, "rotation") } : {}) });
    const budget = Object.freeze({
      inputBytes,
      vertexCount: path.vertices.length,
      segmentCount: segments.length,
      workUnits: segments.length,
      limits: Object.freeze({ maxInputBytes: MAX_MOTION_PATH_FOLLOW_INPUT_BYTES, maxSegments: MAX_MOTION_PATH_FOLLOW_SEGMENTS, flattenTolerance: GPU_SCENE_PATH_FLATTEN_TOLERANCE, maxCurveDepth: GPU_SCENE_PATH_MAX_CURVE_DEPTH })
    });
    const pathFingerprint = canonicalJsonSha256({ schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "path", viewBox: path.viewBox, vertices: path.vertices });
    const base = { schema: MOTION_PATH_FOLLOW_SCHEMA, atUs: input.atUs, localUs, phaseUs, transform, pathFingerprint, sourceSha256: canonicalJsonSha256(source), budget };
    return { ok: true, evaluation: Object.freeze({ ...base, fingerprint: canonicalJsonSha256(base) }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Path follow could not be evaluated." };
  }
}

function readInput(value: unknown): PathFollowInput {
  const record = exactRecord(value, ["schema", "geometry", "atUs", "startUs", "durationUs", "offsetUs", "direction", "orientToPath", "easing"], "Path follow");
  if (record.schema !== MOTION_PATH_FOLLOW_SCHEMA) throw new Error(`Path follow schema must equal ${MOTION_PATH_FOLLOW_SCHEMA}.`);
  const atUs = safeUs(record.atUs, "Path follow atUs"), startUs = safeUs(record.startUs, "Path follow startUs"), durationUs = positiveUs(record.durationUs, "Path follow durationUs");
  if (!Number.isSafeInteger(startUs + durationUs)) throw new Error("Path follow startUs plus durationUs exceeds safe integer microseconds.");
  const offsetUs = Object.hasOwn(record, "offsetUs") ? safeUs(record.offsetUs, "Path follow offsetUs") : 0;
  if (offsetUs >= durationUs) throw new Error("Path follow offsetUs must be less than durationUs.");
  const direction = Object.hasOwn(record, "direction") ? record.direction : "forward";
  if (direction !== "forward" && direction !== "reverse") throw new Error("Path follow direction must be forward or reverse.");
  const orientToPath = Object.hasOwn(record, "orientToPath") ? record.orientToPath : false;
  if (typeof orientToPath !== "boolean") throw new Error("Path follow orientToPath must be boolean.");
  const easing = Object.hasOwn(record, "easing") ? readEasing(record.easing, "Path follow easing") : undefined;
  return { atUs, startUs, durationUs, offsetUs, direction, orientToPath, ...(easing === undefined ? {} : { easing }), geometry: readPathGeometry(record.geometry) };
}

function readPathGeometry(value: unknown): Extract<MotionShapeGeometry, { kind: "path" }> {
  const record = exactRecord(value, ["schema", "kind", "viewBox", "data"], "Path follow geometry");
  if (record.schema !== MOTION_SHAPE_GEOMETRY_SCHEMA || record.kind !== "path") throw new Error("Path follow geometry must be a v1 path record.");
  if (typeof record.data !== "string") throw new Error("Path follow geometry data must be a string.");
  const viewBox = readViewBox(record.viewBox, "Path follow geometry viewBox");
  return { schema: MOTION_SHAPE_GEOMETRY_SCHEMA, kind: "path", viewBox, data: record.data };
}

function readViewBox(value: unknown, label: string): MotionShapeGeometryViewBox {
  const record = exactRecord(value, ["x", "y", "width", "height"], label);
  return { x: finite(record.x, `${label}.x`), y: finite(record.y, `${label}.y`), width: finite(record.width, `${label}.width`), height: finite(record.height, `${label}.height`) };
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
    type: "spring", stiffness: finite(record.stiffness, `${label}.stiffness`), damping: finite(record.damping, `${label}.damping`),
    ...(Object.hasOwn(record, "mass") ? { mass: finite(record.mass, `${label}.mass`) } : {}),
    ...(Object.hasOwn(record, "initialVelocity") ? { initialVelocity: finite(record.initialVelocity, `${label}.initialVelocity`) } : {})
  };
  const problem = readEasingValidationError(easing);
  if (problem) throw new Error(`${label} ${problem}.`);
  return easing;
}

function resolveClosedPath(geometry: Extract<MotionShapeGeometry, { kind: "path" }>): { viewBox: MotionShapeGeometryViewBox; vertices: PathPoint[] } {
  const layer = { id: "path-follow", type: "shape", startMs: 0, durationMs: 1, geometry } as MotionLayer;
  const resolved = resolveMotionShapeGeometry(layer);
  if (!resolved.ok || resolved.geometry.source !== "v1" || resolved.geometry.kind !== "path" || !resolved.geometry.closed) throw new Error(`Path follow geometry ${resolved.ok ? "must resolve as a closed v1 path" : resolved.message}`);
  return { viewBox: { ...resolved.geometry.viewBox }, vertices: resolved.geometry.vertices.map((vertex) => ({ x: vertex.x, y: vertex.y })) };
}

function buildSegments(vertices: readonly PathPoint[]): PathSegment[] {
  if (vertices.length < 3) throw new Error("Path follow requires at least three closed-path vertices.");
  const segments: PathSegment[] = []; let total = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const from = vertices[index], to = vertices[(index + 1) % vertices.length];
    const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length <= 0) throw new Error(`Path follow has a degenerate tangent at segment ${index}.`);
    total += length;
    if (!Number.isFinite(total)) throw new Error("Path follow accumulated a non-finite path length.");
    segments.push({ from, to, length, end: total });
  }
  return segments;
}

function sampleSegments(segments: readonly PathSegment[], distance: number): { x: number; y: number; tangent: PathPoint } {
  if (!Number.isFinite(distance) || distance < 0) throw new Error("Path follow distance is non-finite.");
  let start = 0;
  for (const segment of segments) {
    if (distance < segment.end) {
      const progress = (distance - start) / segment.length;
      const x = segment.from.x + (segment.to.x - segment.from.x) * progress, y = segment.from.y + (segment.to.y - segment.from.y) * progress;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Path follow generated a non-finite transform.");
      return { x, y, tangent: { x: segment.to.x - segment.from.x, y: segment.to.y - segment.from.y } };
    }
    start = segment.end;
  }
  throw new Error("Path follow distance escaped its bounded contour.");
}

function canonicalInput(input: PathFollowInput): Record<string, unknown> {
  return { schema: MOTION_PATH_FOLLOW_SCHEMA, geometry: input.geometry, atUs: input.atUs, startUs: input.startUs, durationUs: input.durationUs, offsetUs: input.offsetUs, direction: input.direction, orientToPath: input.orientToPath, ...(input.easing === undefined ? {} : { easing: input.easing }) };
}
function modulo(value: number, modulus: number): number { const result = value % modulus; const normalized = result < 0 ? result + modulus : result; return Object.is(normalized, -0) ? 0 : normalized; }
function quantized(value: number, label: string): number { if (!Number.isFinite(value)) throw new Error(`Path follow ${label} is non-finite.`); return quantizePointValue(value); }
function safeUs(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer microsecond.`); return value; }
function positiveUs(value: unknown, label: string): number { const result = safeUs(value, label); if (result === 0) throw new Error(`${label} must be positive.`); return result; }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`); return Object.is(value, -0) ? 0 : value; }

function exactRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  const record = dataRecord(value, label), names = Object.getOwnPropertyNames(record);
  const unknown = names.find((name) => !allowed.includes(name));
  if (unknown) throw new Error(`${label} has unknown field '${unknown}'.`);
  for (const key of allowed) if (!Object.hasOwn(record, key) && key !== "offsetUs" && key !== "direction" && key !== "orientToPath" && key !== "easing" && key !== "mass" && key !== "initialVelocity") throw new Error(`${label} requires ${key}.`);
  return record;
}
function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw new Error(`${label} must be a plain object.`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`);
  return value as Record<string, unknown>;
}
