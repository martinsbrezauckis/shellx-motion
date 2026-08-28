import { canonicalJsonSha256 } from "./canonical-json";
import { compileGpuScene2dPlan, type GpuScene2dCompileResources, type GpuScene2dFailure } from "./gpu-scene-2d-plan";
import { compileGpuSceneStaticPlan, type GpuSceneStaticCompileResources, type GpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { gpuVideoTimelineAtUs } from "./gpu-video-frame-request";
import { gpuUnloweredRootAuthorityRefusal } from "./gpu-root-authority-fence";
import { admitStrictScene3dPreviewDocument } from "./gpu-scene3d-animation-admission";
import { evaluateMotionScene3DAnimationPlan } from "./motion-scene3d-animation-evaluate";
import { compileMotionScene3DAnimationPlan } from "./motion-scene3d-animation-plan";
import {
  MAX_MOTION_SCENE3D_ANIMATION_FRAME_WORK_UNITS,
  MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES,
  MAX_MOTION_SCENE3D_ANIMATION_TRACKS,
  type MotionScene3DAnimationDescriptor,
  type MotionScene3DAnimationFramePlan,
  type MotionScene3DAnimationFrameSample,
  type MotionScene3DAnimationPlan,
  type MotionScene3DAnimationValue,
} from "./motion-scene3d-animation-types";
import {
  MAX_SCENE_3D_LAYERS,
  MAX_SCENE_3D_MESH_INDICES_TOTAL,
  MAX_SCENE_3D_MESH_VERTICES_TOTAL,
  MAX_SCENE_3D_OBJECTS_TOTAL,
} from "./scene-3d";
import type { GpuFramePlan } from "./gpu-frame-intent";
import type { MotionDocument, MotionLayer } from "./types";

export const GPU_SCENE3D_ANIMATION_STATIC_PLAN_SCHEMA = "shellx-motion/gpu-scene3d-animation-static@1" as const;
export const GPU_SCENE3D_ANIMATION_FRAME_PLAN_SCHEMA = "shellx-motion/gpu-scene3d-animation-frame@1" as const;

/** Explicit strict-preview ceiling evidence, shared by the card, wrapper, and receipt. */
export interface GpuScene3DAnimationPreviewLimits {
  target: "preview";
  output: "png-frame";
  maxSceneLayers: number;
  maxSceneObjects: number;
  maxMeshVertices: number;
  maxMeshIndices: number;
  maxTracks: number;
  maxKeyframes: number;
  maxFrameWorkUnits: number;
}

/** One exact O6 capability-card contract, shared with the Browser receipt verifier. */
export const GPU_SCENE3D_ANIMATION_PREVIEW_LIMITS: GpuScene3DAnimationPreviewLimits = Object.freeze({
  target: "preview",
  output: "png-frame",
  maxSceneLayers: MAX_SCENE_3D_LAYERS,
  maxSceneObjects: MAX_SCENE_3D_OBJECTS_TOTAL,
  maxMeshVertices: MAX_SCENE_3D_MESH_VERTICES_TOTAL,
  maxMeshIndices: MAX_SCENE_3D_MESH_INDICES_TOTAL,
  maxTracks: MAX_MOTION_SCENE3D_ANIMATION_TRACKS,
  maxKeyframes: MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES,
  maxFrameWorkUnits: MAX_MOTION_SCENE3D_ANIMATION_FRAME_WORK_UNITS,
});

/**
 * Opaque Core authority for the only scene3dAnimation renderer join. The underlying static plan
 * is still the settled GPU plan; this wrapper binds it to the compiler-minted sampled authority.
 */
export interface GpuScene3DAnimationStaticPlan {
  schema: typeof GPU_SCENE3D_ANIMATION_STATIC_PLAN_SCHEMA;
  basePlan: GpuSceneStaticPlan;
  documentFingerprint: string;
  baseStaticFingerprint: string;
  animationStaticPlan: MotionScene3DAnimationPlan;
  animationStaticFingerprint: string;
  targetLayerIds: readonly string[];
  limits: GpuScene3DAnimationPreviewLimits;
  fingerprint: string;
}

/** One exact evaluated compiler frame and one settled GPU frame are bound per preview request. */
export interface GpuScene3DAnimationFramePlan {
  schema: typeof GPU_SCENE3D_ANIMATION_FRAME_PLAN_SCHEMA;
  staticFingerprint: string;
  atUs: number;
  frame: GpuFramePlan;
  baseFrameFingerprint: string;
  animationFramePlan: MotionScene3DAnimationFramePlan;
  animationFrameFingerprint: string;
  fingerprint: string;
}

export type GpuScene3DAnimationStaticPlanResult = { ok: true; plan: GpuScene3DAnimationStaticPlan } | { ok: false; failure: GpuScene2dFailure };
export type GpuScene3DAnimationFramePlanResult = { ok: true; plan: GpuScene3DAnimationFramePlan } | { ok: false; failure: GpuScene2dFailure };
type AuthorizedStaticPlan = Readonly<{ motion: MotionDocument; documentFingerprint: string; animationStaticFingerprint: string; targetLayerIds: readonly string[] }>;
const authorizedStaticPlans = new WeakMap<object, AuthorizedStaticPlan>();

/** Internal Browser bridge to the exact frozen document admitted with this opaque O6 wrapper. */
export function gpuScene3DAnimationAdmittedMotion(staticPlan: GpuScene3DAnimationStaticPlan): MotionDocument | undefined {
  return authorizedStaticPlans.get(staticPlan as unknown as object)?.motion;
}
/**
 * Preflights the sole O6 route before package-resource work. It admits only root scene3d data
 * with no declared asset or companion-layer authority; every other renderer lane remains refused.
 */
export function compileGpuScene3DAnimationStaticPlan(
  motion: MotionDocument,
  resources: GpuSceneStaticCompileResources = {},
): GpuScene3DAnimationStaticPlanResult {
  try {
    const rootAuthorityRefusal = gpuUnloweredRootAuthorityRefusal(motion, "scene3d-animation");
    if (rootAuthorityRefusal) return fail("gpu_unsupported_feature", rootAuthorityRefusal);
    // Descriptor-only admission precedes every direct root read, enumeration, hash, or resource
    // decision. Every later step receives its frozen plain-data snapshot, never source Motion.
    const admitted = admitStrictScene3dPreviewDocument(motion);
    const animation = compileDocumentAnimationPlan(admitted.animation, admitted.layers);
    if (!animation.ok) return fail("gpu_unsupported_feature", animation.message);
    const source = withoutScene3dAnimation(admitted.motion);
    const base = compileGpuSceneStaticPlan(source, resources);
    if (!base.ok) return base;
    if (base.plan.resources.length > 0 || base.plan.hybridTextures?.length || base.plan.effectModules?.length || base.plan.maxima.maxVideoCount > 0 || base.plan.maxima.maxTextCount > 0) {
      return fail("gpu_resource_refused", "GPU scene3d animation preview refuses package resources, video, fonts, hybrid sources, and effect modules before renderer allocation.");
    }
    const documentFingerprint = canonicalJsonSha256(admitted.motion);
    const limits = previewLimits();
    const payload = {
      schema: GPU_SCENE3D_ANIMATION_STATIC_PLAN_SCHEMA,
      documentFingerprint,
      baseStaticFingerprint: base.plan.fingerprint,
      animationStaticFingerprint: animation.plan.fingerprint,
      targetLayerIds: admitted.targetLayerIds,
      limits,
    };
    const plan = freeze({
      ...payload,
      basePlan: base.plan,
      animationStaticPlan: animation.plan,
      targetLayerIds: Object.freeze([...admitted.targetLayerIds]),
      limits: Object.freeze({ ...limits }),
      fingerprint: canonicalJsonSha256(payload),
    });
    authorizedStaticPlans.set(plan, Object.freeze({
      motion: admitted.motion,
      documentFingerprint,
      animationStaticFingerprint: animation.plan.fingerprint,
      targetLayerIds: Object.freeze([...admitted.targetLayerIds]),
    }));
    return { ok: true, plan };
  } catch (error) {
    return fail("gpu_unsupported_feature", error instanceof Error ? error.message : "GPU scene3d animation preview static composition could not be prepared.");
  }
}
/**
 * Validates the opaque wrapper and exact microsecond time before caller resources are visible,
 * samples the accepted compiler exactly once, and delegates an ephemeral root-free document to
 * the existing GPU frame compiler.
 */
export function compileGpuScene3DAnimationFramePlan(
  motion: MotionDocument,
  staticPlan: GpuScene3DAnimationStaticPlan,
  atUs: number,
  resources: GpuScene2dCompileResources = {},
): GpuScene3DAnimationFramePlanResult {
  // Never inspect attacker-controlled Motion data until the opaque static wrapper itself is
  // known to be Core-issued. This keeps forged wrappers off every descriptor/time/hash path.
  const authority = authorizedStaticPlans.get(staticPlan as unknown as object);
  if (!authority) return fail("gpu_resource_refused", "GPU scene3d animation preview requires an exact Core-issued static execution wrapper.");
  const rootAuthorityRefusal = gpuUnloweredRootAuthorityRefusal(motion, "scene3d-animation");
  if (rootAuthorityRefusal) return fail("gpu_unsupported_feature", rootAuthorityRefusal);
  try {
    const admitted = admitStrictScene3dPreviewDocument(motion);
    if (!validRootAtUs(admitted.motion, atUs)) return fail("gpu_invalid_time", "GPU scene3d animation preview requires a safe integer root atUs within the document duration.");
    if (gpuVideoTimelineAtUs(atUs / 1_000) !== atUs) return fail("gpu_invalid_time", "GPU scene3d animation preview atUs cannot round-trip through the legacy GPU millisecond ABI.");
    const documentFingerprint = canonicalJsonSha256(admitted.motion);
    if (authority.documentFingerprint !== documentFingerprint) return fail("gpu_resource_refused", "GPU scene3d animation preview static execution wrapper is stale for this Motion document.");
    if (canonicalJsonSha256(admitted.targetLayerIds) !== canonicalJsonSha256(authority.targetLayerIds)) return fail("gpu_resource_refused", "GPU scene3d animation preview target layers no longer match the static execution wrapper.");
    const animation = compileDocumentAnimationPlan(admitted.animation, admitted.layers);
    if (!animation.ok) return fail("gpu_unsupported_feature", animation.message);
    if (animation.plan.fingerprint !== authority.animationStaticFingerprint) return fail("gpu_resource_refused", "GPU scene3d animation preview static execution wrapper no longer matches the compiler authority.");
    const evaluated = evaluateMotionScene3DAnimationPlan(animation.plan, atUs);
    if (!evaluated.ok) return fail("gpu_unsupported_feature", evaluated.message);
    if (evaluated.plan.staticFingerprint !== authority.animationStaticFingerprint || evaluated.plan.atUs !== atUs) {
      return fail("gpu_resource_refused", "GPU scene3d animation preview evaluation does not match its exact compiler authority.");
    }
    const source = applyScene3dAnimationSamples(admitted.motion, evaluated.plan.samples);
    const base = compileGpuScene2dPlan(source, atUs / 1_000, resources);
    if (!base.ok) return base;
    const payload = {
      schema: GPU_SCENE3D_ANIMATION_FRAME_PLAN_SCHEMA,
      staticFingerprint: staticPlan.fingerprint,
      atUs,
      baseFrameFingerprint: base.plan.frame.fingerprint,
      animationFrameFingerprint: evaluated.plan.fingerprint,
    };
    return { ok: true, plan: freeze({ ...payload, frame: base.plan.frame, animationFramePlan: evaluated.plan, fingerprint: canonicalJsonSha256(payload) }) };
  } catch (error) {
    return fail("gpu_unsupported_feature", error instanceof Error ? error.message : "GPU scene3d animation preview frame composition could not be evaluated.");
  }
}
function compileDocumentAnimationPlan(animation: MotionScene3DAnimationDescriptor, layers: readonly MotionLayer[]): { ok: true; plan: MotionScene3DAnimationPlan } | { ok: false; message: string } {
  try {
    return compileMotionScene3DAnimationPlan({ animation, source: { layers: scene3dSourceLayers(layers) } });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "GPU scene3d animation preview could not read document authority." };
  }
}

