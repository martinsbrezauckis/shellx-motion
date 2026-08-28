import { canonicalJsonSha256 } from "./canonical-json";
import { compileGpuScene2dPlan, type GpuScene2dCompileResources, type GpuScene2dFailure } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan, type GpuSceneStaticCompileResources, type GpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { gpuVideoTimelineAtUs } from "./gpu-video-frame-request";
import { compileMotionRelationAuthoringFramePlanFromEvaluation, evaluateMotionRelationAuthoringFrame } from "./motion-relation-authoring-frame";
import { motionRelationStorePresent } from "./motion-relation-lane-refusal";
import { compileMotionRelationStaticPlan, type MotionRelationFramePlan, type MotionRelationStaticPlan } from "./motion-relation-plan";
import type { GpuFramePlan } from "./gpu-frame-intent";
import type { MotionDocument, MotionLayer } from "./types";

export const GPU_SCENE_RELATIONS_STATIC_PLAN_SCHEMA = "shellx-motion/gpu-scene-relations-static@1" as const;
export const GPU_SCENE_RELATIONS_FRAME_PLAN_SCHEMA = "shellx-motion/gpu-scene-relations-frame@1" as const;

/**
 * Opaque source-only authority for the strict Browser WebGPU relation-preview route. The nested
 * legacy static plan stays exactly gpu-scene-static-plan@1 and cannot itself enable relations.
 */
export interface GpuSceneRelationsStaticPlan {
  schema: typeof GPU_SCENE_RELATIONS_STATIC_PLAN_SCHEMA;
  basePlan: GpuSceneStaticPlan;
  documentFingerprint: string;
  baseStaticFingerprint: string;
  relationStaticPlan: MotionRelationStaticPlan;
  relationStaticFingerprint: string;
  endpointLayerIds: readonly string[];
  fingerprint: string;
}

/** One exact authoring evaluation and one relation-frame-plan@1 identity bind each GPU frame. */
export interface GpuSceneRelationsFramePlan {
  schema: typeof GPU_SCENE_RELATIONS_FRAME_PLAN_SCHEMA;
  staticFingerprint: string;
  atUs: number;
  frame: GpuFramePlan;
  baseFrameFingerprint: string;
  relationFramePlan: MotionRelationFramePlan;
  relationFrameFingerprint: string;
  evaluatedLayerFingerprint: string;
  fingerprint: string;
}

export type GpuSceneRelationsStaticPlanResult = { ok: true; plan: GpuSceneRelationsStaticPlan } | { ok: false; failure: GpuScene2dFailure };
export type GpuSceneRelationsFramePlanResult = { ok: true; plan: GpuSceneRelationsFramePlan } | { ok: false; failure: GpuScene2dFailure };

type AuthorizedStaticPlan = Readonly<{ documentFingerprint: string; relationStaticFingerprint: string; endpointLayerIds: readonly string[] }>;
const authorizedStaticPlans = new WeakMap<object, AuthorizedStaticPlan>();

/**
 * Prepares the one narrow relation path. This admits only visible root-owned 2D shapes and no
 * resource-bearing feature, so it never needs persistent buffers or any resource staging.
 */
export function compileGpuSceneRelationsStaticPlan(motion: MotionDocument, resources: GpuSceneStaticCompileResources = {}): GpuSceneRelationsStaticPlanResult {
  try {
    if (!motionRelationStorePresent(motion)) return fail("gpu_unsupported_feature", "GPU relation preview composition requires document relations@1.");
    const relation = compileMotionRelationStaticPlan(motion);
    if (!relation.ok || relation.plan.relationSourceSha256 === null) return fail("gpu_unsupported_feature", relation.ok ? "GPU relation preview composition requires document relations@1." : relation.message);
    const scope = strictRelationPreviewScope(motion, relation.plan);
    if (scope) return scope;
    const base = compileGpuSceneStaticPlan(stripResolvedDynamicAuthorities(motion), resources);
    if (!base.ok) return base;
    if (base.plan.resources.length > 0 || base.plan.hybridTextures?.length || base.plan.effectModules?.length || base.plan.maxima.maxVideoCount > 0 || base.plan.maxima.maxTextCount > 0) {
      return fail("gpu_resource_refused", "GPU relation preview composition refuses resources, videos, fonts, hybrid sources, and effect modules before renderer allocation.");
    }
    const documentFingerprint = canonicalJsonSha256(motion);
    const payload = {
      schema: GPU_SCENE_RELATIONS_STATIC_PLAN_SCHEMA,
      documentFingerprint,
      baseStaticFingerprint: base.plan.fingerprint,
      relationStaticFingerprint: relation.plan.fingerprint,
      endpointLayerIds: scopeEndpointIds(relation.plan),
    };
    const plan = freeze({
      ...payload,
      basePlan: base.plan,
      relationStaticPlan: relation.plan,
      endpointLayerIds: Object.freeze([...payload.endpointLayerIds]),
      fingerprint: canonicalJsonSha256(payload),
    });
    authorizedStaticPlans.set(plan, Object.freeze({
      documentFingerprint,
      relationStaticFingerprint: relation.plan.fingerprint,
      endpointLayerIds: Object.freeze([...payload.endpointLayerIds]),
    }));
    return { ok: true, plan };
  } catch (error) {
    return fail("gpu_unsupported_feature", error instanceof Error ? error.message : "GPU relation preview static composition could not be prepared.");
  }
}

