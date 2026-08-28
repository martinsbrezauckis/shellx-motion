/** Exact data-only intents for fixed-topology gradient stop color keyframes. */
import {
  isSupportedMotionColorString,
  MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES,
  MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT,
  MAX_MOTION_GRADIENT_COLOR_KEYFRAME_TIME_US,
  MOTION_GRADIENT_COLOR_KEYFRAMES_SCHEMA,
  readEasingValidationError,
  type MotionEasing,
  type MotionGradientColorKeyframe,
} from "@shellx-motion/core";
import { readStrictDataRecord } from "./timeline-strict-data.js";

export const TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS = {
  inspect: "motion.timeline.gradient.color-keyframes.inspect",
  upsert: "motion.timeline.gradient.color-keyframes.upsert",
  delete: "motion.timeline.gradient.color-keyframes.delete",
  move: "motion.timeline.gradient.color-keyframes.move",
} as const;

export type TimelineGradientColorKeyframeCommand = typeof TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS[keyof typeof TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS];
export type TimelineGradientColorKeyframeIntent =
  | { kind: "inspect"; layerId: string }
  | { kind: "upsert"; layerId: string; snapshot: MotionGradientColorKeyframe }
  | { kind: "delete"; layerId: string; atUs: number }
  | { kind: "move"; layerId: string; fromAtUs: number; toAtUs: number };
export type TimelineGradientColorKeyframeIntentParseResult =
  | { ok: true; intent: TimelineGradientColorKeyframeIntent }
  | { ok: false; problem: string };

const MUTATION_COMMON_KEYS = ["packageRoot", "outDir", "packageDir", "receiptsRoot", "createdBy", "layerId"];

export function isTimelineGradientColorKeyframeCommand(command: string): command is TimelineGradientColorKeyframeCommand {
  return Object.values(TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS).includes(command as TimelineGradientColorKeyframeCommand);
}

/** Parses complete, hostile-data-safe arguments before package loading or COW preparation. */
export function readTimelineGradientColorKeyframeIntent(command: string, args: unknown): TimelineGradientColorKeyframeIntentParseResult | null {
  if (!isTimelineGradientColorKeyframeCommand(command)) return null;
  const input = strictRecord(args, "Arguments");
  if (!input.ok) return input;
  const unknown = unknownKey(input.value, allowedArgumentKeys(command));
  if (unknown) return fail(`Unknown argument: ${unknown}.`);
  const layerId = nonEmptyString(input.value.layerId, "layerId");
  if (!layerId.ok) return layerId;
  if (command === TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.inspect) return parsedIntent({ kind: "inspect", layerId: layerId.value });
  if (command === TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.upsert) {
    const snapshot = readSnapshot(input.value.snapshot);
    return snapshot.ok ? parsedIntent({ kind: "upsert", layerId: layerId.value, snapshot: snapshot.value }) : snapshot;
  }
  if (command === TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.delete) {
    const atUs = microseconds(input.value.atUs, "atUs");
    return atUs.ok ? parsedIntent({ kind: "delete", layerId: layerId.value, atUs: atUs.value }) : atUs;
  }
  const fromAtUs = microseconds(input.value.fromAtUs, "fromAtUs");
  const toAtUs = microseconds(input.value.toAtUs, "toAtUs");
  if (!fromAtUs.ok || !toAtUs.ok) return firstProblem(fromAtUs, toAtUs);
  if (fromAtUs.value === toAtUs.value) return fail("fromAtUs and toAtUs must differ for an ordered snapshot move.");
  return parsedIntent({ kind: "move", layerId: layerId.value, fromAtUs: fromAtUs.value, toAtUs: toAtUs.value });
}

