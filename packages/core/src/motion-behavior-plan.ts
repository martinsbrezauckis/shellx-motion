import { canonicalJsonSha256 } from "./canonical-json";
import { evaluateMotionBehaviorFrame } from "./motion-behavior-evaluate";
import { validateMotionBehaviors } from "./motion-behavior-validate";
import type { MotionDocument } from "./types";

export const MOTION_BEHAVIOR_STATIC_PLAN_SCHEMA = "shellx-motion/behavior-static-plan@1" as const;
export const MOTION_BEHAVIOR_FRAME_PLAN_SCHEMA = "shellx-motion/behavior-frame-plan@1" as const;

export interface MotionBehaviorStaticPlan {
  schema: typeof MOTION_BEHAVIOR_STATIC_PLAN_SCHEMA;
  behaviorSourceSha256: string | null;
  bindings: readonly { targetLayerId: string; kind: "path-follow" | "transform"; enabled: boolean; startUs: number; durationUs: number; sourceSha256: string; workUnits: number }[];
  budget: { inputBytes: number; bindingCount: number; enabledBindingCount: number; frameWorkUnits: number };
  fingerprint: string;
}
export interface MotionBehaviorFramePlan {
  schema: typeof MOTION_BEHAVIOR_FRAME_PLAN_SCHEMA;
  staticFingerprint: string;
  atUs: number;
  samples: ReturnType<typeof evaluateMotionBehaviorFrame>["samples"];
  budget: { activeBindingCount: number; frameWorkUnits: number };
  fingerprint: string;
}
export type MotionBehaviorStaticPlanResult = { ok: true; plan: MotionBehaviorStaticPlan } | { ok: false; message: string };
export type MotionBehaviorFramePlanResult = { ok: true; plan: MotionBehaviorFramePlan } | { ok: false; message: string };

/** Separate behavior identity: Phase 1 deliberately does not change GPU static-plan@1. */
export function compileMotionBehaviorStaticPlan(motion: MotionDocument): MotionBehaviorStaticPlanResult {
  const checked = validateMotionBehaviors(motion.behaviors, motion);
  if (!checked.ok) return { ok: false, message: `Motion behaviors invalid at ${checked.issues[0]!.path}: ${checked.issues[0]!.message}` };
  const bindings = checked.bindings.map(({ binding, sourceSha256, workUnits }) => Object.freeze({ targetLayerId: binding.targetLayerId, kind: binding.kind, enabled: binding.enabled, startUs: binding.startUs, durationUs: binding.durationUs, sourceSha256, workUnits }));
  const budget = Object.freeze({ inputBytes: checked.budget.inputBytes, bindingCount: checked.budget.bindingCount, enabledBindingCount: checked.budget.enabledBindingCount, frameWorkUnits: checked.budget.frameWorkUnits });
  const payload = { schema: MOTION_BEHAVIOR_STATIC_PLAN_SCHEMA, behaviorSourceSha256: checked.store ? canonicalJsonSha256(checked.store) : null, bindings, budget };
  return { ok: true, plan: Object.freeze({ ...payload, bindings: Object.freeze(bindings), fingerprint: canonicalJsonSha256(payload) }) };
}

/** Exact microsecond frame identity for future renderer joins; existing frame-plan schemas are unchanged. */
export function compileMotionBehaviorFramePlan(motion: MotionDocument, atUs: number): MotionBehaviorFramePlanResult {
  const staticPlan = compileMotionBehaviorStaticPlan(motion);
  if (!staticPlan.ok) return staticPlan;
  try {
    const evaluation = evaluateMotionBehaviorFrame(motion, atUs);
    const budget = Object.freeze({ activeBindingCount: evaluation.samples.length, frameWorkUnits: evaluation.frameWorkUnits });
    const payload = { schema: MOTION_BEHAVIOR_FRAME_PLAN_SCHEMA, staticFingerprint: staticPlan.plan.fingerprint, atUs, samples: evaluation.samples, budget };
    return { ok: true, plan: Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Motion behavior frame planning refused." };
  }
}
