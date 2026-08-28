/** Exact, data-only intents for v1 shape geometry authoring. */
import { MOTION_SHAPE_GEOMETRY_SCHEMA, type MotionShapeGeometry, type MotionShapeGeometryPoint } from "@shellx-motion/core";

export const TIMELINE_SHAPE_GEOMETRY_COMMANDS = {
  inspect: "motion.timeline.shape.geometry.inspect",
  replace: "motion.timeline.shape.geometry.replace",
  pointUpdate: "motion.timeline.shape.geometry.point.update",
  pointInsert: "motion.timeline.shape.geometry.point.insert",
  pointMove: "motion.timeline.shape.geometry.point.move",
  pointRangeDelete: "motion.timeline.shape.geometry.point.range.delete",
  arcUpdate: "motion.timeline.shape.geometry.arc.update",
  pathReplace: "motion.timeline.shape.geometry.path.replace",
  migrateLegacy: "motion.timeline.shape.geometry.legacy.migrate",
  dashSet: "motion.timeline.shape.geometry.dash.set",
  dashRemove: "motion.timeline.shape.geometry.dash.remove",
} as const;

export type TimelineShapeGeometryCommand = typeof TIMELINE_SHAPE_GEOMETRY_COMMANDS[keyof typeof TIMELINE_SHAPE_GEOMETRY_COMMANDS];

export type TimelineShapeGeometryIntent =
  | { kind: "inspect"; layerId: string }
  | { kind: "replace"; layerId: string; geometry: MotionShapeGeometry }
  | { kind: "point-update"; layerId: string; index: number; point: MotionShapeGeometryPoint }
  | { kind: "point-insert"; layerId: string; index: number; point: MotionShapeGeometryPoint }
  | { kind: "point-move"; layerId: string; fromIndex: number; toIndex: number }
  | { kind: "point-range-delete"; layerId: string; startIndex: number; endIndexExclusive: number }
  | { kind: "arc-update"; layerId: string; center?: MotionShapeGeometryPoint; radius?: number; innerRadius?: number; startAngleDeg?: number; sweepAngleDeg?: number }
  | { kind: "path-replace"; layerId: string; data: string }
  | { kind: "migrate-legacy"; layerId: string }
  | { kind: "dash-set"; layerId: string; strokeDasharray: number[]; strokeDashoffset?: number }
  | { kind: "dash-remove"; layerId: string };

export type TimelineShapeGeometryIntentParseResult =
  | { ok: true; intent: TimelineShapeGeometryIntent }
  | { ok: false; problem: string };

const MUTATION_COMMON_KEYS = ["packageRoot", "outDir", "packageDir", "receiptsRoot", "createdBy"];

export function isTimelineShapeGeometryCommand(command: string): command is TimelineShapeGeometryCommand {
  return Object.values(TIMELINE_SHAPE_GEOMETRY_COMMANDS).includes(command as TimelineShapeGeometryCommand);
}

/**
 * Parses every field supplied by the Debug transport before the package loader or COW sink runs.
 * Bounds, topology and final style semantics remain exclusively Core's authority.
 */
export function readTimelineShapeGeometryIntent(command: string, args: unknown): TimelineShapeGeometryIntentParseResult | null {
  if (!isTimelineShapeGeometryCommand(command)) return null;
  const input = strictRecord(args, "Arguments");
  if (!input.ok) return input;
  const unknown = unknownKey(input.value, allowedArgumentKeys(command));
  if (unknown) return fail(`Unknown argument: ${unknown}.`);
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.inspect) return withLayer(input.value, (layerId) => ({ kind: "inspect", layerId }));
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.replace) return replaceIntent(input.value);
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointUpdate) return pointIntent(input.value, "point-update");
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointInsert) return pointIntent(input.value, "point-insert");
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointMove) return moveIntent(input.value);
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointRangeDelete) return rangeDeleteIntent(input.value);
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.arcUpdate) return arcUpdateIntent(input.value);
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.pathReplace) return pathReplaceIntent(input.value);
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.dashSet) return dashSetIntent(input.value);
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.dashRemove) return withLayer(input.value, (layerId) => ({ kind: "dash-remove", layerId }));
  return withLayer(input.value, (layerId) => ({ kind: "migrate-legacy", layerId }));
}