function scene3dSourceLayers(layers: readonly MotionLayer[]): unknown[] {
  const source: unknown[] = [];
  for (const layer of layers) {
    const type = ownDataField(layer, "type", `GPU scene3d animation layer`);
    if (type !== "scene3d") continue;
    const record: Record<string, unknown> = {};
    for (const key of ["id", "type", "scene3d"] as const) Object.defineProperty(record, key, { value: ownDataField(layer, key, `GPU scene3d animation layer`), enumerable: true, configurable: true, writable: true });
    source.push(record);
  }
  return source;
}

function ownDataField(value: object, key: string, label: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { throw new Error(`${label} reflection failed.`); }
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`);
  return descriptor.value;
}

function withoutScene3dAnimation(motion: MotionDocument): MotionDocument {
  const { scene3dAnimation: _animation, ...source } = motion;
  return source;
}

function applyScene3dAnimationSamples(motion: MotionDocument, samples: readonly MotionScene3DAnimationFrameSample[]): MotionDocument {
  const byLayer = new Map<string, MotionScene3DAnimationFrameSample[]>();
  for (const sample of samples) {
    const entries = byLayer.get(sample.locator.layerId) ?? [];
    entries.push(sample);
    byLayer.set(sample.locator.layerId, entries);
  }
  const source = withoutScene3dAnimation(motion);
  return {
    ...source,
    layers: source.layers.map((layer) => {
      const layerSamples = byLayer.get(layer.id);
      if (!layerSamples || layer.type !== "scene3d" || !layer.scene3d) return layer;
      const scene = structuredClone(layer.scene3d);
      for (const sample of layerSamples) applySample(scene, sample);
      return { ...layer, scene3d: scene };
    }),
  };
}

function applySample(scene: NonNullable<MotionLayer["scene3d"]>, sample: MotionScene3DAnimationFrameSample): void {
  const value = cloneSampleValue(sample.value);
  const locator = sample.locator;
  if (locator.scope === "camera") {
    (scene.camera as Record<string, unknown>)[locator.property] = value;
    return;
  }
  if (locator.scope === "lighting") {
    (scene.lighting as Record<string, unknown>)[locator.property] = value;
    return;
  }
  if (locator.scope === "background") {
    scene.backgroundColor = String(value);
    return;
  }
  const object = scene.objects.find((candidate) => candidate.id === locator.objectId);
  if (!object) throw new Error(`GPU scene3d animation preview compiler-minted object ${locator.layerId}/${locator.objectId} is absent from the frame source.`);
  (object as unknown as Record<string, unknown>)[locator.property] = value;
}

function cloneSampleValue(value: MotionScene3DAnimationValue): MotionScene3DAnimationValue { return Array.isArray(value) ? [...value] as MotionScene3DAnimationValue : value; }
function validRootAtUs(motion: MotionDocument, atUs: number): boolean { const durationUs = motion.durationMs * 1_000; return Number.isSafeInteger(atUs) && atUs >= 0 && Number.isSafeInteger(durationUs) && atUs <= durationUs; }
function previewLimits(): GpuScene3DAnimationPreviewLimits { return Object.freeze({ ...GPU_SCENE3D_ANIMATION_PREVIEW_LIMITS }); }
function fail(code: GpuScene2dFailure["code"], message: string, layerId?: string): { ok: false; failure: GpuScene2dFailure } { return { ok: false, failure: { code, message, ...(layerId ? { layerId } : {}) } }; }
function freeze<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value)) return value; seen.add(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen); return Object.freeze(value); }
