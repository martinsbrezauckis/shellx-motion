import { GPU_MAX_FRAME_DIMENSION, GPU_MAX_FRAME_PIXELS, GPU_MAX_POINTS } from "./gpu-frame-intent";
import { gpuComputeParticleEmitterAbi, gpuComputeParticleEmitterProblem, isGpuComputeParticleEmitter, GPU_COMPUTE_PARTICLE_INSTANCE_BYTES, GPU_COMPUTE_PARTICLE_PING_PONG_BUFFER_COUNT, GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES, GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT, GPU_COMPUTE_PARTICLE_V2_COMPUTE_DISPATCH_COUNT, GPU_COMPUTE_PARTICLE_V2_MAX_RASTER_PASS_COUNT, GPU_COMPUTE_PARTICLE_V2_MIN_RASTER_PASS_COUNT } from "./gpu-particle-compute";
import { gpuSceneHasOnlySupportedEffects } from "./gpu-scene-effects";
import type { GpuScene2dFailure } from "./gpu-scene-2d-plan";
import { gpuSceneUnsupportedFeature } from "./gpu-scene-2d-admission";
import { gpuSceneHasActiveWipeTransition } from "./gpu-scene-wipe-transition";
import { resolveGpuSceneChromaKey } from "./gpu-scene-chroma-key";
import { validateMotionGroups } from "./motion-group-validation";
import { validateScene3DLayers } from "./scene-3d-validate";
import { requestedAgentScriptMode } from "./agent-script-provenance";
import { gpuRestrictedShaderAssetRef, gpuRestrictedShaderTextureDimensions, isGpuRestrictedShaderHybridLayer } from "./gpu-scene-restricted-shader";
import type { MotionDocument, MotionLayer } from "./types";

const GROUP_TRANSFORMS = new Set(["x", "y", "scale", "rotation", "originX", "originY", "opacity"]);
const CAMERA_TRANSFORMS = new Set(["x", "y", "scale", "rotation", "originX", "originY", "opacity"]);
const GROUP_KEYFRAMES = new Set(["transform.x", "transform.y", "transform.scale", "transform.rotation", "transform.originX", "transform.originY", "opacity", "effects.blur", "effects.brightness", "effects.contrast", "effects.saturate", "effects.grayscale"]);
const CAMERA_KEYFRAMES = new Set(["transform.x", "transform.y", "transform.scale", "transform.rotation", "transform.originX", "transform.originY", "opacity"]);

/**
 * Checks package-wide facts before staging opens a file or runtime launches a browser.
 * This intentionally validates source topology, not evaluated frame geometry: exact dynamic
 * values remain the responsibility of compileGpuScene2dPlan at each requested timestamp.
 */
