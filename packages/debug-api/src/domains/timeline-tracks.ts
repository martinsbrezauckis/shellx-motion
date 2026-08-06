/** Track lifecycle and mixer mutations using one atomic package-edit boundary. */
import {
  createTimelineTrack,
  deleteTimelineTrack,
  renameTimelineTrack,
  reorderTimelineTrack,
  setTimelineTrackFade,
  setTimelineTrackLock,
  setTimelineTrackMute,
  setTimelineTrackPan,
  setTimelineTrackSolo,
  setTimelineTrackVolume,
  type MotionDocument
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, finiteNumberArg, nonNegativeIntegerArg, nonNegativeNumberArg, objectArg, stringArg } from "./args.js";
import { timelineTrackCreateArg } from "./timeline-track-create-args.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  type TimelineCommonEditArgs,
  type TimelinePackageEditServices
} from "./timeline-package-edit.js";

export interface TimelineTracksServices extends TimelinePackageEditServices {}

export async function dispatchTimelineTracksCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineTracksServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.timeline.track.create") return create(args, services);
  if (command === "motion.timeline.track.reorder") return reorder(args, services);
  if (command === "motion.timeline.track.delete") return remove(args, services);
  if (command === "motion.timeline.track.rename") return rename(args, services);
  if (command === "motion.timeline.track.lock") return booleanSetter(command, args, services, "locked", (motion, trackId, value) => setTimelineTrackLock(motion, { trackId, locked: value }) as unknown as TrackMutation, "timeline-track-lock");
  if (command === "motion.timeline.track.mute") return booleanSetter(command, args, services, "muted", (motion, trackId, value) => setTimelineTrackMute(motion, { trackId, muted: value }) as unknown as TrackMutation, "timeline-track-mute");
  if (command === "motion.timeline.track.solo") return booleanSetter(command, args, services, "solo", (motion, trackId, value) => setTimelineTrackSolo(motion, { trackId, solo: value }) as unknown as TrackMutation, "timeline-track-solo");
  if (command === "motion.timeline.track.volume") return volume(args, services);
  if (command === "motion.timeline.track.fade") return fade(args, services);
  if (command === "motion.timeline.track.pan") return pan(args, services);
  return null;
}

async function create(args: unknown, services: TimelineTracksServices): Promise<MotionDebugResult> {
  const common = commonArgs("motion.timeline.track.create", args, services);
  if (isResult(common)) return common;
  const index = nonNegativeIntegerArg(args, "index");
  const order = finiteNumberArg(args, "order");
  const volume = nonNegativeNumberArg(args, "volume");
  const panValue = panArg(args);
  const fadeInMs = nonNegativeNumberArg(args, "fadeInMs");
  const fadeOutMs = nonNegativeNumberArg(args, "fadeOutMs");
  if (index === false) return invalidArgs("index must be a non-negative integer.");
  if (order === false) return invalidArgs("order must be a finite number.");
  if (volume === false) return invalidArgs("volume must be a non-negative finite number.");
  if (panValue === false) return invalidArgs("pan must be a finite number between -1 and 1.");
  if (fadeInMs === false || fadeOutMs === false) return invalidArgs("fadeInMs and fadeOutMs must be non-negative finite numbers.");
  const track = timelineTrackCreateArg(args, {
    ...(order !== null ? { order } : {}), ...(volume !== null ? { volume } : {}),
    ...(panValue !== null ? { pan: panValue } : {}), ...(fadeInMs !== null ? { fadeInMs } : {}),
    ...(fadeOutMs !== null ? { fadeOutMs } : {})
  });
  if (!track) return invalidArgs("motion.timeline.track.create requires a track object or trackId/type fields.");
  return execute(common, {
    command: "motion.timeline.track.create", receiptPrefix: "timeline-track-create",
    invalidCode: "timeline_track_create_invalid", failureCode: "timeline_track_create_failed", services,
    mutate: (motion) => createTimelineTrack(motion, { track, ...(index !== null ? { index } : {}) }),
    output: (created) => ({ trackId: created.trackId, index: created.index, attachedLayerIds: created.attachedLayerIds, changedPaths: created.changedPaths, action: created.action, track: created.track, oldTrackCount: created.oldTrackCount, newTrackCount: created.newTrackCount }),
    visible: (created) => ({ trackId: created.trackId, action: created.action, index: created.index, attachedLayerIds: created.attachedLayerIds, changedPaths: created.changedPaths })
  });
}

async function reorder(args: unknown, services: TimelineTracksServices): Promise<MotionDebugResult> {
  const base = trackArgs("motion.timeline.track.reorder", args, services);
  if (isResult(base)) return base;
  const index = nonNegativeIntegerArg(args, "index");
  if (index === null || index === false) return invalidArgs("index must be a non-negative integer.");
  return execute(base, {
    command: "motion.timeline.track.reorder", receiptPrefix: "timeline-track-reorder",
    invalidCode: "timeline_track_reorder_invalid", failureCode: "timeline_track_reorder_failed", services,
    mutate: (motion) => reorderTimelineTrack(motion, { trackId: base.trackId, index }),
    output: (result) => ({ trackId: result.trackId, oldIndex: result.oldIndex, newIndex: result.newIndex, oldTrackOrder: result.oldTrackOrder, newTrackOrder: result.newTrackOrder, changedPaths: result.changedPaths, action: result.action, track: result.track }),
    visible: (result) => ({ trackId: result.trackId, action: result.action, oldIndex: result.oldIndex, newIndex: result.newIndex, oldTrackOrder: result.oldTrackOrder, newTrackOrder: result.newTrackOrder, changedPaths: result.changedPaths })
  });
}

