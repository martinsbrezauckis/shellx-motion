import { canonicalJsonSha256 } from "./canonical-json";
import { compileGpuScene2dPlan, type GpuScene2dCompileResources, type GpuScene2dFailure } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan, type GpuSceneStaticCompileResources, type GpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { gpuVideoTimelineAtUs } from "./gpu-video-frame-request";
import { effectiveLayerAtUs } from "./motion-behavior-evaluate";
import { compileMotionBehaviorFramePlan, compileMotionBehaviorStaticPlan, type MotionBehaviorFramePlan, type MotionBehaviorStaticPlan } from "./motion-behavior-plan";
import { validateMotionBehaviors } from "./motion-behavior-validate";
import type { GpuFramePlan } from "./gpu-frame-intent";
import type { MotionDocument, MotionLayer } from "./types";

export const GPU_SCENE_BEHAVIOR_STATIC_PLAN_SCHEMA = "shellx-motion/gpu-scene-behavior-static@1" as const;
export const GPU_SCENE_BEHAVIOR_FRAME_PLAN_SCHEMA = "shellx-motion/gpu-scene-behavior-frame@1" as const;

export interface GpuSceneBehaviorStaticPlan {
  schema: typeof GPU_SCENE_BEHAVIOR_STATIC_PLAN_SCHEMA;
  /** Ordinary legacy staging plan; its @1 schema and fingerprint remain unchanged. */
  basePlan: GpuSceneStaticPlan;
  /** Separate evaluator plan, kept outside the legacy static-plan@1 payload. */
  behaviorPlan: MotionBehaviorStaticPlan;
  baseStaticFingerprint: string;
  behaviorStaticFingerprint: string;
  behaviorSourceSha256: string;
  targetLayerIds: readonly string[];
  budget: Readonly<{ baseResourceReferenceCount: number; behaviorInputBytes: number; bindingCount: number; enabledBindingCount: number; behaviorFrameWorkUnits: number }>;
  fingerprint: string;
}
export interface GpuSceneBehaviorFramePlan {
  schema: typeof GPU_SCENE_BEHAVIOR_FRAME_PLAN_SCHEMA;
  staticFingerprint: string;
  atUs: number;
  frame: GpuFramePlan;
  baseFrameFingerprint: string;
  behaviorFrameFingerprint: string;
  activeTargetLayerIds: readonly string[];
  budget: Readonly<{ activeBindingCount: number; behaviorFrameWorkUnits: number; drawCount: number; triangleVertexCount: number }>;
  fingerprint: string;
}
/** Stable per-frame behavior proof used by streaming and durable GPU segment stores. */
export interface GpuSceneBehaviorFrameEvidenceFact {
  readonly index: number;
  readonly atMs: number;
  readonly atUs: number;
  readonly fingerprint: string;
  readonly budgetSha256: string;
}
export type GpuSceneBehaviorStaticPlanResult = { ok: true; plan: GpuSceneBehaviorStaticPlan } | { ok: false; failure: GpuScene2dFailure };
export type GpuSceneBehaviorFramePlanResult = { ok: true; plan: GpuSceneBehaviorFramePlan } | { ok: false; failure: GpuScene2dFailure };
type PreparedBehaviorMotion = { ok: true; motion: MotionDocument; behavior: MotionBehaviorStaticPlan; targetLayerIds: readonly string[] } | { ok: false; failure: GpuScene2dFailure };

/**
 * Parallel composition identity. It leaves gpu-scene-static-plan@1 untouched and binds that legacy
 * plan to the separately-versioned behavior evaluator identity.
 */
