/** Exact, data-only intents for bounded point-cloud authoring. */
import type { MotionPoint, MotionPointSamplePosition } from "@shellx-motion/core";
import { readStrictDataRecord } from "./timeline-strict-data.js";

export const TIMELINE_POINT_COMMANDS = {
  rangeInspect: "motion.timeline.points.range.inspect",
  trajectoryInspect: "motion.timeline.points.trajectory.inspect",
  upsert: "motion.timeline.points.point.upsert",
  move: "motion.timeline.points.point.move",
  delete: "motion.timeline.points.point.delete",
  rangeDelete: "motion.timeline.points.point.range.delete",
} as const;

export type TimelinePointCommand = typeof TIMELINE_POINT_COMMANDS[keyof typeof TIMELINE_POINT_COMMANDS];
export type TimelinePointIntent =
  | { kind: "range-inspect"; layerId: string; startIndex: number; endIndexExclusive: number }
  | { kind: "trajectory-inspect"; layerId: string; index: number }
  | { kind: "upsert"; layerId: string; index: number; insert?: boolean; point: MotionPoint; samplePositions?: MotionPointSamplePosition[] }
  | { kind: "move"; layerId: string; fromIndex: number; toIndex: number }
  | { kind: "delete"; layerId: string; index: number }
  | { kind: "range-delete"; layerId: string; startIndex: number; endIndexExclusive: number };

export type TimelinePointIntentParseResult = { ok: true; intent: TimelinePointIntent } | { ok: false; problem: string };

const MUTATION_COMMON_KEYS = ["packageRoot", "outDir", "packageDir", "receiptsRoot", "createdBy"];

export function isTimelinePointCommand(command: string): command is TimelinePointCommand {
  return Object.values(TIMELINE_POINT_COMMANDS).includes(command as TimelinePointCommand);
}

/** All hostile argument values refuse before the package loader or copy-on-write sink is reached. */
export function readTimelinePointIntent(command: string, args: unknown): TimelinePointIntentParseResult | null {
  if (!isTimelinePointCommand(command)) return null;
  try {
    const input = strictRecord(args, "Arguments");
    if (!input.ok) return input;
    const unknown = unknownKey(input.value, allowedArgumentKeys(command));
    if (unknown) return fail(`Unknown argument: ${unknown}.`);
    if (command === TIMELINE_POINT_COMMANDS.rangeInspect || command === TIMELINE_POINT_COMMANDS.rangeDelete) return rangeIntent(input.value, command === TIMELINE_POINT_COMMANDS.rangeInspect ? "range-inspect" : "range-delete");
    if (command === TIMELINE_POINT_COMMANDS.trajectoryInspect || command === TIMELINE_POINT_COMMANDS.delete) return indexIntent(input.value, command === TIMELINE_POINT_COMMANDS.trajectoryInspect ? "trajectory-inspect" : "delete");
    if (command === TIMELINE_POINT_COMMANDS.move) return moveIntent(input.value);
    return upsertIntent(input.value);
  } catch {
    return fail("Arguments must be plain JSON data.");
  }
}

function rangeIntent(input: Record<string, unknown>, kind: "range-inspect" | "range-delete"): TimelinePointIntentParseResult {
  return withLayer(input, (layerId) => {
    const startIndex = nonNegativeInteger(input.startIndex, "startIndex");
    const endIndexExclusive = nonNegativeInteger(input.endIndexExclusive, "endIndexExclusive");
    if (!startIndex.ok || !endIndexExclusive.ok) return firstProblem(startIndex, endIndexExclusive);
    if (endIndexExclusive.value <= startIndex.value) return fail("endIndexExclusive must be greater than startIndex for the half-open [startIndex, endIndexExclusive) range.");
    return { kind, layerId, startIndex: startIndex.value, endIndexExclusive: endIndexExclusive.value };
  });
}

function indexIntent(input: Record<string, unknown>, kind: "trajectory-inspect" | "delete"): TimelinePointIntentParseResult {
  return withLayer(input, (layerId) => {
    const index = nonNegativeInteger(input.index, "index");
    return index.ok ? { kind, layerId, index: index.value } : index;
  });
}

function moveIntent(input: Record<string, unknown>): TimelinePointIntentParseResult {
  return withLayer(input, (layerId) => {
    const fromIndex = nonNegativeInteger(input.fromIndex, "fromIndex");
    const toIndex = nonNegativeInteger(input.toIndex, "toIndex");
    if (!fromIndex.ok || !toIndex.ok) return firstProblem(fromIndex, toIndex);
    if (fromIndex.value === toIndex.value) return fail("fromIndex and toIndex must differ for a stable point move.");
    return { kind: "move", layerId, fromIndex: fromIndex.value, toIndex: toIndex.value };
  });
}

