import {
  resolvedMotionChromaKey,
  validateLayerKeyingAndRoto,
  type MotionChromaKey
} from "./keying";
import type { GpuChromaKeyIntent } from "./gpu-frame-intent";
import type { MotionLayer } from "./types";

/**
 * Resolves the CPU-keyer-compatible subset that the fixed GPU image shader can
 * represent. Matte cleanup stays scalar Motion data and is evaluated by fixed
 * renderer-owned passes; package data never crosses as a kernel or shader.
 */
export function resolveGpuSceneChromaKey(layer: MotionLayer):
  | { ok: true; chromaKey: GpuChromaKeyIntent | null }
  | { ok: false; message: string } {
  if (!layer.keying) return { ok: true, chromaKey: null };
  const issues = validateLayerKeyingAndRoto(layer, `/layers/${layer.id || "unknown"}`);
  if (issues.length > 0) return { ok: false, message: `GPU chroma key on layer ${layer.id} is invalid at ${issues[0].path}: ${issues[0].message}.` };
  if (layer.type !== "image" && layer.type !== "video") return { ok: false, message: `GPU chroma key is supported only on image or video layers; layer ${layer.id} is ${layer.type}.` };
  const settings = resolvedMotionChromaKey(layer.keying as MotionChromaKey);
  const keyColor = parseKeyColor(settings.keyColor);
  return {
    ok: true,
    chromaKey: {
      keyColor: { ...keyColor, a: 1 },
      similarity: settings.similarity,
      smoothness: settings.smoothness,
      shadow: settings.shadow,
      spillSuppression: settings.spillSuppression,
      spillBalance: settings.spillBalance,
      edgeColorCorrection: settings.edgeColorCorrection,
      matte: settings.matte
    }
  };
}

function parseKeyColor(value: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(value.slice(1, 3), 16) / 255,
    g: Number.parseInt(value.slice(3, 5), 16) / 255,
    b: Number.parseInt(value.slice(5, 7), 16) / 255
  };
}
