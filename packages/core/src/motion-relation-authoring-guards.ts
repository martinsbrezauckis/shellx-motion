import type { MotionRelationDocument } from "./motion-relation-types";

/**
 * Relation bindings own target-transform authority, so changing that authority observes the
 * target layer and its owning track locks. Sources are only sampled and remain readable while
 * locked. Keeping this outside mutation and bake leaves makes their COW lock semantics identical.
 */
export function assertMotionRelationTargetsEditable(
  motion: MotionRelationDocument,
  targetLayerIds: readonly string[],
): void {
  for (const targetLayerId of [...new Set(targetLayerIds)]) {
    const layer = motion.layers.find((candidate) => candidate.id === targetLayerId);
    if (!layer) continue;
    if (layer.locked) throw new Error(`Cannot edit locked layer: ${targetLayerId}.`);
    const lockedTrack = (motion.tracks ?? []).find((track) => track.locked
      && (track.id === layer.trackId || track.layerIds?.includes(layer.id)));
    if (lockedTrack) throw new Error(`Cannot edit relation on locked track: ${lockedTrack.id}.`);
  }
}
