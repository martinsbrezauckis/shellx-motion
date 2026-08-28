import { parseGpuScenePathContour } from "./gpu-scene-path-parser";
import { validateAndTriangulateGpuScenePath } from "./gpu-scene-path-tessellation";
import { readGpuSceneStrokeDash } from "./gpu-scene-stroke-dash";
import type { GpuScenePathBox, GpuScenePathGeometryFailure, GpuScenePathVertex } from "./gpu-scene-path-contract";
import { parseMotionPathViewBox } from "./path-contract";
import type { MotionLayer } from "./types";
import { MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA, evaluateMotionShapeGeometryKeyframes } from "./motion-shape-geometry-keyframes";

/** The only admitted authored-geometry record in the initial primitive slice. */
export const MOTION_SHAPE_GEOMETRY_SCHEMA = "shellx-motion/shape-geometry@1" as const;
export const MAX_MOTION_SHAPE_GEOMETRY_COORDINATE = 1_000_000;
export const MAX_MOTION_SHAPE_GEOMETRY_POINTS = 128;
export const MAX_MOTION_SHAPE_GEOMETRY_PATH_BYTES = 16 * 1024;
export const MAX_MOTION_SHAPE_GEOMETRY_ARC_SEGMENTS = 64;
export const MOTION_SHAPE_GEOMETRY_DECIMALS = 6;

export type MotionShapeGeometryKind = "line" | "polyline" | "polygon" | "arc" | "sector" | "path";
export interface ResolvedMotionShapeGeometry {
  source: "v1" | "legacy";
  kind: MotionShapeGeometryKind | "legacy-path";
  viewBox: GpuScenePathBox;
  closed: boolean;
  vertices: readonly GpuScenePathVertex[];
}
export type MotionShapeGeometryResolution = { ok: true; geometry: ResolvedMotionShapeGeometry } | GpuScenePathGeometryFailure;
export interface MotionShapeGeometryValidationIssue { path: string; message: string }

/**
 * Resolves one exact v1 record, or the legacy `shape: path|freeform` seam, to
 * the one bounded contour form used by the GPU path contract. It never accepts
 * both sources because choosing one would silently discard authored geometry.
 */
export function resolveMotionShapeGeometry(layer: MotionLayer): MotionShapeGeometryResolution {
  const record = layer as unknown as Record<string, unknown>;
  const hasGeometry = Object.hasOwn(record, "geometry");
  if (hasGeometry) {
    for (const key of ["shape", "x-path", "x-path-viewBox", "x-path-fillRule"] as const) {
      if (Object.hasOwn(record, key)) return fail(`Shape layer ${layer.id} cannot combine geometry with legacy ${key} geometry.`);
    }
    return resolveV1Geometry(record.geometry, layer.id);
  }
  return resolveLegacyPathGeometry(layer);
}

/** Runtime semantic authority for exact keys, bounds, degeneracy, and topology. */
export function validateMotionShapeGeometryLayers(layers: unknown[], issues: MotionShapeGeometryValidationIssue[]): void {
  layers.forEach((candidate, index) => {
    const layer = asRecord(candidate);
    if (!layer || (!Object.hasOwn(layer, "geometry") && !Object.hasOwn(layer, "geometryKeyframes"))) return;
    const path = `/layers/${index}/geometry`;
    if (layer.type !== "shape") {
      if (Object.hasOwn(layer, "geometry")) issues.push({ path, message: "is supported only on shape layers" });
      if (Object.hasOwn(layer, "geometryKeyframes")) issues.push({ path: `/layers/${index}/geometryKeyframes`, message: "is supported only on shape layers" });
      return;
    }
    if (!Object.hasOwn(layer, "geometry")) {
      if (Object.hasOwn(layer, "geometryKeyframes")) issues.push({ path: `/layers/${index}/geometryKeyframes`, message: "requires an owning v1 geometry record" });
      return;
    }
    const resolution = resolveMotionShapeGeometry(layer as unknown as MotionLayer);
    if (!resolution.ok) {
      issues.push({ path, message: resolution.message });
      return;
    }
    if (resolution.geometry.source !== "v1") {
      issues.push({ path, message: "must use a v1 geometry record when present" });
      return;
    }
    const styleProblem = validateOpenMotionShapeGeometryStyle(layer as unknown as MotionLayer, resolution.geometry);
    if (styleProblem) issues.push({ path, message: styleProblem });
    const style = asRecord(layer.style);
    const dash = readGpuSceneStrokeDash(style, `Shape ${String(layer.id ?? index)}`);
    if (!dash.ok) issues.push({ path, message: dash.message });
    else if (dash.dash && (!style || typeof style.stroke !== "string" || style.stroke.trim().length === 0)) {
      issues.push({ path, message: `Shape ${String(layer.id ?? index)} strokeDasharray requires an explicit supported visible stroke.` });
    }
    if (Object.hasOwn(layer, "geometryKeyframes")) {
      const problem = validateMotionShapeGeometryKeyframesForGeometry(layer.geometryKeyframes, layer.geometry);
      if (problem) issues.push({ path: `/layers/${index}/geometryKeyframes`, message: problem });
    }
  });
}

