import { isSafeShaderUniformName, RESTRICTED_SHADER_LANGUAGE, RESTRICTED_SHADER_SCHEMA } from "./shader-plugin";
import { gpuSceneHasOnlySupportedEffects } from "./gpu-scene-effects";
import type { GpuScene2dFailure } from "./gpu-scene-2d-plan";
import type { MotionDocument, MotionLayer } from "./types";

const TRANSFORM_FIELDS = new Set(["x", "y", "width", "height", "opacity", "scale", "rotation", "originX", "originY"]);
const KEYFRAMES = new Set(["transform.x", "transform.y", "transform.width", "transform.height", "transform.originX", "transform.originY", "transform.scale", "transform.rotation", "opacity", "effects.blur", "effects.brightness", "effects.contrast", "effects.saturate", "effects.grayscale"]);

/** A package GLSL layer can be rasterized only by the legacy bounded WebGL lane. */
export function isGpuRestrictedShaderHybridLayer(layer: MotionLayer): boolean {
  return layer.type === "shader" && !layer.shader?.gpuMaterial;
}

/** Returns the declared package-local source; bytes are still stable-read by the browser producer. */
export function gpuRestrictedShaderAssetRef(motion: MotionDocument, layer: MotionLayer): string | null {
  if (!isGpuRestrictedShaderHybridLayer(layer) || !layer.shader?.fragmentAssetId) return null;
  for (const candidate of motion.assets) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const asset = candidate as Record<string, unknown>;
    const source = asset.source;
    if (asset.id !== layer.shader.fragmentAssetId || !source || typeof source !== "object" || Array.isArray(source)) continue;
    const path = (source as Record<string, unknown>).path;
    const mimeType = (source as Record<string, unknown>).mimeType;
    if (typeof path === "string" && mimeType === "text/x-shellx-motion-glsl") return path;
  }
  return null;
}

/**
 * Admits only metadata which the fixed GPU compositor can own after the
 * bounded legacy WebGL source producer has made a transparent texture. The
 * producer separately stable-reads and validates the actual GLSL bytes.
 */
export function validateGpuSceneRestrictedShaderHybridLayer(layer: MotionLayer): GpuScene2dFailure | null {
  const shader = layer.shader;
  if (!shader || shader.schema !== RESTRICTED_SHADER_SCHEMA || shader.language !== RESTRICTED_SHADER_LANGUAGE) return fail(layer, "GPU restricted-shader hybrid requires the declared versioned GLSL contract.");
  if (!shader.fragmentAssetId || !Number.isInteger(shader.seed) || shader.seed < 0 || shader.seed > 0xffff_ffff) return fail(layer, "GPU restricted-shader hybrid requires a declared shader asset and unsigned 32-bit seed.");
  const uniforms = shader.uniforms ?? {};
  if (Object.keys(uniforms).length > 16 || Object.entries(uniforms).some(([name, value]) => !isSafeShaderUniformName(name) || !Number.isFinite(value) || Math.abs(value) > 1_000_000)) return fail(layer, "GPU restricted-shader hybrid has unsupported declared uniforms.");
  const invalidKeyframe = Object.keys(layer.keyframes ?? {}).some((key) => !KEYFRAMES.has(key) && !(key.startsWith("shader.uniforms.") && isSafeShaderUniformName(key.slice("shader.uniforms.".length)) && key.slice("shader.uniforms.".length) in uniforms));
  if (Object.keys(layer.style ?? {}).length || layer.textFit || layer.transitions || layer.gradient || layer.pathReveal || layer.keying || (Array.isArray(layer.allowedOrigins) && layer.allowedOrigins.length > 0) || Object.keys(layer.transform ?? {}).some((key) => !TRANSFORM_FIELDS.has(key)) || invalidKeyframe) return fail(layer, "GPU restricted-shader hybrid accepts declared shader uniforms, transform, opacity, blend, effects, crop, and masks only.");
  if (!gpuSceneHasOnlySupportedEffects(layer)) return { code: "gpu_unsupported_effect", message: `GPU restricted-shader hybrid layer ${layer.id} uses an unsupported post effect.`, layerId: layer.id };
  return null;
}

export function gpuRestrictedShaderTextureDimensions(motion: MotionDocument, layer: MotionLayer): { width: number; height: number } | null {
  const transform = layer.transform ?? {};
  const width = transform.width ?? layer.width ?? motion.width;
  const height = transform.height ?? layer.height ?? motion.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4_096 || height > 4_096 || width * height > 16_777_216) return null;
  return { width, height };
}

function fail(layer: MotionLayer, message: string): GpuScene2dFailure {
  return { code: "gpu_unsupported_feature", message, layerId: layer.id };
}
