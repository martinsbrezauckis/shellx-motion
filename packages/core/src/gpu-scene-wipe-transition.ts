import type { GpuLayerMaskIntent } from "./gpu-frame-intent";
import { resolveEasing } from "./timeline";
import type { MotionLayer, MotionTransition } from "./types";

export interface GpuSceneWipeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type GpuSceneWipeMaskResult =
  | { ok: true; mask: GpuLayerMaskIntent | null }
  | { ok: false; message: string };

const ZERO_INSETS: GpuSceneWipeInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
const WIPE_DIRECTIONS = new Set(["left", "right", "up", "down"]);

/** Whether this layer has a wipe which changes pixels, rather than a zero-duration no-op. */
export function gpuSceneHasActiveWipeTransition(layer: MotionLayer): boolean {
  return [layer.transitions?.in, layer.transitions?.out].some(
    (transition) => transition?.type === "wipe" && typeof transition.durationMs === "number" && transition.durationMs > 0,
  );
}

/**
 * Checks the deliberately narrow set which can be lowered into the fixed, one-mask GPU ABI.
 * Browser CSS can intersect an arbitrary clip path with a wipe. The GPU ABI has one geometric
 * mask only, so a pre-existing mask/matte is refused instead of being approximated.
 */
export function gpuSceneWipeTransitionProblem(layer: MotionLayer): string | null {
  const wipes = [layer.transitions?.in, layer.transitions?.out].filter(
    (transition): transition is MotionTransition => transition?.type === "wipe",
  );
  if (wipes.length === 0) return null;
  for (const transition of wipes) {
    if (typeof transition.durationMs !== "number" || !Number.isFinite(transition.durationMs)) {
      return `GPU wipe transition on layer ${layer.id} requires a finite durationMs.`;
    }
    // The authoritative browser/native paths treat zero and negative durations as no-op wipes.
    // Keep that behavior here; document validation can separately reject malformed authoring data.
    if (transition.durationMs <= 0) continue;
    if (transition.direction !== undefined && !WIPE_DIRECTIONS.has(transition.direction)) {
      return `GPU wipe transition on layer ${layer.id} has unsupported direction '${transition.direction}'.`;
    }
  }
  if (!gpuSceneHasActiveWipeTransition(layer)) return null;
  if (layer.mask || layer.matte) {
    return `GPU wipe transition on layer ${layer.id} cannot exactly coexist with an authored mask or track matte in the single-mask ABI.`;
  }
  if (layer.effects?.motionBlur) {
    return `GPU wipe transition on layer ${layer.id} cannot exactly coexist with temporal motion blur in the fixed GPU compositor.`;
  }
  if (layer.type !== "shape" && layer.type !== "image" && layer.type !== "video" && layer.type !== "text" && layer.type !== "caption") {
    return `GPU wipe transition on layer ${layer.id} is currently exact only for shape, image, video, text, and caption layers.`;
  }
  if ((layer.type === "image" || layer.type === "video") && (!hasDeclaredDimension(layer, "width") || !hasDeclaredDimension(layer, "height"))) {
    return `GPU wipe transition on ${layer.type} layer ${layer.id} requires explicit bounded width and height so its layer-local clip box is attested.`;
  }
  return null;
}

/**
 * Mirrors the browser's CSS `clip-path: inset(...)` wipe arithmetic exactly, then converts the
 * local inset rectangle through the evaluated layer transform for the fixed GPU mask pass.
 */
export function compileGpuSceneWipeMask(
  layer: MotionLayer,
  atMs: number,
): GpuSceneWipeMaskResult {
  const problem = gpuSceneWipeTransitionProblem(layer);
  if (problem) return { ok: false, message: problem };
  if (!gpuSceneHasActiveWipeTransition(layer)) return { ok: true, mask: null };
  const box = localBox(layer);
  if (!box) return { ok: false, message: `GPU wipe transition on layer ${layer.id} has invalid layer-local transform geometry.` };
  const insets = gpuSceneWipeInsets(layer, atMs);
  if (![insets.top, insets.right, insets.bottom, insets.left].every(Number.isFinite)) {
    return { ok: false, message: `GPU wipe transition on layer ${layer.id} produced non-finite inset geometry.` };
  }
  if (insets.top === 0 && insets.right === 0 && insets.bottom === 0 && insets.left === 0) return { ok: true, mask: null };
  if (insets.left + insets.right >= 100 || insets.top + insets.bottom >= 100) {
    // CSS clip-path has an empty intersection at (or beyond) this boundary. The fixed ABI
    // cannot encode a zero-size box, so an otherwise full-size, zero-strength mask is exact.
    return { ok: true, mask: { shape: "rect", ...box, radius: 0, inverted: false, opacity: 0, featherPx: 0 } };
  }
  const x = box.x + (box.width * insets.left) / 100;
  const y = box.y + (box.height * insets.top) / 100;
  const width = box.width * (1 - (insets.left + insets.right) / 100);
  const height = box.height * (1 - (insets.top + insets.bottom) / 100);
  if (!(width > 0) || !(height > 0)) {
    return { ok: true, mask: { shape: "rect", ...box, radius: 0, inverted: false, opacity: 0, featherPx: 0 } };
  }
  return { ok: true, mask: {
    shape: "rect", x, y, width, height, rotationDeg: box.rotationDeg, pivotX: box.pivotX, pivotY: box.pivotY,
    radius: 0, inverted: false, opacity: 1, featherPx: 0,
  } };
}

