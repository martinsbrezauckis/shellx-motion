/** Typed replay for one prevalidated revision transaction. */
import {
  canonicalJsonSha256, deleteLayerKeyframe, deleteLayerSpatialPosition, loadSchema,
  moveLayerKeyframe, moveLayerSpatialPosition, setTimelineLayerLock, setTimelineLayerName,
  setTimelineLayerText, setTimelineLayerVisibility, timelineLayerLockedTrackId,
  upsertLayerKeyframe, upsertLayerSpatialPosition, validateDocument,
  type MotionDocument, type MotionLayer
} from "@shellx-motion/core";
import type { RevisionTransactionStep } from "./revision-transaction-parser.js";

export interface AppliedRevisionStep {
  index: number;
  command: RevisionTransactionStep["command"];
  stepSha256: string;
  changedPaths: string[];
}
export interface AppliedRevisionTransaction {
  motion: MotionDocument;
  steps: AppliedRevisionStep[];
  validation: Awaited<ReturnType<typeof validateDocument>>;
}
export class RevisionStepError extends Error {
  constructor(readonly index: number, readonly command: string, message: string) { super(message); this.name = "RevisionStepError"; }
}

export async function applyRevisionTransactionSteps(
  motion: MotionDocument,
  steps: RevisionTransactionStep[],
  schema: Awaited<ReturnType<typeof loadSchema>>
): Promise<AppliedRevisionTransaction> {
  let current = structuredClone(motion);
  const applied: AppliedRevisionStep[] = [];
  for (const [index, step] of steps.entries()) {
    try {
      const mutation = applyStep(current, step);
      current = mutation.motion;
      const validation = await validateDocument(schema, current);
      if (!validation.ok) throw new Error(validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; "));
      applied.push({ index, command: step.command, stepSha256: canonicalJsonSha256(step), changedPaths: mutation.changedPaths });
    } catch (error) {
      throw new RevisionStepError(index, step.command, error instanceof Error ? error.message : String(error));
    }
  }
  const validation = await validateDocument(schema, current);
  if (!validation.ok) throw new RevisionStepError(steps.length - 1, "final", "The final Motion document failed validation.");
  return { motion: current, steps: applied, validation };
}

function applyStep(motion: MotionDocument, step: RevisionTransactionStep): { motion: MotionDocument; changedPaths: string[] } {
  switch (step.command) {
    case "motion.timeline.layer.text.set": return changed(setTimelineLayerText(motion, step));
    case "motion.timeline.layer.name.set": return changed(setTimelineLayerName(motion, step));
    case "motion.timeline.layer.visibility.set": return changed(setTimelineLayerVisibility(motion, step));
    case "motion.timeline.layer.lock": return changed(setTimelineLayerLock(motion, step));
    case "motion.timeline.keyframe.upsert": return mutateLayer(motion, step.layerId, (layer) => upsertLayerKeyframe(layer, { target: step.target, atMs: step.atMs, value: step.value, ...(step.easing ? { easing: step.easing } : {}) }));
    case "motion.timeline.keyframe.delete": return mutateLayer(motion, step.layerId, (layer) => deleteLayerKeyframe(layer, { target: step.target, atMs: step.atMs }));
    case "motion.timeline.keyframe.move": return mutateLayer(motion, step.layerId, (layer) => moveLayerKeyframe(layer, { target: step.target, fromMs: step.fromMs, toMs: step.toMs }));
    case "motion.timeline.spatial.position.upsert": return mutateLayer(motion, step.layerId, (layer) => upsertLayerSpatialPosition(layer, { atMs: step.atMs, x: step.x, y: step.y, ...(step.easing ? { easing: step.easing } : {}) }));
    case "motion.timeline.spatial.position.move": return mutateLayer(motion, step.layerId, (layer) => moveLayerSpatialPosition(layer, { fromMs: step.fromMs, toMs: step.toMs }));
    case "motion.timeline.spatial.position.delete": return mutateLayer(motion, step.layerId, (layer) => deleteLayerSpatialPosition(layer, { atMs: step.atMs }));
  }
}

function changed(mutation: { motion: MotionDocument; changedPath?: string; changedPaths?: string[] }): { motion: MotionDocument; changedPaths: string[] } {
  return { motion: mutation.motion, changedPaths: mutation.changedPaths ?? (mutation.changedPath ? [mutation.changedPath] : []) };
}
function mutateLayer(motion: MotionDocument, layerId: string, edit: (layer: MotionLayer) => { layer: MotionLayer; changedPath?: string; changedPaths?: string[] }): { motion: MotionDocument; changedPaths: string[] } {
  const index = motion.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) throw new Error(`Motion layer not found: ${layerId}.`);
  const layer = motion.layers[index];
  const lockedTrackId = timelineLayerLockedTrackId(motion, layer);
  if (lockedTrackId) throw new Error(`Cannot edit layer on locked track: ${lockedTrackId}.`);
  const mutation = edit(layer);
  return { motion: { ...motion, layers: motion.layers.map((candidate, at) => at === index ? mutation.layer : candidate) }, changedPaths: mutation.changedPaths ?? (mutation.changedPath ? [mutation.changedPath] : []) };
}
