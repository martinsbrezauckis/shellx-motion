import type { MotionDocument } from "./types";

export function uniqueSplitLayerId(motion: MotionDocument, layerId: string, atMs: number): string {
  const base = `${layerId}_split_${Math.round(atMs)}`.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "layer_split";
  return firstAvailable(motion, base, `Unable to generate a unique split layer id for ${layerId}.`);
}

export function uniqueDuplicateLayerId(motion: MotionDocument, layerId: string): string {
  const base = `${layerId}_copy`.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "layer_copy";
  return firstAvailable(motion, base, `Unable to generate a unique duplicate layer id for ${layerId}.`);
}

function firstAvailable(motion: MotionDocument, base: string, exhaustedMessage: string): string {
  const existing = new Set(motion.layers.map((layer) => layer.id));
  if (!existing.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}_${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(exhaustedMessage);
}
