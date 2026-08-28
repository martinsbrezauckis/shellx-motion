/** Exact, data-only transport intents for document-root behaviors@1 authoring. */
import { readMotionBehaviorUpsertBinding } from "@shellx-motion/core";
import { readStrictDataRecord, readStrictDataRecordEnvelope } from "./timeline-strict-data.js";

export const TIMELINE_BEHAVIOR_COMMANDS = {
  inspect: "motion.timeline.behaviors.inspect",
  upsert: "motion.timeline.behaviors.upsert",
  remove: "motion.timeline.behaviors.remove",
} as const;

export type TimelineBehaviorCommand = typeof TIMELINE_BEHAVIOR_COMMANDS[keyof typeof TIMELINE_BEHAVIOR_COMMANDS];
export type TimelineBehaviorEditTransport = { packageRoot: string; outDir: string; createdBy?: string };
export type TimelineBehaviorIntent =
  | { kind: "inspect"; packageRoot: string }
  | { kind: "upsert"; edit: TimelineBehaviorEditTransport; binding: unknown }
  | { kind: "remove"; edit: TimelineBehaviorEditTransport; targetLayerId: string };
export type TimelineBehaviorIntentParseResult = { ok: true; intent: TimelineBehaviorIntent } | { ok: false; problem: string };

const EDIT_KEYS = ["packageRoot", "outDir", "packageDir", "createdBy"] as const;

export function isTimelineBehaviorCommand(command: string): command is TimelineBehaviorCommand {
  return Object.values(TIMELINE_BEHAVIOR_COMMANDS).includes(command as TimelineBehaviorCommand);
}

/**
 * Every envelope is descriptor-first and command-bounded before package I/O. Binding semantics
 * stay Core-owned, but its data is detached here so hostile transport values cannot reach a loader.
 */
export function readTimelineBehaviorIntent(command: string, args: unknown): TimelineBehaviorIntentParseResult | null {
  if (!isTimelineBehaviorCommand(command)) return null;
  const allowed = allowedKeys(command);
  const envelope = readStrictDataRecordEnvelope(
    args,
    "Arguments",
    allowed,
    command === TIMELINE_BEHAVIOR_COMMANDS.upsert ? ["binding"] : [],
  );
  if (!envelope.ok) return envelope;
  const input = envelope.value;
  const packageRoot = requiredString(input.packageRoot, "packageRoot");
  if (!packageRoot.ok) return packageRoot;
  if (command === TIMELINE_BEHAVIOR_COMMANDS.inspect) return parsedIntent({ kind: "inspect", packageRoot: packageRoot.value });
  const edit = readEditTransport(input, packageRoot.value);
  if (!edit.ok) return edit;
  if (command === TIMELINE_BEHAVIOR_COMMANDS.remove) {
    const targetLayerId = requiredString(input.targetLayerId, "targetLayerId");
    return targetLayerId.ok ? parsedIntent({ kind: "remove", edit: edit.value, targetLayerId: targetLayerId.value }) : targetLayerId;
  }
  if (!Object.hasOwn(input, "binding")) return fail("binding is required.");
  const binding = readStrictDataRecord(input.binding, "binding");
  if (!binding.ok) return binding;
  try {
    return parsedIntent({ kind: "upsert", edit: edit.value, binding: readMotionBehaviorUpsertBinding(binding.value) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "binding must be an exact Motion behavior record.");
  }
}

function allowedKeys(command: TimelineBehaviorCommand): readonly string[] {
  if (command === TIMELINE_BEHAVIOR_COMMANDS.inspect) return ["packageRoot"];
  return command === TIMELINE_BEHAVIOR_COMMANDS.upsert ? [...EDIT_KEYS, "binding"] : [...EDIT_KEYS, "targetLayerId"];
}

function readEditTransport(input: Record<string, unknown>, packageRoot: string): Parsed<TimelineBehaviorEditTransport> {
  const outDir = Object.hasOwn(input, "outDir") ? requiredString(input.outDir, "outDir") : ok(undefined);
  const packageDir = Object.hasOwn(input, "packageDir") ? requiredString(input.packageDir, "packageDir") : ok(undefined);
  if (!outDir.ok || !packageDir.ok) return firstProblem(outDir, packageDir);
  if (!outDir.value && !packageDir.value) return fail("outDir is required.");
  if (outDir.value && packageDir.value && outDir.value !== packageDir.value) return fail("outDir and packageDir must match when both are supplied.");
  if (Object.hasOwn(input, "createdBy") && (typeof input.createdBy !== "string" || !input.createdBy.trim())) {
    return fail("createdBy must be a non-empty string when supplied.");
  }
  return ok({ packageRoot, outDir: outDir.value ?? packageDir.value!, ...(Object.hasOwn(input, "createdBy") ? { createdBy: input.createdBy as string } : {}) });
}

function requiredString(value: unknown, label: string): Parsed<string> {
  return typeof value === "string" && value.trim().length > 0 ? ok(value) : fail(`${label} must be a non-empty string.`);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };
function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function parsedIntent(intent: TimelineBehaviorIntent): { ok: true; intent: TimelineBehaviorIntent } { return { ok: true, intent }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
function firstProblem(...values: Parsed<unknown>[]): { ok: false; problem: string } { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? fail("Invalid behavior edit transport."); }
