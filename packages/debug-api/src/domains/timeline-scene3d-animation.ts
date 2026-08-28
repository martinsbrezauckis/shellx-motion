/** Closed hostile-data-safe transport intents for exact persisted scene3d tracks. */
import * as Core from "@shellx-motion/core";
import type { MotionScene3DAnimationTrack } from "@shellx-motion/core";
import { readStrictDataRecord, readStrictDataRecordEnvelope } from "./timeline-strict-data.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TRANSPORT_BYTES = 256 * 1024;

export const TIMELINE_SCENE3D_ANIMATION_COMMANDS = {
  inspect: "motion.timeline.scene3d-animation.inspect",
  trackUpsert: "motion.timeline.scene3d-animation.track.upsert",
  trackRemove: "motion.timeline.scene3d-animation.track.remove",
  keyframeUpsert: "motion.timeline.scene3d-animation.keyframe.upsert",
  keyframeDelete: "motion.timeline.scene3d-animation.keyframe.delete",
  keyframeMove: "motion.timeline.scene3d-animation.keyframe.move",
} as const;

export type TimelineScene3DAnimationCommand = typeof TIMELINE_SCENE3D_ANIMATION_COMMANDS[keyof typeof TIMELINE_SCENE3D_ANIMATION_COMMANDS];
export type TimelineScene3DAnimationEditTransport = { packageRoot: string; outDir: string; createdBy?: string };
export type TimelineScene3DAnimationIntent =
  | { kind: "inspect"; packageRoot: string }
  | { kind: "track.upsert"; edit: TimelineScene3DAnimationEditTransport; track: MotionScene3DAnimationTrack }
  | { kind: "track.remove"; edit: TimelineScene3DAnimationEditTransport; trackId: string }
  | { kind: "keyframe.upsert"; edit: TimelineScene3DAnimationEditTransport; trackId: string; keyframe: Record<string, unknown> }
  | { kind: "keyframe.delete"; edit: TimelineScene3DAnimationEditTransport; trackId: string; atUs: number }
  | { kind: "keyframe.move"; edit: TimelineScene3DAnimationEditTransport; trackId: string; fromAtUs: number; toAtUs: number };
export type TimelineScene3DAnimationIntentParseResult = { ok: true; intent: TimelineScene3DAnimationIntent } | { ok: false; problem: string };

const EDIT_KEYS = ["packageRoot", "outDir", "packageDir", "createdBy"] as const;

export function isTimelineScene3DAnimationCommand(command: string): command is TimelineScene3DAnimationCommand {
  return Object.values(TIMELINE_SCENE3D_ANIMATION_COMMANDS).includes(command as TimelineScene3DAnimationCommand);
}

/** Parses all caller data and caps before a package loader/output sink is reachable. */
export function readTimelineScene3DAnimationIntent(command: string, args: unknown): TimelineScene3DAnimationIntentParseResult | null {
  if (!isTimelineScene3DAnimationCommand(command)) return null;
  const envelope = readStrictDataRecordEnvelope(args, "Arguments", allowedKeys(command), opaqueKeys(command));
  if (!envelope.ok) return envelope;
  const input = envelope.value;
  const packageRoot = string(input.packageRoot, "packageRoot");
  if (!packageRoot.ok) return packageRoot;
  if (command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.inspect) return parsed({ kind: "inspect", packageRoot: packageRoot.value });
  const edit = readEditTransport(input, packageRoot.value);
  if (!edit.ok) return edit;
  if (command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackUpsert) {
    const track = trackDraft(input.track);
    return track.ok ? parsed({ kind: "track.upsert", edit: edit.value, track: track.value }) : track;
  }
  const trackId = id(input.trackId, "trackId");
  if (!trackId.ok) return trackId;
  if (command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackRemove) return parsed({ kind: "track.remove", edit: edit.value, trackId: trackId.value });
  if (command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.keyframeUpsert) {
    const keyframe = strictRecord(input.keyframe, "keyframe");
    return keyframe.ok ? parsed({ kind: "keyframe.upsert", edit: edit.value, trackId: trackId.value, keyframe: keyframe.value }) : keyframe;
  }
  if (command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.keyframeDelete) {
    const atUs = microseconds(input.atUs, "atUs");
    return atUs.ok ? parsed({ kind: "keyframe.delete", edit: edit.value, trackId: trackId.value, atUs: atUs.value }) : atUs;
  }
  const fromAtUs = microseconds(input.fromAtUs, "fromAtUs");
  const toAtUs = microseconds(input.toAtUs, "toAtUs");
  if (!fromAtUs.ok || !toAtUs.ok) return firstProblem(fromAtUs, toAtUs);
  if (fromAtUs.value === toAtUs.value) return fail("fromAtUs and toAtUs must differ for an exact scene3d keyframe move.");
  return parsed({ kind: "keyframe.move", edit: edit.value, trackId: trackId.value, fromAtUs: fromAtUs.value, toAtUs: toAtUs.value });
}

