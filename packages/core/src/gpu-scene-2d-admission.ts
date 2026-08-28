import { compileGpuSceneAdjustment, gpuSceneAdjustmentHasOnlySupportedEffects } from "./gpu-scene-adjustment";
import { resolveGpuSceneChromaKey } from "./gpu-scene-chroma-key";
import { gpuSceneHasOnlySupportedEffects } from "./gpu-scene-effects";
import { gpuSceneEllipseHasOnlySupportedStyles } from "./gpu-scene-ellipse";
import { validateGpuSceneEnvironmentLayer } from "./gpu-scene-environment";
import { validateGpuSceneMaterialLayer } from "./gpu-scene-material";
import { validateGpuSceneRestrictedShaderHybridLayer } from "./gpu-scene-restricted-shader";
import { canonicalGpuScenePrimitiveShape, gpuSceneUnsupportedShapeMessage } from "./gpu-scene-shape-geometry";
import { gpuSceneAuthoredShapeHasOnlySupportedStyles, gpuSceneAuthoredShapeUnsupportedFeature, gpuScenePathHasOnlySupportedStyles, gpuScenePathRevealUnsupportedFeature, gpuScenePathUnsupportedFeature, hasGpuScenePathGeometry, isGpuScenePathShape } from "./gpu-scene-path-lowering";
import { gpuSceneTrailProblem } from "./gpu-scene-trail";
import { gpuSceneWipeTransitionProblem } from "./gpu-scene-wipe-transition";
import { gpuComputeParticleEmitterAbi, isGpuComputeParticleEmitter } from "./gpu-particle-compute";
import { evaluateMotionGradientColorKeyframes } from "./motion-gradient-color-keyframes";
import type { GpuScene2dFailure, GpuScene2dPlanResult } from "./gpu-scene-2d-plan";
import type { MotionLayer } from "./types";

