import { canonicalJsonSha256 } from "./canonical-json";
import { evaluateMotionRelationFrame, type MotionRelationFrameSample } from "./motion-relation-evaluate";
import { MOTION_RELATION_FRAME_PLAN_SCHEMA, MOTION_RELATION_STATIC_PLAN_SCHEMA, type MotionRelationDocument } from "./motion-relation-types";
import { validateMotionRelations } from "./motion-relation-validate";

export interface MotionRelationStaticPlan {
  schema: typeof MOTION_RELATION_STATIC_PLAN_SCHEMA;
  relationSourceSha256: string | null;
  bindings: readonly {
    id: string;
    kind: "attach" | "aim";
    sourceLayerId: string;
    targetLayerId: string;
    enabled: boolean;
    startUs: number;
    durationUs: number;
    writeMask: readonly string[];
    sourceSha256: string;
    workUnits: number;
  }[];
  budget: { inputBytes: number; bindingCount: number; enabledBindingCount: number; frameWorkUnits: number };
  fingerprint: string;
}
export interface MotionRelationFramePlan {
  schema: typeof MOTION_RELATION_FRAME_PLAN_SCHEMA;
  staticFingerprint: string;
  atUs: number;
  samples: readonly MotionRelationFrameSample[];
  budget: { activeBindingCount: number; frameWorkUnits: number };
  fingerprint: string;
}
export type MotionRelationStaticPlanResult = { ok: true; plan: MotionRelationStaticPlan } | { ok: false; message: string };
export type MotionRelationFramePlanResult = { ok: true; plan: MotionRelationFramePlan } | { ok: false; message: string };

/** Separate identity rail. Existing renderer static/frame plan schemas remain byte-identical. */
export function compileMotionRelationStaticPlan(motion: MotionRelationDocument): MotionRelationStaticPlanResult {
  const checked = validateMotionRelations(motion.relations, motion);
  if (!checked.ok) return { ok: false, message: `Motion relations invalid at ${checked.issues[0]!.path}: ${checked.issues[0]!.message}` };
  const bindings = checked.bindings.map(({ binding, writeMask, sourceSha256, workUnits }) => Object.freeze({
    id: binding.id,
    kind: binding.kind,
    sourceLayerId: binding.source.layerId,
    targetLayerId: binding.target.layerId,
    enabled: binding.enabled,
    startUs: binding.startUs,
    durationUs: binding.durationUs,
    writeMask: Object.freeze([...writeMask]),
    sourceSha256,
    workUnits,
  }));
  const budget = Object.freeze({ inputBytes: checked.budget.inputBytes, bindingCount: checked.budget.bindingCount, enabledBindingCount: checked.budget.enabledBindingCount, frameWorkUnits: checked.budget.frameWorkUnits });
  const payload = { schema: MOTION_RELATION_STATIC_PLAN_SCHEMA, relationSourceSha256: checked.store ? canonicalJsonSha256(checked.store) : null, bindings, budget };
  return { ok: true, plan: Object.freeze({ ...payload, bindings: Object.freeze(bindings), fingerprint: canonicalJsonSha256(payload) }) };
}

/** Exact microsecond relation-frame identity for a later renderer composition join. */
export function compileMotionRelationFramePlan(motion: MotionRelationDocument, atUs: number, input?: Parameters<typeof evaluateMotionRelationFrame>[2]): MotionRelationFramePlanResult {
  const staticPlan = compileMotionRelationStaticPlan(motion);
  if (!staticPlan.ok) return staticPlan;
  try {
    const evaluation = evaluateMotionRelationFrame(motion, atUs, input);
    const budget = Object.freeze({ activeBindingCount: evaluation.samples.length, frameWorkUnits: evaluation.frameWorkUnits });
    const payload = { schema: MOTION_RELATION_FRAME_PLAN_SCHEMA, staticFingerprint: staticPlan.plan.fingerprint, atUs, samples: evaluation.samples, budget };
    return { ok: true, plan: Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Motion relation frame planning refused." };
  }
}
