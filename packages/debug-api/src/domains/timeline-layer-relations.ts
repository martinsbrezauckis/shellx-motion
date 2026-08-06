/** Layer-to-layer and layer-to-track relationship mutations. */
import {
  assignLayerTrack,
  setTimelineLayerDucking,
  timelineLayerLockedTrackId
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { unsupportedEnumValue } from "./enum-error.js";
import { nonNegativeIntegerArg, nonNegativeNumberArg, stringArg, stringArrayArg } from "./args.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  type TimelinePackageEditServices
} from "./timeline-package-edit.js";

export interface TimelineLayerRelationsServices extends TimelinePackageEditServices {}

export async function dispatchTimelineLayerRelationsCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineLayerRelationsServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.timeline.layer.ducking.set") return setDucking(args, services);
  if (command === "motion.timeline.layer.track.assign") return assignTrack(args, services);
  return null;
}

async function setDucking(args: unknown, services: TimelineLayerRelationsServices): Promise<MotionDebugResult> {
  const common = readTimelineCommonEditArgs("motion.timeline.layer.ducking.set", args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const triggerLayerIds = stringArrayArg(args, "triggerLayerIds") ?? stringArrayArg(args, "triggers");
  const mode = stringArg(args, "mode");
  const duckToVolume = nonNegativeNumberArg(args, "duckToVolume");
  const attackMs = nonNegativeNumberArg(args, "attackMs");
  const releaseMs = nonNegativeNumberArg(args, "releaseMs");
  // sidechain-only compressor knobs; range enforced by setTimelineLayerDucking.
  const threshold = nonNegativeNumberArg(args, "threshold");
  const ratio = nonNegativeNumberArg(args, "ratio");
  if (!layerId) return invalidArgs("motion.timeline.layer.ducking.set requires layerId.");
  if (!triggerLayerIds || triggerLayerIds.length === 0) return invalidArgs("motion.timeline.layer.ducking.set requires triggerLayerIds.");
  if (mode !== null && mode !== "timed" && mode !== "sidechain") return unsupportedEnumValue("mode", mode, "duckingMode");
  if (duckToVolume === false || attackMs === false || releaseMs === false) {
    return invalidArgs("duckToVolume, attackMs, and releaseMs must be non-negative finite numbers.");
  }
  if (threshold === false || ratio === false) {
    return invalidArgs("threshold and ratio must be non-negative finite numbers.");
  }
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.layer.ducking.set",
    receiptPrefix: "timeline-layer-ducking",
    receiptFileName: "timeline-layer-ducking.receipt.json",
    invalidCode: "timeline_layer_ducking_invalid",
    failureCode: "timeline_layer_ducking_failed",
    services,
    mutate: (pkg) => {
      const result = setTimelineLayerDucking(pkg.motion, {
        layerId, triggerLayerIds,
        ...(mode !== null ? { mode: mode as "timed" | "sidechain" } : {}),
        ...(duckToVolume !== null ? { duckToVolume } : {}),
        ...(attackMs !== null ? { attackMs } : {}),
        ...(releaseMs !== null ? { releaseMs } : {}),
        ...(threshold !== null ? { threshold } : {}),
        ...(ratio !== null ? { ratio } : {})
      });
      const lockedTrackId = timelineLayerLockedTrackId(pkg.motion, result.layer);
      if (lockedTrackId) throw new Error(`Cannot edit layer on locked track: ${lockedTrackId}.`);
      return result;
    },
    outputFacts: (result) => ({ layerId: result.layerId, oldDucking: result.oldDucking, newDucking: result.newDucking, changedPaths: result.changedPaths, action: result.action, layer: result.layer }),
    resultFacts: (result) => ({ changedPaths: result.changedPaths, action: result.action, layerId: result.layerId, oldDucking: result.oldDucking, newDucking: result.newDucking, layer: result.layer }),
    visibleFacts: (result) => ({ layerId: result.layerId, action: result.action, oldDucking: result.oldDucking, newDucking: result.newDucking, changedPaths: result.changedPaths })
  });
}

async function assignTrack(args: unknown, services: TimelineLayerRelationsServices): Promise<MotionDebugResult> {
  const common = readTimelineCommonEditArgs("motion.timeline.layer.track.assign", args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const trackId = stringArg(args, "trackId") ?? stringArg(args, "track");
  const index = nonNegativeIntegerArg(args, "index");
  if (!layerId) return invalidArgs("motion.timeline.layer.track.assign requires layerId.");
  if (!trackId) return invalidArgs("motion.timeline.layer.track.assign requires trackId.");
  if (index === false) return invalidArgs("index must be a non-negative integer.");
  return commitAtomicTimelineMutation({
    ...common,
    command: "motion.timeline.layer.track.assign",
    receiptPrefix: "timeline-layer-track-assign",
    receiptFileName: "timeline-layer-track-assign.receipt.json",
    invalidCode: "timeline_layer_track_invalid",
    failureCode: "timeline_layer_track_assign_failed",
    services,
    mutate: (pkg) => assignLayerTrack(pkg.motion, { layerId, trackId, ...(index !== null ? { index } : {}) }),
    outputFacts: (result) => ({ layerId, oldTrackId: result.oldTrackId, newTrackId: result.newTrackId, oldIndex: result.oldIndex, newIndex: result.newIndex, changedPaths: result.changedPaths, action: result.action, removedFromTrackIds: result.removedFromTrackIds }),
    resultFacts: (result) => ({ changedPaths: result.changedPaths, action: result.action, oldTrackId: result.oldTrackId, newTrackId: result.newTrackId, oldIndex: result.oldIndex, newIndex: result.newIndex, removedFromTrackIds: result.removedFromTrackIds, layer: result.layer }),
    visibleFacts: (result) => ({ layerId, oldTrackId: result.oldTrackId, newTrackId: result.newTrackId, oldIndex: result.oldIndex, newIndex: result.newIndex, removedFromTrackIds: result.removedFromTrackIds, action: result.action, changedPaths: result.changedPaths })
  });
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
