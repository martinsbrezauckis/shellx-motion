import type { GpuLayerEffects } from "./gpu-frame-intent";
import { parseGpuSceneColor } from "./gpu-scene-color";
import type { MotionLayer } from "./types";

const GPU_EFFECT_KEYS = new Set(["blur", "brightness", "contrast", "saturate", "grayscale", "glow", "motionBlur", "trail"]);

export function gpuSceneHasOnlySupportedEffects(layer: MotionLayer): boolean {
  const effects = layer.effects;
  if (!Object.keys(effects ?? {}).every((key) => GPU_EFFECT_KEYS.has(key))) return false;
  const temporal = effects?.motionBlur;
  return (!effects?.glow || (Number.isFinite(effects.glow.radius) && effects.glow.radius >= 0 && effects.glow.radius <= 128 && parseGpuSceneColor(effects.glow.color) !== null))
    && (!temporal || (Number.isInteger(temporal.samples) && temporal.samples >= 2 && temporal.samples <= 8 && Number.isFinite(temporal.shutterAngle) && temporal.shutterAngle > 0 && temporal.shutterAngle <= 360));
}

/** Normalizes the bounded filter controls shared with the native/browser lanes. */
export function gpuSceneEffects(layer: MotionLayer): GpuLayerEffects | null {
  const effects = layer.effects;
  if (!effects || Object.keys(effects).every((key) => key === "motionBlur" || key === "trail")) return null;
  const glowColor = effects.glow ? parseGpuSceneColor(effects.glow.color) : null;
  return {
    blur: effects.blur ?? 0,
    brightness: effects.brightness ?? 1,
    contrast: effects.contrast ?? 1,
    saturate: effects.saturate ?? 1,
    grayscale: effects.grayscale ?? 0,
    glow: effects.glow && glowColor ? { radius: effects.glow.radius, color: glowColor } : null
  };
}