export function validateGpuSceneStaticDocument(motion: MotionDocument): GpuScene2dFailure | null {
  if (!Number.isFinite(motion.durationMs) || motion.durationMs <= 0 || !Number.isFinite(motion.fps) || motion.fps <= 0) {
    return failure("gpu_invalid_time", "GPU static planning requires positive finite durationMs and fps.");
  }
  if (!Number.isInteger(motion.width) || !Number.isInteger(motion.height) || motion.width < 1 || motion.height < 1 || motion.width > GPU_MAX_FRAME_DIMENSION || motion.height > GPU_MAX_FRAME_DIMENSION || motion.width * motion.height > GPU_MAX_FRAME_PIXELS) {
    return failure("gpu_resource_refused", `GPU static planning requires frame dimensions within ${GPU_MAX_FRAME_DIMENSION}px and ${GPU_MAX_FRAME_PIXELS} pixels.`);
  }
  const groupErrors: Array<{ path: string; message: string }> = [];
  validateMotionGroups(motion.layers, groupErrors);
  if (groupErrors.length > 0) return failure("gpu_unsupported_feature", `GPU group graph is invalid at ${groupErrors[0].path}: ${groupErrors[0].message}.`);
  const scene3dErrors: Array<{ path: string; message: string }> = [];
  validateScene3DLayers(motion.layers, scene3dErrors);
  if (scene3dErrors.length > 0) return failure("gpu_unsupported_feature", `GPU scene3d topology is invalid at ${scene3dErrors[0].path}: ${scene3dErrors[0].message}.`);
  const ids = new Set<string>();
  const browserSurfaces: MotionLayer[] = [];
  const restrictedShaderSurfaces: MotionLayer[] = [];
  let firstBrowserSurface: MotionLayer | undefined;
  for (const layer of motion.layers) {
    if (!layer.id || ids.has(layer.id)) return failure("gpu_unsupported_feature", `GPU static planning requires unique non-empty layer ids${layer.id ? `; duplicate ${layer.id}` : ""}.`, layer.id || undefined);
    ids.add(layer.id);
    if (!Number.isFinite(layer.startMs) || !Number.isFinite(layer.durationMs) || layer.durationMs < 0) return failure("gpu_invalid_time", `GPU layer ${layer.id} has invalid timing.`, layer.id);
    if (isBrowserSurfaceLayer(layer.type)) {
      firstBrowserSurface ??= layer;
      if (layer.visible !== false) browserSurfaces.push(layer);
    }
    if (layer.visible !== false && isGpuRestrictedShaderHybridLayer(layer)) restrictedShaderSurfaces.push(layer);
  }
  // G7 deliberately starts with one source surface. Browser-session policy
  // captures exactly one document and GPU still owns all composition around it;
  // admitting several would silently select only the first document.
  if (browserSurfaces.length > 1) return failure("gpu_resource_refused", "GPU hybrid composition accepts exactly one visible browser surface per package.", browserSurfaces[1].id);
  if (restrictedShaderSurfaces.length > 1) return failure("gpu_resource_refused", "GPU restricted-shader hybrid accepts exactly one visible package GLSL surface per package.", restrictedShaderSurfaces[1].id);
  if (browserSurfaces.length + restrictedShaderSurfaces.length > 1) return failure("gpu_resource_refused", "GPU hybrid composition accepts one governed browser or restricted-shader surface per package.", restrictedShaderSurfaces[0]?.id ?? browserSurfaces[0]?.id);
  const browserSurface = browserSurfaces[0];
  const governedHybrid = browserSurface ?? restrictedShaderSurfaces[0];
  if (governedHybrid) {
    if (requestedAgentScriptMode(motion) !== "none") return failure("gpu_unsupported_feature", `GPU governed hybrid surface ${governedHybrid.id} refuses active or unrecognized package scripts in the deterministic hybrid profile.`, governedHybrid.id);
  }
  if (browserSurface) {
    // The governed browser session intentionally loads its first browser
    // source. Refuse a hidden predecessor rather than letting the GPU plan
    // bind a visible surface to a different captured document.
    if (firstBrowserSurface?.id !== browserSurface.id) return failure("gpu_resource_refused", `GPU browser surface ${browserSurface.id} must be the first browser surface in document order.`, browserSurface.id);
    const source = typeof browserSurface.source === "string" ? browserSurface.source : "";
    if (!isPackageHtmlSource(source)) return failure("gpu_unsupported_feature", `GPU browser surface ${browserSurface.id} must reference one package-relative HTML source.`, browserSurface.id);
    if (Array.isArray(browserSurface.allowedOrigins) && browserSurface.allowedOrigins.length > 0) return failure("gpu_unsupported_feature", `GPU browser surface ${browserSurface.id} refuses remote network origins in the deterministic hybrid profile.`, browserSurface.id);
  }
  return null;
}

/** Validates a layer that can become visible in the package timeline. */
export function validateGpuSceneStaticLayer(motion: MotionDocument, layer: MotionLayer): GpuScene2dFailure | null {
  if (layer.type === "audio") return null;
  if (layer.type === "group") return validateGroup(layer);
  if (layer.type === "camera") return validateCamera(layer);
  // A video decoder supplies one exact canonical frame. It cannot provide the shutter-time
  // sequence temporal blur needs, so reject this during static admission rather than allowing
  // capability selection to promise a path the frame compiler will later refuse.
  if (layer.type === "video" && layer.effects?.motionBlur) {
    return failure("gpu_unsupported_feature", `GPU video layer ${layer.id} does not support temporal motion blur until its decoder can supply every shutter sample.`, layer.id);
  }
  if (layer.type === "particles" && (layer.emitter?.count ?? 0) > 1_000) {
    const problem = gpuComputeParticleEmitterProblem(layer.emitter);
    if (problem) return failure("gpu_resource_refused", `GPU scene layer ${layer.id} ${problem}`, layer.id);
    if (!isGpuComputeParticleEmitter(layer.emitter)) return failure("gpu_resource_refused", `GPU scene layer ${layer.id} cannot form a fixed compute particle descriptor.`, layer.id);
    if (gpuComputeParticleEmitterAbi(layer.emitter) === "v2") {
      if ((layer.blendMode ?? "normal") !== "normal" || layer.effects || layer.depth !== undefined || gpuSceneHasActiveWipeTransition(layer)) return failure("gpu_unsupported_feature", `GPU fixed v2 compute particle layer ${layer.id} requires normal blend with no effects, depth, or wipe transition.`, layer.id);
    } else if ((layer.blendMode ?? "normal") !== "normal" || layer.effects || layer.mask || layer.matte) return failure("gpu_unsupported_feature", `GPU compute particle layer ${layer.id} requires normal blend with no effects, masks, or mattes.`, layer.id);
  }
  const unsupported = gpuSceneUnsupportedFeature(layer);
  if (unsupported && !unsupported.ok) return unsupported.failure;
  if (isGpuRestrictedShaderHybridLayer(layer)) {
    if (!gpuRestrictedShaderAssetRef(motion, layer)) return failure("gpu_unsupported_feature", `GPU restricted-shader layer ${layer.id} must reference one declared text/x-shellx-motion-glsl package asset.`, layer.id);
    if (!gpuRestrictedShaderTextureDimensions(motion, layer)) return failure("gpu_resource_refused", `GPU restricted-shader layer ${layer.id} texture dimensions exceed the 4096px and 16-megapixel bounded browser/GPU surface budget.`, layer.id);
  }
  const chroma = resolveGpuSceneChromaKey(layer);
  if (!chroma.ok) return failure("gpu_unsupported_feature", chroma.message, layer.id);
  return validateMaskOrMatte(motion, layer);
}