export function compileGpuSceneBehaviorStaticPlan(motion: MotionDocument, resources: GpuSceneStaticCompileResources = {}): GpuSceneBehaviorStaticPlanResult {
  const prepared = prepare(motion);
  if (!prepared.ok) return prepared;
  const base = compileGpuSceneStaticPlan(prepared.motion, resources);
  if (!base.ok) return base;
  // The current behavior rail only composes ordinary Core-owned draws.  Hybrid
  // frames need their own exact-time source capture, so admitting the static
  // topology here would otherwise create a false GPU capability promise.
  if (base.plan.hybridTextures?.length) {
    return fail("gpu_unsupported_feature", "GPU behavior composition does not combine document behaviors@1 with hybrid GPU source capture.");
  }
  // Behavior frames cross the legacy millisecond GPU bridge.  Until the
  // behavior wrapper binds every decoded source/request identity, allowing a
  // video resource through would let a stale provider stand in for an absent
  // per-frame Core request.  Refuse before any resource preparation instead.
  if (base.plan.maxima.maxVideoCount > 0) {
    return fail("gpu_unsupported_feature", "GPU behavior composition does not combine document behaviors@1 with video sources before exact behavior video request binding exists.");
  }
  const { behavior } = prepared;
  const payload = {
    schema: GPU_SCENE_BEHAVIOR_STATIC_PLAN_SCHEMA,
    baseStaticFingerprint: base.plan.fingerprint,
    behaviorStaticFingerprint: behavior.fingerprint,
    behaviorSourceSha256: behavior.behaviorSourceSha256!,
    targetLayerIds: prepared.targetLayerIds,
    budget: { baseResourceReferenceCount: base.plan.maxima.resourceReferenceCount, behaviorInputBytes: behavior.budget.inputBytes, bindingCount: behavior.budget.bindingCount, enabledBindingCount: behavior.budget.enabledBindingCount, behaviorFrameWorkUnits: behavior.budget.frameWorkUnits },
  };
  return { ok: true, plan: freeze({ ...payload, basePlan: base.plan, behaviorPlan: behavior, targetLayerIds: Object.freeze([...payload.targetLayerIds]), budget: Object.freeze(payload.budget), fingerprint: canonicalJsonSha256(payload) }) };
}

/**
 * Samples root time exactly once, overlays only validated root targets, then uses the unmodified
 * legacy compiler to emit its ordinary GPU frame plan. Targeted motion blur refuses before output.
 */
export function compileGpuSceneBehaviorFramePlan(motion: MotionDocument, atUs: number, resources: GpuScene2dCompileResources = {}): GpuSceneBehaviorFramePlanResult {
  if (!validRootAtUs(motion, atUs)) return fail("gpu_invalid_time", "GPU behavior composition requires a safe integer root atUs within the document duration.");
  // The legacy lowerer still accepts milliseconds and canonicalizes them back to microseconds.
  // Never let a legal safe-integer behavior time shift by one microsecond through that bridge.
  if (gpuVideoTimelineAtUs(atUs / 1_000) !== atUs) return fail("gpu_invalid_time", "GPU behavior composition atUs cannot round-trip through the legacy GPU millisecond ABI.");
  const prepared = prepare(motion);
  if (!prepared.ok) return prepared;
  const staticPlan = compileGpuSceneBehaviorStaticPlan(motion);
  if (!staticPlan.ok) return staticPlan;
  const behaviorFrame = compileMotionBehaviorFramePlan(motion, atUs);
  if (!behaviorFrame.ok) return fail("gpu_unsupported_feature", behaviorFrame.message);
  const targetIds = new Set(prepared.targetLayerIds);
  const source = applyBehaviorTransforms(motion, targetIds, atUs, behaviorFrame.plan);
  const base = compileGpuScene2dPlan(source, atUs / 1_000, resources);
  if (!base.ok) return base;
  const activeTargetLayerIds = behaviorFrame.plan.samples.map((sample) => sample.targetLayerId);
  const budget = { activeBindingCount: behaviorFrame.plan.budget.activeBindingCount, behaviorFrameWorkUnits: behaviorFrame.plan.budget.frameWorkUnits, drawCount: base.plan.frame.draws.length, triangleVertexCount: base.plan.frame.budget.triangleVertexCount };
  const payload = { schema: GPU_SCENE_BEHAVIOR_FRAME_PLAN_SCHEMA, staticFingerprint: staticPlan.plan.fingerprint, atUs, baseFrameFingerprint: base.plan.frame.fingerprint, behaviorFrameFingerprint: behaviorFrame.plan.fingerprint, activeTargetLayerIds, budget };
  return { ok: true, plan: freeze({ ...payload, frame: base.plan.frame, activeTargetLayerIds: Object.freeze([...activeTargetLayerIds]), budget: Object.freeze(budget), fingerprint: canonicalJsonSha256(payload) }) };
}

