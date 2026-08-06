import type {
  MotionSdkTimelineEdit,
  MotionSdkTimelineReceiptOperation,
} from "./timeline-edit-types.js";
import { spatialTimelineReceiptOperation } from "./spatial-timeline-normalize.js";

export function timelineEditReceiptOperation(
  kind: MotionSdkTimelineEdit["kind"] | unknown,
): MotionSdkTimelineReceiptOperation | null {
  const spatial = spatialTimelineReceiptOperation(kind);
  if (spatial) return spatial;
  if (kind === "rich.set") return "timeline.layer.rich.set";
  if (kind === "keyframe.upsert") return "timeline.keyframe.upsert";
  if (kind === "keyframe.delete") return "timeline.keyframe.delete";
  if (kind === "keyframe.range.delete") return "timeline.keyframe.range.delete";
  if (kind === "keyframe.move") return "timeline.keyframe.move";
  if (kind === "keyframe.easing.apply") return "timeline.keyframe.easing.apply";
  if (kind === "keyframe.shift") return "timeline.keyframe.shift";
  if (kind === "keyframe.scale") return "timeline.keyframe.scale";
  if (kind === "keyframe.duplicate") return "timeline.keyframe.duplicate";
  if (kind === "keyframe.distribute") return "timeline.keyframe.distribute";
  if (kind === "keyframe.reverse") return "timeline.keyframe.reverse";
  if (kind === "keyframe.snap") return "timeline.keyframe.snap";
  return null;
}
