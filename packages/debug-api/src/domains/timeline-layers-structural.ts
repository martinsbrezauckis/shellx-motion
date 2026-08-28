/** Structural layer mutations backed by the shared atomic package-edit executor. */
import {
  createTimelineLayer,
  deleteTimelineLayer,
  duplicateTimelineLayer,
  reorderTimelineLayer,
  splitLayerAtMs,
  trimTimelineLayer,
  type MotionPackage
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { nonNegativeIntegerArg, nonNegativeNumberArg, positiveNumberArg, stringArg } from "./args.js";
import { readTimelineLayerCreateArg } from "./timeline-layer-create-args.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  type TimelineCommonEditArgs,
  type TimelinePackageEditServices
} from "./timeline-package-edit.js";

export interface TimelineLayersStructuralServices extends TimelinePackageEditServices {}
export async function dispatchTimelineLayersStructuralCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineLayersStructuralServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.timeline.layer.create") return create(args, services);
  if (command === "motion.timeline.layer.trim") return trim(args, services);
  if (command === "motion.timeline.layer.split") return split(args, services);
  if (command === "motion.timeline.layer.delete") return remove(args, services);
  if (command === "motion.timeline.layer.duplicate") return duplicate(args, services);
  if (command === "motion.timeline.layer.reorder") return reorder(args, services);
  return null;
}

async function create(args: unknown, services: TimelineLayersStructuralServices): Promise<MotionDebugResult> {
  const common = commonArgs("motion.timeline.layer.create", args, services);
  if (isResult(common)) return common;
  const startMs = nonNegativeNumberArg(args, "startMs");
  const durationMs = positiveNumberArg(args, "durationMs");
  const index = nonNegativeIntegerArg(args, "index");
  const trackIndex = nonNegativeIntegerArg(args, "trackIndex");
  const fontSize = positiveNumberArg(args, "fontSize");
  const width = positiveNumberArg(args, "width");
  const height = positiveNumberArg(args, "height");
  if (startMs === false) return invalidArgs("startMs must be a non-negative number.");
  if (durationMs === false) return invalidArgs("durationMs must be a positive number.");
  if (index === false) return invalidArgs("index must be a non-negative integer.");
  if (trackIndex === false) return invalidArgs("trackIndex must be a non-negative integer.");
  if (fontSize === false) return invalidArgs("fontSize must be a positive number.");
  if (width === false) return invalidArgs("width must be a positive number.");
  if (height === false) return invalidArgs("height must be a positive number.");
  const parsedLayer = readTimelineLayerCreateArg(args, {
    ...(startMs !== null ? { startMs } : {}),
    ...(durationMs !== null ? { durationMs } : {})
  });
  if (!parsedLayer.ok) return invalidArgs(parsedLayer.problem);
  const layer = parsedLayer.layer;
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.layer.create",
    receiptPrefix: "timeline-layer-create",
    receiptFileName: "timeline-layer-create.receipt.json",
    invalidCode: "timeline_layer_create_invalid",
    failureCode: "timeline_layer_create_failed",
    services,
    mutate: (pkg) => createTimelineLayer(pkg.motion, {
      layer,
      ...(index !== null ? { index } : {}),
      ...(trackIndex !== null ? { trackIndex } : {})
    }),
    outputFacts: (created) => ({
      layerId: created.layerId,
      index: created.index,
      ...(created.trackId ? { trackId: created.trackId } : {}),
      ...(created.trackIndex !== undefined ? { trackIndex: created.trackIndex } : {}),
      changedPaths: created.changedPaths,
      action: created.action,
      layer: created.layer,
      oldLayerCount: created.oldLayerCount,
      newLayerCount: created.newLayerCount,
      insertedTrackRefs: created.insertedTrackRefs
    }),
    visibleFacts: (created) => ({
      layerId: created.layerId,
      action: created.action,
      index: created.index,
      ...(created.trackId ? { trackId: created.trackId } : {}),
      ...(created.trackIndex !== undefined ? { trackIndex: created.trackIndex } : {}),
      changedPaths: created.changedPaths
    }),
    resultFacts: (created) => ({
      changedPaths: created.changedPaths,
      action: created.action,
      layerId: created.layerId,
      index: created.index,
      ...(created.trackId ? { trackId: created.trackId } : {}),
      ...(created.trackIndex !== undefined ? { trackIndex: created.trackIndex } : {}),
      layer: created.layer,
      oldLayerCount: created.oldLayerCount,
      newLayerCount: created.newLayerCount,
      insertedTrackRefs: created.insertedTrackRefs
    })
  });
}