function replaceIntent(input: Record<string, unknown>): TimelineShapeGeometryIntentParseResult {
  return withLayer(input, (layerId) => {
    const geometry = readGeometry(input.geometry);
    return geometry.ok ? { kind: "replace", layerId, geometry: geometry.value } : geometry;
  });
}

function pointIntent(input: Record<string, unknown>, kind: "point-update" | "point-insert"): TimelineShapeGeometryIntentParseResult {
  return withLayer(input, (layerId) => {
    const index = nonNegativeInteger(input.index, "index");
    const point = readPoint(input.point, "point");
    if (!index.ok || !point.ok) return firstProblem(index, point);
    return { kind, layerId, index: index.value, point: point.value };
  });
}

function moveIntent(input: Record<string, unknown>): TimelineShapeGeometryIntentParseResult {
  return withLayer(input, (layerId) => {
    const fromIndex = nonNegativeInteger(input.fromIndex, "fromIndex");
    const toIndex = nonNegativeInteger(input.toIndex, "toIndex");
    if (!fromIndex.ok || !toIndex.ok) return firstProblem(fromIndex, toIndex);
    return { kind: "point-move", layerId, fromIndex: fromIndex.value, toIndex: toIndex.value };
  });
}

function rangeDeleteIntent(input: Record<string, unknown>): TimelineShapeGeometryIntentParseResult {
  return withLayer(input, (layerId) => {
    const startIndex = nonNegativeInteger(input.startIndex, "startIndex");
    const endIndexExclusive = nonNegativeInteger(input.endIndexExclusive, "endIndexExclusive");
    if (!startIndex.ok || !endIndexExclusive.ok) return firstProblem(startIndex, endIndexExclusive);
    if (endIndexExclusive.value <= startIndex.value) return fail("endIndexExclusive must be greater than startIndex for the half-open [startIndex, endIndexExclusive) range.");
    return { kind: "point-range-delete", layerId, startIndex: startIndex.value, endIndexExclusive: endIndexExclusive.value };
  });
}

function arcUpdateIntent(input: Record<string, unknown>): TimelineShapeGeometryIntentParseResult {
  return withLayer(input, (layerId) => {
    const supplied = ["center", "radius", "innerRadius", "startAngleDeg", "sweepAngleDeg"].filter((key) => Object.hasOwn(input, key));
    if (supplied.length === 0) return fail("Arc update requires at least one changed control.");
    const center = Object.hasOwn(input, "center") ? readPoint(input.center, "center") : absent<MotionShapeGeometryPoint>();
    const radius = optionalFiniteNumber(input, "radius");
    const innerRadius = optionalFiniteNumber(input, "innerRadius");
    const startAngleDeg = optionalFiniteNumber(input, "startAngleDeg");
    const sweepAngleDeg = optionalFiniteNumber(input, "sweepAngleDeg");
    if (!center.ok || !radius.ok || !innerRadius.ok || !startAngleDeg.ok || !sweepAngleDeg.ok) return firstProblem(center, radius, innerRadius, startAngleDeg, sweepAngleDeg);
    return {
      kind: "arc-update", layerId,
      ...(center.value === undefined ? {} : { center: center.value }),
      ...(radius.value === undefined ? {} : { radius: radius.value }),
      ...(innerRadius.value === undefined ? {} : { innerRadius: innerRadius.value }),
      ...(startAngleDeg.value === undefined ? {} : { startAngleDeg: startAngleDeg.value }),
      ...(sweepAngleDeg.value === undefined ? {} : { sweepAngleDeg: sweepAngleDeg.value }),
    };
  });
}

function pathReplaceIntent(input: Record<string, unknown>): TimelineShapeGeometryIntentParseResult {
  return withLayer(input, (layerId) => typeof input.data === "string"
    ? { kind: "path-replace", layerId, data: input.data }
    : fail("data must be a string."));
}

