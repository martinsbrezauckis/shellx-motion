import { canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { GPU_MAX_COMPUTE_PARTICLE_FIELDS, GPU_MAX_COMPUTE_PARTICLES, GPU_MAX_POINTS, GPU_MAX_TRIANGLE_VERTICES } from "./gpu-frame-intent";
import { gpuImageMimeTypeForAssetRef, type GpuImageMimeType } from "./gpu-image-resource";
import { parseGpuSceneColor } from "./gpu-scene-color";
import { gpuSceneImageAssetRef } from "./gpu-scene-media";
import { isGpuBrowserSurfaceLayer } from "./gpu-scene-2d-admission";
import { gpuRestrictedShaderAssetRef, isGpuRestrictedShaderHybridLayer } from "./gpu-scene-restricted-shader";
import { gpuSceneTextPrimaryFontFamily } from "./gpu-scene-text";
import { GPU_MAX_VISIBLE_VIDEO_SOURCES } from "./gpu-video-frame-request";
import { staticLayerComputeParticleBudget, staticLayerComputeParticleCount, staticLayerPointCount, validateGpuSceneStaticDocument, validateGpuSceneStaticLayer, validateGpuSceneStaticMattes } from "./gpu-scene-static-validation";
import { gpuComputeParticleEmitterAbi, GPU_COMPUTE_PARTICLE_V2_MAX_INSTANCE_MEMORY_BYTES } from "./gpu-particle-compute";
import { deriveGpuHybridTextureStaticDescriptor, type GpuHybridTextureStaticDescriptor } from "./gpu-hybrid-texture-request";
import { compileGpuSceneAuthoredShapeGeometry, hasGpuScenePathGeometry } from "./gpu-scene-path-geometry";
import { gpuSceneAuthoredDashScaleProblem, GPU_SCENE_AUTHORED_DASH_STROKE_MAX_VERTICES } from "./gpu-scene-path-tessellation";
import { resolveGpuEffectModuleDescriptors, type GpuEffectModuleRegistryEntry, type GpuEffectModuleRendererIdentity, type GpuEffectModuleStaticDescriptor } from "./effect-module";
import { motionBehaviorLaneRefusal } from "./motion-behavior-lane-refusal";
import { motionRelationLaneRefusal } from "./motion-relation-lane-refusal";
import { motionScene3DAnimationLaneRefusal } from "./motion-scene3d-animation-lane-refusal";
import { gpuUnloweredRootAuthorityRefusal } from "./gpu-root-authority-fence";
import { motionLayoutGapAnimationLaneRefusal } from "./motion-layout-gap-animation-lane-refusal";
import type { GpuScene2dFailure } from "./gpu-scene-2d-plan";
import type { MotionDocument, MotionFontAsset, MotionLayer } from "./types";

export const GPU_SCENE_STATIC_PLAN_SCHEMA = "shellx-motion/gpu-scene-static-plan@1" as const;
export const GPU_STATIC_MAX_CANONICAL_FRAMES = 10_000_000;

export interface GpuSceneStaticResourceReference {
  key: string;
  kind: "image" | "video" | "font" | "browser-surface";
  assetRef: string;
  /** Fixed expected image MIME, selected before the package asset is opened. */
  mimeType?: GpuImageMimeType;
  family?: string;
  consumers: readonly { layerId: string; role: "texture" | "decoded-frame" | "font" | "environment-scene" | "environment-effect-mask" | "governed-browser-surface" | "governed-restricted-shader-surface" }[];
}
export interface GpuSceneStaticLayerTopology {
  id: string;
  type: string;
  startMs: number;
  endMs: number;
  firstCanonicalFrame: number | null;
  endCanonicalFrameExclusive: number | null;
  groupDepth: number;
  resourceKeys: readonly string[];
  keyframeTargets: readonly string[];
  /** No geometry is promised reusable: exact frames retain ownership of keyframed evaluation. */
  geometry: { reuse: "not-claimed"; keyframed: boolean };
}
export interface GpuSceneStaticMaxima {
  canonicalFrameCount: number;
  maxVisualLayerCount: number;
  maxGroupCount: number;
  maxPointCount: number;
  /** High-density fixed analytic compute particles are not CPU point instances. */
  maxComputeParticleFieldCount: number;
  maxComputeParticleCount: number;
  maxComputeParticleInstanceBytes: number;
  maxComputeParticleRetainedMemoryBytes: number;
  maxComputeParticleComputeDispatchCount: number;
  maxComputeParticleRasterPassCount: number;
  maxImageCount: number;
  /** At most one governed browser producer is admitted in v0.2 G7. */
  maxBrowserSurfaceCount: number;
  maxVideoCount: number;
  maxTextCount: number;
  maxAdjustmentCount: number;
  maxScene3dCount: number;
  maxScene3dObjectCount: number;
  maxEnvironmentCount: number;
  maxMaterialCount: number;
  resourceReferenceCount: number;
}
export interface GpuSceneStaticPlan {
  schema: typeof GPU_SCENE_STATIC_PLAN_SCHEMA;
  fingerprint: string;
  documentFingerprint: string;
  canonicalFrameCount: number;
  resources: readonly GpuSceneStaticResourceReference[];
  /** Present only for governed hybrid plans; omission preserves the legacy static-plan@1 identity. */
  hybridTextures?: readonly GpuHybridTextureStaticDescriptor[];
  /** Present only for host-resolved closed local modules; omission preserves @1 no-module identity. */
  effectModules?: readonly GpuEffectModuleStaticDescriptor[];
  layers: readonly GpuSceneStaticLayerTopology[];
  maxima: Readonly<GpuSceneStaticMaxima>;
}
export type GpuSceneStaticPlanResult = { ok: true; plan: GpuSceneStaticPlan } | { ok: false; failure: GpuScene2dFailure };
export interface GpuSceneStaticCompileResources { effectModuleRegistry?: ReadonlyMap<string, GpuEffectModuleRegistryEntry>; effectModuleRendererIdentity?: GpuEffectModuleRendererIdentity }

/**
 * Plans immutable package topology before staging. It reads only Motion data and never opens an
 * asset path; resource bytes, decoded images and exact video frames stay with the runtime stage.
 */
export function compileGpuSceneStaticPlan(motion: MotionDocument, compileResources: GpuSceneStaticCompileResources = {}): GpuSceneStaticPlanResult {
  const rootAuthorityRefusal = gpuUnloweredRootAuthorityRefusal(motion, "static");
  if (rootAuthorityRefusal) return fail("gpu_unsupported_feature", rootAuthorityRefusal);
  const layoutGapAnimationRefusal = motionLayoutGapAnimationLaneRefusal(motion, "gpu-static");
  if (layoutGapAnimationRefusal) return fail("gpu_unsupported_feature", layoutGapAnimationRefusal.message);
  const scene3dAnimationRefusal = motionScene3DAnimationLaneRefusal(motion, "gpu-static");
  if (scene3dAnimationRefusal) return fail("gpu_unsupported_feature", scene3dAnimationRefusal.message);
  const relationRefusal = motionRelationLaneRefusal(motion, "gpu-static");
  if (relationRefusal) return fail("gpu_unsupported_feature", relationRefusal.message);
  const behaviorRefusal = motionBehaviorLaneRefusal(motion, "gpu-static");
  if (behaviorRefusal) return fail("gpu_unsupported_feature", behaviorRefusal.message);
  const documentFailure = validateGpuSceneStaticDocument(motion);
  if (documentFailure) return { ok: false, failure: documentFailure };
  if (!parseGpuSceneColor(motion.background ?? "transparent")) return fail("gpu_unsupported_color", "GPU scenes accept only transparent or hexadecimal document backgrounds.");
  const effectModules = resolveGpuEffectModuleDescriptors(motion, compileResources.effectModuleRegistry, compileResources.effectModuleRendererIdentity); if (!effectModules.ok) return fail("gpu_resource_refused", effectModules.message, effectModules.layerId);
  const canonicalFrameCount = Math.ceil((motion.durationMs * motion.fps) / 1_000);
  if (!Number.isSafeInteger(canonicalFrameCount) || canonicalFrameCount < 1 || canonicalFrameCount > GPU_STATIC_MAX_CANONICAL_FRAMES) return fail("gpu_resource_refused", `GPU static planning accepts at most ${GPU_STATIC_MAX_CANONICAL_FRAMES} canonical frames.`);
  const byId = new Map(motion.layers.map((layer) => [layer.id, layer]));
  const owned = new Set(motion.layers.filter((layer) => layer.type === "group").flatMap((layer) => layer.childLayerIds ?? []));
  const matteSources = new Set(motion.layers.map((layer) => layer.matte?.sourceLayerId).filter((id): id is string => typeof id === "string"));
  const resources = new ResourceCollector(); const candidates: Candidate[] = [];
  const visit = (layer: MotionLayer, offsetMs: number, ancestorStart: number, ancestorEnd: number, groupDepth: number): GpuScene2dFailure | null => {
    if (layer.visible === false) return null;
    const startMs = Math.max(0, ancestorStart, offsetMs + layer.startMs);
    const endMs = Math.min(motion.durationMs, ancestorEnd, offsetMs + layer.startMs + layer.durationMs);
    if (endMs <= startMs) return null;
    const invalid = validateGpuSceneStaticLayer(motion, layer); if (invalid) return invalid;
    const resourceKeys = collectResources(motion, layer, byId, resources);
    if (resourceKeys instanceof Error) return failure("gpu_unsupported_feature", resourceKeys.message, layer.id);
    candidates.push({ layer, startMs, endMs, groupDepth, resourceKeys, matteSource: matteSources.has(layer.id) });
    if (layer.type !== "group") return null;
    for (const childId of layer.childLayerIds ?? []) {
      const child = byId.get(childId); if (!child) return failure("gpu_unsupported_feature", `GPU group ${layer.id} references missing child ${childId}.`, layer.id);
      const issue = visit(child, offsetMs + layer.startMs, startMs, endMs, groupDepth + 1); if (issue) return issue;
    }
    return null;
  };
  for (const layer of motion.layers) if (!owned.has(layer.id)) { const issue = visit(layer, 0, 0, motion.durationMs, 1); if (issue) return { ok: false, failure: issue }; }
  const matteFailure = validateGpuSceneStaticMattes(motion, candidates.map((candidate) => candidate.layer));
  if (matteFailure) return { ok: false, failure: matteFailure };
  const authoredTriangleFailure = validateStaticAuthoredShapeTriangleLoad(candidates, motion.fps, canonicalFrameCount);
  if (authoredTriangleFailure) return { ok: false, failure: authoredTriangleFailure };
  const computeParticleCapacities = new Set(
    candidates.map((candidate) => staticLayerComputeParticleCount(candidate.layer)).filter((count) => count > 0)
  );
  if (computeParticleCapacities.size > 1) {
    return fail("gpu_resource_refused", "GPU fixed particle compute requires one retained particle capacity across the complete timeline.");
  }
  const computeParticleAbis = new Set(candidates.map((candidate) => gpuComputeParticleEmitterAbi(candidate.layer.emitter)).filter((abi): abi is "v1" | "v2" => abi !== null));
  if (computeParticleAbis.size > 1) {
    return fail("gpu_resource_refused", "GPU fixed particle compute requires one retained particle ABI across the complete timeline so one session cannot install both retained pools.");
  }
  const layers = candidates.map((candidate) => topology(candidate, motion.fps, canonicalFrameCount));
  const references = resources.finish();
  const hybridTextures = candidates.flatMap((candidate) => {
    const descriptor = deriveGpuHybridTextureStaticDescriptor(motion, candidate.layer);
    return descriptor ? [descriptor] : [];
  }).sort((left, right) => compareCodeUnits(left.layerId, right.layerId));
  if (hybridTextures.length > 1) return fail("gpu_resource_refused", "GPU static planning found more than one governed hybrid texture descriptor.");
  const visibleVideoLayers = candidates.filter((candidate) => candidate.layer.type === "video" && !candidate.matteSource);
  const visibleVideoSources = new Set(visibleVideoLayers.flatMap((candidate) => candidate.resourceKeys));
  if (visibleVideoLayers.length > GPU_MAX_VISIBLE_VIDEO_SOURCES || visibleVideoSources.size > GPU_MAX_VISIBLE_VIDEO_SOURCES) {
    return fail("gpu_resource_refused", `GPU static planning accepts at most ${GPU_MAX_VISIBLE_VIDEO_SOURCES} visible video layers and sources.`, visibleVideoLayers[GPU_MAX_VISIBLE_VIDEO_SOURCES]?.layer.id);
  }
  const measured = measure(candidates, motion.fps, canonicalFrameCount, references.length);
  if (measured instanceof Error) return fail("gpu_resource_refused", measured.message);
  const maxima = measured;
  const documentFingerprint = canonicalJsonSha256(motion);
  const fingerprintPayload = { schema: GPU_SCENE_STATIC_PLAN_SCHEMA, documentFingerprint, canonicalFrameCount, resources: references, ...(hybridTextures.length ? { hybridTextures } : {}), ...(effectModules.descriptors.length ? { effectModules: effectModules.descriptors } : {}), layers, maxima };
  const fingerprint = canonicalJsonSha256(fingerprintPayload);
  return { ok: true, plan: immutable({ schema: GPU_SCENE_STATIC_PLAN_SCHEMA, fingerprint, documentFingerprint, canonicalFrameCount, resources: references, ...(hybridTextures.length ? { hybridTextures } : {}), ...(effectModules.descriptors.length ? { effectModules: effectModules.descriptors } : {}), layers, maxima }) };
}

interface Candidate { layer: MotionLayer; startMs: number; endMs: number; groupDepth: number; resourceKeys: readonly string[]; matteSource: boolean }
type Metric = Omit<GpuSceneStaticMaxima, "canonicalFrameCount" | "resourceReferenceCount">;
const ZERO: Metric = { maxVisualLayerCount: 0, maxGroupCount: 0, maxPointCount: 0, maxComputeParticleFieldCount: 0, maxComputeParticleCount: 0, maxComputeParticleInstanceBytes: 0, maxComputeParticleRetainedMemoryBytes: 0, maxComputeParticleComputeDispatchCount: 0, maxComputeParticleRasterPassCount: 0, maxImageCount: 0, maxBrowserSurfaceCount: 0, maxVideoCount: 0, maxTextCount: 0, maxAdjustmentCount: 0, maxScene3dCount: 0, maxScene3dObjectCount: 0, maxEnvironmentCount: 0, maxMaterialCount: 0 };

function topology(candidate: Candidate, fps: number, frameCount: number): GpuSceneStaticLayerTopology {
  const interval = frameInterval(candidate.startMs, candidate.endMs, fps, frameCount);
  const keyframeTargets = [
    ...Object.keys(candidate.layer.keyframes ?? {}),
    ...(candidate.layer.gradient?.colorKeyframes ? ["gradient.colorKeyframes"] : []),
  ].sort(compareCodeUnits);
  return { id: candidate.layer.id, type: candidate.layer.type, startMs: candidate.startMs, endMs: candidate.endMs, firstCanonicalFrame: interval ? interval.start : null, endCanonicalFrameExclusive: interval ? interval.end : null, groupDepth: candidate.groupDepth, resourceKeys: [...candidate.resourceKeys].sort(compareCodeUnits), keyframeTargets, geometry: { reuse: "not-claimed", keyframed: keyframeTargets.some((key) => key.startsWith("transform.") || key === "gradient.angle" || key === "gradient.colorKeyframes") } };
}

function measure(candidates: readonly Candidate[], fps: number, frameCount: number, resourceReferenceCount: number): GpuSceneStaticMaxima | Error {
  const events = new Map<number, Metric>();
  for (const candidate of candidates) {
    const interval = frameInterval(candidate.startMs, candidate.endMs, fps, frameCount); if (!interval) continue;
    const value = contribution(candidate); add(events, interval.start, value, 1); add(events, interval.end, value, -1);
  }
  const current = { ...ZERO }, maximum = { ...ZERO };
  for (const frame of [...events.keys()].sort((left, right) => left - right)) { addMetric(current, events.get(frame)!); for (const key of Object.keys(ZERO) as (keyof Metric)[]) maximum[key] = Math.max(maximum[key], current[key]); }
  if (maximum.maxPointCount > GPU_MAX_POINTS) return new Error(`GPU scene exceeds its ${GPU_MAX_POINTS}-point total admission limit.`);
  if (maximum.maxComputeParticleFieldCount > GPU_MAX_COMPUTE_PARTICLE_FIELDS || maximum.maxComputeParticleCount > GPU_MAX_COMPUTE_PARTICLES || maximum.maxComputeParticleRetainedMemoryBytes > GPU_COMPUTE_PARTICLE_V2_MAX_INSTANCE_MEMORY_BYTES) return new Error(`GPU scene exceeds its ${GPU_MAX_COMPUTE_PARTICLES}-particle or ${GPU_COMPUTE_PARTICLE_V2_MAX_INSTANCE_MEMORY_BYTES}-byte fixed compute-field admission limit.`);
  if (maximum.maxBrowserSurfaceCount > 1) return new Error("GPU hybrid composition accepts at most one active browser surface per canonical frame.");
  return { canonicalFrameCount: frameCount, ...maximum, resourceReferenceCount };
}

function contribution(candidate: Candidate): Metric {
  const layer = candidate.layer; const visual = candidate.matteSource || layer.type === "audio" || layer.type === "camera" ? 0 : 1;
  const scene3dObjects = layer.type === "scene3d" && Array.isArray(layer.scene3d?.objects) ? layer.scene3d.objects.length : 0;
  const computeParticles = staticLayerComputeParticleCount(layer), computeBudget = staticLayerComputeParticleBudget(layer);
  return { maxVisualLayerCount: visual, maxGroupCount: layer.type === "group" ? 1 : 0, maxPointCount: staticLayerPointCount(layer), maxComputeParticleFieldCount: computeParticles > 0 ? 1 : 0, maxComputeParticleCount: computeParticles, maxComputeParticleInstanceBytes: computeBudget.instanceBytes, maxComputeParticleRetainedMemoryBytes: computeBudget.retainedMemoryBytes, maxComputeParticleComputeDispatchCount: computeBudget.computeDispatchCount, maxComputeParticleRasterPassCount: computeBudget.rasterPassCount, maxImageCount: layer.type === "image" ? 1 : 0, maxBrowserSurfaceCount: isGpuBrowserSurfaceLayer(layer.type) || isGpuRestrictedShaderHybridLayer(layer) ? 1 : 0, maxVideoCount: layer.type === "video" ? 1 : 0, maxTextCount: layer.type === "text" || layer.type === "caption" ? 1 : 0, maxAdjustmentCount: layer.type === "adjustment" ? 1 : 0, maxScene3dCount: layer.type === "scene3d" ? 1 : 0, maxScene3dObjectCount: scene3dObjects, maxEnvironmentCount: layer.type === "environment" ? 1 : 0, maxMaterialCount: layer.type === "shader" && !isGpuRestrictedShaderHybridLayer(layer) ? 1 : 0 };
}

/** Bounds the exact v1 contour output before a frame compiler reaches its 65,535-vertex limit. */
function validateStaticAuthoredShapeTriangleLoad(candidates: readonly Candidate[], fps: number, frameCount: number): GpuScene2dFailure | null {
  const events = new Map<number, number>();
  for (const candidate of candidates) {
    if (candidate.matteSource || candidate.layer.type !== "shape" || !hasGpuScenePathGeometry(candidate.layer)) continue;
    const geometry = compileGpuSceneAuthoredShapeGeometry(candidate.layer);
    if (!geometry.ok) return failure("gpu_unsupported_feature", geometry.message, candidate.layer.id);
    const contour = geometry.geometry.contour;
    const dashScaleProblem = staticAuthoredShapeDashScaleProblem(candidate.layer, geometry.geometry.strokeDash ?? null);
    if (dashScaleProblem) return failure("gpu_unsupported_feature", dashScaleProblem, candidate.layer.id);
    // A static plan cannot know keyframed transform scale, so dashed strokes
    // reserve the exact Core segmenter's hard maximum rather than admitting a
    // scene that can exceed the frame-plan triangle ceiling later.
    const strokeVertices = geometry.geometry.stroke
      ? geometry.geometry.strokeDash ? GPU_SCENE_AUTHORED_DASH_STROKE_MAX_VERTICES : (contour.closed ? contour.vertices.length : contour.vertices.length - 1) * 6
      : 0;
    const vertices = (contour.closed ? geometry.geometry.fillTriangleIndices.length : 0) + strokeVertices;
    const samples = candidate.layer.effects?.motionBlur?.samples ?? 1;
    const interval = frameInterval(candidate.startMs, candidate.endMs, fps, frameCount);
    if (!Number.isSafeInteger(vertices) || !Number.isSafeInteger(samples) || vertices < 0 || samples < 1 || !interval) return failure("gpu_resource_refused", `GPU shape ${candidate.layer.id} has an invalid static triangle bound.`, candidate.layer.id);
    events.set(interval.start, (events.get(interval.start) ?? 0) + vertices * samples);
    events.set(interval.end, (events.get(interval.end) ?? 0) - vertices * samples);
  }
  let current = 0;
  for (const frame of [...events.keys()].sort((left, right) => left - right)) {
    current += events.get(frame)!;
    if (current > GPU_MAX_TRIANGLE_VERTICES) return failure("gpu_resource_refused", `GPU scene exceeds ${GPU_MAX_TRIANGLE_VERTICES} authored shape triangle vertices at canonical frame ${frame}.`);
  }
  return null;
}

function staticAuthoredShapeDashScaleProblem(layer: MotionLayer, dash: import("./gpu-scene-stroke-dash").GpuSceneStrokeDash | null): string | null {
  const scales = [layer.transform?.scale ?? 1, ...(layer.keyframes?.["transform.scale"] ?? []).map((keyframe) => keyframe.value)];
  for (const scale of scales) {
    if (typeof scale !== "number") return "GPU authored dashed shape has a non-numeric transform.scale keyframe.";
    const problem = gpuSceneAuthoredDashScaleProblem(dash, scale);
    if (problem) return problem;
  }
  return null;
}

function collectResources(motion: MotionDocument, layer: MotionLayer, byId: ReadonlyMap<string, MotionLayer>, resources: ResourceCollector): readonly string[] | Error {
  const keys: string[] = []; const addImage = (assetRef: string, role: Parameters<ResourceCollector["add"]>[3]) => {
    const mimeType = gpuSceneImageMimeType(motion, assetRef);
    if (!mimeType) return new Error(`GPU image resource ${assetRef} has no admitted image MIME declaration or suffix.`);
    keys.push(resources.add("image", assetRef, layer.id, role, undefined, mimeType));
    return null;
  };
  if (layer.type === "image" || layer.type === "video") {
    const assetRef = gpuSceneImageAssetRef(motion, layer); if (!assetRef) return new Error(`GPU ${layer.type} layer ${layer.id} has no package asset reference.`);
    if (layer.type === "image") { const issue = addImage(assetRef, "texture"); if (issue) return issue; }
    else keys.push(resources.add("video", assetRef, layer.id, "decoded-frame"));
  }
  if (isGpuBrowserSurfaceLayer(layer.type)) {
    const assetRef = gpuSceneImageAssetRef(motion, layer);
    if (!assetRef) return new Error(`GPU browser surface layer ${layer.id} has no package HTML source.`);
    keys.push(resources.add("browser-surface", assetRef, layer.id, "governed-browser-surface"));
  }
  if (isGpuRestrictedShaderHybridLayer(layer)) {
    const assetRef = gpuRestrictedShaderAssetRef(motion, layer);
    if (!assetRef) return new Error(`GPU restricted-shader layer ${layer.id} has no declared package GLSL source.`);
    keys.push(resources.add("browser-surface", assetRef, layer.id, "governed-restricted-shader-surface"));
  }
  if (layer.type === "text" || layer.type === "caption") {
    const family = gpuSceneTextPrimaryFontFamily(motion, layer); if (!family) return new Error(`GPU text layer ${layer.id} requires a safe manifest-bound font family.`);
    const faces = motion.assets.map(fontAsset).filter((asset): asset is MotionFontAsset => asset !== null && asset.family.toLowerCase() === family.toLowerCase());
    if (!faces.length) return new Error(`GPU text layer ${layer.id} font family '${family}' is not backed by a manifest font asset.`);
    for (const face of faces) keys.push(resources.add("font", face.source.path, layer.id, "font", family));
  }
  if (layer.type === "environment" && layer.environment) for (const [sourceLayerId, role] of [[layer.environment.sceneSourceLayerId, "environment-scene"], [layer.environment.effectMaskLayerId, "environment-effect-mask"]] as const) if (sourceLayerId) {
    const source = byId.get(sourceLayerId); const assetRef = source && source.type === "image" ? gpuSceneImageAssetRef(motion, source) : null;
    if (!assetRef) return new Error(`GPU environment layer ${layer.id} ${role} requires an image source with a package asset reference.`);
    const issue = addImage(assetRef, role); if (issue) return issue;
  }
  return keys;
}

function gpuSceneImageMimeType(motion: MotionDocument, assetRef: string): GpuImageMimeType | null {
  for (const candidate of motion.assets) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const source = (candidate as { source?: unknown }).source;
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const record = source as { path?: unknown; mimeType?: unknown };
    if (record.path === assetRef && typeof record.mimeType === "string") {
      return record.mimeType === "image/png" || record.mimeType === "image/jpeg" || record.mimeType === "image/webp" || record.mimeType === "image/svg+xml" ? record.mimeType : null;
    }
  }
  return gpuImageMimeTypeForAssetRef(assetRef);
}