async function trim(args: unknown, services: TimelineLayersStructuralServices): Promise<MotionDebugResult> {
  const common = commonArgs("motion.timeline.layer.trim", args, services);
  if (isResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const startMs = nonNegativeNumberArg(args, "startMs");
  const durationMs = positiveNumberArg(args, "durationMs");
  const trimStartMs = nonNegativeNumberArg(args, "trimStartMs");
  const trimDurationMs = positiveNumberArg(args, "trimDurationMs");
  if (!layerId) return invalidArgs("motion.timeline.layer.trim requires layerId.");
  if (startMs === false) return invalidArgs("startMs must be a non-negative number.");
  if (durationMs === false) return invalidArgs("durationMs must be a positive number.");
  if (trimStartMs === false) return invalidArgs("trimStartMs must be a non-negative number.");
  if (trimDurationMs === false) return invalidArgs("trimDurationMs must be a positive number.");
  if (startMs === null && durationMs === null && trimStartMs === null && trimDurationMs === null) {
    return invalidArgs("motion.timeline.layer.trim requires at least one timing field.");
  }
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.layer.trim",
    receiptPrefix: "timeline-layer-trim",
    receiptFileName: "timeline-layer-trim.receipt.json",
    invalidCode: "timeline_layer_trim_invalid",
    failureCode: "timeline_layer_trim_failed",
    services,
    mutate: (pkg) => trimMutation(pkg, layerId, {
      ...(startMs !== null ? { startMs } : {}),
      ...(durationMs !== null ? { durationMs } : {}),
      ...(trimStartMs !== null ? { trimStartMs } : {}),
      ...(trimDurationMs !== null ? { trimDurationMs } : {})
    }),
    outputFacts: (trimmed) => ({
      layerId,
      changedPaths: trimmed.changedPaths,
      action: trimmed.action,
      oldTiming: trimmed.oldTiming,
      newTiming: trimmed.newTiming
    }),
    visibleFacts: (trimmed) => ({ layerId, action: trimmed.action, changedPaths: trimmed.changedPaths }),
    resultFacts: (trimmed) => ({
      changedPaths: trimmed.changedPaths,
      action: trimmed.action,
      oldTiming: trimmed.oldTiming,
      newTiming: trimmed.newTiming,
      layer: trimmed.layer
    })
  });
}

async function split(args: unknown, services: TimelineLayersStructuralServices): Promise<MotionDebugResult> {
  const common = commonArgs("motion.timeline.layer.split", args, services);
  if (isResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const atMs = nonNegativeNumberArg(args, "atMs");
  const newLayerId = stringArg(args, "newLayerId") ?? stringArg(args, "newLayer") ?? undefined;
  if (!layerId) return invalidArgs("motion.timeline.layer.split requires layerId.");
  if (atMs === null || atMs === false) return invalidArgs("atMs must be a non-negative number.");
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.layer.split",
    receiptPrefix: "timeline-layer-split",
    receiptFileName: "timeline-layer-split.receipt.json",
    invalidCode: "timeline_layer_split_invalid",
    failureCode: "timeline_layer_split_failed",
    services,
    mutate: (pkg) => splitLayerAtMs(pkg.motion, { layerId, atMs, ...(newLayerId ? { newLayerId } : {}) }),
    outputFacts: (splitResult) => ({
      layerId: splitResult.layerId,
      newLayerId: splitResult.newLayerId,
      atMs: splitResult.atMs,
      splitOffsetMs: splitResult.splitOffsetMs,
      ...(splitResult.sourceOffsetMs !== undefined ? { sourceOffsetMs: splitResult.sourceOffsetMs } : {}),
      changedPaths: splitResult.changedPaths,
      action: splitResult.action,
      oldTiming: splitResult.oldTiming,
      newTimings: splitResult.newTimings,
      originalLayer: splitResult.originalLayer,
      newLayer: splitResult.newLayer
    }),
    visibleFacts: (splitResult) => ({
      layerId: splitResult.layerId,
      newLayerId: splitResult.newLayerId,
      atMs: splitResult.atMs,
      action: splitResult.action,
      changedPaths: splitResult.changedPaths
    }),
    resultFacts: (splitResult) => ({
      changedPaths: splitResult.changedPaths,
      action: splitResult.action,
      layerId: splitResult.layerId,
      newLayerId: splitResult.newLayerId,
      atMs: splitResult.atMs,
      splitOffsetMs: splitResult.splitOffsetMs,
      ...(splitResult.sourceOffsetMs !== undefined ? { sourceOffsetMs: splitResult.sourceOffsetMs } : {}),
      oldTiming: splitResult.oldTiming,
      newTimings: splitResult.newTimings,
      originalLayer: splitResult.originalLayer,
      newLayer: splitResult.newLayer
    })
  });
}

async function remove(args: unknown, services: TimelineLayersStructuralServices): Promise<MotionDebugResult> {
  const common = commonArgs("motion.timeline.layer.delete", args, services);
  if (isResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  if (!layerId) return invalidArgs("motion.timeline.layer.delete requires layerId.");
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.layer.delete",
    receiptPrefix: "timeline-layer-delete",
    receiptFileName: "timeline-layer-delete.receipt.json",
    invalidCode: "timeline_layer_delete_invalid",
    failureCode: "timeline_layer_delete_failed",
    services,
    mutate: (pkg) => deleteTimelineLayer(pkg.motion, { layerId }),
    outputFacts: (deleted) => ({
      layerId: deleted.layerId,
      changedPaths: deleted.changedPaths,
      action: deleted.action,
      removed: deleted.removed,
      remainingCount: deleted.remainingCount,
      removedTrackRefs: deleted.removedTrackRefs
    }),
    visibleFacts: (deleted) => ({ layerId: deleted.layerId, action: deleted.action, changedPaths: deleted.changedPaths }),
    resultFacts: (deleted) => ({
      changedPaths: deleted.changedPaths,
      action: deleted.action,
      layerId: deleted.layerId,
      removed: deleted.removed,
      remainingCount: deleted.remainingCount,
      removedTrackRefs: deleted.removedTrackRefs
    })
  });
}

