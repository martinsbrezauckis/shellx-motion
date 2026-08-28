import { canonicalJsonSha256 } from "./canonical-json";
import { compileGpuScene2dPlan, type GpuScene2dCompileResources, type GpuScene2dFailure } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan, type GpuSceneStaticCompileResources, type GpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { gpuVideoTimelineAtUs } from "./gpu-video-frame-request";
import { validateMotionShapeGeometryKeyframesForGeometry } from "./motion-shape-geometry";
import { evaluateMotionShapeGeometryKeyframes } from "./motion-shape-geometry-keyframes";
import type { GpuFramePlan } from "./gpu-frame-intent";
import type { MotionDocument, MotionLayer } from "./types";

export const GPU_SCENE_GEOMETRY_KEYFRAMES_STATIC_PLAN_SCHEMA = "shellx-motion/gpu-scene-geometry-keyframes-static@1" as const;
export const GPU_SCENE_GEOMETRY_KEYFRAMES_FRAME_PLAN_SCHEMA = "shellx-motion/gpu-scene-geometry-keyframes-frame@1" as const;

export interface GpuSceneGeometryKeyframesTarget {
  layerId: string;
  sourceSequenceSha256: string;
  keyframeCount: number;
}

/**
 * Source-only execution authority for the strict GPU geometry-keyframe route. The legacy static
 * plan remains exactly `gpu-scene-static-plan@1`; this wrapper binds its untouched identity to
 * the separately-versioned geometry source. It is not an installed or hardware proof.
 */
export interface GpuSceneGeometryKeyframesStaticPlan {
  schema: typeof GPU_SCENE_GEOMETRY_KEYFRAMES_STATIC_PLAN_SCHEMA;
  /** The ordinary, geometry-keyframes-stripped GPU topology plan. */
  basePlan: GpuSceneStaticPlan;
  documentFingerprint: string;
  baseStaticFingerprint: string;
  targets: readonly GpuSceneGeometryKeyframesTarget[];
  fingerprint: string;
}

export interface GpuSceneGeometryKeyframesFrameSample {
  layerId: string;
  geometryFingerprint: string;
  evaluationFingerprint: string;
}

export interface GpuSceneGeometryKeyframesFramePlan {
  schema: typeof GPU_SCENE_GEOMETRY_KEYFRAMES_FRAME_PLAN_SCHEMA;
  staticFingerprint: string;
  atUs: number;
  frame: GpuFramePlan;
  baseFrameFingerprint: string;
  samples: readonly GpuSceneGeometryKeyframesFrameSample[];
  fingerprint: string;
}

export type GpuSceneGeometryKeyframesStaticPlanResult = { ok: true; plan: GpuSceneGeometryKeyframesStaticPlan } | { ok: false; failure: GpuScene2dFailure };
export type GpuSceneGeometryKeyframesFramePlanResult = { ok: true; plan: GpuSceneGeometryKeyframesFramePlan } | { ok: false; failure: GpuScene2dFailure };

type AuthorizedStaticPlan = Readonly<{ documentFingerprint: string; targetLayerIds: readonly string[] }>;
const authorizedStaticPlans = new WeakMap<object, AuthorizedStaticPlan>();

/**
 * Preflights the sole geometry-keyframe GPU path before renderer resource preparation. It removes
 * the authored keyframe records only from the legacy base plan; the wrapper remains the authority
 * that must evaluate them at an exact frame time.
 */