async function remove(args: unknown, services: TimelineTracksServices): Promise<MotionDebugResult> {
  const base = trackArgs("motion.timeline.track.delete", args, services);
  if (isResult(base)) return base;
  const detachLayers = optionalBooleanArg(args, "detachLayers");
  if (detachLayers === false) return invalidArgs("detachLayers must be a boolean.");
  return execute(base, {
    command: "motion.timeline.track.delete", receiptPrefix: "timeline-track-delete",
    invalidCode: "timeline_track_delete_invalid", failureCode: "timeline_track_delete_failed", services,
    mutate: (motion) => deleteTimelineTrack(motion, { trackId: base.trackId, ...(detachLayers !== null ? { detachLayers } : {}) }),
    output: (result) => ({ trackId: result.trackId, removed: result.removed, detachedLayerIds: result.detachedLayerIds, removedSceneRefs: result.removedSceneRefs, oldTrackCount: result.oldTrackCount, newTrackCount: result.newTrackCount, changedPaths: result.changedPaths, action: result.action }),
    visible: (result) => ({ trackId: result.trackId, action: result.action, detachedLayerIds: result.detachedLayerIds, removedSceneRefs: result.removedSceneRefs, oldTrackCount: result.oldTrackCount, newTrackCount: result.newTrackCount, changedPaths: result.changedPaths })
  });
}

async function rename(args: unknown, services: TimelineTracksServices): Promise<MotionDebugResult> {
  const base = trackArgs("motion.timeline.track.rename", args, services);
  if (isResult(base)) return base;
  const name = stringArg(args, "name") ?? stringArg(args, "trackName");
  if (!name?.trim()) return invalidArgs("motion.timeline.track.rename requires name.");
  return execute(base, {
    command: "motion.timeline.track.rename", receiptPrefix: "timeline-track-rename",
    invalidCode: "timeline_track_rename_invalid", failureCode: "timeline_track_rename_failed", services,
    mutate: (motion) => renameTimelineTrack(motion, { trackId: base.trackId, name }),
    output: (result) => ({ trackId: result.trackId, oldName: result.oldName, newName: result.newName, changedPaths: result.changedPaths, action: result.action, track: result.track }),
    visible: (result) => ({ trackId: result.trackId, action: result.action, oldName: result.oldName, newName: result.newName, changedPaths: result.changedPaths })
  });
}

type BooleanTrackMutation = (motion: MotionDocument, trackId: string, value: boolean) => TrackMutation;

async function booleanSetter(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineTracksServices,
  property: "locked" | "muted" | "solo",
  mutate: BooleanTrackMutation,
  receiptPrefix: string
): Promise<MotionDebugResult> {
  const base = trackArgs(command, args, services);
  if (isResult(base)) return base;
  const value = booleanArg(args, property);
  if (value === null) return invalidArgs(`${property} must be a boolean.`);
  const capitalized = `${property[0].toUpperCase()}${property.slice(1)}`;
  const operation = property === "locked" ? "lock" : property === "muted" ? "mute" : "solo";
  return execute(base, {
    command, receiptPrefix, invalidCode: `timeline_track_${operation}_invalid`,
    failureCode: `timeline_track_${operation}_failed`, services,
    mutate: (motion) => mutate(motion, base.trackId, value),
    output: (result) => ({ trackId: result.trackId, [`old${capitalized}`]: result[`old${capitalized}`], [`new${capitalized}`]: result[`new${capitalized}`], changedPaths: result.changedPaths, action: result.action, track: result.track }),
    visible: (result) => ({ trackId: result.trackId, action: result.action, [`old${capitalized}`]: result[`old${capitalized}`], [`new${capitalized}`]: result[`new${capitalized}`], changedPaths: result.changedPaths })
  });
}

async function volume(args: unknown, services: TimelineTracksServices): Promise<MotionDebugResult> {
  const base = trackArgs("motion.timeline.track.volume", args, services);
  if (isResult(base)) return base;
  const value = nonNegativeNumberArg(args, "volume");
  if (value === null || value === false) return invalidArgs("volume must be a non-negative finite number.");
  return numericSetter(base, services, "motion.timeline.track.volume", "timeline-track-volume", "volume", value,
    (motion, trackId, next) => setTimelineTrackVolume(motion, { trackId, volume: next }) as unknown as TrackMutation);
}

