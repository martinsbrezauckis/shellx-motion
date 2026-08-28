import * as Core from "@shellx-motion/core";
import type { MotionLayoutGapAnimationTrack } from "@shellx-motion/core";
import {
  readStrictDataRecord,
  readStrictDataRecordEnvelope,
} from "./timeline-strict-data.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EDIT_KEYS = ["packageRoot", "outDir", "packageDir", "createdBy"] as const;

export const TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS = {
  inspect: "motion.timeline.layout-gap-animation.inspect",
  trackUpsert: "motion.timeline.layout-gap-animation.track.upsert",
  trackRemove: "motion.timeline.layout-gap-animation.track.remove",
  keyframeUpsert: "motion.timeline.layout-gap-animation.keyframe.upsert",
  keyframeDelete: "motion.timeline.layout-gap-animation.keyframe.delete",
  keyframeMove: "motion.timeline.layout-gap-animation.keyframe.move",
} as const;

export type TimelineLayoutGapAnimationCommand =
  typeof TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS[keyof typeof TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS];

export type TimelineLayoutGapAnimationIntent =
  | { kind: "inspect"; packageRoot: string }
  | { kind: "track.upsert"; edit: Edit; track: MotionLayoutGapAnimationTrack }
  | { kind: "track.remove"; edit: Edit; trackId: string }
  | { kind: "keyframe.upsert"; edit: Edit; trackId: string; keyframe: Record<string, unknown> }
  | { kind: "keyframe.delete"; edit: Edit; trackId: string; atUs: number }
  | { kind: "keyframe.move"; edit: Edit; trackId: string; fromAtUs: number; toAtUs: number };

export type TimelineLayoutGapAnimationIntentParseResult =
  | { ok: true; intent: TimelineLayoutGapAnimationIntent }
  | { ok: false; problem: string };

type Edit = { packageRoot: string; outDir: string; createdBy?: string };
type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

export function isTimelineLayoutGapAnimationCommand(
  command: string,
): command is TimelineLayoutGapAnimationCommand {
  return Object.values(TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS).includes(
    command as TimelineLayoutGapAnimationCommand,
  );
}

export function readTimelineLayoutGapAnimationIntent(
  command: string,
  args: unknown,
): TimelineLayoutGapAnimationIntentParseResult | null {
  if (!isTimelineLayoutGapAnimationCommand(command)) return null;
  const envelope = readStrictDataRecordEnvelope(
    args,
    "Arguments",
    allowed(command),
    opaque(command),
  );
  if (!envelope.ok) return envelope;

  const packageRoot = string(envelope.value.packageRoot, "packageRoot");
  if (!packageRoot.ok) return packageRoot;
  if (command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.inspect) {
    return { ok: true, intent: { kind: "inspect", packageRoot: packageRoot.value } };
  }

  const edit = readEdit(envelope.value, packageRoot.value);
  if (!edit.ok) return edit;
  if (command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackUpsert) {
    return readTrackUpsert(edit.value, envelope.value.track);
  }

  const trackId = id(envelope.value.trackId, "trackId");
  if (!trackId.ok) return trackId;
  if (command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackRemove) {
    return { ok: true, intent: { kind: "track.remove", edit: edit.value, trackId: trackId.value } };
  }
  if (command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.keyframeUpsert) {
    const keyframe = strict(envelope.value.keyframe, "keyframe");
    return keyframe.ok
      ? {
          ok: true,
          intent: {
            kind: "keyframe.upsert",
            edit: edit.value,
            trackId: trackId.value,
            // `readStrictDataRecord` deliberately returns null-prototype data so transport
            // getters and prototypes cannot cross the boundary. Normalize that admitted data
            // before Core's exact plain-object reader, as track.upsert already does above.
            keyframe: structuredClone(keyframe.value),
          },
        }
      : keyframe;
  }

  const fromLabel = command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.keyframeDelete
    ? "atUs"
    : "fromAtUs";
  const fromValue = command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.keyframeDelete
    ? envelope.value.atUs
    : envelope.value.fromAtUs;
  const at = us(fromValue, fromLabel);
  if (!at.ok) return at;
  if (command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.keyframeDelete) {
    return {
      ok: true,
      intent: { kind: "keyframe.delete", edit: edit.value, trackId: trackId.value, atUs: at.value },
    };
  }

  const to = us(envelope.value.toAtUs, "toAtUs");
  if (!to.ok) return to;
  if (at.value === to.value) {
    return fail("fromAtUs and toAtUs must differ for an exact layout gap keyframe move.");
  }
  return {
    ok: true,
    intent: {
      kind: "keyframe.move",
      edit: edit.value,
      trackId: trackId.value,
      fromAtUs: at.value,
      toAtUs: to.value,
    },
  };
}

