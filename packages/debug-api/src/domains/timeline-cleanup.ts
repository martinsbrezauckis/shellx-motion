/** Timeline reference cleanup through the shared atomic package-edit executor. */
import { cleanupMotionTimeline } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  type TimelinePackageEditServices
} from "./timeline-package-edit.js";

export interface TimelineCleanupServices extends TimelinePackageEditServices {}

export async function dispatchTimelineCleanupCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineCleanupServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.timeline.cleanup") return null;
  const common = readTimelineCommonEditArgs(command, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  return commitAtomicTimelineMutation({
    ...common,
    command,
    receiptPrefix: "timeline-cleanup",
    receiptFileName: "timeline-cleanup.receipt.json",
    invalidCode: "timeline_cleanup_invalid",
    failureCode: "timeline_cleanup_failed",
    services,
    mutate: (pkg) => cleanupMotionTimeline(pkg.motion),
    outputFacts: (cleanup) => {
      const removedRefCount = refCount(cleanup);
      return {
        changedPaths: cleanup.changedPaths,
        removedTrackLayerRefs: cleanup.removedTrackLayerRefs,
        removedSceneTrackRefs: cleanup.removedSceneTrackRefs,
        removedSceneMarkerRefs: cleanup.removedSceneMarkerRefs,
        removedRefCount,
        oldDurationMs: cleanup.oldDurationMs,
        newDurationMs: cleanup.newDurationMs,
        durationChanged: cleanup.durationChanged,
        action: cleanup.action
      };
    },
    resultFacts: (cleanup) => ({
      changedPaths: cleanup.changedPaths,
      action: cleanup.action,
      removedTrackLayerRefs: cleanup.removedTrackLayerRefs,
      removedSceneTrackRefs: cleanup.removedSceneTrackRefs,
      removedSceneMarkerRefs: cleanup.removedSceneMarkerRefs,
      removedRefCount: refCount(cleanup),
      oldDurationMs: cleanup.oldDurationMs,
      newDurationMs: cleanup.newDurationMs,
      durationChanged: cleanup.durationChanged
    }),
    visibleFacts: (cleanup) => ({
      changedPaths: cleanup.changedPaths,
      removedRefCount: refCount(cleanup),
      oldDurationMs: cleanup.oldDurationMs,
      newDurationMs: cleanup.newDurationMs
    })
  });
}

function refCount(cleanup: ReturnType<typeof cleanupMotionTimeline>): number {
  return cleanup.removedTrackLayerRefs.length + cleanup.removedSceneTrackRefs.length + cleanup.removedSceneMarkerRefs.length;
}