/** Validates the persisted source and proves its fixed topology against the owning static v1 record. */
export function validateMotionShapeGeometryKeyframesForGeometry(value: unknown, geometry: unknown): string | null {
  try {
    const keyframes = geometryKeyframeRecord(value);
    const sampled = evaluateMotionShapeGeometryKeyframes({ schema: keyframes.schema, atUs: 0, keyframes: keyframes.keyframes });
    if (!sampled.ok) return sampled.message;
    // Reuse the evaluator's exact topology authority rather than maintaining a second path parser.
    const compatible = evaluateMotionShapeGeometryKeyframes({
      schema: MOTION_SHAPE_GEOMETRY_KEYFRAMES_SCHEMA,
      atUs: 0,
      keyframes: [{ atUs: 0, geometry }, { atUs: 1, geometry: sampled.evaluation.geometry }],
    });
    return compatible.ok ? null : compatible.message;
  } catch (error) {
    return error instanceof Error ? error.message : "Geometry keyframes could not be validated.";
  }
}

/** Open v1 contours have no fill realization: require an explicit Core-supported stroke. */
export function validateOpenMotionShapeGeometryStyle(layer: MotionLayer, geometry: ResolvedMotionShapeGeometry): string | null {
  if (geometry.source !== "v1" || geometry.closed) return null;
  const style = asRecord(layer.style) ?? {};
  if (layer.fill !== undefined || layer.color !== undefined || style.fill !== undefined || style.color !== undefined) return `Shape ${geometry.kind} ${layer.id} is stroke-only and refuses authored fill.`;
  if (layer.gradient !== undefined) return `Shape ${geometry.kind} ${layer.id} is stroke-only and refuses gradients.`;
  if (typeof style.stroke !== "string" || style.stroke.trim().length === 0) return `Shape ${geometry.kind} ${layer.id} requires an explicit non-empty style.stroke.`;
  const width = finite(style.strokeWidth);
  if (width === null || width <= 0 || width > 4_096) return `Shape ${geometry.kind} ${layer.id} requires finite style.strokeWidth in 0..4096.`;
  if (style.strokeLinejoin !== undefined && style.strokeLinejoin !== "miter") return `Shape ${geometry.kind} ${layer.id} supports only the exact miter stroke join.`;
  if (style.strokeLinecap !== undefined && style.strokeLinecap !== "butt") return `Shape ${geometry.kind} ${layer.id} supports only the exact butt stroke cap.`;
  return null;
}