export function compileGpuSceneGeometryKeyframesStaticPlan(motion: MotionDocument, resources: GpuSceneStaticCompileResources = {}): GpuSceneGeometryKeyframesStaticPlanResult {
  try {
    const targets = geometryTargets(motion);
    if (targets.length === 0) return fail("gpu_unsupported_feature", "GPU geometry-keyframe composition requires at least one visible shape geometry keyframe target.");
    const conflict = staticConflict(motion, targets);
    if (conflict) return conflict;
    const source = stripGeometryKeyframes(motion, new Set(targets.map((target) => target.layerId)));
    const base = compileGpuSceneStaticPlan(source, resources);
    if (!base.ok) return base;
    if (base.plan.resources.length > 0 || base.plan.hybridTextures?.length || base.plan.effectModules?.length) {
      return fail("gpu_resource_refused", "GPU geometry-keyframe composition refuses static resources, hybrid sources, and effect modules before renderer allocation.");
    }
    const documentFingerprint = canonicalJsonSha256(motion);
    const payload = {
      schema: GPU_SCENE_GEOMETRY_KEYFRAMES_STATIC_PLAN_SCHEMA,
      documentFingerprint,
      baseStaticFingerprint: base.plan.fingerprint,
      targets,
    };
    const plan = freeze({ ...payload, basePlan: base.plan, targets: Object.freeze(targets.map((target) => Object.freeze({ ...target }))), fingerprint: canonicalJsonSha256(payload) });
    authorizedStaticPlans.set(plan, Object.freeze({ documentFingerprint, targetLayerIds: Object.freeze(targets.map((target) => target.layerId)) }));
    return { ok: true, plan };
  } catch (error) {
    return fail("gpu_unsupported_feature", error instanceof Error ? error.message : "GPU geometry-keyframe static composition could not be prepared.");
  }
}

/**
 * Samples every approved target exactly once at one safe integer microsecond, then delegates the
 * ephemeral keyframe-free document to the settled GPU frame compiler. A structural lookalike or
 * a wrapper made for another document is not execution authority and refuses before resources.
 */
export function compileGpuSceneGeometryKeyframesFramePlan(
  motion: MotionDocument,
  staticPlan: GpuSceneGeometryKeyframesStaticPlan,
  atUs: number,
  resources: GpuScene2dCompileResources = {}
): GpuSceneGeometryKeyframesFramePlanResult {
  // This must be first: the settled GPU compiler still crosses its legacy millisecond ABI.
  if (!validRootAtUs(motion, atUs)) return fail("gpu_invalid_time", "GPU geometry-keyframe composition requires a safe integer root atUs within the document duration.");
  if (gpuVideoTimelineAtUs(atUs / 1_000) !== atUs) return fail("gpu_invalid_time", "GPU geometry-keyframe composition atUs cannot round-trip through the legacy GPU millisecond ABI.");
  try {
    const authority = authorizedStaticPlans.get(staticPlan as unknown as object);
    if (!authority) return fail("gpu_resource_refused", "GPU geometry-keyframe composition requires an exact Core-issued static execution wrapper.");
    const documentFingerprint = canonicalJsonSha256(motion);
    if (authority.documentFingerprint !== documentFingerprint) return fail("gpu_resource_refused", "GPU geometry-keyframe static execution wrapper is stale for this Motion document.");
    const targetIds = new Set(authority.targetLayerIds);
    const conflict = staticConflict(motion, authority.targetLayerIds.map((layerId) => ({ layerId })));
    if (conflict) return conflict;
    const samples: GpuSceneGeometryKeyframesFrameSample[] = [];
    const source = applyGeometrySamples(motion, targetIds, atUs, samples);
    const base = compileGpuScene2dPlan(source, atUs / 1_000, resources);
    if (!base.ok) return base;
    const payload = {
      schema: GPU_SCENE_GEOMETRY_KEYFRAMES_FRAME_PLAN_SCHEMA,
      staticFingerprint: staticPlan.fingerprint,
      atUs,
      baseFrameFingerprint: base.plan.frame.fingerprint,
      samples,
    };
    return { ok: true, plan: freeze({ ...payload, frame: base.plan.frame, samples: Object.freeze(samples.map((sample) => Object.freeze({ ...sample }))), fingerprint: canonicalJsonSha256(payload) }) };
  } catch (error) {
    return fail("gpu_unsupported_feature", error instanceof Error ? error.message : "GPU geometry-keyframe frame composition could not be evaluated.");
  }
}

