import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import { gpuSceneEffects } from "./gpu-scene-effects";
import { parseGpuSceneColor } from "./gpu-scene-color";
import type { GpuTextFitIntent, GpuTextIntent, GpuRgba, GpuTextShadow } from "./gpu-frame-intent";
import type { MotionDocument, MotionLayer } from "./types";

export interface GpuScene2dFontResource {
  resourceId: string;
  assetRef: string;
  family: string;
  weight: number;
  style: "normal" | "italic" | "oblique";
  mimeType: "font/woff2" | "font/woff" | "font/ttf" | "font/otf";
  sha256: string;
}

export type GpuScene2dFontResources = ReadonlyMap<string, readonly GpuScene2dFontResource[]>;
export type GpuSceneTextCompileResult =
  | { ok: true; draw: GpuTextIntent }
  | { ok: false; failure: { code: "gpu_unsupported_feature" | "gpu_unsupported_color"; message: string; layerId: string } };

/** Resolve the manifest family requested by a text/caption layer, including design tokens. */
export function gpuSceneTextPrimaryFontFamily(motion: MotionDocument, layer: MotionLayer): string | null {
  const resolved = resolveToken(layer.style?.fontFamily, motion.designTokens);
  if (typeof resolved !== "string" || /[;{}<>]/.test(resolved) || /(?:url\s*\(|@import)/i.test(resolved)) return null;
  const family = resolved.split(",", 1)[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return family && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(family) ? family : null;
}

/** Lower one browser-shaped text box. Host fonts are never an implicit fallback. */
export function compileGpuSceneText(
  motion: MotionDocument,
  layer: MotionLayer,
  fonts: GpuScene2dFontResources | undefined
): GpuSceneTextCompileResult {
  if (layer.textRuns !== undefined) {
    return fail(layer, "gpu_unsupported_feature", `GPU text layer ${layer.id} does not support text.runs.v1; use the Browser lane.`);
  }
  const family = gpuSceneTextPrimaryFontFamily(motion, layer);
  const faces = family ? fonts?.get(family.toLowerCase()) : undefined;
  if (!family || !faces?.length) return fail(layer, "gpu_unsupported_feature", `GPU text layer ${layer.id} requires a prepared manifest-bound font family.`);
  const style = layer.style ?? {}; const transform = layer.transform ?? {};
  const text = typeof layer.text === "string" ? layer.text : "";
  const width = positive(transform.width ?? layer.width ?? number(style.width));
  const height = positive(transform.height ?? layer.height ?? number(style.height));
  const x = finite(transform.x ?? 0); const y = finite(transform.y ?? 0); const scale = positive(transform.scale ?? 1);
  const fontSize = positive(number(style.fontSize) ?? 32); const fontWeight = integer(number(style.fontWeight) ?? 500, 1, 1_000);
  const letterSpacing = finite(number(style.letterSpacing) ?? 0); const lineHeight = boundedPositive(number(style.lineHeight) ?? 1.15, 10);
  const opacity = boundedUnit(layer.opacity ?? transform.opacity ?? 1);
  if ([width, height, x, y, scale, fontSize, fontWeight, letterSpacing, lineHeight, opacity].some((value) => value === null)) return fail(layer, "gpu_unsupported_feature", `GPU text layer ${layer.id} has invalid layout, typography or opacity.`);
  const originX = finite(transform.originX ?? (width as number) / 2); const originY = finite(transform.originY ?? (height as number) / 2); const rotationDeg = finite(transform.rotation ?? 0);
  if (originX === null || originY === null || rotationDeg === null) return fail(layer, "gpu_unsupported_feature", `GPU text layer ${layer.id} has an invalid transform origin or rotation.`);
  const colorValue = resolveToken(style.color ?? "#111827", motion.designTokens);
  const color = typeof colorValue === "string" ? parseTextColor(colorValue) : null;
  if (!color) return fail(layer, "gpu_unsupported_color", `GPU text layer ${layer.id} requires a bounded hexadecimal, rgb(), rgba(), or transparent text color.`);
  const textShadow = readTextShadow(style.textShadow ?? style.shadow, motion.designTokens);
  if (textShadow === undefined) return fail(layer, "gpu_unsupported_feature", `GPU text layer ${layer.id} has an invalid or unsupported text shadow.`);
  const textFit = readTextFit(layer, motion);
  if (textFit === undefined) return fail(layer, "gpu_unsupported_feature", `GPU text layer ${layer.id} requires a valid browser glyph-layout text-fit contract.`);
  const direction = textDirection(style.direction, text);
  const textAlign = horizontalAlign(style.textAlign, direction);
  const verticalAlign = vertical(style.verticalAlign ?? style.alignY);
  const fontStyle = style.fontStyle === "italic" || style.fontStyle === "oblique" ? style.fontStyle : "normal";
  const fontResourceIds = faces.map((face) => face.resourceId).sort();
  const box = {
    x: (x as number) + originX - originX * (scale as number),
    y: (y as number) + originY - originY * (scale as number),
    width: (width as number) * (scale as number), height: (height as number) * (scale as number)
  };
  const renderedFontSize = (fontSize as number) * (scale as number); const renderedLetterSpacing = (letterSpacing as number) * (scale as number);
  const raster = {
    fontResourceIds, fontFamily: family, text, width: box.width, height: box.height, color, fontSize: renderedFontSize, fontWeight,
    fontStyle, letterSpacing: renderedLetterSpacing, lineHeight, textAlign, verticalAlign, direction, textShadow, textFit
  };
  const surfaceId = `text-${createHash("sha256").update(canonicalJson(raster)).digest("hex").slice(0, 24)}`;
  return { ok: true, draw: {
    kind: "text", id: layer.id, blendMode: layer.blendMode ?? "normal", effects: gpuSceneEffects(layer), surfaceId, fontResourceIds, fontFamily: family, text,
    ...box, rotationDeg, pivotX: (x as number) + originX, pivotY: (y as number) + originY,
    opacity: opacity as number, color, fontSize: renderedFontSize, fontWeight: fontWeight as number,
    fontStyle, letterSpacing: renderedLetterSpacing, lineHeight: lineHeight as number, textAlign, verticalAlign, direction, textShadow, textFit
  } };
}

function resolveToken(value: unknown, tokens: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = /^\{([^}]+)\}$/.exec(value.trim()); if (!match) return value;
  let current = tokens;
  for (const key of match[1].split(".")) current = record(current)[key];
  return current ?? value;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function finite(value: number): number | null { return Number.isFinite(value) ? value : null; }
function positive(value: number | null): number | null { return value !== null && Number.isFinite(value) && value > 0 ? value : null; }
function integer(value: number | null, min: number, max: number): number | null { return value !== null && Number.isInteger(value) && value >= min && value <= max ? value : null; }
function boundedPositive(value: number | null, max: number): number | null { return value !== null && value > 0 && value <= max ? value : null; }
function boundedUnit(value: number): number | null { return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null; }
function textDirection(value: unknown, text: string): "ltr" | "rtl" { return value === "rtl" || (value !== "ltr" && /[\u0590-\u08ff]/u.test(text)) ? "rtl" : "ltr"; }
function horizontalAlign(value: unknown, direction: "ltr" | "rtl"): "left" | "center" | "right" { if (value === "center") return "center"; if (value === "right" || value === "end") return direction === "rtl" && value === "end" ? "left" : "right"; if (value === "start") return direction === "rtl" ? "right" : "left"; return "left"; }
function vertical(value: unknown): "top" | "middle" | "bottom" { return value === "bottom" ? "bottom" : value === "middle" || value === "center" ? "middle" : "top"; }
function parseTextColor(value: string): GpuRgba | null {
  const parsed = parseGpuSceneColor(value.trim()); if (parsed) return parsed;
  const match = /^rgba?\(\s*([+-]?(?:\d+|\d*\.\d+)(?:%)?)\s*[,/]\s*([+-]?(?:\d+|\d*\.\d+)(?:%)?)\s*[,/]\s*([+-]?(?:\d+|\d*\.\d+)(?:%)?)(?:\s*[,/]\s*([+-]?(?:\d+|\d*\.\d+)(?:%)?))?\s*\)$/i.exec(value.trim());
  if (!match || (value.trim().toLowerCase().startsWith("rgba") && !match[4])) return null;
  const channel = (raw: string): number | null => raw.endsWith("%") ? bounded(Number(raw.slice(0, -1)) / 100) : bounded(Number(raw) / 255);
  const alpha = match[4] === undefined ? 1 : match[4].endsWith("%") ? bounded(Number(match[4].slice(0, -1)) / 100) : bounded(Number(match[4]));
  const [r, g, b] = [channel(match[1]), channel(match[2]), channel(match[3])];
  return r === null || g === null || b === null || alpha === null ? null : { r, g, b, a: alpha };
}
function bounded(value: number): number | null { return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null; }
function readTextShadow(value: unknown, tokens: unknown): GpuTextShadow | null | undefined {
  if (value === undefined || value === null) return null;
  const shadow = record(resolveToken(value, tokens));
  if (Object.keys(shadow).length === 0 || Object.keys(shadow).some((key) => !["x", "y", "offsetX", "offsetY", "blur", "blurRadius", "color"].includes(key))) return undefined;
  const offsetX = finite(number(resolveToken(shadow.x ?? shadow.offsetX ?? 0, tokens)) ?? NaN);
  const offsetY = finite(number(resolveToken(shadow.y ?? shadow.offsetY ?? 0, tokens)) ?? NaN);
  const blur = number(resolveToken(shadow.blur ?? shadow.blurRadius ?? 0, tokens));
  const colorValue = resolveToken(shadow.color ?? "rgba(0,0,0,0.35)", tokens);
  const color = typeof colorValue === "string" ? parseTextColor(colorValue) : null;
  if (offsetX === null || offsetY === null || blur === null || blur < 0 || blur > 512 || !color) return undefined;
  return { offsetX, offsetY, blur, color };
}
function readTextFit(layer: MotionLayer, motion: MotionDocument): GpuTextFitIntent | null | undefined {
  if (!layer.textFit) return null;
  const policy = layer.textFit.policy;
  if (policy !== "safe" && policy !== "allow-crop" && policy !== "auto-fit") return undefined;
  const safeAreaId = layer.textFit.safeAreaId;
  const minFontSize = layer.textFit.minFontSize;
  if (policy === "allow-crop") return { policy, safeArea: null, minFontSize: null };
  if (typeof safeAreaId !== "string" || !safeAreaId) return undefined;
  const source = motion.safeAreas?.[safeAreaId];
  const top = source?.top; const right = source?.right; const bottom = source?.bottom; const left = source?.left;
  if (![top, right, bottom, left].every((value) => typeof value === "number" && Number.isFinite(value))) return undefined;
  const safeArea = { top: top as number, right: motion.width - (right as number), bottom: motion.height - (bottom as number), left: left as number };
  if (safeArea.right < safeArea.left || safeArea.bottom < safeArea.top) return undefined;
  if (policy === "safe") return { policy, safeArea, minFontSize: null };
  const effectiveMin = minFontSize ?? 12;
  if (!Number.isFinite(effectiveMin) || effectiveMin <= 0) return undefined;
  return { policy, safeArea, minFontSize: effectiveMin };
}
function fail(layer: MotionLayer, code: "gpu_unsupported_feature" | "gpu_unsupported_color", message: string): GpuSceneTextCompileResult { return { ok: false, failure: { code, message, layerId: layer.id } }; }
