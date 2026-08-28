/** Exact, hostile-data-safe transport intents for persisted shape geometry snapshots. */
import {
  MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_TIME_US,
  readMotionShapeGeometryKeyframe,
  type MotionShapeGeometryKeyframe,
} from "@shellx-motion/core";
import { readStrictDataRecord, readStrictDataRecordEnvelope } from "./timeline-strict-data.js";

export const TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS = {
  inspect: "motion.timeline.shape.geometry-keyframes.inspect",
  upsert: "motion.timeline.shape.geometry-keyframes.upsert",
  delete: "motion.timeline.shape.geometry-keyframes.delete",
  move: "motion.timeline.shape.geometry-keyframes.move",
} as const;

export type TimelineShapeGeometryKeyframeCommand = typeof TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS[keyof typeof TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS];
export type TimelineShapeGeometryKeyframeEditTransport = { packageRoot: string; outDir: string; createdBy?: string };
export type TimelineShapeGeometryKeyframeIntent =
  | { kind: "inspect"; packageRoot: string; layerId: string }
  | { kind: "upsert"; edit: TimelineShapeGeometryKeyframeEditTransport; layerId: string; snapshot: MotionShapeGeometryKeyframe }
  | { kind: "delete"; edit: TimelineShapeGeometryKeyframeEditTransport; layerId: string; atUs: number }
  | { kind: "move"; edit: TimelineShapeGeometryKeyframeEditTransport; layerId: string; fromAtUs: number; toAtUs: number };
export type TimelineShapeGeometryKeyframeIntentParseResult = { ok: true; intent: TimelineShapeGeometryKeyframeIntent } | { ok: false; problem: string };

const EDIT_KEYS = ["packageRoot", "outDir", "packageDir", "createdBy", "layerId"] as const;

export function isTimelineShapeGeometryKeyframeCommand(command: string): command is TimelineShapeGeometryKeyframeCommand {
  return Object.values(TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS).includes(command as TimelineShapeGeometryKeyframeCommand);
}

/** Admission completes before a package loader can observe any argument value. */
export function readTimelineShapeGeometryKeyframeIntent(command: string, args: unknown): TimelineShapeGeometryKeyframeIntentParseResult | null {
  if (!isTimelineShapeGeometryKeyframeCommand(command)) return null;
  const envelope = readStrictDataRecordEnvelope(args, "Arguments", allowedKeys(command), command === TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.upsert ? ["snapshot"] : []);
  if (!envelope.ok) return envelope;
  const input = envelope.value;
  const packageRoot = requiredString(input.packageRoot, "packageRoot");
  const layerId = requiredString(input.layerId, "layerId");
  if (!packageRoot.ok || !layerId.ok) return firstProblem(packageRoot, layerId);
  if (command === TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.inspect) return parsed({ kind: "inspect", packageRoot: packageRoot.value, layerId: layerId.value });
  const edit = readEditTransport(input, packageRoot.value);
  if (!edit.ok) return edit;
  if (command === TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.upsert) {
    if (!Object.hasOwn(input, "snapshot")) return fail("snapshot is required.");
    const snapshot = readSnapshot(input.snapshot);
    return snapshot.ok ? parsed({ kind: "upsert", edit: edit.value, layerId: layerId.value, snapshot: snapshot.value }) : snapshot;
  }
  if (command === TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.delete) {
    const atUs = microseconds(input.atUs, "atUs");
    return atUs.ok ? parsed({ kind: "delete", edit: edit.value, layerId: layerId.value, atUs: atUs.value }) : atUs;
  }
  const fromAtUs = microseconds(input.fromAtUs, "fromAtUs"), toAtUs = microseconds(input.toAtUs, "toAtUs");
  if (!fromAtUs.ok || !toAtUs.ok) return firstProblem(fromAtUs, toAtUs);
  if (fromAtUs.value === toAtUs.value) return fail("fromAtUs and toAtUs must differ for an ordered snapshot move.");
  return parsed({ kind: "move", edit: edit.value, layerId: layerId.value, fromAtUs: fromAtUs.value, toAtUs: toAtUs.value });
}

function allowedKeys(command: TimelineShapeGeometryKeyframeCommand): readonly string[] {
  if (command === TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.inspect) return ["packageRoot", "layerId"];
  if (command === TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.upsert) return [...EDIT_KEYS, "snapshot"];
  return command === TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMANDS.delete ? [...EDIT_KEYS, "atUs"] : [...EDIT_KEYS, "fromAtUs", "toAtUs"];
}
function readSnapshot(value: unknown): Parsed<MotionShapeGeometryKeyframe> {
  const snapshot = readStrictDataRecord(value, "snapshot");
  if (!snapshot.ok) return snapshot;
  try { return ok(readMotionShapeGeometryKeyframe(structuredClone(snapshot.value))); }
  catch (error) { return fail(error instanceof Error ? error.message : "snapshot must be one exact shape geometry keyframe."); }
}
function readEditTransport(input: Record<string, unknown>, packageRoot: string): Parsed<TimelineShapeGeometryKeyframeEditTransport> {
  const outDir = Object.hasOwn(input, "outDir") ? requiredString(input.outDir, "outDir") : ok(undefined);
  const packageDir = Object.hasOwn(input, "packageDir") ? requiredString(input.packageDir, "packageDir") : ok(undefined);
  if (!outDir.ok || !packageDir.ok) return firstProblem(outDir, packageDir);
  if (!outDir.value && !packageDir.value) return fail("outDir is required.");
  if (outDir.value && packageDir.value && outDir.value !== packageDir.value) return fail("outDir and packageDir must match when both are supplied.");
  if (Object.hasOwn(input, "createdBy") && (typeof input.createdBy !== "string" || !input.createdBy.trim())) return fail("createdBy must be a non-empty string when supplied.");
  return ok({ packageRoot, outDir: outDir.value ?? packageDir.value!, ...(Object.hasOwn(input, "createdBy") ? { createdBy: input.createdBy as string } : {}) });
}
function requiredString(value: unknown, label: string): Parsed<string> { return typeof value === "string" && value.trim() ? ok(value) : fail(`${label} must be a non-empty string.`); }
function microseconds(value: unknown, label: string): Parsed<number> { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_TIME_US ? ok(value) : fail(`${label} must be a safe integer microsecond within 0..${MAX_MOTION_SHAPE_GEOMETRY_KEYFRAME_TIME_US}.`); }
type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };
function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function parsed(intent: TimelineShapeGeometryKeyframeIntent): { ok: true; intent: TimelineShapeGeometryKeyframeIntent } { return { ok: true, intent }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
function firstProblem(...values: Parsed<unknown>[]): { ok: false; problem: string } { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? fail("Invalid shape geometry keyframe intent."); }
