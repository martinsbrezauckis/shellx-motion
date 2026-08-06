/** Scene and marker mutations using one bounded atomic package-edit path. */
import {
  createTimelineScene,
  deleteTimelineMarker,
  deleteTimelineScene,
  reorderTimelineScene,
  resizeTimelineScene,
  setTimelineSceneName,
  upsertTimelineMarker,
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import {
  booleanArg,
  nonNegativeIntegerArg,
  nonNegativeNumberArg,
  objectArg,
  positiveNumberArg,
  stringArg,
  stringArrayArg
} from "./args.js";
import {
  commitAtomicTimelineMutation as commitAtomicMutation,
  isTimelineCommonEditResult as isDebugResult,
  readTimelineCommonEditArgs as commonEditArgs,
  timelineMutationFacts as withoutMotion,
  type TimelinePackageEditServices
} from "./timeline-package-edit.js";

export interface TimelineScenesMarkersServices extends TimelinePackageEditServices {}

export async function dispatchTimelineScenesMarkersCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineScenesMarkersServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.timeline.scene.create") return createScene(args, services);
  if (command === "motion.timeline.scene.delete") return deleteScene(args, services);
  if (command === "motion.timeline.scene.reorder") return reorderScene(args, services);
  if (command === "motion.timeline.scene.resize") return resizeScene(args, services);
  if (command === "motion.timeline.scene.name.set") return setSceneName(args, services);
  if (command === "motion.timeline.marker.upsert") return upsertMarker(args, services);
  if (command === "motion.timeline.marker.delete") return deleteMarker(args, services);
  return null;
}

async function createScene(args: unknown, services: TimelineScenesMarkersServices): Promise<MotionDebugResult> {
  const common = commonEditArgs("motion.timeline.scene.create", args, services);
  if (isDebugResult(common)) return common;
  const sceneId = stringArg(args, "sceneId") ?? stringArg(args, "scene") ?? stringArg(args, "id");
  const name = stringArg(args, "name") ?? stringArg(args, "sceneName") ?? undefined;
  const startMs = nonNegativeNumberArg(args, "startMs");
  const durationMs = positiveNumberArg(args, "durationMs");
  const index = nonNegativeIntegerArg(args, "index");
  const layerIdsArg = stringArrayArg(args, "layerIds");
  const trackIdsArg = stringArrayArg(args, "trackIds");
  const markerIdsArg = stringArrayArg(args, "markerIds");
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const trackId = stringArg(args, "trackId") ?? stringArg(args, "track");
  const markerId = stringArg(args, "markerId") ?? stringArg(args, "marker");
  if (!sceneId) return invalidArgs("motion.timeline.scene.create requires sceneId.");
  if (startMs === null || startMs === false) return invalidArgs("startMs must be a non-negative number.");
  if (durationMs === null || durationMs === false) return invalidArgs("durationMs must be a positive number.");
  if (index === false) return invalidArgs("index must be a non-negative integer.");
  if (hasOwn(args, "layerIds") && layerIdsArg === null) return invalidArgs("layerIds must be an array of strings.");
  if (hasOwn(args, "trackIds") && trackIdsArg === null) return invalidArgs("trackIds must be an array of strings.");
  if (hasOwn(args, "markerIds") && markerIdsArg === null) return invalidArgs("markerIds must be an array of strings.");
  const layerIds = layerIdsArg ?? (layerId ? [layerId] : undefined);
  const trackIds = trackIdsArg ?? (trackId ? [trackId] : undefined);
  const markerIds = markerIdsArg ?? (markerId ? [markerId] : undefined);
  return commitAtomicMutation({
    ...common,
    command: "motion.timeline.scene.create",
    receiptPrefix: "timeline-scene-create",
    receiptFileName: "timeline-scene-create.receipt.json",
    invalidCode: "timeline_scene_create_invalid",
    failureCode: "timeline_scene_create_failed",
    services,
    mutate: (pkg) => createTimelineScene(pkg.motion, {
      ...(index !== null ? { index } : {}),
      scene: {
        id: sceneId,
        ...(name ? { name } : {}),
        startMs,
        durationMs,
        ...(layerIds ? { layerIds } : {}),
        ...(trackIds ? { trackIds } : {}),
        ...(markerIds ? { markerIds } : {})
      }
    }),
    outputFacts: withoutMotion,
    resultFacts: withoutMotion,
    visibleFacts: (created) => ({
      sceneId: created.sceneId,
      index: created.index,
      action: created.action,
      oldSceneCount: created.oldSceneCount,
      newSceneCount: created.newSceneCount,
      oldDurationMs: created.oldDurationMs,
      newDurationMs: created.newDurationMs,
      durationChanged: created.durationChanged,
      changedPaths: created.changedPaths
    })
  });
}