function dashSetIntent(input: Record<string, unknown>): TimelineShapeGeometryIntentParseResult {
  return withLayer(input, (layerId) => {
    if (!Array.isArray(input.strokeDasharray) || input.strokeDasharray.length < 1 || input.strokeDasharray.length > 32) {
      return fail("strokeDasharray must be a non-empty numeric array with at most 32 items.");
    }
    const strokeDasharray: number[] = [];
    for (let index = 0; index < input.strokeDasharray.length; index += 1) {
      const value = input.strokeDasharray[index];
      if (typeof value !== "number" || !Number.isFinite(value)) return fail(`strokeDasharray[${index}] must be finite.`);
      strokeDasharray.push(value);
    }
    const strokeDashoffset = optionalFiniteNumber(input, "strokeDashoffset");
    if (!strokeDashoffset.ok) return strokeDashoffset;
    return { kind: "dash-set", layerId, strokeDasharray, ...(strokeDashoffset.value === undefined ? {} : { strokeDashoffset: strokeDashoffset.value }) };
  });
}

function withLayer(
  input: Record<string, unknown>,
  next: (layerId: string) => TimelineShapeGeometryIntent | TimelineShapeGeometryIntentParseResult,
): TimelineShapeGeometryIntentParseResult {
  const layerId = typeof input.layerId === "string" && input.layerId.trim().length > 0
    ? input.layerId
    : null;
  if (!layerId) return fail("layerId must be a non-empty string.");
  const result = next(layerId);
  return "ok" in result ? result : { ok: true, intent: result };
}

function readGeometry(value: unknown): Parsed<MotionShapeGeometry> {
  const geometry = strictRecord(value, "geometry");
  if (!geometry.ok) return geometry;
  if (geometry.value.schema !== MOTION_SHAPE_GEOMETRY_SCHEMA) return fail("geometry.schema must equal shellx-motion/shape-geometry@1.");
  const kind = geometry.value.kind;
  if (kind !== "line" && kind !== "polyline" && kind !== "polygon" && kind !== "arc" && kind !== "sector" && kind !== "path") {
    return fail("geometry.kind must be line, polyline, polygon, arc, sector, or path.");
  }
  const unknown = unknownKey(geometry.value, geometryKeys(kind));
  if (unknown) return fail(`geometry has unknown field ${unknown}.`);
  const viewBox = readViewBox(geometry.value.viewBox);
  if (!viewBox.ok) return viewBox;
  if (kind === "line" || kind === "polyline" || kind === "polygon") {
    if (!Array.isArray(geometry.value.points)) return fail("geometry.points must be an array.");
    for (let index = 0; index < geometry.value.points.length; index += 1) {
      if (!Object.hasOwn(geometry.value.points, index)) return fail(`geometry.points[${index}] must be present.`);
      const point = readPoint(geometry.value.points[index], `geometry.points[${index}]`);
      if (!point.ok) return point;
    }
  } else if (kind === "path") {
    if (typeof geometry.value.data !== "string") return fail("geometry.data must be a string.");
  } else {
    const center = readPoint(geometry.value.center, "geometry.center");
    if (!center.ok) return center;
    for (const key of ["radius", "startAngleDeg", "sweepAngleDeg"] as const) {
      if (typeof geometry.value[key] !== "number" || !Number.isFinite(geometry.value[key])) return fail(`geometry.${key} must be a finite number.`);
    }
    if (Object.hasOwn(geometry.value, "innerRadius") && (typeof geometry.value.innerRadius !== "number" || !Number.isFinite(geometry.value.innerRadius))) {
      return fail("geometry.innerRadius must be a finite number when supplied.");
    }
  }
  return ok(structuredClone(geometry.value) as unknown as MotionShapeGeometry);
}

function readViewBox(value: unknown): Parsed<Record<string, number>> {
  const viewBox = strictRecord(value, "geometry.viewBox");
  if (!viewBox.ok) return viewBox;
  const unknown = unknownKey(viewBox.value, ["x", "y", "width", "height"]);
  if (unknown) return fail(`geometry.viewBox has unknown field ${unknown}.`);
  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof viewBox.value[key] !== "number" || !Number.isFinite(viewBox.value[key])) return fail(`geometry.viewBox.${key} must be a finite number.`);
  }
  return ok(viewBox.value as Record<string, number>);
}

