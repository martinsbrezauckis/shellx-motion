import { canonicalJson, canonicalJsonSha256, compileGpuSceneBehaviorStaticPlan, gpuEffectModuleStaticDescriptorProblem, type GpuSceneBehaviorStaticPlan, type MotionDocument } from "@shellx-motion/core";
import { prepareGpuSceneResources, type PreparedGpuSceneResources } from "./gpu-scene-resources";
import type { GpuStreamingStaticPlan, GpuStreamingStaticPlanEvidence } from "./gpu-streaming-producer-types";
import type { GpuVideoFrameProvider } from "./gpu-video-frame-provider";

export type GpuStaticPlanFailure = { code: string; message: string; layerId?: string };

/** Validates the immutable Core topology before any package resource or GPU work. */
export function validateGpuStreamingStaticPlan(plan: GpuStreamingStaticPlan, motion: MotionDocument, frameCount: number, manifestAssets: readonly string[]): GpuStaticPlanFailure | null {
  if (!plan || typeof plan !== "object" || plan.schema !== "shellx-motion/gpu-scene-static-plan@1" || !Object.isFrozen(plan) || !Object.isFrozen(plan.resources) || !Object.isFrozen(plan.layers) || !Object.isFrozen(plan.maxima)) return { code: "gpu_static_plan_invalid", message: "GPU final rendering requires one immutable Core static scene plan." };
  if (!SHA256.test(plan.fingerprint) || !SHA256.test(plan.documentFingerprint) || plan.documentFingerprint !== canonicalJsonSha256(motion)) return { code: "gpu_static_plan_invalid", message: "GPU static scene plan does not bind the retained Motion document." };
  if (!Number.isSafeInteger(plan.canonicalFrameCount) || plan.canonicalFrameCount !== frameCount || plan.maxima.canonicalFrameCount !== frameCount) return { code: "gpu_static_plan_invalid", message: "GPU static scene plan does not match the canonical delivery frame count." };
  if (plan.maxima.resourceReferenceCount !== plan.resources.length || !plan.layers.every((layer) => typeof layer.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(layer.id) && typeof layer.type === "string" && layer.type.length > 0 && Number.isInteger(layer.groupDepth) && layer.groupDepth >= 1 && layer.groupDepth <= 6 && layer.geometry?.reuse === "not-claimed")) return { code: "gpu_static_plan_invalid", message: "GPU static scene plan must retain exact resource topology without claiming reusable geometry." };
  let prior = ""; const keys = new Set<string>(); const declared = new Set(manifestAssets);
  for (const resource of plan.resources) {
    if (!resource || !RESOURCE_KIND.has(resource.kind) || !resource.key || !resource.assetRef || (resource.kind === "font" && (!resource.family || typeof resource.family !== "string")) || keys.has(resource.key) || (prior && resource.key < prior)) return { code: "gpu_static_plan_invalid", message: "GPU static scene plan has invalid deterministic resource references." };
    if (!isSafePackageAssetRef(resource.assetRef) || !declared.has(resource.assetRef)) return { code: "gpu_static_plan_resource_refused", message: `GPU static scene resource ${resource.assetRef} must be a declared safe package-relative asset.` };
    prior = resource.key; keys.add(resource.key);
  }
  const moduleFailure = validateGpuStreamingStaticPlanEffectModules(plan);
  if (moduleFailure) return moduleFailure;
  return null;
}

/**
 * Behavior composition keeps the immutable legacy resource topology in
 * `basePlan`, while this helper binds it back to the complete authored
 * document before Browser reads a resource or opens Chromium.
 */
export function validateGpuStreamingBehaviorStaticPlan(
  plan: GpuSceneBehaviorStaticPlan,
  motion: MotionDocument,
  frameCount: number,
  manifestAssets: readonly string[]
): GpuStaticPlanFailure | null {
  const compiled = compileGpuSceneBehaviorStaticPlan(motion);
  if (!compiled.ok) return compiled.failure;
  if (canonicalJson(plan) !== canonicalJson(compiled.plan)) {
    return { code: "gpu_static_plan_invalid", message: "GPU behavior static plan does not bind the retained Motion document." };
  }
  const { behaviors: _behaviors, ...baseMotion } = motion;
  return validateGpuStreamingStaticPlan(compiled.plan.basePlan, baseMotion, frameCount, manifestAssets);
}

