import {
  parseMotionPathViewBox,
  validateMotionPathData,
  type MotionLayer,
  type MotionPackage,
} from "@shellx-motion/core";

export type GeneratedSvgShapeKind = "ellipse" | "triangle" | "star" | "path";

interface SvgShapeFormatting {
  escapeAttr(value: string): string;
  formatNumber(value: number): string;
}

interface SvgShapeGradientFormatting extends SvgShapeFormatting {
  cssColor(value: unknown, pkg: MotionPackage, fallback: string): string;
}

interface SvgShapeRenderFormatting {
  escapeAttr(value: string): string;
  boxStyle(
    layer: MotionLayer,
    index: number,
    defaults?: { defaultWidth: number | null; defaultHeight: number | null },
    atMs?: number
  ): string;
}

/** SVG-only geometry shared by normal generated shapes and shape mattes. */
export function generatedShapeKind(layer: MotionLayer): string | null {
  const shape = readString(layer.shape);
  if (shape === "freeform" && generatedShapePath(layer)) return "path";
  return shape;
}

/**
 * Converts a declared shape gradient into an SVG paint server.
 *
 * SVG shapes cannot take the CSS gradient string the rect path uses, so the same declaration is
 * emitted as `<linearGradient>` / `<radialGradient>`. `objectBoundingBox` units keep it aligned to
 * the shape regardless of the layer's size.
 */
export function svgGradientDef(
  layer: MotionLayer,
  pkg: MotionPackage,
  id: string,
  formatting: SvgShapeGradientFormatting
): { id: string; def: string } | null {
  const gradient = readRecord(layer.gradient);
  const rawStops = Array.isArray(gradient.stops) ? gradient.stops : [];
  if ((gradient.type !== "linear" && gradient.type !== "radial") || rawStops.length < 2 || rawStops.length > 16) return null;
  const stops: string[] = [];
  for (const value of rawStops) {
    const stop = readRecord(value);
    const offset = readNumber(stop.offset);
    if (offset === null || offset < 0 || offset > 1) return null;
    const color = formatting.cssColor(stop.color, pkg, "transparent");
    stops.push(`<stop offset="${formatting.escapeAttr(formatting.formatNumber(offset * 100))}%" stop-color="${formatting.escapeAttr(color)}"/>`);
  }
  if (gradient.type === "radial") {
    const cx = clamp(readNumber(gradient.centerX) ?? 0.5, 0, 1) * 100;
    const cy = clamp(readNumber(gradient.centerY) ?? 0.5, 0, 1) * 100;
    return {
      id,
      def: `<radialGradient id="${formatting.escapeAttr(id)}" cx="${formatting.escapeAttr(formatting.formatNumber(cx))}%" cy="${formatting.escapeAttr(formatting.formatNumber(cy))}%" r="50%">${stops.join("")}</radialGradient>`
    };
  }
  // CSS measures the angle clockwise from "to top"; SVG wants an explicit vector. Convert once
  // here so an author's `angle` means the same thing on every shape kind.
  const angle = readNumber(gradient.angle) ?? 180;
  const radians = ((angle - 90) * Math.PI) / 180;
  const x1 = 50 - Math.cos(radians) * 50, y1 = 50 - Math.sin(radians) * 50;
  const x2 = 50 + Math.cos(radians) * 50, y2 = 50 + Math.sin(radians) * 50;
  return {
    id,
    def: `<linearGradient id="${formatting.escapeAttr(id)}" x1="${formatting.escapeAttr(formatting.formatNumber(x1))}%" y1="${formatting.escapeAttr(formatting.formatNumber(y1))}%" x2="${formatting.escapeAttr(formatting.formatNumber(x2))}%" y2="${formatting.escapeAttr(formatting.formatNumber(y2))}%">${stops.join("")}</linearGradient>`
  };
}

export function renderGeneratedSvgShape(input: {
  shapeKind: GeneratedSvgShapeKind;
  layer: MotionLayer;
  index: number;
  atMs: number;
  fill: string;
  stroke: string;
  strokeWidth: string;
  shadow: string | null;
  labelHtml: string;
  align: string;
  gradient?: { id: string; def: string } | null;
}, formatting: SvgShapeRenderFormatting): string {
  const viewBox = generatedShapeViewBox(input.layer);
  const paint = input.gradient ? `url(#${input.gradient.id})` : input.fill;
  const svg = [
    `<svg aria-hidden="true" viewBox="${formatting.escapeAttr(viewBox)}" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;">`,
    input.gradient ? `<defs>${input.gradient.def}</defs>` : "",
    generatedSvgShapeElement(input.shapeKind, input.layer, paint, input.stroke, input.strokeWidth, formatting.escapeAttr),
    "</svg>"
  ].join("");

  return `<div data-layer-id="${formatting.escapeAttr(input.layer.id)}" data-start="${input.layer.startMs}" data-duration="${input.layer.durationMs}" style="${formatting.boxStyle(input.layer, input.index, undefined, input.atMs)}${input.align}${input.shadow ? `${input.shadow};` : ""}">${svg}${input.labelHtml}</div>`;
}