async function pan(args: unknown, services: TimelineTracksServices): Promise<MotionDebugResult> {
  const base = trackArgs("motion.timeline.track.pan", args, services);
  if (isResult(base)) return base;
  const value = panArg(args);
  if (value === null || value === false) return invalidArgs("pan must be a finite number between -1 and 1.");
  return numericSetter(base, services, "motion.timeline.track.pan", "timeline-track-pan", "pan", value,
    (motion, trackId, next) => setTimelineTrackPan(motion, { trackId, pan: next }) as unknown as TrackMutation);
}

function numericSetter(
  base: TrackArgs, services: TimelineTracksServices, command: MotionDebugCommand, receiptPrefix: string,
  property: "volume" | "pan", value: number,
  mutate: (motion: MotionDocument, trackId: string, value: number) => TrackMutation
): Promise<MotionDebugResult> {
  const capitalized = `${property[0].toUpperCase()}${property.slice(1)}`;
  return execute(base, {
    command, receiptPrefix, invalidCode: `timeline_track_${property}_invalid`, failureCode: `timeline_track_${property}_failed`, services,
    mutate: (motion) => mutate(motion, base.trackId, value),
    output: (result) => ({ trackId: result.trackId, [`old${capitalized}`]: result[`old${capitalized}`], [`new${capitalized}`]: result[`new${capitalized}`], changedPaths: result.changedPaths, action: result.action, track: result.track }),
    visible: (result) => ({ trackId: result.trackId, action: result.action, [`old${capitalized}`]: result[`old${capitalized}`], [`new${capitalized}`]: result[`new${capitalized}`], changedPaths: result.changedPaths })
  });
}

async function fade(args: unknown, services: TimelineTracksServices): Promise<MotionDebugResult> {
  const base = trackArgs("motion.timeline.track.fade", args, services);
  if (isResult(base)) return base;
  const fadeInMs = nonNegativeNumberArg(args, "fadeInMs");
  const fadeOutMs = nonNegativeNumberArg(args, "fadeOutMs");
  if (fadeInMs === false || fadeOutMs === false) return invalidArgs("fadeInMs and fadeOutMs must be non-negative finite numbers.");
  if (fadeInMs === null && fadeOutMs === null) return invalidArgs("motion.timeline.track.fade requires fadeInMs or fadeOutMs.");
  return execute(base, {
    command: "motion.timeline.track.fade", receiptPrefix: "timeline-track-fade",
    invalidCode: "timeline_track_fade_invalid", failureCode: "timeline_track_fade_failed", services,
    mutate: (motion) => setTimelineTrackFade(motion, { trackId: base.trackId, ...(fadeInMs !== null ? { fadeInMs } : {}), ...(fadeOutMs !== null ? { fadeOutMs } : {}) }),
    output: (result) => ({ trackId: result.trackId, oldFade: result.oldFade, newFade: result.newFade, changedPaths: result.changedPaths, action: result.action, track: result.track }),
    visible: (result) => ({ trackId: result.trackId, action: result.action, oldFade: result.oldFade, newFade: result.newFade, changedPaths: result.changedPaths })
  });
}

type TrackMutation = { motion: MotionDocument; changedPaths: string[]; action: string; trackId: string; track?: unknown } & Record<string, unknown>;
interface TrackArgs extends TimelineCommonEditArgs { trackId: string }

function trackArgs(command: MotionDebugCommand, args: unknown, services: TimelineTracksServices): TrackArgs | MotionDebugResult {
  const common = commonArgs(command, args, services);
  if (isResult(common)) return common;
  const trackId = stringArg(args, "trackId") ?? stringArg(args, "track");
  if (!trackId) return invalidArgs(`${command} requires trackId.`);
  return { ...common, trackId };
}

function execute<T extends { motion: MotionDocument }>(
  common: TimelineCommonEditArgs,
  input: {
    command: MotionDebugCommand; receiptPrefix: string; invalidCode: string; failureCode: string; services: TimelineTracksServices;
    mutate: (motion: MotionDocument) => T; output: (mutation: T) => Record<string, unknown>; visible: (mutation: T) => Record<string, unknown>;
  }
): Promise<MotionDebugResult> {
  return commitAtomicTimelineMutation({
    ...common, command: input.command, receiptPrefix: input.receiptPrefix,
    receiptFileName: `${input.receiptPrefix}.receipt.json`, invalidCode: input.invalidCode,
    failureCode: input.failureCode, services: input.services,
    mutate: (pkg) => input.mutate(pkg.motion), outputFacts: input.output, resultFacts: input.output, visibleFacts: input.visible
  });
}

function commonArgs(command: MotionDebugCommand, args: unknown, services: TimelineTracksServices): TimelineCommonEditArgs | MotionDebugResult {
  return readTimelineCommonEditArgs(command, args, services);
}

function optionalBooleanArg(args: unknown, key: string): boolean | false | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  return typeof record[key] === "boolean" ? record[key] : false;
}

function panArg(args: unknown): number | false | null {
  const value = finiteNumberArg(args, "pan");
  return typeof value === "number" && (value < -1 || value > 1) ? false : value;
}

function isResult(value: TimelineCommonEditArgs | MotionDebugResult): value is MotionDebugResult {
  return isTimelineCommonEditResult(value);
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
