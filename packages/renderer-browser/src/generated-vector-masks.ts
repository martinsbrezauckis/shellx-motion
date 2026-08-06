import {
  parseMotionPathViewBox,
  resolveRotoFrame,
  rotoFrameSvgPath,
  validateLayerKeyingAndRoto,
  validateMotionPathData,
  type MotionLayer,
} from "@shellx-motion/core";

export function generatedVectorMaskDefinition(layer: MotionLayer, index: number, atMs: number): string {
  const mask = readRecord(layer.mask);
  const type = readString(mask.type);
  if (type === "path") return generatedPathMaskDefinition(layer, mask, index);
  if (type !== "roto") return "";
  const issues = validateLayerKeyingAndRoto(layer, `/layers/${layer.id}`);
  if (issues.length > 0) throw new Error(`Invalid browser roto mask at ${issues[0].path}: ${issues[0].message}.`);

  const box = layerBoxSize(layer);
  const frame = resolveRotoFrame(layer.mask!, atMs);
  const path = rotoFrameSvgPath(frame, box.width, box.height, true);
  const opacity = clamp(readNumber(mask.opacity) ?? 1, 0, 1);
  const feather = clamp(readNumber(mask.featherPx) ?? 0, 0, 128);
  const expansion = clamp(readNumber(mask.expansionPx) ?? 0, -256, 256);
  const inverted = mask.inverted === true;
  const filter = rotoFilter(index, box, expansion, feather);
  const filterAttr = filter ? ` filter="url(#${rotoFilterId(index)})"` : "";
  const fillRule = mask.fillRule === "evenodd" ? "evenodd" : "nonzero";
  const background = `<rect x="0" y="0" width="${number(box.width)}" height="${number(box.height)}" fill="${inverted ? "white" : "black"}"></rect>`;
  const shape = `<path d="${escapeAttr(path)}" fill="${inverted ? "black" : "white"}" fill-rule="${fillRule}" opacity="${number(opacity)}"${filterAttr}></path>`;
  return `${filter}<mask id="${rotoMaskId(index)}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="${number(box.width)}" height="${number(box.height)}" style="mask-type:luminance">${background}${shape}</mask>`;
}

export function cssVectorMaskStyle(layer: MotionLayer, index: number): string | null {
  const type = readString(readRecord(layer.mask).type);
  if (type === "path") return `clip-path:url(#${pathMaskId(index)})`;
  if (type !== "roto") return null;
  const ref = `url(#${rotoMaskId(index)})`;
  return `-webkit-mask:${ref};-webkit-mask-repeat:no-repeat;mask:${ref};mask-repeat:no-repeat`;
}

function generatedPathMaskDefinition(layer: MotionLayer, mask: Record<string, unknown>, index: number): string {
  const path = validateMotionPathData(mask.path, `Browser path mask ${layer.id}`);
  const viewBox = parseMotionPathViewBox(mask.viewBox, `Browser path mask ${layer.id} viewBox`);
  const box = layerBoxSize(layer);
  const fillRule = mask.fillRule === "evenodd" ? "evenodd" : "nonzero";
  const scaleX = box.width / viewBox.width;
  const scaleY = box.height / viewBox.height;
  const matrix = [scaleX, 0, 0, scaleY, -viewBox.x * scaleX, -viewBox.y * scaleY].map(number).join(" ");
  return `<clipPath id="${pathMaskId(index)}" clipPathUnits="userSpaceOnUse"><path d="${escapeAttr(path)}" transform="matrix(${matrix})" clip-rule="${fillRule}"></path></clipPath>`;
}

function rotoFilter(
  index: number,
  box: { width: number; height: number },
  expansion: number,
  feather: number,
): string {
  if (expansion === 0 && feather === 0) return "";
  const padding = Math.ceil(Math.abs(expansion) + feather * 4 + 2);
  const morphology = expansion === 0
    ? ""
    : `<feMorphology in="SourceGraphic" operator="${expansion > 0 ? "dilate" : "erode"}" radius="${number(Math.abs(expansion))}" result="expanded"></feMorphology>`;
  const blurInput = expansion === 0 ? "SourceGraphic" : "expanded";
  const blur = feather === 0 ? "" : `<feGaussianBlur in="${blurInput}" stdDeviation="${number(feather / 2)}"></feGaussianBlur>`;
  return `<filter id="${rotoFilterId(index)}" filterUnits="userSpaceOnUse" x="${-padding}" y="${-padding}" width="${number(box.width + padding * 2)}" height="${number(box.height + padding * 2)}" color-interpolation-filters="sRGB">${morphology}${blur}</filter>`;
}

function layerBoxSize(layer: MotionLayer): { width: number; height: number } {
  const transform = readRecord(layer.transform);
  const style = readRecord(layer.style);
  return {
    width: readNumber(transform.width) ?? readNumber(layer.width) ?? readNumber(style.width) ?? 100,
    height: readNumber(transform.height) ?? readNumber(layer.height) ?? readNumber(style.height) ?? 100,
  };
}

function pathMaskId(index: number): string { return `shellx-motion-path-mask-${index}`; }
function rotoMaskId(index: number): string { return `shellx-motion-roto-mask-${index}`; }
function rotoFilterId(index: number): string { return `shellx-motion-roto-filter-${index}`; }
function number(value: number): string { return Number(value.toFixed(9)).toString(); }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function escapeAttr(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] ?? char); }
function readRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function readNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function readString(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