function readSnapshot(value: unknown): Parsed<MotionGradientColorKeyframe> {
  const snapshot = strictRecord(value, "snapshot");
  if (!snapshot.ok) return snapshot;
  const exact = exactKeys(snapshot.value, ["atUs", "colors", "easing"], "snapshot", ["easing"]);
  if (!exact.ok) return exact;
  const atUs = microseconds(snapshot.value.atUs, "snapshot.atUs");
  if (!atUs.ok) return atUs;
  if (!Array.isArray(snapshot.value.colors) || snapshot.value.colors.length < 1 || snapshot.value.colors.length > MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT) {
    return fail(`snapshot.colors must contain 1..${MAX_MOTION_GRADIENT_COLOR_KEYFRAME_STOP_COUNT} colors; Core checks the existing fixed stop count.`);
  }
  const colors: string[] = [];
  for (let index = 0; index < snapshot.value.colors.length; index += 1) {
    if (!Object.hasOwn(snapshot.value.colors, index)) return fail(`snapshot.colors[${index}] must be present.`);
    const color = snapshot.value.colors[index];
    if (typeof color !== "string" || Buffer.byteLength(color, "utf8") > MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES || !isSupportedMotionColorString(color)) {
      return fail(`snapshot.colors[${index}] must be a supported color string of at most ${MAX_MOTION_GRADIENT_COLOR_KEYFRAME_COLOR_BYTES} bytes.`);
    }
    colors.push(color);
  }
  const easing = Object.hasOwn(snapshot.value, "easing") ? readEasing(snapshot.value.easing) : ok<MotionEasing | undefined>(undefined);
  if (!easing.ok) return easing;
  return ok({ atUs: atUs.value, colors, ...(easing.value === undefined ? {} : { easing: easing.value }) });
}

function readEasing(value: unknown): Parsed<MotionEasing> {
  if (typeof value === "string") {
    const problem = readEasingValidationError(value);
    return problem ? fail(`snapshot.easing ${problem}.`) : ok(value);
  }
  const easing = strictRecord(value, "snapshot.easing");
  if (!easing.ok) return easing;
  const exact = exactKeys(easing.value, ["type", "stiffness", "damping", "mass", "initialVelocity"], "snapshot.easing", ["mass", "initialVelocity"]);
  if (!exact.ok) return exact;
  if (easing.value.type !== "spring") return fail("snapshot.easing must be a supported easing.");
  for (const key of ["stiffness", "damping", "mass", "initialVelocity"] as const) {
    if (Object.hasOwn(easing.value, key) && (typeof easing.value[key] !== "number" || !Number.isFinite(easing.value[key]))) return fail(`snapshot.easing.${key} must be finite.`);
  }
  const normalized: MotionEasing = {
    type: "spring", stiffness: easing.value.stiffness as number, damping: easing.value.damping as number,
    ...(Object.hasOwn(easing.value, "mass") ? { mass: easing.value.mass as number } : {}),
    ...(Object.hasOwn(easing.value, "initialVelocity") ? { initialVelocity: easing.value.initialVelocity as number } : {}),
  };
  const problem = readEasingValidationError(normalized);
  return problem ? fail(`snapshot.easing ${problem}.`) : ok(normalized);
}

function strictRecord(value: unknown, label: string): Parsed<Record<string, unknown>> { return readStrictDataRecord(value, label); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string, optional: readonly string[] = []): Parsed<void> {
  const unknown = unknownKey(value, keys);
  if (unknown) return fail(`${label} has unknown field ${unknown}.`);
  const missing = keys.find((key) => !optional.includes(key) && !Object.hasOwn(value, key));
  return missing ? fail(`${label} requires ${missing}.`) : ok(undefined);
}
function allowedArgumentKeys(command: TimelineGradientColorKeyframeCommand): string[] {
  if (command === TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.inspect) return ["packageRoot", "layerId"];
  if (command === TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.upsert) return [...MUTATION_COMMON_KEYS, "snapshot"];
  if (command === TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.delete) return [...MUTATION_COMMON_KEYS, "atUs"];
  return [...MUTATION_COMMON_KEYS, "fromAtUs", "toAtUs"];
}
function unknownKey(input: Record<string, unknown>, allowed: readonly string[]): string | null { return Object.getOwnPropertyNames(input).find((key) => !allowed.includes(key)) ?? null; }
function nonEmptyString(value: unknown, label: string): Parsed<string> { return typeof value === "string" && value.trim() ? ok(value) : fail(`${label} must be a non-empty string.`); }
function microseconds(value: unknown, label: string): Parsed<number> { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_MOTION_GRADIENT_COLOR_KEYFRAME_TIME_US ? ok(value) : fail(`${label} must be a safe integer microsecond within 0..${MAX_MOTION_GRADIENT_COLOR_KEYFRAME_TIME_US}.`); }
type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };
function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function parsedIntent(intent: TimelineGradientColorKeyframeIntent): { ok: true; intent: TimelineGradientColorKeyframeIntent } { return { ok: true, intent }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
function firstProblem(...values: Parsed<unknown>[]): { ok: false; problem: string } { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? fail("Invalid gradient color keyframe intent."); }