export function gpuSceneBehaviorFrameEvidenceFact(index: number, atMs: number, plan: GpuSceneBehaviorFramePlan): GpuSceneBehaviorFrameEvidenceFact {
  return Object.freeze({ index, atMs, atUs: plan.atUs, fingerprint: plan.fingerprint, budgetSha256: canonicalJsonSha256(plan.budget) });
}

/** One canonical sequence shape prevents Browser and durable-store hash drift. */
export function gpuSceneBehaviorFrameEvidenceSequences(frames: readonly GpuSceneBehaviorFrameEvidenceFact[]): Readonly<{ framePlanSequenceSha256: string; frameBudgetSequenceSha256: string }> {
  return Object.freeze({
    framePlanSequenceSha256: canonicalJsonSha256(frames.map(({ index, atMs, atUs, fingerprint }) => ({ index, atMs, atUs, fingerprint }))),
    frameBudgetSequenceSha256: canonicalJsonSha256(frames.map(({ index, atMs, atUs, budgetSha256 }) => ({ index, atMs, atUs, budgetSha256 })))
  });
}

function prepare(motion: MotionDocument): PreparedBehaviorMotion {
  if (!motion.behaviors) return fail("gpu_unsupported_feature", "GPU behavior composition requires document behaviors@1.");
  const checked = validateMotionBehaviors(motion.behaviors, motion);
  if (!checked.ok) return fail("gpu_unsupported_feature", `GPU behavior composition found invalid behaviors at ${checked.issues[0]!.path}: ${checked.issues[0]!.message}`);
  const behavior = compileMotionBehaviorStaticPlan(motion);
  if (!behavior.ok || behavior.plan.behaviorSourceSha256 === null) return fail("gpu_unsupported_feature", behavior.ok ? "GPU behavior composition requires document behaviors@1." : behavior.message);
  for (const resolved of checked.bindings) {
    const layer = motion.layers.find((candidate) => candidate.id === resolved.binding.targetLayerId);
    if (!layer || layer.effects?.motionBlur) return fail("gpu_unsupported_feature", `GPU behavior composition refuses target '${resolved.binding.targetLayerId}' with temporal motion blur until shutter samples evaluate behaviors.`, resolved.binding.targetLayerId);
  }
  return { ok: true, motion: omitBehaviors(motion), behavior: behavior.plan, targetLayerIds: checked.bindings.map((entry) => entry.binding.targetLayerId) };
}

function applyBehaviorTransforms(motion: MotionDocument, targetIds: ReadonlySet<string>, atUs: number, overlay: MotionBehaviorFramePlan): MotionDocument {
  const layers = motion.layers.map((layer) => targetIds.has(layer.id) ? behaviorLayer(motion, layer, atUs, overlay) : layer);
  return { ...omitBehaviors(motion), layers };
}
function behaviorLayer(motion: MotionDocument, layer: MotionLayer, atUs: number, overlay: MotionBehaviorFramePlan): MotionLayer { return effectiveLayerAtUs(motion, layer, atUs, overlay); }
function omitBehaviors(motion: MotionDocument): MotionDocument { const { behaviors: _behaviors, ...next } = motion; return next; }
function validRootAtUs(motion: MotionDocument, atUs: number): boolean { const durationUs = motion.durationMs * 1_000; return Number.isSafeInteger(atUs) && atUs >= 0 && Number.isSafeInteger(durationUs) && atUs <= durationUs; }
function fail(code: GpuScene2dFailure["code"], message: string, layerId?: string): { ok: false; failure: GpuScene2dFailure } { return { ok: false, failure: { code, message, ...(layerId ? { layerId } : {}) } }; }
function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry, seen);
  return Object.freeze(value);
}