function allowedKeys(command: TimelineScene3DAnimationCommand): readonly string[] {
  if (command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.inspect) return ["packageRoot"];
  if (command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackUpsert) return [...EDIT_KEYS, "track"];
  if (command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackRemove) return [...EDIT_KEYS, "trackId"];
  if (command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.keyframeUpsert) return [...EDIT_KEYS, "trackId", "keyframe"];
  if (command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.keyframeDelete) return [...EDIT_KEYS, "trackId", "atUs"];
  return [...EDIT_KEYS, "trackId", "fromAtUs", "toAtUs"];
}
function opaqueKeys(command: TimelineScene3DAnimationCommand): readonly string[] {
  return command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackUpsert ? ["track"]
    : command === TIMELINE_SCENE3D_ANIMATION_COMMANDS.keyframeUpsert ? ["keyframe"] : [];
}
function readEditTransport(input: Record<string, unknown>, packageRoot: string): Parsed<TimelineScene3DAnimationEditTransport> {
  const outDir = Object.hasOwn(input, "outDir") ? string(input.outDir, "outDir") : ok(undefined);
  const packageDir = Object.hasOwn(input, "packageDir") ? string(input.packageDir, "packageDir") : ok(undefined);
  if (!outDir.ok || !packageDir.ok) return firstProblem(outDir, packageDir);
  if (!outDir.value && !packageDir.value) return fail("outDir is required.");
  if (outDir.value && packageDir.value && outDir.value !== packageDir.value) return fail("outDir and packageDir must match when both are supplied.");
  const createdBy = Object.hasOwn(input, "createdBy") ? string(input.createdBy, "createdBy") : ok(undefined);
  if (!createdBy.ok) return createdBy;
  return ok({ packageRoot, outDir: outDir.value ?? packageDir.value!, ...(createdBy.value === undefined ? {} : { createdBy: createdBy.value }) });
}
function trackDraft(value: unknown): Parsed<MotionScene3DAnimationTrack> {
  const raw = strictRecord(value, "track");
  if (!raw.ok) return raw;
  try { return ok(Core.readMotionScene3DAnimationTrackForAuthoring(structuredClone(raw.value))); }
  catch (error) { return fail(error instanceof Error ? error.message : "track must be one typed scene3d animation track."); }
}
function strictRecord(value: unknown, label: string): Parsed<Record<string, unknown>> {
  const parsed = readStrictDataRecord(value, label);
  if (!parsed.ok) return parsed;
  return Buffer.byteLength(Core.canonicalJson(parsed.value), "utf8") <= MAX_TRANSPORT_BYTES
    ? parsed : fail(`${label} exceeds the ${MAX_TRANSPORT_BYTES}-byte scene3d animation transport limit.`);
}
function string(value: unknown, label: string): Parsed<string> { return typeof value === "string" && value.trim() ? ok(value) : fail(`${label} must be a non-empty string.`); }
function id(value: unknown, label: string): Parsed<string> { return typeof value === "string" && SAFE_ID.test(value) ? ok(value) : fail(`${label} must be a safe stable id.`); }
function microseconds(value: unknown, label: string): Parsed<number> {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= Core.MAX_MOTION_SCENE3D_ANIMATION_TIME_US
    ? ok(value)
    : fail(`${label} must be a safe integer microsecond in 0..${Core.MAX_MOTION_SCENE3D_ANIMATION_TIME_US}.`);
}
type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };
function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function parsed(intent: TimelineScene3DAnimationIntent): { ok: true; intent: TimelineScene3DAnimationIntent } { return { ok: true, intent }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
function firstProblem(...values: Parsed<unknown>[]): { ok: false; problem: string } { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? fail("Invalid scene3d animation intent."); }
