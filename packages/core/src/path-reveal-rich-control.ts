import { assertMotionPathRevealOwner } from "./path-reveal";
import type { MotionLayer } from "./types";

export interface PathRevealRichEdit {
  pointer: string;
  oldValue: number;
  newValue: number;
}

/** Applies one independently bounded reveal scalar after confirming its path/stroke owner. */
export function editPathRevealRichControl(
  layer: MotionLayer,
  path: string,
  rawValue: unknown
): PathRevealRichEdit | null {
  if (path !== "pathReveal.start" && path !== "pathReveal.end") return null;
  assertMotionPathRevealOwner(layer, `Rich control ${path} on layer ${layer.id}`);
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0 || rawValue > 1) {
    throw new Error(`${path} must be a finite number between 0 and 1.`);
  }
  const reveal = layer.pathReveal ? { ...layer.pathReveal } : { start: 0, end: 1 };
  layer.pathReveal = reveal;
  const key = path === "pathReveal.start" ? "start" : "end";
  const oldValue = reveal[key];
  reveal[key] = rawValue;
  return { pointer: `pathReveal/${key}`, oldValue, newValue: rawValue };
}