/** Validates cross-layer matte references even when a source starts later than its consumer. */
export function validateGpuSceneStaticMattes(motion: MotionDocument, layers: readonly MotionLayer[]): GpuScene2dFailure | null {
  for (const layer of layers) {
    const matte = layer.matte;
    if (!matte) continue;
    if (!MATTE_TYPES.has(matte.type)) return failure("gpu_unsupported_feature", `GPU scene layer ${layer.id} has unsupported matte type '${matte.type}'.`, layer.id);
    const source = motion.layers.find((candidate) => candidate.id === matte.sourceLayerId);
    if (!source) return failure("gpu_unsupported_feature", `GPU scene layer ${layer.id} references missing matte source ${matte.sourceLayerId}.`, layer.id);
    if (source.type !== "shape" || (source.shape !== "rect" && source.shape !== "ellipse" && source.shape !== "triangle")) return failure("gpu_unsupported_feature", `GPU track mattes require rect, ellipse, or triangle shape source ${source.id}.`, layer.id);
    if (source.mask || source.matte || source.effects || source.blendMode || source.transitions || source.keyframes || source.label || source.visible === false) return failure("gpu_unsupported_feature", `GPU matte source ${source.id} must remain a static uncomposited shape.`, source.id);
    if (Object.keys(source.style ?? {}).some((key) => ["stroke", "shadow", "boxShadow", "borderRadius", "radius", "opacity"].includes(key))) return failure("gpu_unsupported_feature", `GPU matte source ${source.id} cannot use strokes, shadows, radii or style opacity.`, source.id);
  }
  return null;
}

function validateGroup(layer: MotionLayer): GpuScene2dFailure | null {
  if (!gpuSceneHasOnlySupportedEffects(layer) || layer.effects?.motionBlur) return failure("gpu_unsupported_feature", `GPU group ${layer.id} supports bounded spatial effects but not group temporal blur.`, layer.id);
  if (gpuSceneHasActiveWipeTransition(layer)) return failure("gpu_unsupported_feature", `GPU group ${layer.id} cannot lower a wipe transition exactly through the fixed single-mask compositor.`, layer.id);
  if (layer.matte || layer.crop || layer.keying || layer.pathReveal || layer.depth !== undefined || layer.textFit || layer.emitter || layer.pointCloud || layer.shader || layer.scene3d || layer.environment || layer.gradient || Object.keys(layer.style ?? {}).length > 0) return failure("gpu_unsupported_feature", `GPU group ${layer.id} carries unsupported layer-specific fields.`, layer.id);
  if (Object.keys(layer.transform ?? {}).some((key) => !GROUP_TRANSFORMS.has(key)) || Object.keys(layer.keyframes ?? {}).some((key) => !GROUP_KEYFRAMES.has(key))) return failure("gpu_unsupported_feature", `GPU group ${layer.id} has unsupported transform or keyframe state.`, layer.id);
  return validateMaskOrMatte(undefined, layer);
}