function resolveLegacyPathGeometry(layer: MotionLayer): MotionShapeGeometryResolution {
  if (layer.shape !== "path" && layer.shape !== "freeform") {
    return fail(`GPU ${String(layer.shape)} shape ${layer.id} requires v1 geometry or a legacy path/freeform shape.`);
  }
  const path = layer["x-path"];
  if (typeof path !== "string" || path.trim().length === 0) return fail(`GPU ${String(layer.shape)} shape ${layer.id} requires a non-empty x-path string.`);
  let viewBox: GpuScenePathBox;
  try {
    const parsed = parseMotionPathViewBox(layer["x-path-viewBox"] ?? "0 0 100 100", `GPU path ${layer.id} viewBox`);
    viewBox = { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
  } catch (error) {
    return fail(error instanceof Error ? error.message : `GPU path ${layer.id} has an invalid viewBox.`);
  }
  if (layer["x-path-fillRule"] !== undefined && layer["x-path-fillRule"] !== "nonzero") return fail(`GPU ${String(layer.shape)} shape ${layer.id} supports only nonzero fillRule; holes and evenodd fills are refused.`);
  const contour = parseGpuScenePathContour(path, viewBox, layer.id);
  if (!contour.ok) return contour;
  return { ok: true, geometry: { source: "legacy", kind: "legacy-path", viewBox, closed: true, vertices: contour.vertices } };
}

function resolveV1Geometry(value: unknown, layerId: string): MotionShapeGeometryResolution {
  const geometry = asRecord(value);
  if (!geometry) return fail(`Shape layer ${layerId} geometry must be an object.`);
  const kind = geometry.kind;
  if (geometry.schema !== MOTION_SHAPE_GEOMETRY_SCHEMA) return fail(`Shape layer ${layerId} geometry schema must equal ${MOTION_SHAPE_GEOMETRY_SCHEMA}.`);
  if (!isKind(kind)) return fail(`Shape layer ${layerId} geometry kind must be line, polyline, polygon, arc, sector, or path.`);
  const allowed = keysFor(kind);
  const unknown = Object.keys(geometry).find((key) => !allowed.has(key));
  if (unknown) return fail(`Shape layer ${layerId} geometry has unknown field '${unknown}'.`);
  const missing = [...allowed].find((key) => key !== "innerRadius" && !Object.hasOwn(geometry, key));
  if (missing) return fail(`Shape layer ${layerId} geometry requires ${missing}.`);
  const viewBox = readViewBox(geometry.viewBox, layerId);
  if (!viewBox.ok) return viewBox;
  if (kind === "line" || kind === "polyline" || kind === "polygon") {
    const points = readPoints(geometry.points, viewBox.value, kind, layerId);
    if (!points.ok) return points;
    if (kind === "polygon") {
      const topology = validateAndTriangulateGpuScenePath(points.vertices, viewBox.value, layerId);
      if (!topology.ok) return topology;
    }
    return { ok: true, geometry: { source: "v1", kind, viewBox: viewBox.value, closed: kind === "polygon", vertices: points.vertices } };
  }
  if (kind === "path") {
    if (typeof geometry.data !== "string" || geometry.data.trim().length === 0 || Buffer.byteLength(geometry.data, "utf8") > MAX_MOTION_SHAPE_GEOMETRY_PATH_BYTES) {
      return fail(`Shape path ${layerId} data must be a non-empty UTF-8 string up to ${MAX_MOTION_SHAPE_GEOMETRY_PATH_BYTES} bytes.`);
    }
    const contour = parseGpuScenePathContour(geometry.data, viewBox.value, layerId);
    if (!contour.ok) return contour;
    const topology = validateAndTriangulateGpuScenePath(contour.vertices, viewBox.value, layerId);
    if (!topology.ok) return topology;
    return { ok: true, geometry: { source: "v1", kind, viewBox: viewBox.value, closed: true, vertices: contour.vertices } };
  }
  const arc = readArc(geometry, viewBox.value, kind, layerId);
  if (!arc.ok) return arc;
  if (kind === "sector") {
    const topology = validateAndTriangulateGpuScenePath(arc.vertices, viewBox.value, layerId);
    if (!topology.ok) return topology;
  }
  return { ok: true, geometry: { source: "v1", kind, viewBox: viewBox.value, closed: kind === "sector", vertices: arc.vertices } };
}

function readViewBox(value: unknown, layerId: string): { ok: true; value: GpuScenePathBox } | GpuScenePathGeometryFailure {
  const viewBox = asRecord(value);
  if (!viewBox) return fail(`Shape layer ${layerId} geometry viewBox must be an object.`);
  const unknown = Object.keys(viewBox).find((key) => !["x", "y", "width", "height"].includes(key));
  if (unknown) return fail(`Shape layer ${layerId} geometry viewBox has unknown field '${unknown}'.`);
  for (const key of ["x", "y", "width", "height"] as const) if (!Object.hasOwn(viewBox, key)) return fail(`Shape layer ${layerId} geometry viewBox requires ${key}.`);
  const x = finite(viewBox.x), y = finite(viewBox.y), width = finite(viewBox.width), height = finite(viewBox.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0 || Math.abs(x) > MAX_MOTION_SHAPE_GEOMETRY_COORDINATE || Math.abs(y) > MAX_MOTION_SHAPE_GEOMETRY_COORDINATE || Math.abs(x + width) > MAX_MOTION_SHAPE_GEOMETRY_COORDINATE || Math.abs(y + height) > MAX_MOTION_SHAPE_GEOMETRY_COORDINATE) {
    return fail(`Shape layer ${layerId} geometry viewBox must have finite bounded x/y and positive bounded width/height.`);
  }
  return { ok: true, value: { x, y, width, height } };
}

function readPoints(value: unknown, viewBox: GpuScenePathBox, kind: "line" | "polyline" | "polygon", layerId: string): { ok: true; vertices: GpuScenePathVertex[] } | GpuScenePathGeometryFailure {
  if (!Array.isArray(value)) return fail(`Shape ${kind} ${layerId} points must be an array.`);
  const minimum = kind === "line" ? 2 : kind === "polyline" ? 2 : 3;
  const exact = kind === "line";
  if ((exact && value.length !== 2) || (!exact && (value.length < minimum || value.length > MAX_MOTION_SHAPE_GEOMETRY_POINTS))) {
    return fail(`Shape ${kind} ${layerId} points must contain ${exact ? "exactly 2" : `${minimum}..${MAX_MOTION_SHAPE_GEOMETRY_POINTS}`} points.`);
  }
  const vertices: GpuScenePathVertex[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const point = asRecord(value[index]);
    if (!point) return fail(`Shape ${kind} ${layerId} point ${index} must be an object.`);
    const unknown = Object.keys(point).find((key) => key !== "x" && key !== "y");
    if (unknown) return fail(`Shape ${kind} ${layerId} point ${index} has unknown field '${unknown}'.`);
    if (!Object.hasOwn(point, "x") || !Object.hasOwn(point, "y")) return fail(`Shape ${kind} ${layerId} point ${index} requires x and y.`);
    const x = finite(point.x), y = finite(point.y);
    if (x === null || y === null || Math.abs(x) > MAX_MOTION_SHAPE_GEOMETRY_COORDINATE || Math.abs(y) > MAX_MOTION_SHAPE_GEOMETRY_COORDINATE || !inside({ x, y }, viewBox)) return fail(`Shape ${kind} ${layerId} point ${index} must be finite and inside its viewBox.`);
    const vertex = { x, y };
    if (vertices.length && samePoint(vertices[vertices.length - 1], vertex)) return fail(`Shape ${kind} ${layerId} contains an adjacent duplicate point.`);
    vertices.push(vertex);
  }
  if (kind === "polygon" && samePoint(vertices[0], vertices[vertices.length - 1])) return fail(`Shape polygon ${layerId} contains an adjacent duplicate point.`);
  return { ok: true, vertices };
}

function readArc(value: Record<string, unknown>, viewBox: GpuScenePathBox, kind: "arc" | "sector", layerId: string): { ok: true; vertices: GpuScenePathVertex[] } | GpuScenePathGeometryFailure {
  const center = asRecord(value.center);
  if (!center) return fail(`Shape ${kind} ${layerId} center must be an object.`);
  const unknown = Object.keys(center).find((key) => key !== "x" && key !== "y");
  if (unknown) return fail(`Shape ${kind} ${layerId} center has unknown field '${unknown}'.`);
  const x = finite(center.x), y = finite(center.y), radius = finite(value.radius), startAngleDeg = finite(value.startAngleDeg), sweepAngleDeg = finite(value.sweepAngleDeg);
  if (x === null || y === null || radius === null || startAngleDeg === null || sweepAngleDeg === null || !inside({ x, y }, viewBox) || radius <= 0 || radius > MAX_MOTION_SHAPE_GEOMETRY_COORDINATE || Math.abs(sweepAngleDeg) > 360 || sweepAngleDeg === 0) {
    return fail(`Shape ${kind} ${layerId} requires a finite in-viewBox center, positive bounded radius, and nonzero sweepAngleDeg in -360..360.`);
  }
  if (x - radius < viewBox.x || x + radius > viewBox.x + viewBox.width || y - radius < viewBox.y || y + radius > viewBox.y + viewBox.height) return fail(`Shape ${kind} ${layerId} radius must stay inside its viewBox.`);
  const innerRadius = value.innerRadius === undefined ? 0 : finite(value.innerRadius);
  if (kind === "sector" && (innerRadius === null || innerRadius < 0 || innerRadius >= radius)) return fail(`Shape sector ${layerId} innerRadius must be finite in 0..radius (exclusive).`);
  const segments = Math.max(1, Math.ceil(Math.abs(sweepAngleDeg) * MAX_MOTION_SHAPE_GEOMETRY_ARC_SEGMENTS / 360));
  const outer = arcPoints(x, y, radius, startAngleDeg, sweepAngleDeg, segments, kind === "sector" && Math.abs(sweepAngleDeg) === 360);
  const outerProblem = generatedVerticesProblem(outer, viewBox, `Shape ${kind} ${layerId}`);
  if (outerProblem) return fail(outerProblem);
  if (kind === "arc") return { ok: true, vertices: outer };
  const inner = innerRadius! > 0
    ? arcPoints(x, y, innerRadius!, startAngleDeg + sweepAngleDeg, -sweepAngleDeg, segments, Math.abs(sweepAngleDeg) === 360)
    : [{ x: canonicalCoordinate(x), y: canonicalCoordinate(y) }];
  const vertices = [...outer, ...inner];
  const verticesProblem = generatedVerticesProblem(vertices, viewBox, `Shape sector ${layerId}`);
  if (verticesProblem) return fail(verticesProblem);
  return { ok: true, vertices };
}

function arcPoints(x: number, y: number, radius: number, startAngleDeg: number, sweepAngleDeg: number, segments: number, omitClosedEndpoint: boolean): GpuScenePathVertex[] {
  const count = omitClosedEndpoint ? segments : segments + 1;
  const start = normalizeAngle(startAngleDeg) * Math.PI / 180;
  const sweep = sweepAngleDeg * Math.PI / 180;
  return Array.from({ length: count }, (_value, index) => {
    const angle = start + sweep * index / segments;
    return { x: canonicalCoordinate(x + radius * Math.cos(angle)), y: canonicalCoordinate(y + radius * Math.sin(angle)) };
  });
}

function normalizeAngle(value: number): number {
  const normalized = ((value % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}
function canonicalCoordinate(value: number): number {
  const rounded = Number(value.toFixed(MOTION_SHAPE_GEOMETRY_DECIMALS));
  return Object.is(rounded, -0) ? 0 : rounded;
}
function keysFor(kind: MotionShapeGeometryKind): Set<string> {
  if (kind === "line" || kind === "polyline" || kind === "polygon") return new Set(["schema", "kind", "viewBox", "points"]);
  if (kind === "path") return new Set(["schema", "kind", "viewBox", "data"]);
  return new Set(["schema", "kind", "viewBox", "center", "radius", "startAngleDeg", "sweepAngleDeg", ...(kind === "sector" ? ["innerRadius"] : [])]);
}
function geometryKeyframeRecord(value: unknown): { schema: unknown; keyframes: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw new Error("Geometry keyframes record must be a plain object.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== 2 || names.some((name) => name !== "schema" && name !== "keyframes")) throw new Error("Geometry keyframes record has unknown field.");
  for (const name of names) if (!("value" in descriptors[name]!) || !descriptors[name]!.enumerable) throw new Error(`Geometry keyframes record.${name} must be an enumerable data field.`);
  if (!Object.hasOwn(value, "schema") || !Object.hasOwn(value, "keyframes")) throw new Error("Geometry keyframes record requires schema and keyframes.");
  return value as { schema: unknown; keyframes: unknown };
}
function isKind(value: unknown): value is MotionShapeGeometryKind { return value === "line" || value === "polyline" || value === "polygon" || value === "arc" || value === "sector" || value === "path"; }
function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function inside(point: GpuScenePathVertex, box: GpuScenePathBox): boolean { return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height; }
function samePoint(left: GpuScenePathVertex, right: GpuScenePathVertex): boolean { return left.x === right.x && left.y === right.y; }
function generatedVerticesProblem(vertices: readonly GpuScenePathVertex[], viewBox: GpuScenePathBox, label: string): string | null {
  if (vertices.length < 2 || vertices.length > MAX_MOTION_SHAPE_GEOMETRY_POINTS) return `${label} generated an out-of-bounds segment count.`;
  for (let index = 0; index < vertices.length; index += 1) {
    const vertex = vertices[index];
    if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y) || !inside(vertex, viewBox)) return `${label} generated a non-finite or out-of-viewBox vertex.`;
    if (index > 0 && samePoint(vertices[index - 1], vertex)) return `${label} generated an adjacent duplicate vertex; radius or sweep is too small.`;
  }
  return null;
}
function fail(message: string): GpuScenePathGeometryFailure { return { ok: false, message }; }
