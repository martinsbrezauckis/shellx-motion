/** Exact transport intents for persisted relation-actions@2 authoring and materialization. */
import {
  readMotionRelationActionApplyRequest,
  readMotionRelationActionDefinitionRemove,
  readMotionRelationActionDefinitionUpsert,
  type MotionRelationActionApplyRequest,
  type MotionRelationActionDefinition,
} from "@shellx-motion/core";
import { readStrictDataRecordEnvelope } from "./timeline-strict-data.js";

export const TIMELINE_RELATION_ACTION_COMMANDS = {
  inspect: "motion.timeline.relation-actions.inspect",
  upsert: "motion.timeline.relation-actions.upsert",
  remove: "motion.timeline.relation-actions.remove",
  apply: "motion.timeline.relation-actions.apply",
} as const;

export type TimelineRelationActionCommand = typeof TIMELINE_RELATION_ACTION_COMMANDS[keyof typeof TIMELINE_RELATION_ACTION_COMMANDS];
export type TimelineRelationActionEditTransport = { packageRoot: string; outDir: string; createdBy?: string };
export type TimelineRelationActionIntent =
  | { kind: "inspect"; packageRoot: string }
  | { kind: "upsert"; edit: TimelineRelationActionEditTransport; definition: MotionRelationActionDefinition }
  | { kind: "remove"; edit: TimelineRelationActionEditTransport; definitionId: string }
  | { kind: "apply"; edit: TimelineRelationActionEditTransport; expectedPackageId: string; expectedPackageManifestSha256: string; request: MotionRelationActionApplyRequest };
export type TimelineRelationActionIntentParseResult = { ok: true; intent: TimelineRelationActionIntent } | { ok: false; problem: string };

const EDIT_KEYS = ["packageRoot", "outDir", "packageDir", "createdBy"] as const;
const SHA256 = /^[a-f0-9]{64}$/;

export function isTimelineRelationActionCommand(command: string): command is TimelineRelationActionCommand {
  return Object.values(TIMELINE_RELATION_ACTION_COMMANDS).includes(command as TimelineRelationActionCommand);
}

/**
 * The semantic values stay opaque until the accepted Core readers see them. This keeps Core's
 * tighter per-branch descriptor limits ahead of any generic Debug data traversal and precedes
 * every package-loader/output interaction.
 */
export function readTimelineRelationActionIntent(command: string, args: unknown): TimelineRelationActionIntentParseResult | null {
  if (!isTimelineRelationActionCommand(command)) return null;
  const opaque = command === TIMELINE_RELATION_ACTION_COMMANDS.upsert ? ["definition"]
    : command === TIMELINE_RELATION_ACTION_COMMANDS.remove ? ["id"]
      : command === TIMELINE_RELATION_ACTION_COMMANDS.apply ? ["request"] : [];
  const envelope = readStrictDataRecordEnvelope(args, "Arguments", allowedKeys(command), opaque);
  if (!envelope.ok) return envelope;
  const input = envelope.value;
  const packageRoot = requiredString(input.packageRoot, "packageRoot");
  if (!packageRoot.ok) return packageRoot;
  if (command === TIMELINE_RELATION_ACTION_COMMANDS.inspect) return parsed({ kind: "inspect", packageRoot: packageRoot.value });
  const edit = readEditTransport(input, packageRoot.value);
  if (!edit.ok) return edit;
  try {
    if (command === TIMELINE_RELATION_ACTION_COMMANDS.upsert) {
      if (!Object.hasOwn(input, "definition")) return fail("definition is required.");
      return parsed({ kind: "upsert", edit: edit.value, definition: readMotionRelationActionDefinitionUpsert({ definition: input.definition }) });
    }
    if (command === TIMELINE_RELATION_ACTION_COMMANDS.remove) {
      if (!Object.hasOwn(input, "id")) return fail("id is required.");
      return parsed({ kind: "remove", edit: edit.value, definitionId: readMotionRelationActionDefinitionRemove({ id: input.id }) });
    }
    if (!Object.hasOwn(input, "request")) return fail("request is required.");
    const expectedPackageId = requiredString(input.expectedPackageId, "expectedPackageId");
    if (!expectedPackageId.ok) return expectedPackageId;
    if (typeof input.expectedPackageManifestSha256 !== "string" || !SHA256.test(input.expectedPackageManifestSha256)) {
      return fail("expectedPackageManifestSha256 must be lowercase SHA-256.");
    }
    return parsed({
      kind: "apply", edit: edit.value, expectedPackageId: expectedPackageId.value,
      expectedPackageManifestSha256: input.expectedPackageManifestSha256,
      request: readMotionRelationActionApplyRequest(input.request),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Relation action arguments are invalid.");
  }
}

function allowedKeys(command: TimelineRelationActionCommand): readonly string[] {
  if (command === TIMELINE_RELATION_ACTION_COMMANDS.inspect) return ["packageRoot"];
  if (command === TIMELINE_RELATION_ACTION_COMMANDS.upsert) return [...EDIT_KEYS, "definition"];
  if (command === TIMELINE_RELATION_ACTION_COMMANDS.remove) return [...EDIT_KEYS, "id"];
  return [...EDIT_KEYS, "expectedPackageId", "expectedPackageManifestSha256", "request"];
}
function readEditTransport(input: Record<string, unknown>, packageRoot: string): Parsed<TimelineRelationActionEditTransport> {
  const outDir = Object.hasOwn(input, "outDir") ? requiredString(input.outDir, "outDir") : ok(undefined);
  const packageDir = Object.hasOwn(input, "packageDir") ? requiredString(input.packageDir, "packageDir") : ok(undefined);
  if (!outDir.ok || !packageDir.ok) return firstProblem(outDir, packageDir);
  if (!outDir.value && !packageDir.value) return fail("outDir is required.");
  if (outDir.value && packageDir.value && outDir.value !== packageDir.value) return fail("outDir and packageDir must match when both are supplied.");
  if (Object.hasOwn(input, "createdBy") && (typeof input.createdBy !== "string" || !input.createdBy.trim())) return fail("createdBy must be a non-empty string when supplied.");
  return ok({ packageRoot, outDir: outDir.value ?? packageDir.value!, ...(Object.hasOwn(input, "createdBy") ? { createdBy: input.createdBy as string } : {}) });
}
function requiredString(value: unknown, label: string): Parsed<string> { return typeof value === "string" && value.trim() ? ok(value) : fail(`${label} must be a non-empty string.`); }
type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };
function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function parsed(intent: TimelineRelationActionIntent): { ok: true; intent: TimelineRelationActionIntent } { return { ok: true, intent }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
function firstProblem(...values: Parsed<unknown>[]): { ok: false; problem: string } { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? fail("Invalid relation action edit transport."); }