/**
 * Validates opaque authority and exact time before any caller can prepare resources, then passes
 * one fresh, fully resolved document to the settled legacy GPU frame compiler exactly once.
 */
export function compileGpuSceneRelationsFramePlan(
  motion: MotionDocument,
  staticPlan: GpuSceneRelationsStaticPlan,
  atUs: number,
  resources: GpuScene2dCompileResources = {},
): GpuSceneRelationsFramePlanResult {
  if (!validRootAtUs(motion, atUs)) return fail("gpu_invalid_time", "GPU relation preview composition requires a safe integer root atUs within the document duration.");
  if (atUs % 1_000 !== 0 || gpuVideoTimelineAtUs(atUs / 1_000) !== atUs) return fail("gpu_invalid_time", "GPU relation preview composition atUs cannot round-trip through the legacy GPU millisecond ABI.");
  try {
    const authority = authorizedStaticPlans.get(staticPlan as unknown as object);
    if (!authority) return fail("gpu_resource_refused", "GPU relation preview composition requires an exact Core-issued static execution wrapper.");
    const documentFingerprint = canonicalJsonSha256(motion);
    if (authority.documentFingerprint !== documentFingerprint) return fail("gpu_resource_refused", "GPU relation preview static execution wrapper is stale for this Motion document.");
    const relation = compileMotionRelationStaticPlan(motion);
    if (!relation.ok || relation.plan.fingerprint !== authority.relationStaticFingerprint) return fail("gpu_resource_refused", relation.ok ? "GPU relation preview static execution wrapper no longer matches relation authority." : relation.message);
    const scope = strictRelationPreviewScope(motion, relation.plan);
    if (scope) return scope;
    const evaluation = evaluateMotionRelationAuthoringFrame(motion, atUs);
    const relationFrame = compileMotionRelationAuthoringFramePlanFromEvaluation(motion, evaluation);
    if (!relationFrame.ok) return fail("gpu_unsupported_feature", relationFrame.message);
    if (relationFrame.plan.staticFingerprint !== authority.relationStaticFingerprint || relationFrame.plan.atUs !== evaluation.atUs || relationFrame.plan.samples.length !== evaluation.samples.length) {
      return fail("gpu_resource_refused", "GPU relation preview authoring-frame evaluation does not match its exact relation frame authority.");
    }
    const endpointProblem = activeEndpointsVisible(motion, relationFrame.plan, authority.endpointLayerIds);
    if (endpointProblem) return endpointProblem;
    const source = stripResolvedDynamicAuthorities(motion, evaluation.layers);
    const base = compileGpuScene2dPlan(source, atUs / 1_000, resources);
    if (!base.ok) return base;
    const evaluatedLayerFingerprint = canonicalJsonSha256(evaluation.layers);
    const payload = {
      schema: GPU_SCENE_RELATIONS_FRAME_PLAN_SCHEMA,
      staticFingerprint: staticPlan.fingerprint,
      atUs,
      baseFrameFingerprint: base.plan.frame.fingerprint,
      relationFrameFingerprint: relationFrame.plan.fingerprint,
      evaluatedLayerFingerprint,
    };
    return {
      ok: true,
      plan: freeze({
        ...payload,
        frame: base.plan.frame,
        relationFramePlan: relationFrame.plan,
        fingerprint: canonicalJsonSha256(payload),
      }),
    };
  } catch (error) {
    return fail("gpu_unsupported_feature", error instanceof Error ? error.message : "GPU relation preview frame composition could not be evaluated.");
  }
}

