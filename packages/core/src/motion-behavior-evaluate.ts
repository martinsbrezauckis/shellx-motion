import { evaluateMotionPathFollow, type MotionPathFollowTransformIntent } from "./motion-path-follow";
import { evaluateMotionTransformBehavior, type MotionTransformBehaviorIntent } from "./motion-transform-behavior";
import { validateMotionBehaviors, type MotionBehaviorBaseTransform, type ResolvedMotionBehaviorBinding } from "./motion-behavior-validate";
import { effectiveLayerAtMs } from "./timeline";
import type { MotionDocument, MotionLayer } from "./types";

export interface MotionBehaviorFrameSample {
  targetLayerId: string;
  kind: "path-follow" | "transform";
  sourceSha256: string;
  transform: MotionPathFollowTransformIntent | MotionTransformBehaviorIntent;
  workUnits: number;
}
export interface MotionBehaviorFrameEvaluation { atUs: number; samples: readonly MotionBehaviorFrameSample[]; frameWorkUnits: number }
/** A prior exact frame evaluation may be reused by a composition plan at the same root playhead. */
export interface MotionBehaviorFrameOverlay { atUs: number; samples: readonly MotionBehaviorFrameSample[] }

/**
 * New microsecond evaluation rail. Legacy effectiveLayerAtMs remains untouched and is used as the
 * base for every sample; document behaviors only overlay an admitted active transform authority.
 */
export function effectiveLayerAtUs(motion: MotionDocument, layer: MotionLayer, atUs: number, overlay?: MotionBehaviorFrameOverlay): MotionLayer {
  assertAtUs(motion, atUs);
  const base = effectiveLayerAtMs(layer, atUs / 1_000);
  if (!motion.behaviors) return base;
  if (overlay && overlay.atUs !== atUs) throw new Error("Motion behavior overlay must use the exact root microsecond playhead.");
  const evaluation = overlay ?? evaluateMotionBehaviorFrame(motion, atUs);
  const sample = evaluation.samples.find((entry) => entry.targetLayerId === layer.id);
  return sample ? { ...base, transform: { ...(base.transform ?? {}), ...sample.transform } } : base;
}

/** Samples all enabled, active bindings without mutation, callbacks, or history. */
export function evaluateMotionBehaviorFrame(motion: MotionDocument, atUs: number): MotionBehaviorFrameEvaluation {
  assertAtUs(motion, atUs);
  const checked = validateMotionBehaviors(motion.behaviors, motion);
  if (!checked.ok) throw new Error(`Motion behaviors invalid at ${checked.issues[0]!.path}: ${checked.issues[0]!.message}`);
  const samples: MotionBehaviorFrameSample[] = [];
  for (const resolved of checked.bindings) {
    if (!resolved.binding.enabled || atUs < resolved.binding.startUs || atUs > resolved.binding.startUs + resolved.binding.durationUs) continue;
    samples.push(sampleBinding(resolved, atUs));
  }
  return Object.freeze({ atUs, samples: Object.freeze(samples), frameWorkUnits: samples.reduce((total, sample) => total + sample.workUnits, 0) });
}

function sampleBinding(resolved: ResolvedMotionBehaviorBinding, atUs: number): MotionBehaviorFrameSample {
  const { binding } = resolved;
  if (binding.kind === "path-follow") {
    const result = evaluateMotionPathFollow({ schema: "shellx-motion/path-follow@1", atUs, startUs: binding.startUs, durationUs: binding.durationUs, geometry: binding.geometry, ...(binding.offsetUs === undefined ? {} : { offsetUs: binding.offsetUs }), ...(binding.direction === undefined ? {} : { direction: binding.direction }), ...(binding.orientToPath === undefined ? {} : { orientToPath: binding.orientToPath }), ...(binding.easing === undefined ? {} : { easing: binding.easing }) });
    if (!result.ok) throw new Error(`Motion behavior ${binding.targetLayerId} path-follow refused: ${result.message}`);
    return Object.freeze({ targetLayerId: binding.targetLayerId, kind: binding.kind, sourceSha256: resolved.sourceSha256, transform: result.evaluation.transform, workUnits: result.evaluation.budget.workUnits });
  }
  const result = evaluateMotionTransformBehavior({ schema: "shellx-motion/transform-behavior@1", atUs, startUs: binding.startUs, durationUs: binding.durationUs, base: resolved.base as MotionBehaviorBaseTransform, ...(binding.motion === undefined ? {} : { motion: binding.motion }), ...(binding.squash === undefined ? {} : { squash: binding.squash }) });
  if (!result.ok) throw new Error(`Motion behavior ${binding.targetLayerId} transform refused: ${result.message}`);
  return Object.freeze({ targetLayerId: binding.targetLayerId, kind: binding.kind, sourceSha256: resolved.sourceSha256, transform: result.evaluation.transform, workUnits: result.evaluation.budget.workUnits });
}

function assertAtUs(motion: MotionDocument, atUs: number): void {
  const durationUs = motion.durationMs * 1_000;
  if (!Number.isSafeInteger(atUs) || atUs < 0 || !Number.isSafeInteger(durationUs) || atUs > durationUs) throw new Error("Motion behavior evaluation requires a safe integer microsecond playhead within the document duration.");
}