export function attestGpuStreamingStaticPlan(plan: GpuStreamingStaticPlan): GpuStreamingStaticPlanEvidence {
  return Object.freeze({ schema: plan.schema, fingerprint: plan.fingerprint, documentFingerprint: plan.documentFingerprint, canonicalFrameCount: plan.canonicalFrameCount, resourceReferencesSha256: canonicalJsonSha256(plan.resources), resourceReferenceCount: plan.resources.length, maxima: Object.freeze({ ...plan.maxima }), geometryReuse: "not-claimed", ...(plan.effectModules ? { effectModules: plan.effectModules } : {}) });
}

export function validateGpuStreamingPreparedResources(plan: GpuStreamingStaticPlan, resources: PreparedGpuSceneResources, video: GpuVideoFrameProvider | undefined): GpuStaticPlanFailure | null {
  const expected = new Set(plan.resources.map((resource) => `${resource.kind}\0${resource.assetRef}`));
  for (const resource of resources.images.values()) if (!expected.has(`image\0${resource.assetRef}`)) return { code: "gpu_static_plan_resource_mismatch", message: `GPU image resource ${resource.assetRef} was not admitted by the static scene plan.` };
  for (const faces of resources.fonts.values()) for (const face of faces) if (!expected.has(`font\0${face.assetRef}`)) return { code: "gpu_static_plan_resource_mismatch", message: `GPU font resource ${face.assetRef} was not admitted by the static scene plan.` };
  const preparedImages = new Set([...resources.images.values()].map((resource) => resource.assetRef));
  const preparedFonts = new Set([...resources.fonts.values()].flatMap((faces) => faces.map((face) => face.assetRef)));
  for (const resource of plan.resources) {
    if (resource.kind === "image" && !preparedImages.has(resource.assetRef)) return { code: "gpu_static_plan_resource_mismatch", message: `GPU image resource ${resource.assetRef} was admitted by the static scene plan but was not prepared.` };
    if (resource.kind === "font" && !preparedFonts.has(resource.assetRef)) return { code: "gpu_static_plan_resource_mismatch", message: `GPU font resource ${resource.assetRef} was admitted by the static scene plan but was not prepared.` };
  }
  const expectedVideos = plan.resources.filter((resource) => resource.kind === "video");
  if (expectedVideos.length && !video) return { code: "gpu_static_plan_resource_mismatch", message: "GPU static scene plan requires admitted video resources, but no immutable video provider opened." };
  for (const resource of expectedVideos) if (!video?.inputHashes[resource.assetRef]) return { code: "gpu_static_plan_resource_mismatch", message: `GPU video resource ${resource.assetRef} was not bound by the immutable video provider.` };
  return null;
}

const RESOURCE_KIND = new Set(["image", "video", "font", "browser-surface"]);
const SHA256 = /^[a-f0-9]{64}$/;
function isSafePackageAssetRef(value: string): boolean { return value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."); }

/**
 * Core owns descriptor grammar and fingerprinting; final delivery independently
 * rechecks that the optional static-plan branch is an immutable, ordered,
 * non-empty set.  An empty own field would create a distinct fake no-module
 * plan, so it is refused rather than normalized away.
 */
function validateGpuStreamingStaticPlanEffectModules(plan: GpuStreamingStaticPlan): GpuStaticPlanFailure | null {
  const ownsEffectModules = Object.prototype.hasOwnProperty.call(plan, "effectModules");
  if (!ownsEffectModules) return null;
  const descriptors = plan.effectModules;
  if (!Array.isArray(descriptors) || descriptors.length < 1 || !Object.isFrozen(descriptors)) {
    return { code: "gpu_static_plan_invalid", message: "GPU effect-module static plans require one immutable non-empty descriptor set." };
  }
  let previous = "";
  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    if (!Object.isFrozen(descriptor) || gpuEffectModuleStaticDescriptorProblem(descriptor) !== null
      || ids.has(descriptor.layerId) || (previous && descriptor.layerId <= previous)) {
      return { code: "gpu_static_plan_invalid", message: "GPU effect-module static descriptors must be immutable, canonical, unique, and ordered." };
    }
    ids.add(descriptor.layerId);
    previous = descriptor.layerId;
  }
  return null;
}