const SUPPORTED_KEYFRAMES = new Set(["transform.x", "transform.y", "transform.width", "transform.height", "transform.originX", "transform.originY", "transform.scale", "transform.rotation", "opacity", "fill", "style.fill", "style.color", "style.width", "style.height", "style.fontSize", "style.fontWeight", "style.letterSpacing", "style.lineHeight", "style.textAlign", "style.verticalAlign", "gradient.angle", "style.textShadow.x", "style.textShadow.y", "style.textShadow.offsetX", "style.textShadow.offsetY", "style.textShadow.blur", "style.textShadow.blurRadius", "style.textShadow.color", "style.stroke", "style.borderColor", "style.strokeWidth", "style.borderWidth", "style.radius", "style.borderRadius", "style.shadow.x", "style.shadow.y", "style.shadow.offsetX", "style.shadow.offsetY", "style.shadow.blur", "style.shadow.blurRadius", "style.shadow.spread", "style.shadow.spreadRadius", "style.shadow.color", "effects.blur", "effects.brightness", "effects.contrast", "effects.saturate", "effects.grayscale", "effects.glow.radius", "pathReveal.start", "pathReveal.end"]);
const SUPPORTED_TRANSFORM_FIELDS = new Set(["x", "y", "width", "height", "opacity", "scale", "rotation", "originX", "originY"]);
const SUPPORTED_STYLE_FIELDS = new Set(["fill", "color", "width", "height", "fit", "objectFit", "stroke", "borderColor", "strokeWidth", "borderWidth", "radius", "borderRadius", "shadow", "boxShadow"]);
const SUPPORTED_TEXT_STYLE_FIELDS = new Set(["color", "width", "height", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textAlign", "verticalAlign", "alignY", "direction", "textShadow", "shadow"]);

export function isGpuBrowserSurfaceLayer(type: unknown): type is "web" | "html" | "canvas" { return type === "web" || type === "html" || type === "canvas"; }

/** Static GPU admission shared by per-frame and package-static planning. */
export function gpuSceneUnsupportedFeature(layer: MotionLayer): GpuScene2dPlanResult | null {
  // Geometry keyframes have an exact-atUs composition wrapper. Generic static/frame compilation
  // must refuse them so a direct caller cannot silently lower the owning static geometry instead.
  if (layer.geometryKeyframes !== undefined) return fail("gpu_unsupported_feature", `GPU shape geometry keyframes on layer ${layer.id} require the exact geometry-keyframe composition wrapper.`, layer.id);
  if (layer.type !== "shape" && layer.type !== "points" && layer.type !== "particles" && layer.type !== "image" && layer.type !== "video" && !isGpuBrowserSurfaceLayer(layer.type) && layer.type !== "text" && layer.type !== "caption" && layer.type !== "adjustment" && layer.type !== "scene3d" && layer.type !== "environment" && layer.type !== "shader") return fail("gpu_unsupported_layer", `GPU scene refuses visible layer ${layer.id} of type '${layer.type}'.`, layer.id);
  if (layer.type === "adjustment") {
    if (layer.effectModule) return null;
    if (!gpuSceneAdjustmentHasOnlySupportedEffects(layer)) return fail("gpu_unsupported_effect", `GPU adjustment layer ${layer.id} supports only vignette and film grain.`, layer.id);
    if ((layer.blendMode && layer.blendMode !== "normal") || hasKeys(layer.transform) || hasKeys(layer.style) || hasKeys(layer.keyframes) || layer.mask || layer.matte || layer.keying || layer.crop || layer.pathReveal || layer.depth !== undefined || layer.textFit || layer.transitions) return fail("gpu_unsupported_feature", `GPU adjustment layer ${layer.id} must remain a full-frame authored effect.`, layer.id);
    return null;
  }
  if (layer.type === "scene3d") {
    if (!layer.scene3d) return fail("gpu_unsupported_layer", `GPU scene3d layer ${layer.id} requires scene3d data.`, layer.id);
    if (Object.keys(layer.transform ?? {}).some((key) => key !== "opacity") || hasKeys(layer.style) || hasKeys(layer.keyframes) || layer.keying || layer.crop || layer.pathReveal || layer.textFit || layer.transitions) return fail("gpu_unsupported_feature", `GPU scene3d layer ${layer.id} accepts internal scene transforms plus layer opacity, effects, blend and mask only.`, layer.id);
    if (!gpuSceneHasOnlySupportedEffects(layer)) return fail("gpu_unsupported_effect", `GPU scene3d layer ${layer.id} uses an unsupported post effect.`, layer.id);
    return null;
  }
  if (layer.type === "environment") { const invalid = validateGpuSceneEnvironmentLayer(layer); return invalid ? { ok: false, failure: invalid } : null; }
  if (layer.type === "shader") { const invalid = layer.shader?.gpuMaterial ? validateGpuSceneMaterialLayer(layer) : validateGpuSceneRestrictedShaderHybridLayer(layer); return invalid ? { ok: false, failure: invalid } : null; }
  if (layer.type === "shape" && hasGpuScenePathGeometry(layer)) {
    const problem = gpuSceneAuthoredShapeUnsupportedFeature(layer); if (problem) return fail("gpu_unsupported_feature", problem, layer.id);
  }
  else if (layer.type === "shape" && isGpuScenePathShape(layer.shape)) {
    const problem = gpuScenePathUnsupportedFeature(layer); if (problem) return fail("gpu_unsupported_feature", problem, layer.id);
    const revealProblem = gpuScenePathRevealUnsupportedFeature(layer); if (revealProblem) return fail("gpu_unsupported_feature", revealProblem, layer.id);
  }
  else if (layer.type === "shape" && !canonicalGpuScenePrimitiveShape(layer.shape)) return fail("gpu_unsupported_layer", gpuSceneUnsupportedShapeMessage(layer.id, layer.shape), layer.id);
  if (layer.type === "points" && !layer.pointCloud) return fail("gpu_unsupported_layer", `GPU scene requires pointCloud data on layer ${layer.id}.`, layer.id);
  if (layer.type === "particles" && !layer.emitter) return fail("gpu_unsupported_layer", `GPU scene requires emitter data on layer ${layer.id}.`, layer.id);
  if ((layer.type === "points" || layer.type === "particles") && gpuSceneTrailProblem(layer)) return fail("gpu_unsupported_feature", `GPU scene layer ${layer.id} ${gpuSceneTrailProblem(layer)}`, layer.id);
  if (!gpuSceneHasOnlySupportedEffects(layer)) return fail("gpu_unsupported_effect", `GPU scene supports only blur, glow, brightness, contrast, saturation and grayscale effects on layer ${layer.id}.`, layer.id);
  const chroma = resolveGpuSceneChromaKey(layer); if (!chroma.ok) return fail("gpu_unsupported_feature", chroma.message, layer.id);
  if ((layer.gradient && (layer.type !== "shape" || canonicalGpuScenePrimitiveShape(layer.shape) !== "rect")) || (layer.crop && layer.type !== "image" && layer.type !== "video" && !isGpuBrowserSurfaceLayer(layer.type)) || (layer.pathReveal && !(layer.type === "shape" && isGpuScenePathShape(layer.shape)))) return fail("gpu_unsupported_feature", `GPU scene refuses this gradient, non-media crop, or path reveal feature on layer ${layer.id}.`, layer.id);
  if (layer.gradient?.colorKeyframes) {
    const colorKeyframes = evaluateMotionGradientColorKeyframes({ gradient: layer.gradient, atUs: 0 });
    if (!colorKeyframes.ok) return fail("gpu_unsupported_feature", `GPU scene layer ${layer.id} has invalid gradient color keyframes: ${colorKeyframes.message}`, layer.id);
  }
  const isV2Compute = layer.type === "particles" && isGpuComputeParticleEmitter(layer.emitter) && gpuComputeParticleEmitterAbi(layer.emitter) === "v2";
  if ((layer.mask || layer.matte) && (layer.type === "points" || (layer.type === "particles" && !isV2Compute))) return fail("gpu_unsupported_feature", `GPU point and particle layers do not yet support masks or mattes on layer ${layer.id}.`, layer.id);
  if (Object.keys(layer.transform ?? {}).some((key) => !SUPPORTED_TRANSFORM_FIELDS.has(key))) return fail("gpu_unsupported_feature", `GPU scene layer ${layer.id} has an unsupported transform field.`, layer.id);
  const stylesSupported = layer.type === "shape" && hasGpuScenePathGeometry(layer) ? gpuSceneAuthoredShapeHasOnlySupportedStyles(layer) : layer.type === "shape" && isGpuScenePathShape(layer.shape) ? gpuScenePathHasOnlySupportedStyles(layer) : layer.type === "shape" && canonicalGpuScenePrimitiveShape(layer.shape) === "ellipse" ? gpuSceneEllipseHasOnlySupportedStyles(layer) : Object.keys(layer.style ?? {}).every((key) => (layer.type === "text" || layer.type === "caption" ? SUPPORTED_TEXT_STYLE_FIELDS : SUPPORTED_STYLE_FIELDS).has(key));
  if (!stylesSupported) return fail("gpu_unsupported_feature", `GPU scene layer ${layer.id} has an unsupported style field.`, layer.id);
  if (Object.keys(layer.keyframes ?? {}).some((key) => !SUPPORTED_KEYFRAMES.has(key))) return fail("gpu_unsupported_feature", `GPU scene layer ${layer.id} has an unsupported keyframe target.`, layer.id);
  if ([layer.transitions?.in, layer.transitions?.out].some((transition) => transition && transition.type !== "fade" && transition.type !== "slide" && transition.type !== "wipe")) return fail("gpu_unsupported_feature", `GPU scene layer ${layer.id} has an unsupported transition.`, layer.id);
  const wipeProblem = gpuSceneWipeTransitionProblem(layer); return wipeProblem ? fail("gpu_unsupported_feature", wipeProblem, layer.id) : null;
}

function hasKeys(value: unknown): boolean { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length > 0; }
function fail(code: GpuScene2dFailure["code"], message: string, layerId?: string): { ok: false; failure: GpuScene2dFailure } { return { ok: false, failure: { code, message, ...(layerId ? { layerId } : {}) } }; }