async function deleteScene(args: unknown, services: TimelineScenesMarkersServices): Promise<MotionDebugResult> {
  const common = commonEditArgs("motion.timeline.scene.delete", args, services);
  if (isDebugResult(common)) return common;
  const sceneId = stringArg(args, "sceneId") ?? stringArg(args, "scene") ?? stringArg(args, "id");
  if (!sceneId) return invalidArgs("motion.timeline.scene.delete requires sceneId.");
  return commitAtomicMutation({
    ...common,
    command: "motion.timeline.scene.delete",
    receiptPrefix: "timeline-scene-delete",
    receiptFileName: "timeline-scene-delete.receipt.json",
    invalidCode: "timeline_scene_delete_invalid",
    failureCode: "timeline_scene_delete_failed",
    services,
    mutate: (pkg) => deleteTimelineScene(pkg.motion, { sceneId }),
    outputFacts: withoutMotion,
    resultFacts: withoutMotion,
    visibleFacts: (deleted) => ({
      sceneId: deleted.sceneId,
      index: deleted.index,
      action: deleted.action,
      oldSceneCount: deleted.oldSceneCount,
      newSceneCount: deleted.newSceneCount,
      oldDurationMs: deleted.oldDurationMs,
      newDurationMs: deleted.newDurationMs,
      durationChanged: deleted.durationChanged,
      changedPaths: deleted.changedPaths
    })
  });
}

async function reorderScene(args: unknown, services: TimelineScenesMarkersServices): Promise<MotionDebugResult> {
  const common = commonEditArgs("motion.timeline.scene.reorder", args, services);
  if (isDebugResult(common)) return common;
  const sceneId = stringArg(args, "sceneId") ?? stringArg(args, "scene") ?? stringArg(args, "id");
  const index = nonNegativeIntegerArg(args, "index");
  if (!sceneId) return invalidArgs("motion.timeline.scene.reorder requires sceneId.");
  if (index === null || index === false) return invalidArgs("index must be a non-negative integer.");
  return commitAtomicMutation({
    ...common,
    command: "motion.timeline.scene.reorder",
    receiptPrefix: "timeline-scene-reorder",
    receiptFileName: "timeline-scene-reorder.receipt.json",
    invalidCode: "timeline_scene_reorder_invalid",
    failureCode: "timeline_scene_reorder_failed",
    services,
    mutate: (pkg) => reorderTimelineScene(pkg.motion, { sceneId, index }),
    outputFacts: withoutMotion,
    resultFacts: withoutMotion,
    visibleFacts: (reordered) => ({
      sceneId: reordered.sceneId,
      action: reordered.action,
      oldIndex: reordered.oldIndex,
      newIndex: reordered.newIndex,
      oldSceneOrder: reordered.oldSceneOrder,
      newSceneOrder: reordered.newSceneOrder,
      oldDurationMs: reordered.oldDurationMs,
      newDurationMs: reordered.newDurationMs,
      durationChanged: reordered.durationChanged,
      changedPaths: reordered.changedPaths
    })
  });
}

async function resizeScene(args: unknown, services: TimelineScenesMarkersServices): Promise<MotionDebugResult> {
  const common = commonEditArgs("motion.timeline.scene.resize", args, services);
  if (isDebugResult(common)) return common;
  const sceneId = stringArg(args, "sceneId") ?? stringArg(args, "scene");
  const durationMs = positiveNumberArg(args, "durationMs");
  const ripple = booleanArg(args, "ripple") ?? false;
  if (!sceneId) return invalidArgs("motion.timeline.scene.resize requires sceneId.");
  if (durationMs === null || durationMs === false) return invalidArgs("durationMs must be a positive number.");
  return commitAtomicMutation({
    ...common,
    command: "motion.timeline.scene.resize",
    receiptPrefix: "timeline-scene-resize",
    receiptFileName: "timeline-scene-resize.receipt.json",
    invalidCode: "timeline_scene_resize_invalid",
    failureCode: "timeline_scene_resize_failed",
    services,
    mutate: (pkg) => resizeTimelineScene(pkg.motion, { sceneId, durationMs, ripple }),
    outputFacts: withoutMotion,
    resultFacts: withoutMotion,
    visibleFacts: (resized) => ({
      sceneId: resized.sceneId,
      oldDurationMs: resized.oldDurationMs,
      newDurationMs: resized.newDurationMs,
      deltaMs: resized.deltaMs,
      ripple: resized.ripple,
      changedPaths: resized.changedPaths
    })
  });
}

