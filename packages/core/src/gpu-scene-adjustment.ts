import type { GpuAdjustmentIntent } from "./gpu-frame-intent";
import { parseGpuSceneColor } from "./gpu-scene-color";
import type { MotionDocument, MotionLayer } from "./types";

const ADJUSTMENT_EFFECT_KEYS = new Set(["vignette", "filmGrain"]);

export function gpuSceneAdjustmentHasOnlySupportedEffects(layer: MotionLayer): boolean {
  return Object.keys(layer.effects ?? {}).every((key) => ADJUSTMENT_EFFECT_KEYS.has(key));
}

/** Lowers the existing Motion adjustment contract to deterministic fixed-shader inputs. */
export function compileGpuSceneAdjustment(layer: MotionLayer, motion: MotionDocument, atMs: number): { ok: true; draw: GpuAdjustmentIntent } | { ok: false; message: string } {
  const vignette = layer.effects?.vignette;
  const filmGrain = layer.effects?.filmGrain;
  if (!vignette && !filmGrain) return { ok: false, message: `GPU adjustment layer ${layer.id} must declare vignette or film grain.` };
  const vignetteColor = vignette ? parseGpuSceneColor(vignette.color) : null;
  if (vignette && (!Number.isFinite(vignette.amount) || vignette.amount < 0 || vignette.amount > 1 || !Number.isFinite(vignette.softness) || vignette.softness < 0 || vignette.softness > 1 || !vignetteColor)) return { ok: false, message: `GPU adjustment layer ${layer.id} has an invalid vignette.` };
  if (filmGrain && (!Number.isFinite(filmGrain.amount) || filmGrain.amount < 0 || filmGrain.amount > 1 || !Number.isInteger(filmGrain.size) || filmGrain.size < 1 || filmGrain.size > 8 || !Number.isSafeInteger(filmGrain.seed) || filmGrain.seed < 0 || filmGrain.seed > 0xffff_ffff)) return { ok: false, message: `GPU adjustment layer ${layer.id} has invalid film grain.` };
  const frameIndex = Math.floor(Math.max(0, atMs - layer.startMs) * motion.fps / 1_000);
  const frameSeed = filmGrain ? ((filmGrain.seed >>> 0) ^ Math.imul(frameIndex + 1, 0x9e3779b1)) >>> 0 : 0;
  return { ok: true, draw: {
    kind: "adjustment", id: layer.id,
    vignette: vignette && vignetteColor ? { amount: vignette.amount, softness: vignette.softness, color: vignetteColor } : null,
    filmGrain: filmGrain ? { amount: filmGrain.amount, size: filmGrain.size, frameSeed } : null
  } };
}