export function generatedMatteShapeGeometry(
  layer: MotionLayer,
  formatting: Pick<SvgShapeFormatting, "escapeAttr">
): { viewBox: { x: number; y: number; width: number; height: number }; element: string } {
  const shapeKind = generatedShapeKind(layer);
  const unitViewBox = { x: 0, y: 0, width: 100, height: 100 };
  if (shapeKind === "rect") return { viewBox: unitViewBox, element: "<rect x=\"0\" y=\"0\" width=\"100\" height=\"100\" fill=\"MATTE_FILL\"></rect>" };
  if (shapeKind === "ellipse") return { viewBox: unitViewBox, element: "<ellipse cx=\"50\" cy=\"50\" rx=\"50\" ry=\"50\" fill=\"MATTE_FILL\"></ellipse>" };
  if (shapeKind === "triangle") return { viewBox: unitViewBox, element: "<polygon points=\"50,0 0,100 100,100\" fill=\"MATTE_FILL\"></polygon>" };
  if (shapeKind === "star") return { viewBox: unitViewBox, element: `<polygon points="${formatting.escapeAttr(generatedStarPoints())}" fill="MATTE_FILL"></polygon>` };
  if (shapeKind === "path") {
    const path = validateMotionPathData(generatedShapePath(layer), `Browser matte source ${layer.id}`);
    const viewBox = parseMotionPathViewBox(generatedShapeViewBox(layer), `Browser matte source ${layer.id} viewBox`);
    return { viewBox, element: `<path d="${formatting.escapeAttr(path)}" fill="MATTE_FILL"></path>` };
  }
  throw new Error(`Browser matte source ${layer.id} uses unsupported shape ${shapeKind ?? "missing"}.`);
}

function generatedSvgShapeElement(
  shapeKind: GeneratedSvgShapeKind,
  layer: MotionLayer,
  fill: string,
  stroke: string,
  strokeWidth: string,
  escapeAttr: (value: string) => string
): string {
  const linecap = cssSvgStrokeLinecap(readRecord(layer.style).strokeLinecap);
  const paintAttrs = `fill="${escapeAttr(fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${escapeAttr(strokeWidth)}" stroke-linecap="${linecap}" vector-effect="non-scaling-stroke"`;
  if (shapeKind === "ellipse") return `<ellipse cx="50" cy="50" rx="50" ry="50" ${paintAttrs}></ellipse>`;
  if (shapeKind === "triangle") return `<polygon points="50,0 0,100 100,100" ${paintAttrs}></polygon>`;
  if (shapeKind === "star") return `<polygon points="${escapeAttr(generatedStarPoints())}" ${paintAttrs}></polygon>`;

  const pathData = generatedShapePath(layer);
  if (!pathData) {
    throw new Error(`Browser generated path shape ${layer.id} requires an x-path string.`);
  }
  return `<path d="${escapeAttr(pathData)}" ${paintAttrs}${pathRevealAttributes(layer)}></path>`;
}

/**
 * SVG normalizes this path's measured length to one unit. The contract has already rejected
 * multi-subpath geometry, so a single dash and following one-unit gap represent one contiguous
 * `[start, end]` window instead of ambiguous serial subpaths. End <= start is explicitly empty.
 */
function pathRevealAttributes(layer: MotionLayer): string {
  const reveal = layer.pathReveal;
  if (!reveal) return "";
  if (reveal.end <= reveal.start) return ' stroke-opacity="0"';
  const length = reveal.end - reveal.start;
  return ` pathLength="1" stroke-dasharray="${formatRevealNumber(length)} 1" stroke-dashoffset="${formatRevealNumber(-reveal.start)}"`;
}

function formatRevealNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function cssSvgStrokeLinecap(value: unknown): "butt" | "round" | "square" {
  const linecap = readString(value)?.trim().toLowerCase();
  return linecap === "round" || linecap === "square" ? linecap : "butt";
}

function generatedStarPoints(): string {
  const points: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const angle = (-Math.PI / 2) + (index * Math.PI / 5);
    const radius = index % 2 === 0 ? 50 : 22.5;
    const x = 50 + (Math.cos(angle) * radius);
    const y = 50 + (Math.sin(angle) * radius);
    points.push(`${formatStarPoint(x)},${formatStarPoint(y)}`);
  }
  return points.join(" ");
}

function formatStarPoint(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function generatedShapePath(layer: MotionLayer): string | null {
  return readString(layer["x-path"]) ?? readString(readRecord(layer.style).path);
}

function generatedShapeViewBox(layer: MotionLayer): string {
  const value = readString(layer["x-path-viewBox"]);
  if (!value) return "0 0 100 100";
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || parts[2] <= 0 || parts[3] <= 0) {
    throw new Error(`Browser generated path shape ${layer.id} has an invalid x-path-viewBox.`);
  }
  return parts.map((part) => Number(part.toFixed(4)).toString()).join(" ");
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
