/** Strict data-only intents for complete manifest-bound styled text runs. */
import { readMotionTextRuns, type MotionTextRuns } from "@shellx-motion/core";
import { readStrictDataRecord, readStrictDataRecordEnvelope } from "./timeline-strict-data.js";

export const TIMELINE_TEXT_RUNS_COMMANDS = {
  inspect: "motion.timeline.layer.text-runs.inspect",
  replace: "motion.timeline.layer.text-runs.replace",
  remove: "motion.timeline.layer.text-runs.remove",
} as const;

export type TimelineTextRunsCommand = typeof TIMELINE_TEXT_RUNS_COMMANDS[keyof typeof TIMELINE_TEXT_RUNS_COMMANDS];
export type TimelineTextRunsIntent =
  | { kind: "inspect"; layerId: string }
  | { kind: "replace"; layerId: string; textRuns: MotionTextRuns }
  | { kind: "remove"; layerId: string; expectedPlainText: string };
export type TimelineTextRunsIntentParseResult = { ok: true; intent: TimelineTextRunsIntent } | { ok: false; problem: string };

const EDIT_COMMON = ["packageRoot", "outDir", "packageDir", "receiptsRoot", "createdBy"];

export function isTimelineTextRunsCommand(command: string): command is TimelineTextRunsCommand {
  return Object.values(TIMELINE_TEXT_RUNS_COMMANDS).includes(command as TimelineTextRunsCommand);
}

/** Hostile input fails before package loading, output preparation, or a Core authoring call. */
export function readTimelineTextRunsIntent(command: string, args: unknown): TimelineTextRunsIntentParseResult | null {
  if (!isTimelineTextRunsCommand(command)) return null;
  // `textRuns` has its own 32-run descriptor-first reader. Do not send it
  // through the generic 512-item transport clone first, or a hostile array can
  // make Debug visit indexes before the product cap is checked.
  const parsed = command === TIMELINE_TEXT_RUNS_COMMANDS.replace
    ? readReplaceArgumentEnvelope(args)
    : readStrictDataRecord(args, "Arguments");
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const unknown = Object.keys(input).find((key) => !allowed(command).includes(key));
  if (unknown) return fail(`Unknown argument: ${unknown}.`);
  if (typeof input.layerId !== "string" || input.layerId.trim().length === 0) return fail("layerId must be a non-empty string.");
  if (command === TIMELINE_TEXT_RUNS_COMMANDS.inspect) return ok({ kind: "inspect", layerId: input.layerId });
  if (command === TIMELINE_TEXT_RUNS_COMMANDS.remove) {
    return typeof input.expectedPlainText === "string"
      ? ok({ kind: "remove", layerId: input.layerId, expectedPlainText: input.expectedPlainText })
      : fail("expectedPlainText must be a string.");
  }
  try {
    return ok({ kind: "replace", layerId: input.layerId, textRuns: readMotionTextRuns(input.textRuns, "textRuns") });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "textRuns must be a closed text-runs@1 record.");
  }
}

function allowed(command: TimelineTextRunsCommand): string[] {
  if (command === TIMELINE_TEXT_RUNS_COMMANDS.inspect) return ["packageRoot", "layerId"];
  if (command === TIMELINE_TEXT_RUNS_COMMANDS.replace) return [...EDIT_COMMON, "layerId", "textRuns"];
  return [...EDIT_COMMON, "layerId", "expectedPlainText"];
}

function readReplaceArgumentEnvelope(args: unknown): ReturnType<typeof readStrictDataRecord> {
  return readStrictDataRecordEnvelope(args, "Arguments", allowed(TIMELINE_TEXT_RUNS_COMMANDS.replace), ["textRuns"]);
}
function ok<T>(intent: T): { ok: true; intent: T } { return { ok: true, intent }; }
function fail(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