function strictRelationPreviewScope(motion: MotionDocument, relation: MotionRelationStaticPlan): { ok: false; failure: GpuScene2dFailure } | null {
  if (motion.assets.length > 0) return fail("gpu_resource_refused", "GPU relation preview composition refuses declared resources before renderer allocation.");
  for (const layer of motion.layers) {
    if (layer.visible === false) return fail("gpu_unsupported_feature", `GPU relation preview composition accepts only visible root-owned 2D shape layers; layer ${layer.id} is hidden.`, layer.id);
    if (layer.effectModule !== undefined) return fail("gpu_resource_refused", `GPU relation preview composition refuses effect modules on layer ${layer.id} before renderer allocation.`, layer.id);
    if (layer.effects?.motionBlur !== undefined) return fail("gpu_unsupported_feature", `GPU relation preview composition refuses temporal motion blur on layer ${layer.id}.`, layer.id);
    if (layer.geometryKeyframes !== undefined) return fail("gpu_unsupported_feature", `GPU relation preview composition refuses geometry keyframes on layer ${layer.id}.`, layer.id);
    if (layer.type === "group") return fail("gpu_unsupported_feature", `GPU relation preview composition refuses groups; layer ${layer.id} cannot establish relation ownership.`, layer.id);
    if (layer.type === "camera" || layer.depth !== undefined) return fail("gpu_unsupported_feature", `GPU relation preview composition refuses depth and camera state on layer ${layer.id}.`, layer.id);
    if (layer.type === "video" || layer.type === "text" || layer.type === "caption") return fail("gpu_resource_refused", `GPU relation preview composition refuses ${layer.type} resources on layer ${layer.id} before renderer allocation.`, layer.id);
    if (layer.type !== "shape") return fail("gpu_unsupported_layer", `GPU relation preview composition accepts only visible root-owned 2D shape layers; layer ${layer.id} is ${layer.type}.`, layer.id);
  }
  const byId = new Map(motion.layers.map((layer) => [layer.id, layer]));
  for (const layerId of scopeEndpointIds(relation)) {
    const layer = byId.get(layerId);
    if (!layer || layer.visible === false) return fail("gpu_unsupported_feature", `GPU relation preview composition requires visible relation endpoint ${layerId}.`, layerId);
  }
  return null;
}

function activeEndpointsVisible(motion: MotionDocument, relation: MotionRelationFramePlan, endpointLayerIds: readonly string[]): { ok: false; failure: GpuScene2dFailure } | null {
  const byId = new Map(motion.layers.map((layer) => [layer.id, layer]));
  const active = new Set(relation.samples.flatMap((sample) => [
    motion.relations?.bindings.find((binding) => binding.id === sample.id)?.source.layerId,
    sample.targetLayerId,
  ]));
  for (const layerId of endpointLayerIds) {
    if (!active.has(layerId)) continue;
    const layer = byId.get(layerId);
    if (!layer || layer.visible === false || !layerActiveAtUs(layer, relation.atUs)) {
      return fail("gpu_unsupported_feature", `GPU relation preview composition requires active visible relation endpoint ${layerId} at ${relation.atUs}us.`, layerId);
    }
  }
  return null;
}

/** Creates a new per-plan/frame document; never removes dynamic authority from package source. */
function stripResolvedDynamicAuthorities(motion: MotionDocument, layers: readonly MotionLayer[] = motion.layers): MotionDocument {
  const { relations: _relations, relationships: _relationships, behaviors: _behaviors, ...source } = motion;
  return { ...source, layers: layers.map(resolvedLayerSnapshot) };
}

/**
 * `effectiveLayerAtMs` has already resolved ordinary/spatial keyframes, transitions, and gradient
 * colour tracks for this exact frame. Removing their source authorities prevents the legacy GPU
 * compiler from evaluating a second, potentially divergent transform over the relation result.
 */
function resolvedLayerSnapshot(layer: MotionLayer): MotionLayer {
  const { keyframes: _keyframes, transitions: _transitions, gradient, ...source } = layer;
  const resolvedGradient = gradient
    ? (() => {
        const { colorKeyframes: _colorKeyframes, ...value } = gradient;
        return { ...value, stops: value.stops.map((stop) => ({ ...stop })) };
      })()
    : undefined;
  return {
    ...source,
    ...(layer.transform ? { transform: { ...layer.transform } } : {}),
    ...(layer.style ? { style: { ...layer.style } } : {}),
    ...(layer.effects ? { effects: { ...layer.effects, ...(layer.effects.glow ? { glow: { ...layer.effects.glow } } : {}) } } : {}),
    ...(layer.mask ? { mask: { ...layer.mask, ...(layer.mask.inset ? { inset: { ...layer.mask.inset } } : {}) } } : {}),
    ...(layer.crop ? { crop: { ...layer.crop } } : {}),
    ...(layer.pathReveal ? { pathReveal: { ...layer.pathReveal } } : {}),
    ...(resolvedGradient ? { gradient: resolvedGradient } : {}),
  };
}

function scopeEndpointIds(relation: MotionRelationStaticPlan): string[] {
  return [...new Set(relation.bindings.flatMap((binding) => [binding.sourceLayerId, binding.targetLayerId]))].sort();
}
function layerActiveAtUs(layer: MotionLayer, atUs: number): boolean { return atUs >= layer.startMs * 1_000 && atUs < (layer.startMs + layer.durationMs) * 1_000; }
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