async function setSceneName(args: unknown, services: TimelineScenesMarkersServices): Promise<MotionDebugResult> {
  const common = commonEditArgs("motion.timeline.scene.name.set", args, services);
  if (isDebugResult(common)) return common;
  const sceneId = stringArg(args, "sceneId") ?? stringArg(args, "scene");
  const name = stringArg(args, "name") ?? stringArg(args, "sceneName") ?? stringArg(args, "value");
  if (!sceneId) return invalidArgs("motion.timeline.scene.name.set requires sceneId.");
  if (!name?.trim()) return invalidArgs("motion.timeline.scene.name.set requires name.");
  return commitAtomicMutation({
    ...common,
    command: "motion.timeline.scene.name.set",
    receiptPrefix: "timeline-scene-name-set",
    receiptFileName: "timeline-scene-name-set.receipt.json",
    invalidCode: "timeline_scene_name_set_invalid",
    failureCode: "timeline_scene_name_set_failed",
    services,
    mutate: (pkg) => setTimelineSceneName(pkg.motion, { sceneId, name }),
    outputFacts: withoutMotion,
    resultFacts: withoutMotion,
    visibleFacts: (nameSet) => ({
      sceneId: nameSet.sceneId,
      action: nameSet.action,
      oldName: nameSet.oldName,
      newName: nameSet.newName,
      changedPaths: nameSet.changedPaths
    })
  });
}

async function upsertMarker(args: unknown, services: TimelineScenesMarkersServices): Promise<MotionDebugResult> {
  const common = commonEditArgs("motion.timeline.marker.upsert", args, services);
  if (isDebugResult(common)) return common;
  const markerId = stringArg(args, "id") ?? stringArg(args, "markerId");
  const atMs = nonNegativeNumberArg(args, "atMs");
  const durationMs = nonNegativeNumberArg(args, "durationMs");
  const label = stringArg(args, "label") ?? undefined;
  const type = stringArg(args, "type") ?? undefined;
  const color = stringArg(args, "color") ?? undefined;
  const sceneId = stringArg(args, "sceneId") ?? stringArg(args, "scene") ?? undefined;
  if (!markerId) return invalidArgs("motion.timeline.marker.upsert requires marker id.");
  if (atMs === null || atMs === false) return invalidArgs("atMs must be a non-negative number.");
  if (durationMs === false) return invalidArgs("durationMs must be a non-negative number.");
  const inputFacts = {
    markerId,
    atMs,
    ...(durationMs !== null ? { durationMs } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(sceneId !== undefined ? { sceneId } : {})
  };
  return commitAtomicMutation({
    ...common,
    command: "motion.timeline.marker.upsert",
    receiptPrefix: "timeline-marker-upsert",
    receiptFileName: "timeline-marker-upsert.receipt.json",
    invalidCode: "timeline_marker_invalid",
    failureCode: "timeline_marker_upsert_failed",
    services,
    mutate: (pkg) => upsertTimelineMarker(pkg.motion, {
      id: markerId,
      atMs,
      ...(durationMs !== null ? { durationMs } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(sceneId !== undefined ? { sceneId } : {})
    }),
    outputFacts: (upsert) => ({ ...inputFacts, ...withoutMotion(upsert) }),
    resultFacts: withoutMotion,
    visibleFacts: (upsert) => ({ markerId, action: upsert.action, changedPath: upsert.changedPath })
  });
}

async function deleteMarker(args: unknown, services: TimelineScenesMarkersServices): Promise<MotionDebugResult> {
  const common = commonEditArgs("motion.timeline.marker.delete", args, services);
  if (isDebugResult(common)) return common;
  const markerId = stringArg(args, "id") ?? stringArg(args, "markerId");
  if (!markerId) return invalidArgs("motion.timeline.marker.delete requires marker id.");
  return commitAtomicMutation({
    ...common,
    command: "motion.timeline.marker.delete",
    receiptPrefix: "timeline-marker-delete",
    receiptFileName: "timeline-marker-delete.receipt.json",
    invalidCode: "timeline_marker_invalid",
    failureCode: "timeline_marker_delete_failed",
    services,
    mutate: (pkg) => deleteTimelineMarker(pkg.motion, { id: markerId }),
    outputFacts: (deletion) => ({ markerId, ...withoutMotion(deletion) }),
    resultFacts: withoutMotion,
    visibleFacts: (deletion) => ({ markerId, action: deletion.action, changedPath: deletion.changedPath })
  });
}

function hasOwn(args: unknown, key: string): boolean {
  const record = objectArg(args);
  return Boolean(record && Object.hasOwn(record, key));
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
