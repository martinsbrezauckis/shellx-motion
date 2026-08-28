import type { MotionLayer } from "@shellx-motion/core";

/** Pure layout and metric helpers for the native lane's fixed 5x7 block glyphs. */
export interface NativeTextTransform {
  x: number;
  y: number;
  scale: number;
  width?: number;
  height?: number;
  originX?: number;
  originY?: number;
}

export interface NativeTextBox {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}

export interface NativeTextPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface NativeTextBorder {
  color: string | null;
  width: number;
}

export type NativeTextAlign = "left" | "center" | "right";
export type NativeVerticalAlign = "top" | "middle" | "bottom";

export function readNativeTextRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function readNativeTextString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNativeTextNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readNativeTextTransform(layer: MotionLayer): NativeTextTransform {
  const transform = readNativeTextRecord(layer.transform);
  const width = readNativeTextNumber(transform.width);
  const height = readNativeTextNumber(transform.height);
  const originX = readNativeTextNumber(transform.originX);
  const originY = readNativeTextNumber(transform.originY);
  return {
    x: readNativeTextNumber(transform.x) ?? 0,
    y: readNativeTextNumber(transform.y) ?? 0,
    scale: readNativeTextNumber(transform.scale) ?? 1,
    ...(width !== null ? { width } : {}),
    ...(height !== null ? { height } : {}),
    ...(originX !== null ? { originX } : {}),
    ...(originY !== null ? { originY } : {})
  };
}