function geometryTargets(motion: MotionDocument): GpuSceneGeometryKeyframesTarget[] {
  const targets: GpuSceneGeometryKeyframesTarget[] = [];
  for (const layer of motion.layers) {
    if (layer.visible === false || layer.geometryKeyframes === undefined) continue;
    if (layer.type !== "shape") throw new Error(`GPU geometry keyframes require shape layer targets; ${layer.id} is ${layer.type}.`);
    if (!layer.geometry) throw new Error(`GPU geometry keyframe target ${layer.id} requires an owning v1 geometry record.`);
    const compatibility = validateMotionShapeGeometryKeyframesForGeometry(layer.geometryKeyframes, layer.geometry);
    if (compatibility) throw new Error(`GPU geometry keyframe target ${layer.id} is invalid: ${compatibility}`);
    const record = layer.geometryKeyframes as { schema: unknown; keyframes: unknown };
    const evaluated = evaluateMotionShapeGeometryKeyframes({ schema: record.schema, atUs: 0, keyframes: record.keyframes });
    if (!evaluated.ok) throw new Error(`GPU geometry keyframe target ${layer.id} is invalid: ${evaluated.message}`);
    targets.push({ layerId: layer.id, sourceSequenceSha256: evaluated.evaluation.sourceSequenceSha256, keyframeCount: evaluated.evaluation.budget.keyframeCount });
  }
  return targets;
}

function staticConflict(motion: MotionDocument, targets: readonly { layerId: string }[]): { ok: false; failure: GpuScene2dFailure } | null {
  if (motion.behaviors !== undefined) return fail("gpu_unsupported_feature", "GPU geometry-keyframe composition does not combine shape geometry keyframes with document behaviors@1.");
  const targetIds = new Set(targets.map((target) => target.layerId));
  for (const layer of motion.layers) {
    if (!targetIds.has(layer.id)) continue;
    if (layer.effects?.motionBlur) return fail("gpu_unsupported_feature", `GPU geometry keyframe target ${layer.id} does not support temporal motion blur until every shutter sample has exact geometry evaluation.`, layer.id);
    if (motion.layers.some((candidate) => candidate.matte?.sourceLayerId === layer.id)) return fail("gpu_unsupported_feature", `GPU geometry keyframe target ${layer.id} cannot be a track-matte source in the strict static-topology path.`, layer.id);
  }
  return null;
}

function stripGeometryKeyframes(motion: MotionDocument, targetIds: ReadonlySet<string>): MotionDocument {
  return {
    ...motion,
    layers: motion.layers.map((layer) => targetIds.has(layer.id) ? withoutGeometryKeyframes(layer) : layer),
  };
}

function applyGeometrySamples(motion: MotionDocument, targetIds: ReadonlySet<string>, atUs: number, samples: GpuSceneGeometryKeyframesFrameSample[]): MotionDocument {
  return {
    ...motion,
    layers: motion.layers.map((layer) => {
      if (!targetIds.has(layer.id)) return layer;
      const evaluated = evaluateMotionShapeGeometryKeyframes({
        schema: layer.geometryKeyframes!.schema,
        atUs,
        keyframes: layer.geometryKeyframes!.keyframes,
      });
      if (!evaluated.ok) throw new Error(`GPU geometry keyframe target ${layer.id} could not bind its evaluation identity: ${evaluated.message}`);
      samples.push({ layerId: layer.id, geometryFingerprint: evaluated.evaluation.geometryFingerprint, evaluationFingerprint: evaluated.evaluation.fingerprint });
      return { ...withoutGeometryKeyframes(layer), geometry: evaluated.evaluation.geometry };
    }),
  };
}

function withoutGeometryKeyframes(layer: MotionLayer): MotionLayer {
  const { geometryKeyframes: _geometryKeyframes, ...source } = layer;
  return source;
}

function validRootAtUs(motion: MotionDocument, atUs: number): boolean {
  const durationUs = motion.durationMs * 1_000;
  return Number.isSafeInteger(atUs) && atUs >= 0 && Number.isSafeInteger(durationUs) && atUs <= durationUs;
}

function fail(code: GpuScene2dFailure["code"], message: string, layerId?: string): { ok: false; failure: GpuScene2dFailure } {
  return { ok: false, failure: { code, message, ...(layerId ? { layerId } : {}) } };
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry, seen);
  return Object.freeze(value);
}