function readTrackUpsert(
  edit: Edit,
  value: unknown,
): TimelineLayoutGapAnimationIntentParseResult {
  const track = strict(value, "track");
  if (!track.ok) return track;
  try {
    return {
      ok: true,
      intent: {
        kind: "track.upsert",
        edit,
        track: Core.readMotionLayoutGapAnimationTrackForAuthoring(structuredClone(track.value)),
      },
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "track must be a typed layout gap animation track.");
  }
}

function allowed(command: TimelineLayoutGapAnimationCommand): readonly string[] {
  if (command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.inspect) return ["packageRoot"];
  if (command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackUpsert) {
    return [...EDIT_KEYS, "track"];
  }
  if (command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackRemove) {
    return [...EDIT_KEYS, "trackId"];
  }
  if (command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.keyframeUpsert) {
    return [...EDIT_KEYS, "trackId", "keyframe"];
  }
  if (command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.keyframeDelete) {
    return [...EDIT_KEYS, "trackId", "atUs"];
  }
  return [...EDIT_KEYS, "trackId", "fromAtUs", "toAtUs"];
}

function opaque(command: TimelineLayoutGapAnimationCommand): readonly string[] {
  if (command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.trackUpsert) return ["track"];
  return command === TIMELINE_LAYOUT_GAP_ANIMATION_COMMANDS.keyframeUpsert ? ["keyframe"] : [];
}

function readEdit(value: Record<string, unknown>, packageRoot: string): Parsed<Edit> {
  const outDir = optionalString(value, "outDir");
  if (!outDir.ok) return outDir;
  const packageDir = optionalString(value, "packageDir");
  if (!packageDir.ok) return packageDir;
  if (!outDir.value && !packageDir.value) return fail("outDir is required.");
  if (outDir.value && packageDir.value && outDir.value !== packageDir.value) {
    return fail("outDir and packageDir must match when both are supplied.");
  }
  const createdBy = optionalString(value, "createdBy");
  if (!createdBy.ok) return createdBy;
  return ok({
    packageRoot,
    outDir: outDir.value ?? packageDir.value!,
    ...(createdBy.value ? { createdBy: createdBy.value } : {}),
  });
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): Parsed<string | undefined> {
  return Object.hasOwn(value, key) ? string(value[key], key) : ok(undefined);
}

function strict(value: unknown, label: string): Parsed<Record<string, unknown>> {
  const parsed = readStrictDataRecord(value, label);
  if (!parsed.ok) return parsed;
  return Buffer.byteLength(Core.canonicalJson(parsed.value), "utf8") <= 128 * 1024
    ? parsed
    : fail(`${label} exceeds the 131072-byte layout gap animation transport limit.`);
}

function string(value: unknown, label: string): Parsed<string> {
  return typeof value === "string" && value.trim()
    ? ok(value)
    : fail(`${label} must be a non-empty string.`);
}

function id(value: unknown, label: string): Parsed<string> {
  return typeof value === "string" && SAFE_ID.test(value)
    ? ok(value)
    : fail(`${label} must be a safe stable id.`);
}

function us(value: unknown, label: string): Parsed<number> {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= Core.MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US
    ? ok(value)
    : fail(
        `${label} must be a safe integer microsecond in 0..${Core.MAX_MOTION_LAYOUT_GAP_ANIMATION_TIME_US}.`,
      );
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function fail<T = never>(problem: string): { ok: false; problem: string } {
  return { ok: false, problem };
}