function readCssPixelValue(value: unknown): number | null {
  const numeric = readNativeTextNumber(value);
  if (numeric !== null) return numeric;
  const text = readNativeTextString(value)?.trim();
  if (!text) return null;
  if (text.endsWith("px")) {
    const pixels = Number(text.slice(0, -2));
    return Number.isFinite(pixels) ? pixels : null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nativeTextAlign(value: unknown): NativeTextAlign {
  const align = readNativeTextString(value)?.trim().toLowerCase();
  if (align === "center" || align === "right") return align;
  return "left";
}

export function nativeVerticalAlign(value: unknown): NativeVerticalAlign {
  const align = readNativeTextString(value)?.trim().toLowerCase();
  if (align === "bottom") return "bottom";
  if (align === "middle" || align === "center") return "middle";
  return "top";
}

export function alignedTextStartX(
  x: number,
  line: string,
  maxLineWidth: number | null,
  glyphWidth: number,
  spacing: number,
  textAlign: NativeTextAlign
): number {
  if (maxLineWidth === null || textAlign === "left") return x;
  const lineWidth = measureNativeText(line, glyphWidth, spacing);
  const remaining = Math.max(0, maxLineWidth - lineWidth);
  if (textAlign === "right") return x + remaining;
  return x + remaining / 2;
}

export function alignedTextStartY(
  y: number,
  lineCount: number,
  maxBoxHeight: number | null,
  lineHeight: number,
  glyphHeight: number,
  verticalAlign: NativeVerticalAlign
): number {
  if (maxBoxHeight === null || verticalAlign === "top") return y;
  const textHeight = lineCount <= 1 ? glyphHeight : ((lineCount - 1) * lineHeight) + glyphHeight;
  const remaining = Math.max(0, maxBoxHeight - textHeight);
  if (verticalAlign === "bottom") return y + remaining;
  return y + remaining / 2;
}

export function insetTextDimension(value: number | null, inset: number): number | null {
  return value === null ? null : Math.max(0, value - inset);
}

export function textBoxPaddingPixels(style: Record<string, unknown>, scale: number): NativeTextPadding {
  const all = readCssPixelValue(style.padding) ?? 0;
  const horizontal = readCssPixelValue(style.paddingX) ?? all;
  const vertical = readCssPixelValue(style.paddingY) ?? all;
  return {
    top: Math.max(0, (readCssPixelValue(style.paddingTop) ?? vertical) * scale),
    right: Math.max(0, (readCssPixelValue(style.paddingRight) ?? horizontal) * scale),
    bottom: Math.max(0, (readCssPixelValue(style.paddingBottom) ?? vertical) * scale),
    left: Math.max(0, (readCssPixelValue(style.paddingLeft) ?? horizontal) * scale)
  };
}

export function textBoxBorder(style: Record<string, unknown>, scale: number): NativeTextBorder {
  const color = readNativeTextString(style.borderColor) ?? readNativeTextString(style.stroke);
  const widthFallback = color ? readCssPixelValue(style.width) ?? 0 : 0;
  const width = readCssPixelValue(style.borderWidth) ?? readCssPixelValue(style.strokeWidth) ?? widthFallback;
  return { color, width: Math.max(0, width * scale) };
}

export function textBoxRadiusPixels(style: Record<string, unknown>, scale: number, width: number, height: number): number {
  const radius = readCssPixelValue(style.borderRadius) ?? readCssPixelValue(style.radius) ?? 0;
  return Math.max(0, Math.min((radius * scale), width / 2, height / 2));
}

export function textBoxBaseWidth(layer: MotionLayer, style: Record<string, unknown>, transform: NativeTextTransform): number | null {
  const value = transform.width ?? readCssPixelValue(layer.width) ?? readCssPixelValue(style.width);
  return value !== null && value > 0 ? value : null;
}

export function textBoxBaseHeight(layer: MotionLayer, style: Record<string, unknown>, transform: NativeTextTransform): number | null {
  const value = transform.height ?? readCssPixelValue(layer.height) ?? readCssPixelValue(style.height);
  return value !== null && value > 0 ? value : null;
}

export function textBoxWidthPixels(layer: MotionLayer, style: Record<string, unknown>, transform: NativeTextTransform): number | null {
  const value = textBoxBaseWidth(layer, style, transform);
  return value === null ? null : value * transform.scale;
}

export function textBoxHeightPixels(layer: MotionLayer, style: Record<string, unknown>, transform: NativeTextTransform): number | null {
  const value = textBoxBaseHeight(layer, style, transform);
  return value === null ? null : value * transform.scale;
}

export function textVisualBox(
  transform: NativeTextTransform,
  baseWidth: number | null,
  baseHeight: number | null,
  width: number | null,
  height: number | null,
  lines: string[],
  glyphWidth: number,
  spacing: number,
  lineHeight: number,
  glyphHeight: number,
  border: Pick<NativeTextBorder, "width">,
  padding: NativeTextPadding
): NativeTextBox {
  const naturalTextWidth = lines.reduce((max, line) => Math.max(max, measureNativeText(line, glyphWidth, spacing)), 0);
  const naturalTextHeight = lines.length <= 1 ? glyphHeight : ((lines.length - 1) * lineHeight) + glyphHeight;
  const scaledWidth = width ?? naturalTextWidth + (border.width * 2) + padding.left + padding.right;
  const scaledHeight = height ?? naturalTextHeight + (border.width * 2) + padding.top + padding.bottom;
  const baseVisualWidth = baseWidth ?? scaledDimensionBase(scaledWidth, transform.scale);
  const baseVisualHeight = baseHeight ?? scaledDimensionBase(scaledHeight, transform.scale);
  const box = scaleTextBoxAroundOrigin(transform.x, transform.y, baseVisualWidth, baseVisualHeight, transform.scale, transform.originX, transform.originY);
  return { x: box.x, y: box.y, width: scaledWidth, height: scaledHeight };
}

function scaledDimensionBase(value: number, scale: number): number {
  return scale === 0 ? 0 : value / scale;
}

function scaleTextBoxAroundOrigin(
  x: number,
  y: number,
  width: number,
  height: number,
  scale: number,
  originX: number | undefined,
  originY: number | undefined
): NativeTextBox {
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  const anchorX = originX ?? width / 2;
  const anchorY = originY ?? height / 2;
  return {
    x: x + anchorX - (anchorX * scale),
    y: y + anchorY - (anchorY * scale),
    width: scaledWidth,
    height: scaledHeight
  };
}

export function layoutNativeTextLines(text: string, maxLineWidth: number | null, glyphWidth: number, spacing: number): string[] {
  const hardLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (maxLineWidth === null) return hardLines;
  return hardLines.flatMap((line) => wrapTextLine(line, maxLineWidth, glyphWidth, spacing));
}

function wrapTextLine(line: string, maxLineWidth: number, glyphWidth: number, spacing: number): string[] {
  const words = line.split(/[ \t]+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      const wrapped = wrapLongWord(word, maxLineWidth, glyphWidth, spacing);
      lines.push(...wrapped.slice(0, -1));
      current = wrapped.at(-1) ?? "";
      continue;
    }

    const candidate = `${current} ${word}`;
    if (measureNativeText(candidate, glyphWidth, spacing) <= maxLineWidth) {
      current = candidate;
      continue;
    }

    lines.push(current);
    const wrapped = wrapLongWord(word, maxLineWidth, glyphWidth, spacing);
    lines.push(...wrapped.slice(0, -1));
    current = wrapped.at(-1) ?? "";
  }
  if (current) lines.push(current);
  return lines;
}

function wrapLongWord(word: string, maxLineWidth: number, glyphWidth: number, spacing: number): string[] {
  if (measureNativeText(word, glyphWidth, spacing) <= maxLineWidth) return [word];
  const lines: string[] = [];
  let current = "";
  for (const char of word) {
    const candidate = `${current}${char}`;
    if (current && measureNativeText(candidate, glyphWidth, spacing) > maxLineWidth) {
      lines.push(current);
      current = char;
      continue;
    }
    current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

export function measureNativeText(text: string, glyphWidth: number, spacing: number): number {
  let width = 0;
  for (const char of text) {
    if (char === "\t") {
      width += (glyphWidth + spacing) * 4;
      continue;
    }
    width += glyphWidth + spacing;
  }
  return width === 0 ? 0 : width - spacing;
}

export function lineHeightPixels(value: unknown, fontSize: number, scale: number, glyphHeight: number): number {
  const numeric = readNativeTextNumber(value);
  if (numeric !== null) return normalizedLineHeightPixels(numeric, fontSize, scale, glyphHeight);

  const text = readNativeTextString(value)?.trim();
  if (!text) return normalizedLineHeightPixels(1.15, fontSize, scale, glyphHeight);
  if (text.endsWith("%")) {
    const percent = Number(text.slice(0, -1));
    if (Number.isFinite(percent)) return normalizedLineHeightPixels(percent / 100, fontSize, scale, glyphHeight);
  }
  if (text.endsWith("px")) {
    const px = Number(text.slice(0, -2));
    if (Number.isFinite(px)) return normalizedLineHeightPixels(px, fontSize, scale, glyphHeight);
  }
  const parsed = Number(text);
  return Number.isFinite(parsed)
    ? normalizedLineHeightPixels(parsed, fontSize, scale, glyphHeight)
    : normalizedLineHeightPixels(1.15, fontSize, scale, glyphHeight);
}

export function letterSpacingPixels(value: unknown, scale: number): number {
  return (readCssPixelValue(value) ?? 0) * scale;
}

function normalizedLineHeightPixels(value: number, fontSize: number, scale: number, glyphHeight: number): number {
  const cssPixels = value <= 4 ? fontSize * value : value;
  return Math.max(glyphHeight + 1, Math.round(cssPixels * scale));
}

export function fontWeightExtraPixels(value: unknown, pixelSize: number): number {
  const weight = normalizedFontWeight(value);
  if (weight >= 800) return Math.max(1, Math.round(pixelSize * 1.25));
  if (weight >= 700) return Math.max(1, Math.round(pixelSize * 0.8));
  if (weight >= 600) return Math.max(1, Math.round(pixelSize * 0.4));
  return 0;
}

function normalizedFontWeight(value: unknown): number {
  const numeric = readNativeTextNumber(value);
  if (numeric !== null) return numeric;
  const text = readNativeTextString(value)?.trim().toLowerCase();
  if (!text || text === "normal") return 400;
  if (text === "bold" || text === "bolder") return 700;
  if (text === "lighter") return 300;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 400;
}