class ResourceCollector {
  readonly #values = new Map<string, { kind: GpuSceneStaticResourceReference["kind"]; assetRef: string; family?: string; mimeType?: GpuImageMimeType; consumers: { layerId: string; role: GpuSceneStaticResourceReference["consumers"][number]["role"] }[] }>();
  add(kind: GpuSceneStaticResourceReference["kind"], assetRef: string, layerId: string, role: GpuSceneStaticResourceReference["consumers"][number]["role"], family?: string, mimeType?: GpuImageMimeType): string { const key = `${kind}:${family ? `${family.toLowerCase()}:` : ""}${assetRef}`; const value = this.#values.get(key) ?? { kind, assetRef, ...(family ? { family } : {}), ...(mimeType ? { mimeType } : {}), consumers: [] }; if (value.mimeType !== mimeType) throw new Error(`GPU image resource ${assetRef} changed its admitted MIME classification.`); value.consumers.push({ layerId, role }); this.#values.set(key, value); return key; }
  finish(): GpuSceneStaticResourceReference[] { return [...this.#values.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([key, value]) => ({ key, kind: value.kind, assetRef: value.assetRef, ...(value.family ? { family: value.family } : {}), ...(value.mimeType ? { mimeType: value.mimeType } : {}), consumers: value.consumers.sort((left, right) => compareCodeUnits(left.layerId, right.layerId) || compareCodeUnits(left.role, right.role)) })); }
}

function frameInterval(startMs: number, endMs: number, fps: number, frameCount: number): { start: number; end: number } | null { const start = Math.max(0, Math.ceil((startMs * fps) / 1_000)); const end = Math.min(frameCount, Math.ceil((endMs * fps) / 1_000)); return start < end ? { start, end } : null; }
function add(events: Map<number, Metric>, frame: number, value: Metric, direction: 1 | -1): void { const target = events.get(frame) ?? { ...ZERO }; for (const key of Object.keys(ZERO) as (keyof Metric)[]) target[key] += value[key] * direction; events.set(frame, target); }
function addMetric(target: Metric, value: Metric): void { for (const key of Object.keys(ZERO) as (keyof Metric)[]) target[key] += value[key]; }
function fontAsset(value: unknown): MotionFontAsset | null { if (!value || typeof value !== "object" || Array.isArray(value)) return null; const record = value as Record<string, unknown>, source = record.source; if (record.type !== "font" || typeof record.id !== "string" || typeof record.family !== "string" || !source || typeof source !== "object" || Array.isArray(source)) return null; const fields = source as Record<string, unknown>; return typeof fields.path === "string" && (fields.mimeType === "font/woff2" || fields.mimeType === "font/woff" || fields.mimeType === "font/ttf" || fields.mimeType === "font/otf") ? value as MotionFontAsset : null; }
function failure(code: GpuScene2dFailure["code"], message: string, layerId?: string): GpuScene2dFailure { return { code, message, ...(layerId ? { layerId } : {}) }; }
function fail(code: GpuScene2dFailure["code"], message: string, layerId?: string): GpuSceneStaticPlanResult { return { ok: false, failure: failure(code, message, layerId) }; }
function immutable<T>(value: T): T { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const nested of Object.values(value as Record<string, unknown>)) immutable(nested); return Object.freeze(value); }