function validateCamera(layer: MotionLayer): GpuScene2dFailure | null {
  if (layer.mask || layer.matte || layer.effects || layer.keying || layer.crop || layer.pathReveal || layer.textFit || layer.gradient || Object.keys(layer.style ?? {}).length > 0 || Object.keys(layer.transform ?? {}).some((key) => !CAMERA_TRANSFORMS.has(key)) || Object.keys(layer.keyframes ?? {}).some((key) => !CAMERA_KEYFRAMES.has(key))) return failure("gpu_unsupported_feature", `GPU camera ${layer.id} accepts only bounded camera transforms and transform keyframes.`, layer.id);
  return null;
}

function validateMaskOrMatte(motion: MotionDocument | undefined, layer: MotionLayer): GpuScene2dFailure | null {
  if (layer.mask && layer.matte) return failure("gpu_unsupported_feature", `GPU layer ${layer.id} cannot combine a mask and track matte.`, layer.id);
  if (layer.mask) {
    if (layer.mask.type !== "rect" && layer.mask.type !== "rounded-rect") return failure("gpu_unsupported_feature", `GPU scene supports rect and rounded-rect masks; layer ${layer.id} uses '${layer.mask.type}'.`, layer.id);
    const values = [layer.mask.radius, layer.mask.opacity, layer.mask.featherPx, layer.mask.expansionPx, layer.mask.inset?.top, layer.mask.inset?.right, layer.mask.inset?.bottom, layer.mask.inset?.left].filter((value): value is number => value !== undefined);
    if (values.some((value) => !Number.isFinite(value))) return failure("gpu_unsupported_feature", `GPU scene layer ${layer.id} has non-finite mask geometry.`, layer.id);
  }
  if (layer.matte && motion === undefined) return failure("gpu_unsupported_feature", `GPU group ${layer.id} cannot use a track matte.`, layer.id);
  return null;
}

export function staticLayerPointCount(layer: MotionLayer): number {
  const points = layer.type === "points" ? layer.pointCloud?.points.length ?? 0 : layer.type === "particles" && !isGpuComputeParticleEmitter(layer.emitter) ? layer.emitter?.count ?? 0 : 0;
  return Number.isInteger(points) && points >= 0 && points <= GPU_MAX_POINTS ? points : GPU_MAX_POINTS + 1;
}

export function staticLayerComputeParticleCount(layer: MotionLayer): number {
  return layer.type === "particles" && isGpuComputeParticleEmitter(layer.emitter) ? layer.emitter.count : 0;
}

/** Static retained-memory and pass accounting shared with topology planning. */
export function staticLayerComputeParticleBudget(layer: MotionLayer): { instanceBytes: number; retainedMemoryBytes: number; computeDispatchCount: number; rasterPassCount: number } {
  if (layer.type !== "particles" || !isGpuComputeParticleEmitter(layer.emitter)) return { instanceBytes: 0, retainedMemoryBytes: 0, computeDispatchCount: 0, rasterPassCount: 0 };
  if (gpuComputeParticleEmitterAbi(layer.emitter) === "v2") {
    const trail = layer.emitter.trail;
    return { instanceBytes: GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES, retainedMemoryBytes: layer.emitter.count * GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES * GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT, computeDispatchCount: GPU_COMPUTE_PARTICLE_V2_COMPUTE_DISPATCH_COUNT, rasterPassCount: trail ? GPU_COMPUTE_PARTICLE_V2_MAX_RASTER_PASS_COUNT : GPU_COMPUTE_PARTICLE_V2_MIN_RASTER_PASS_COUNT };
  }
  return { instanceBytes: GPU_COMPUTE_PARTICLE_INSTANCE_BYTES, retainedMemoryBytes: layer.emitter.count * GPU_COMPUTE_PARTICLE_INSTANCE_BYTES * GPU_COMPUTE_PARTICLE_PING_PONG_BUFFER_COUNT, computeDispatchCount: 1, rasterPassCount: 1 };
}

const MATTE_TYPES = new Set(["alpha", "alpha-inverted", "luma", "luma-inverted"]);
function isBrowserSurfaceLayer(type: unknown): boolean { return type === "web" || type === "html" || type === "canvas"; }
function isPackageHtmlSource(source: string): boolean {
  const lower = source.toLowerCase();
  return source.length > 0 && source.length <= 512 && !source.startsWith("/") && !source.includes("\\") && !source.includes("\0")
    && source.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
    && (lower.endsWith(".html") || lower.endsWith(".htm"));
}
function failure(code: GpuScene2dFailure["code"], message: string, layerId?: string): GpuScene2dFailure { return { code, message, ...(layerId ? { layerId } : {}) }; }