function readPoint(value: unknown, label: string): Parsed<MotionShapeGeometryPoint> {
  const point = strictRecord(value, label);
  if (!point.ok) return point;
  const unknown = unknownKey(point.value, ["x", "y"]);
  if (unknown) return fail(`${label} has unknown field ${unknown}.`);
  if (typeof point.value.x !== "number" || !Number.isFinite(point.value.x)) return fail(`${label}.x must be a finite number.`);
  if (typeof point.value.y !== "number" || !Number.isFinite(point.value.y)) return fail(`${label}.y must be a finite number.`);
  return ok({ x: point.value.x, y: point.value.y });
}

function strictRecord(value: unknown, label: string): Parsed<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(`${label} must be a plain data object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(`${label} must be a plain data object.`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) return fail(`${label}.${key} must be a data property.`);
    const data = strictData(descriptor.value, `${label}.${key}`);
    if (!data.ok) return data;
  }
  return ok(value as Record<string, unknown>);
}

function strictData(value: unknown, label: string): Parsed<void> {
  if (value === null || typeof value === "string" || typeof value === "boolean") return ok(undefined);
  if (typeof value === "number") return Number.isFinite(value) ? ok(undefined) : fail(`${label} must be finite.`);
  if (Array.isArray(value)) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (key === "length") continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return fail(`${label} has unsupported array property ${key}.`);
      if (!("value" in descriptor)) return fail(`${label}[${key}] must be a data property.`);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return fail(`${label}[${index}] must be present.`);
      const item = strictData(value[index], `${label}[${index}]`);
      if (!item.ok) return item;
    }
    return ok(undefined);
  }
  if (typeof value === "object") {
    const nested = strictRecord(value, label);
    return nested.ok ? ok(undefined) : nested;
  }
  return fail(`${label} must be JSON data.`);
}

function nonNegativeInteger(value: unknown, label: string): Parsed<number> {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? ok(value) : fail(`${label} must be a non-negative integer.`);
}

function optionalFiniteNumber(input: Record<string, unknown>, key: string): Parsed<number | undefined> {
  if (!Object.hasOwn(input, key)) return absent();
  return typeof input[key] === "number" && Number.isFinite(input[key]) ? ok(input[key]) : fail(`${key} must be a finite number.`);
}

function unknownKey(input: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.getOwnPropertyNames(input).find((key) => !allowed.includes(key)) ?? null;
}

function allowedArgumentKeys(command: TimelineShapeGeometryCommand): string[] {
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.inspect) return ["packageRoot", "layerId"];
  const common = [...MUTATION_COMMON_KEYS, "layerId"];
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.replace) return [...common, "geometry"];
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointUpdate || command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointInsert) return [...common, "index", "point"];
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointMove) return [...common, "fromIndex", "toIndex"];
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.pointRangeDelete) return [...common, "startIndex", "endIndexExclusive"];
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.arcUpdate) return [...common, "center", "radius", "innerRadius", "startAngleDeg", "sweepAngleDeg"];
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.pathReplace) return [...common, "data"];
  if (command === TIMELINE_SHAPE_GEOMETRY_COMMANDS.dashSet) return [...common, "strokeDasharray", "strokeDashoffset"];
  return common;
}

function geometryKeys(kind: MotionShapeGeometry["kind"]): string[] {
  if (kind === "line" || kind === "polyline" || kind === "polygon") return ["schema", "kind", "viewBox", "points"];
  if (kind === "path") return ["schema", "kind", "viewBox", "data"];
  return ["schema", "kind", "viewBox", "center", "radius", "innerRadius", "startAngleDeg", "sweepAngleDeg"];
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };
function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
function absent<T>(): { ok: true; value: T | undefined } { return ok(undefined); }
function firstProblem(...values: Parsed<unknown>[]): { ok: false; problem: string } { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? fail("Invalid geometry intent."); }