/** Browser-equivalent percentages before conversion to the transformed GPU layer box. */
export function gpuSceneWipeInsets(layer: MotionLayer, atMs: number): GpuSceneWipeInsets {
  const localMs = atMs - layer.startMs;
  const remainingMs = Math.max(0, layer.durationMs) - localMs;
  const entering = wipeTransitionInsets(layer.transitions?.in, localMs, "in");
  const leaving = wipeTransitionInsets(layer.transitions?.out, remainingMs, "out");
  return {
    top: Math.max(0, entering.top, leaving.top),
    right: Math.max(0, entering.right, leaving.right),
    bottom: Math.max(0, entering.bottom, leaving.bottom),
    left: Math.max(0, entering.left, leaving.left),
  };
}

function wipeTransitionInsets(
  transition: MotionTransition | undefined,
  elapsedMs: number,
  edge: "in" | "out",
): GpuSceneWipeInsets {
  if (!transition || transition.type !== "wipe" || typeof transition.durationMs !== "number" || transition.durationMs <= 0) return ZERO_INSETS;
  const hiddenPercent = edge === "in" ? wipeInHiddenPercent(transition, elapsedMs) : wipeOutHiddenPercent(transition, elapsedMs);
  const direction = transition.direction ?? "left";
  if (edge === "in") {
    if (direction === "right") return { ...ZERO_INSETS, left: hiddenPercent };
    if (direction === "up") return { ...ZERO_INSETS, bottom: hiddenPercent };
    if (direction === "down") return { ...ZERO_INSETS, top: hiddenPercent };
    return { ...ZERO_INSETS, right: hiddenPercent };
  }
  if (direction === "right") return { ...ZERO_INSETS, right: hiddenPercent };
  if (direction === "up") return { ...ZERO_INSETS, top: hiddenPercent };
  if (direction === "down") return { ...ZERO_INSETS, bottom: hiddenPercent };
  return { ...ZERO_INSETS, left: hiddenPercent };
}

function wipeInHiddenPercent(transition: MotionTransition, elapsedMs: number): number {
  if (elapsedMs >= transition.durationMs) return 0;
  if (elapsedMs <= 0) return 100;
  return 100 * (1 - resolveEasing(transition.easing)(clamp(elapsedMs / transition.durationMs, 0, 1)));
}

function wipeOutHiddenPercent(transition: MotionTransition, remainingMs: number): number {
  if (remainingMs >= transition.durationMs) return 0;
  if (remainingMs <= 0) return 100;
  return 100 * resolveEasing(transition.easing)(clamp(1 - (remainingMs / transition.durationMs), 0, 1));
}

function localBox(layer: MotionLayer): Omit<GpuLayerMaskIntent, "shape" | "radius" | "inverted" | "opacity" | "featherPx"> | null {
  const transform = layer.transform ?? {};
  const width = dimension(layer, "width");
  const height = dimension(layer, "height");
  const x = finite(transform.x ?? 0); const y = finite(transform.y ?? 0); const scale = positive(transform.scale ?? 1);
  if (width === null || height === null || x === null || y === null || scale === null) return null;
  const originX = finite(transform.originX ?? width / 2); const originY = finite(transform.originY ?? height / 2); const rotationDeg = finite(transform.rotation ?? 0);
  if (originX === null || originY === null || rotationDeg === null) return null;
  return {
    x: x + originX - originX * scale,
    y: y + originY - originY * scale,
    width: width * scale,
    height: height * scale,
    rotationDeg,
    pivotX: x + originX,
    pivotY: y + originY,
  };
}

function dimension(layer: MotionLayer, side: "width" | "height"): number | null {
  const transform = layer.transform ?? {};
  const direct = transform[side] ?? layer[side] ?? layer.style?.[side];
  if (direct !== undefined) return positive(direct);
  if (layer.type === "shape") return 100;
  // Text already requires an explicit box. Image/video must be explicit for an exact CSS layer
  // box, rather than borrowing decoded-media placement after object-fit.
  return null;
}

function hasDeclaredDimension(layer: MotionLayer, side: "width" | "height"): boolean {
  const transform = layer.transform ?? {};
  return positive(transform[side] ?? layer[side] ?? layer.style?.[side]) !== null;
}

function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : null; }
function positive(value: unknown): number | null { const number = finite(value); return number !== null && number > 0 && number <= 4_096 ? number : null; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