function upsertIntent(input: Record<string, unknown>): TimelinePointIntentParseResult {
  return withLayer(input, (layerId) => {
    const index = nonNegativeInteger(input.index, "index");
    const point = readBasePoint(input.point, "point");
    if (!index.ok || !point.ok) return firstProblem(index, point);
    let insert: boolean | undefined;
    if (Object.hasOwn(input, "insert")) {
      if (typeof input.insert !== "boolean") return fail("insert must be a boolean when supplied.");
      insert = input.insert;
    }
    let samplePositions: MotionPointSamplePosition[] | undefined;
    if (Object.hasOwn(input, "samplePositions")) {
      if (!Array.isArray(input.samplePositions)) return fail("samplePositions must be an array.");
      samplePositions = [];
      for (let at = 0; at < input.samplePositions.length; at += 1) {
        if (!Object.hasOwn(input.samplePositions, at)) return fail(`samplePositions[${at}] must be present.`);
        const sample = readSamplePosition(input.samplePositions[at], `samplePositions[${at}]`);
        if (!sample.ok) return sample;
        samplePositions.push(sample.value);
      }
    }
    return { kind: "upsert", layerId, index: index.value, point: point.value, ...(insert === undefined ? {} : { insert }), ...(samplePositions === undefined ? {} : { samplePositions }) };
  });
}

function readBasePoint(value: unknown, label: string): Parsed<MotionPoint> {
  const point = strictRecord(value, label);
  if (!point.ok) return point;
  const unknown = unknownKey(point.value, ["x", "y", "color", "size", "opacity"]);
  if (unknown) return fail(`${label} has unknown field ${unknown}.`);
  const coordinates = coordinatePair(point.value, label);
  if (!coordinates.ok) return coordinates;
  if (Object.hasOwn(point.value, "color") && typeof point.value.color !== "string") return fail(`${label}.color must be a string.`);
  if (Object.hasOwn(point.value, "size") && !finiteNumber(point.value.size)) return fail(`${label}.size must be a finite number.`);
  if (Object.hasOwn(point.value, "opacity") && !finiteNumber(point.value.opacity)) return fail(`${label}.opacity must be a finite number.`);
  return ok({ ...coordinates.value, ...(typeof point.value.color === "string" ? { color: point.value.color } : {}), ...(typeof point.value.size === "number" ? { size: point.value.size } : {}), ...(typeof point.value.opacity === "number" ? { opacity: point.value.opacity } : {}) });
}

function readSamplePosition(value: unknown, label: string): Parsed<MotionPointSamplePosition> {
  const point = strictRecord(value, label);
  if (!point.ok) return point;
  const unknown = unknownKey(point.value, ["x", "y", "size", "opacity"]);
  if (unknown) return fail(`${label} has unknown field ${unknown}.`);
  const coordinates = coordinatePair(point.value, label);
  if (!coordinates.ok) return coordinates;
  if (Object.hasOwn(point.value, "size") && !finiteNumber(point.value.size)) return fail(`${label}.size must be a finite number.`);
  if (Object.hasOwn(point.value, "opacity") && !finiteNumber(point.value.opacity)) return fail(`${label}.opacity must be a finite number.`);
  return ok({ ...coordinates.value, ...(typeof point.value.size === "number" ? { size: point.value.size } : {}), ...(typeof point.value.opacity === "number" ? { opacity: point.value.opacity } : {}) });
}

function coordinatePair(input: Record<string, unknown>, label: string): Parsed<{ x: number; y: number }> {
  if (!finiteNumber(input.x)) return fail(`${label}.x must be a finite number.`);
  if (!finiteNumber(input.y)) return fail(`${label}.y must be a finite number.`);
  return ok({ x: input.x, y: input.y });
}

function withLayer(input: Record<string, unknown>, next: (layerId: string) => TimelinePointIntent | TimelinePointIntentParseResult): TimelinePointIntentParseResult {
  const layerId = typeof input.layerId === "string" && input.layerId.trim().length > 0 ? input.layerId : null;
  if (!layerId) return fail("layerId must be a non-empty string.");
  const result = next(layerId);
  return "ok" in result ? result : { ok: true, intent: result };
}

function strictRecord(value: unknown, label: string): Parsed<Record<string, unknown>> { return readStrictDataRecord(value, label); }

function allowedArgumentKeys(command: TimelinePointCommand): string[] {
  if (command === TIMELINE_POINT_COMMANDS.rangeInspect) return ["packageRoot", "layerId", "startIndex", "endIndexExclusive"];
  if (command === TIMELINE_POINT_COMMANDS.trajectoryInspect) return ["packageRoot", "layerId", "index"];
  const common = [...MUTATION_COMMON_KEYS, "layerId"];
  if (command === TIMELINE_POINT_COMMANDS.upsert) return [...common, "index", "insert", "point", "samplePositions"];
  if (command === TIMELINE_POINT_COMMANDS.move) return [...common, "fromIndex", "toIndex"];
  if (command === TIMELINE_POINT_COMMANDS.delete) return [...common, "index"];
  return [...common, "startIndex", "endIndexExclusive"];
}

function unknownKey(input: Record<string, unknown>, allowed: readonly string[]): string | null { return Object.getOwnPropertyNames(input).find((key) => !allowed.includes(key)) ?? null; }
function finiteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function nonNegativeInteger(value: unknown, label: string): Parsed<number> { return finiteNumber(value) && Number.isInteger(value) && value >= 0 ? ok(value) : fail(`${label} must be a non-negative integer.`); }
type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };
function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
function firstProblem(...values: Parsed<unknown>[]): { ok: false; problem: string } { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? fail("Invalid point intent."); }
