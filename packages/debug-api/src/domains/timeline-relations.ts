/** Exact, hostile-data-safe transport intents for document-root relations@1. */
import {
  MAX_MOTION_RELATION_DURATION_US,
  readMotionRelationUpsertBinding,
  type MotionRelationBinding,
} from "@shellx-motion/core";
import { readStrictDataRecord, readStrictDataRecordEnvelope } from "./timeline-strict-data.js";

export const TIMELINE_RELATION_COMMANDS = {
  inspect: "motion.timeline.relations.inspect",
  upsert: "motion.timeline.relations.upsert",
  enabled: "motion.timeline.relations.enabled.set",
  remove: "motion.timeline.relations.remove",
  detach: "motion.timeline.relations.detach",
  bake: "motion.timeline.relations.bake",
} as const;

export type TimelineRelationCommand = typeof TIMELINE_RELATION_COMMANDS[keyof typeof TIMELINE_RELATION_COMMANDS];
export type TimelineRelationEditTransport = { packageRoot: string; outDir: string; createdBy?: string };
export type TimelineRelationIntent =
  | { kind: "inspect"; packageRoot: string; atUs?: number }
  | { kind: "upsert"; edit: TimelineRelationEditTransport; binding: MotionRelationBinding }
  | { kind: "enabled"; edit: TimelineRelationEditTransport; id: string; enabled: boolean }
  | { kind: "remove" | "detach"; edit: TimelineRelationEditTransport; id: string }
  | { kind: "bake"; edit: TimelineRelationEditTransport; id: string; sampleEveryUs: number };
export type TimelineRelationIntentParseResult = { ok: true; intent: TimelineRelationIntent } | { ok: false; problem: string };

const EDIT_KEYS = ["packageRoot", "outDir", "packageDir", "createdBy"] as const;

export function isTimelineRelationCommand(command: string): command is TimelineRelationCommand {
  return Object.values(TIMELINE_RELATION_COMMANDS).includes(command as TimelineRelationCommand);
}

/** All command data is bounded before a loader can observe a package path or create output. */
export function readTimelineRelationIntent(command: string, args: unknown): TimelineRelationIntentParseResult | null {
  if (!isTimelineRelationCommand(command)) return null;
  const envelope = readStrictDataRecordEnvelope(args, "Arguments", allowedKeys(command), command === TIMELINE_RELATION_COMMANDS.upsert ? ["binding"] : []);
  if (!envelope.ok) return envelope;
  const input = envelope.value;
  const packageRoot = requiredString(input.packageRoot, "packageRoot");
  if (!packageRoot.ok) return packageRoot;
  if (command === TIMELINE_RELATION_COMMANDS.inspect) {
    if (!Object.hasOwn(input, "atUs")) return parsed({ kind: "inspect", packageRoot: packageRoot.value });
    const atUs = legacyMilliseconds(input.atUs, "atUs", false, Number.MAX_SAFE_INTEGER);
    return atUs.ok ? parsed({ kind: "inspect", packageRoot: packageRoot.value, atUs: atUs.value }) : atUs;
  }
  const edit = readEditTransport(input, packageRoot.value);
  if (!edit.ok) return edit;
  if (command === TIMELINE_RELATION_COMMANDS.upsert) {
    if (!Object.hasOwn(input, "binding")) return fail("binding is required.");
    const binding = readStrictDataRecord(input.binding, "binding");
    if (!binding.ok) return binding;
    try { return parsed({ kind: "upsert", edit: edit.value, binding: readMotionRelationUpsertBinding(binding.value) }); }
    catch (error) { return fail(error instanceof Error ? error.message : "binding must be one exact Motion relation record."); }
  }
  const id = requiredString(input.id, "id");
  if (!id.ok) return id;
  if (command === TIMELINE_RELATION_COMMANDS.enabled) {
    return typeof input.enabled === "boolean"
      ? parsed({ kind: "enabled", edit: edit.value, id: id.value, enabled: input.enabled })
      : fail("enabled must be boolean.");
  }
  if (command === TIMELINE_RELATION_COMMANDS.remove) return parsed({ kind: "remove", edit: edit.value, id: id.value });
  if (command === TIMELINE_RELATION_COMMANDS.detach) return parsed({ kind: "detach", edit: edit.value, id: id.value });
  const sampleEveryUs = legacyMilliseconds(input.sampleEveryUs, "sampleEveryUs", true);
  return sampleEveryUs.ok ? parsed({ kind: "bake", edit: edit.value, id: id.value, sampleEveryUs: sampleEveryUs.value }) : sampleEveryUs;
}

function allowedKeys(command: TimelineRelationCommand): readonly string[] {
  if (command === TIMELINE_RELATION_COMMANDS.inspect) return ["packageRoot", "atUs"];
  if (command === TIMELINE_RELATION_COMMANDS.upsert) return [...EDIT_KEYS, "binding"];
  if (command === TIMELINE_RELATION_COMMANDS.enabled) return [...EDIT_KEYS, "id", "enabled"];
  if (command === TIMELINE_RELATION_COMMANDS.bake) return [...EDIT_KEYS, "id", "sampleEveryUs"];
  return [...EDIT_KEYS, "id"];
}
function readEditTransport(input: Record<string, unknown>, packageRoot: string): Parsed<TimelineRelationEditTransport> {
  const outDir = Object.hasOwn(input, "outDir") ? requiredString(input.outDir, "outDir") : ok(undefined);
  const packageDir = Object.hasOwn(input, "packageDir") ? requiredString(input.packageDir, "packageDir") : ok(undefined);
  if (!outDir.ok || !packageDir.ok) return firstProblem(outDir, packageDir);
  if (!outDir.value && !packageDir.value) return fail("outDir is required.");
  if (outDir.value && packageDir.value && outDir.value !== packageDir.value) return fail("outDir and packageDir must match when both are supplied.");
  if (Object.hasOwn(input, "createdBy") && (typeof input.createdBy !== "string" || !input.createdBy.trim())) return fail("createdBy must be a non-empty string when supplied.");
  return ok({ packageRoot, outDir: outDir.value ?? packageDir.value!, ...(Object.hasOwn(input, "createdBy") ? { createdBy: input.createdBy as string } : {}) });
}
function legacyMilliseconds(value: unknown, label: string, positive = false, maximum = MAX_MOTION_RELATION_DURATION_US): Parsed<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > maximum || value % 1_000 !== 0) {
    return fail(`${label} must be a ${positive ? "positive " : "non-negative "}safe integer whole-millisecond-representable microsecond value within 0..${maximum}.`);
  }
  return ok(value);
}
function requiredString(value: unknown, label: string): Parsed<string> { return typeof value === "string" && value.trim() ? ok(value) : fail(`${label} must be a non-empty string.`); }
type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };
function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function parsed(intent: TimelineRelationIntent): { ok: true; intent: TimelineRelationIntent } { return { ok: true, intent }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
function firstProblem(...values: Parsed<unknown>[]): { ok: false; problem: string } { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? fail("Invalid relation intent."); }
