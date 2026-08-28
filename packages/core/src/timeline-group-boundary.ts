/** Ownership-aware boundary for generic timeline layer mutations. */
import {
  timelineLayerLockedTrackId,
  trimLayerTiming,
  type LayerTimingTrim,
  type LayerTimingTrimResult
} from "./timeline";
import { readMotionGroupGraph } from "./motion-group-structural-support";
import type { MotionDocument, MotionLayer } from "./types";

export interface TimelineLayerTrim extends LayerTimingTrim {
  layerId: string;
}

export interface TimelineLayerTrimResult extends LayerTimingTrimResult {
  motion: MotionDocument;
  layerId: string;
}

/** Refuses group containers and group-owned children before ordinary root-layer timing is applied. */
export function trimTimelineLayer(motion: MotionDocument, input: TimelineLayerTrim): TimelineLayerTrimResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");
  const layerIndex = motion.layers.findIndex((layer) => layer.id === input.layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${input.layerId}.`);
  const layer = motion.layers[layerIndex];
  assertGenericLayerStructuralTarget(motion, layer, "trim", "trimMotionGroup");
  const lockedTrackId = timelineLayerLockedTrackId(motion, layer);
  if (lockedTrackId) throw new Error(`Cannot edit layer on locked track: ${lockedTrackId}.`);
  const trimmed = trimLayerTiming(layer, input);
  return {
    ...trimmed,
    motion: { ...motion, layers: motion.layers.map((candidate, index) => index === layerIndex ? trimmed.layer : candidate) },
    layerId: layer.id
  };
}

/** Generic flat-layer operations cannot preserve the owner's local time or child ordering. */
export function assertGenericLayerStructuralTarget(
  motion: MotionDocument,
  layer: MotionLayer,
  operation: "trim" | "split" | "delete" | "duplicate" | "reorder",
  dedicatedOperation: string
): void {
  const graph = readMotionGroupGraph(motion);
  if (layer.type === "group") {
    throw new Error(`Cannot ${operation} group layer ${layer.id} through a generic layer operation; use ${dedicatedOperation}.`);
  }
  const parentGroupId = graph.parentByChildId.get(layer.id);
  if (parentGroupId) {
    throw new Error(`Cannot ${operation} group-owned layer ${layer.id} through a generic layer operation; use a dedicated operation for owning group ${parentGroupId}.`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