async function duplicate(args: unknown, services: TimelineLayersStructuralServices): Promise<MotionDebugResult> {
  const common = commonArgs("motion.timeline.layer.duplicate", args, services);
  if (isResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const newLayerId = stringArg(args, "newLayerId") ?? stringArg(args, "newLayer") ?? undefined;
  const offsetMs = nonNegativeNumberArg(args, "offsetMs");
  if (!layerId) return invalidArgs("motion.timeline.layer.duplicate requires layerId.");
  if (offsetMs === false) return invalidArgs("offsetMs must be a non-negative number.");
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.layer.duplicate",
    receiptPrefix: "timeline-layer-duplicate",
    receiptFileName: "timeline-layer-duplicate.receipt.json",
    invalidCode: "timeline_layer_duplicate_invalid",
    failureCode: "timeline_layer_duplicate_failed",
    services,
    mutate: (pkg) => duplicateTimelineLayer(pkg.motion, {
      layerId,
      ...(newLayerId ? { newLayerId } : {}),
      ...(offsetMs !== null ? { offsetMs } : {})
    }),
    outputFacts: (duplicated) => ({
      layerId: duplicated.layerId,
      newLayerId: duplicated.newLayerId,
      offsetMs: duplicated.offsetMs,
      changedPaths: duplicated.changedPaths,
      action: duplicated.action,
      sourceLayer: duplicated.sourceLayer,
      layer: duplicated.layer,
      insertedTrackRefs: duplicated.insertedTrackRefs
    }),
    visibleFacts: (duplicated) => ({
      layerId: duplicated.layerId,
      newLayerId: duplicated.newLayerId,
      offsetMs: duplicated.offsetMs,
      action: duplicated.action,
      changedPaths: duplicated.changedPaths
    }),
    resultFacts: (duplicated) => ({
      changedPaths: duplicated.changedPaths,
      action: duplicated.action,
      layerId: duplicated.layerId,
      newLayerId: duplicated.newLayerId,
      offsetMs: duplicated.offsetMs,
      sourceLayer: duplicated.sourceLayer,
      layer: duplicated.layer,
      insertedTrackRefs: duplicated.insertedTrackRefs
    })
  });
}

async function reorder(args: unknown, services: TimelineLayersStructuralServices): Promise<MotionDebugResult> {
  const common = commonArgs("motion.timeline.layer.reorder", args, services);
  if (isResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const index = nonNegativeIntegerArg(args, "index");
  if (!layerId) return invalidArgs("motion.timeline.layer.reorder requires layerId.");
  if (index === null || index === false) return invalidArgs("index must be a non-negative integer.");
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.layer.reorder",
    receiptPrefix: "timeline-layer-reorder",
    receiptFileName: "timeline-layer-reorder.receipt.json",
    invalidCode: "timeline_layer_reorder_invalid",
    failureCode: "timeline_layer_reorder_failed",
    services,
    mutate: (pkg) => reorderTimelineLayer(pkg.motion, { layerId, index }),
    outputFacts: (reordered) => ({
      layerId: reordered.layerId,
      oldIndex: reordered.oldIndex,
      newIndex: reordered.newIndex,
      changedPaths: reordered.changedPaths,
      action: reordered.action,
      layer: reordered.layer,
      reorderedTrackRefs: reordered.reorderedTrackRefs
    }),
    visibleFacts: (reordered) => ({
      layerId: reordered.layerId,
      action: reordered.action,
      oldIndex: reordered.oldIndex,
      newIndex: reordered.newIndex,
      changedPaths: reordered.changedPaths
    }),
    resultFacts: (reordered) => ({
      changedPaths: reordered.changedPaths,
      action: reordered.action,
      layerId: reordered.layerId,
      oldIndex: reordered.oldIndex,
      newIndex: reordered.newIndex,
      layer: reordered.layer,
      reorderedTrackRefs: reordered.reorderedTrackRefs
    })
  });
}

function trimMutation(
  pkg: MotionPackage,
  layerId: string,
  timing: { startMs?: number; durationMs?: number; trimStartMs?: number; trimDurationMs?: number }
) {
  return trimTimelineLayer(pkg.motion, { layerId, ...timing });
}

function commonArgs(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineLayersStructuralServices
): TimelineCommonEditArgs | MotionDebugResult {
  return readTimelineCommonEditArgs(command, args, services);
}

function isResult(value: TimelineCommonEditArgs | MotionDebugResult): value is MotionDebugResult {
  return isTimelineCommonEditResult(value);
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
