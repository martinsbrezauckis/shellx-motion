import { canonicalJsonSha256 } from "./canonical-json";
import { evaluateMotionBehaviorFrame } from "./motion-behavior-evaluate";
import { evaluateMotionProceduralLayers } from "./procedural-relationship-evaluate";
import { evaluateMotionRelationFrame, type MotionRelationFrameEvaluation } from "./motion-relation-evaluate";
import { compileMotionRelationStaticPlan, type MotionRelationFramePlanResult } from "./motion-relation-plan";
import { MOTION_RELATION_FRAME_PLAN_SCHEMA, type MotionRelationDocument } from "./motion-relation-types";
import type { MotionLayer } from "./types";

export const MOTION_RELATION_LEGACY_MILLISECONDS_PER_MICROSECOND = 1_000;
type AuthoringFrameAuthority = Readonly<{ motion: MotionRelationDocument; documentFingerprint: string; evaluationFingerprint: string; atUs: number }>;
const authoringFrameAuthorities = new WeakMap<object, AuthoringFrameAuthority>();

/**
 * Converts the current legacy-keyframe bridge without a floating-point time round trip. A future
 * all-microsecond timeline rail may be broader, but this authoring vertical only materializes
 * samples that ordinary `atMs` keyframes can identify exactly.
 */
export function motionRelationLegacyAtMs(atUs: number, motion: MotionRelationDocument): number {
  const durationUs = motion.durationMs * MOTION_RELATION_LEGACY_MILLISECONDS_PER_MICROSECOND;
  if (!Number.isSafeInteger(atUs) || atUs < 0 || !Number.isSafeInteger(durationUs) || atUs > durationUs) {
    throw new Error("Motion relation authoring evaluation requires a safe integer microsecond playhead within the document duration.");
  }
  if (atUs % MOTION_RELATION_LEGACY_MILLISECONDS_PER_MICROSECOND !== 0) {
    throw new Error("Motion relation authoring evaluation requires a whole-millisecond representable microsecond playhead.");
  }
  return atUs / MOTION_RELATION_LEGACY_MILLISECONDS_PER_MICROSECOND;
}

/**
 * Core-owned authoring composition in the documented authority order. This is intentionally not a
 * renderer admission/lowerer: it exists so inspect and bake can sample the same bounded data that
 * a future relation renderer must compose.
 */
export function evaluateMotionRelationAuthoringFrame(
  motion: MotionRelationDocument,
  atUs: number,
): MotionRelationFrameEvaluation {
  const evaluation = evaluateMotionRelationFrame(motion, atUs, { baseLayers: authoringBaseLayers(motion, atUs) });
  authoringFrameAuthorities.set(evaluation, Object.freeze({
    motion,
    documentFingerprint: canonicalJsonSha256(motion),
    evaluationFingerprint: canonicalJsonSha256(evaluation),
    atUs,
  }));
  return evaluation;
}

/** Binds a public inspect sample to the existing relation-frame-plan@1 identity. */
export function compileMotionRelationAuthoringFramePlan(
  motion: MotionRelationDocument,
  atUs: number,
): MotionRelationFramePlanResult {
  try {
    return compileMotionRelationAuthoringFramePlanFromEvaluation(motion, evaluateMotionRelationAuthoringFrame(motion, atUs));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Motion relation authoring frame planning refused." };
  }
}

/**
 * Binds an already-owned T3C evaluation without re-running its legacy/procedural/behavior base
 * pipeline. Renderer wrappers use this to carry exactly one authoritative dynamic snapshot.
 */
export function compileMotionRelationAuthoringFramePlanFromEvaluation(
  motion: MotionRelationDocument,
  evaluation: MotionRelationFrameEvaluation,
): MotionRelationFramePlanResult {
  try {
    motionRelationLegacyAtMs(evaluation.atUs, motion);
    const authority = authoringFrameAuthorities.get(evaluation as unknown as object);
    if (!authority) return { ok: false, message: "Motion relation authoring frame planning requires an exact Core-issued authoring evaluation." };
    if (
      authority.motion !== motion
      || authority.atUs !== evaluation.atUs
      || authority.documentFingerprint !== canonicalJsonSha256(motion)
      || authority.evaluationFingerprint !== canonicalJsonSha256(evaluation)
    ) {
      return { ok: false, message: "Motion relation authoring frame evaluation is stale for this Motion document or playhead." };
    }
    const staticPlan = compileMotionRelationStaticPlan(motion);
    if (!staticPlan.ok) return staticPlan;
    const budget = Object.freeze({ activeBindingCount: evaluation.samples.length, frameWorkUnits: evaluation.frameWorkUnits });
    const payload = { schema: MOTION_RELATION_FRAME_PLAN_SCHEMA, staticFingerprint: staticPlan.plan.fingerprint, atUs: evaluation.atUs, samples: evaluation.samples, budget };
    return { ok: true, plan: Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Motion relation authoring frame planning refused." };
  }
}

function authoringBaseLayers(motion: MotionRelationDocument, atUs: number): MotionLayer[] {
  const atMs = motionRelationLegacyAtMs(atUs, motion);
  const procedural = evaluateMotionProceduralLayers(motion, atMs);
  const behaviors = evaluateMotionBehaviorFrame(motion, atUs);
  return overlayBehaviorTransforms(procedural.layers, behaviors.samples);
}

function overlayBehaviorTransforms(
  layers: readonly MotionLayer[],
  samples: ReturnType<typeof evaluateMotionBehaviorFrame>["samples"],
): MotionLayer[] {
  const transforms = new Map(samples.map((sample) => [sample.targetLayerId, sample.transform]));
  return layers.map((layer) => {
    const transform = transforms.get(layer.id);
    return transform ? { ...layer, transform: { ...(layer.transform ?? {}), ...transform } } : layer;
  });
}
