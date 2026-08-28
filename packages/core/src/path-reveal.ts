import { isSupportedMotionColorString } from "./color";
import { parseMotionPathViewBox, validateMotionPathData } from "./path-contract";
import type { MotionLayer, MotionPathReveal } from "./types";

/** The two scalar tracks that control a browser path-reveal window. */
export const PATH_REVEAL_KEYFRAME_TARGETS = new Set(["pathReveal.start", "pathReveal.end"] as const);

export interface MotionPathRevealGeometry {
  path: string;
  viewBox: string;
  strokeWidth: number;
}

/**
 * Validates the bounded, data-only owner for a path reveal. This is deliberately separate from
 * generic path validation: legacy path shapes remain compatible, while a reveal opts into the
 * stricter single-subpath and explicit-stroke contract required by SVG dash rendering.
 */
export function assertMotionPathRevealOwner(
  layer: MotionLayer,
  label = `Motion path reveal layer ${layer.id}`
): MotionPathRevealGeometry {
  if (layer.type !== "shape" || (layer.shape !== "path" && layer.shape !== "freeform")) {
    throw new Error(`${label} requires a shape path or freeform layer.`);
  }
  const style = readRecord(layer.style) ?? {};
  const path = validateMotionPathData(layer["x-path"] ?? style.path, `${label} path`);
  if (countPathSubpaths(path) !== 1) {
    throw new Error(`${label} requires exactly one SVG subpath.`);
  }
  const viewBox = parseMotionPathViewBox(layer["x-path-viewBox"] ?? "0 0 100 100", `${label} viewBox`).normalized;
  const stroke = style.stroke;
  if (!isVisibleStrokeColor(stroke)) {
    throw new Error(`${label} requires an explicit, non-transparent supported style.stroke.`);
  }
  const strokeWidth = readPositiveFiniteNumber(style.strokeWidth) ?? readPositiveFiniteNumber(style.width);
  if (strokeWidth === null) {
    throw new Error(`${label} requires a finite positive style.strokeWidth (or legacy style.width).`);
  }
  return { path, viewBox, strokeWidth };
}

/** Validates start and end independently; crossing them is legal and renders an empty window. */
export function assertMotionPathReveal(value: unknown, label = "Motion path reveal"): MotionPathReveal {
  const reveal = readRecord(value);
  if (!reveal) throw new Error(`${label} must be an object with start and end.`);
  const start = reveal.start;
  const end = reveal.end;
  if (!isUnitIntervalNumber(start)) throw new Error(`${label}.start must be a finite number between 0 and 1.`);
  if (!isUnitIntervalNumber(end)) throw new Error(`${label}.end must be a finite number between 0 and 1.`);
  return { start, end };
}

/** Central semantic validation used by the document validator and authoring controls. */
export function assertMotionPathRevealLayer(layer: MotionLayer, label = `Motion path reveal layer ${layer.id}`): MotionPathReveal {
  const reveal = assertMotionPathReveal(layer.pathReveal, `${label} pathReveal`);
  assertMotionPathRevealOwner(layer, label);
  return reveal;
}

export function isPathRevealKeyframeTarget(value: string): value is "pathReveal.start" | "pathReveal.end" {
  return PATH_REVEAL_KEYFRAME_TARGETS.has(value as "pathReveal.start" | "pathReveal.end");
}

function countPathSubpaths(path: string): number {
  return path.match(/[Mm]/g)?.length ?? 0;
}

function isVisibleStrokeColor(value: unknown): boolean {
  if (!isSupportedMotionColorString(value) || typeof value !== "string") return false;
  const color = value.trim().toLowerCase();
  if (color === "transparent" || color === "currentcolor") return false;
  if (/^#[0-9a-f]{4}$/i.test(color)) return color[4] !== "0";
  if (/^#[0-9a-f]{8}$/i.test(color)) return color.slice(7, 9) !== "00";
  const functional = /^(?:rgb|rgba|hsl|hsla)\((.*)\)$/i.exec(color);
  if (!functional) return true;
  const body = functional[1].trim();
  const alpha = body.includes("/")
    ? body.slice(body.lastIndexOf("/") + 1).trim()
    : body.split(",").length === 4
      ? body.split(",")[3].trim()
      : null;
  return alpha === null || !isZeroAlpha(alpha);
}

function isZeroAlpha(value: string): boolean {
  if (/^[-+]?0*\.?0*%?$/.test(value)) return true;
  return false;
}

function isUnitIntervalNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readPositiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
