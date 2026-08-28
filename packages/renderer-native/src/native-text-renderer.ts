import type { MotionLayer, MotionPackage } from "@shellx-motion/core";
import { caseFoldedCharacters, fallbackGlyphCharacters, glyphRows } from "./native-glyphs";
import {
  alignedTextStartX,
  alignedTextStartY,
  fontWeightExtraPixels,
  insetTextDimension,
  layoutNativeTextLines,
  letterSpacingPixels,
  lineHeightPixels,
  nativeTextAlign,
  nativeVerticalAlign,
  readNativeTextRecord,
  readNativeTextString,
  readNativeTextTransform,
  textBoxBaseHeight,
  textBoxBaseWidth,
  textBoxBorder,
  textBoxHeightPixels,
  textBoxPaddingPixels,
  textBoxRadiusPixels,
  textBoxWidthPixels,
  textVisualBox,
  type NativeTextBox
} from "./native-text-layout";
import { requestedFontFamily } from "./text-delivery-gate";

export interface NativeTextRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface NativeTextCanvas {
  withClip(clip: NativeTextBox | null, paint: () => void): void;
  fillRect(x: number, y: number, width: number, height: number, color: NativeTextRgba): void;
  fillRoundedRect(x: number, y: number, width: number, height: number, radius: number, color: NativeTextRgba): void;
  strokeRoundedRect(x: number, y: number, width: number, height: number, strokeWidth: number, radius: number, color: NativeTextRgba): void;
}

export interface NativeTextRenderingServices {
  applyLayerOpacity(color: NativeTextRgba, layer: MotionLayer): NativeTextRgba;
  layerPaintClip(layer: MotionLayer, box: NativeTextBox, scale: number, atMs: number): NativeTextBox | null;
  parseColor(value: string, context?: { currentColor?: NativeTextRgba }): NativeTextRgba;
  resolveTokenString(value: unknown, pkg: MotionPackage): string;
}

/** Draw one text or caption layer through the existing fixed 5x7 block-glyph raster path. */
export function drawNativeTextLayer(
  canvas: NativeTextCanvas,
  layer: MotionLayer,
  pkg: MotionPackage,
  atMs: number,
  services: NativeTextRenderingServices
): void {
  const text = readNativeTextString(layer.text) ?? "";
  if (text.length === 0) return;

  const transform = readNativeTextTransform(layer);
  const style = readNativeTextRecord(layer.style);
  const fontSize = readNativeTextNumber(style.fontSize) ?? 32;
  const baseTextColor = services.parseColor(services.resolveTokenString(readNativeTextString(style.color) ?? readNativeTextString(layer.color) ?? "#111827", pkg));
  const color = services.applyLayerOpacity(baseTextColor, layer);
  const pixelSize = Math.max(1, Math.round((fontSize * transform.scale) / 7));
  const glyphWidth = pixelSize * 5;
  const glyphHeight = pixelSize * 7;
  const spacing = Math.max(1, Math.round(pixelSize * 0.8)) + letterSpacingPixels(style.letterSpacing, transform.scale);
  const fontWeightExtra = fontWeightExtraPixels(style.fontWeight, pixelSize);
  const lineHeight = lineHeightPixels(style.lineHeight, fontSize, transform.scale, glyphHeight);
  const baseLineWidth = textBoxBaseWidth(layer, style, transform);
  const maxLineWidth = textBoxWidthPixels(layer, style, transform);
  const textAlign = nativeTextAlign(style.textAlign);
  const baseBoxHeight = textBoxBaseHeight(layer, style, transform);
  const maxBoxHeight = textBoxHeightPixels(layer, style, transform);
  const verticalAlign = nativeVerticalAlign(style.verticalAlign ?? style.alignY);
  const padding = textBoxPaddingPixels(style, transform.scale);
  const border = textBoxBorder(style, transform.scale);
  const shadow = textShadow(style, pkg, transform.scale, layer, baseTextColor, services);
  const contentLineWidth = insetTextDimension(maxLineWidth, (border.width * 2) + padding.left + padding.right);
  const contentBoxHeight = insetTextDimension(maxBoxHeight, (border.width * 2) + padding.top + padding.bottom);
  const lines = layoutNativeTextLines(text, contentLineWidth, glyphWidth, spacing);
  const visualBox = textVisualBox(transform, baseLineWidth, baseBoxHeight, maxLineWidth, maxBoxHeight, lines, glyphWidth, spacing, lineHeight, glyphHeight, border, padding);
  const contentX = visualBox.x + border.width + padding.left;
  const contentY = visualBox.y + border.width + padding.top;
  const mask = services.layerPaintClip(layer, visualBox, transform.scale, atMs);

  canvas.withClip(mask, () => {
    drawTextBoxDecoration(canvas, layer, pkg, style, transform.scale, visualBox, maxLineWidth, maxBoxHeight, border, baseTextColor, services);
    const startY = alignedTextStartY(contentY, lines.length, contentBoxHeight, lineHeight, glyphHeight, verticalAlign);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const cursorX = alignedTextStartX(contentX, lines[lineIndex], contentLineWidth, glyphWidth, spacing, textAlign);
      const cursorY = startY + lineIndex * lineHeight;
      if (shadow) {
        drawTextLineShadow(canvas, lines[lineIndex], cursorX, cursorY, pixelSize, glyphWidth, spacing, fontWeightExtra, shadow);
      }
      drawTextLineGlyphs(canvas, lines[lineIndex], cursorX, cursorY, pixelSize, glyphWidth, spacing, fontWeightExtra, color);
    }
  });
}

interface NativeTextShadow {
  x: number;
  y: number;
  blur: number;
  color: NativeTextRgba;
}

function textShadow(
  style: Record<string, unknown>,
  pkg: MotionPackage,
  scale: number,
  layer: MotionLayer,
  currentColor: NativeTextRgba,
  services: NativeTextRenderingServices
): NativeTextShadow | null {
  const shadow = readNativeTextRecord(style.textShadow ?? style.shadow);
  if (Object.keys(shadow).length === 0) return null;
  const color = services.applyLayerOpacity(services.parseColor(services.resolveTokenString(readNativeTextString(shadow.color) ?? "rgba(0,0,0,0.35)", pkg), { currentColor }), layer);
  if (color.a <= 0) return null;
  return {
    x: shadowLengthPixels(shadow, ["x", "offsetX"], scale),
    y: shadowLengthPixels(shadow, ["y", "offsetY"], scale),
    blur: Math.max(0, shadowLengthPixels(shadow, ["blur", "blurRadius"], scale)),
    color
  };
}

function shadowLengthPixels(shadow: Record<string, unknown>, keys: string[], scale: number): number {
  for (const key of keys) {
    const value = readCssPixelValue(shadow[key]);
    if (value !== null) return value * scale;
  }
  return 0;
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

function drawTextBoxDecoration(
  canvas: NativeTextCanvas,
  layer: MotionLayer,
  pkg: MotionPackage,
  style: Record<string, unknown>,
  scale: number,
  box: NativeTextBox,
  width: number | null,
  height: number | null,
  border: { color: string | null; width: number },
  currentColor: NativeTextRgba,
  services: NativeTextRenderingServices
): void {
  if (width === null || height === null) return;
  const radius = textBoxRadiusPixels(style, scale, width, height);
  const background = readNativeTextString(style.backgroundColor) ?? readNativeTextString(style.background);
  if (background) {
    canvas.fillRoundedRect(box.x, box.y, width, height, radius, services.applyLayerOpacity(services.parseColor(services.resolveTokenString(background, pkg), { currentColor }), layer));
  }
  if (border.color && border.width > 0) {
    canvas.strokeRoundedRect(box.x, box.y, width, height, border.width, radius, services.applyLayerOpacity(services.parseColor(services.resolveTokenString(border.color, pkg), { currentColor }), layer));
  }
}

function drawTextLineShadow(
  canvas: NativeTextCanvas,
  line: string,
  x: number,
  y: number,
  pixelSize: number,
  glyphWidth: number,
  spacing: number,
  fontWeightExtra: number,
  shadow: NativeTextShadow
): void {
  drawTextLineGlyphs(canvas, line, x + shadow.x, y + shadow.y, pixelSize, glyphWidth, spacing, fontWeightExtra, shadow.color);
  if (shadow.blur <= 0) return;

  const steps = Math.min(12, Math.max(1, Math.ceil(shadow.blur)));
  for (let step = steps; step >= 1; step -= 1) {
    const alpha = Math.round(shadow.color.a * ((steps - step + 1) / (steps + 1)) * 0.25);
    if (alpha <= 0) continue;
    const expansion = (shadow.blur * step) / steps;
    const color = { ...shadow.color, a: alpha };
    drawTextLineGlyphs(canvas, line, x + shadow.x - expansion, y + shadow.y, pixelSize, glyphWidth, spacing, fontWeightExtra, color);
    drawTextLineGlyphs(canvas, line, x + shadow.x + expansion, y + shadow.y, pixelSize, glyphWidth, spacing, fontWeightExtra, color);
    drawTextLineGlyphs(canvas, line, x + shadow.x, y + shadow.y - expansion, pixelSize, glyphWidth, spacing, fontWeightExtra, color);
    drawTextLineGlyphs(canvas, line, x + shadow.x, y + shadow.y + expansion, pixelSize, glyphWidth, spacing, fontWeightExtra, color);
  }
}

function drawTextLineGlyphs(
  canvas: NativeTextCanvas,
  line: string,
  x: number,
  y: number,
  pixelSize: number,
  glyphWidth: number,
  spacing: number,
  fontWeightExtra: number,
  color: NativeTextRgba
): void {
  let cursorX = x;
  for (const char of line) {
    if (char === " ") {
      cursorX += glyphWidth + spacing;
      continue;
    }
    if (char === "\t") {
      cursorX += (glyphWidth + spacing) * 4;
      continue;
    }
    drawGlyph(canvas, char, cursorX, y, pixelSize, fontWeightExtra, color);
    cursorX += glyphWidth + spacing;
  }
}

function drawGlyph(canvas: NativeTextCanvas, char: string, x: number, y: number, pixelSize: number, fontWeightExtra: number, color: NativeTextRgba): void {
  const rows = glyphRows(char);
  for (let row = 0; row < rows.length; row += 1) {
    for (let col = 0; col < rows[row].length; col += 1) {
      if (rows[row][col] === "1") {
        canvas.fillRect(x + col * pixelSize, y + row * pixelSize, pixelSize + fontWeightExtra, pixelSize, color);
      }
    }
  }
}

/** Per-layer preview warnings for text the fixed block-glyph set cannot draw faithfully. */
export function nativeTextLayerWarnings(layer: MotionLayer): string[] {
  const text = readNativeTextString(layer.text) ?? "";
  const warnings: string[] = [];
  const caseFolded = caseFoldedCharacters(text);
  if (caseFolded.length > 0) {
    warnings.push(`Native renderer case-folded lowercase text to uppercase block glyphs on layer ${layer.id}: ${caseFolded.join("")}.`);
  }
  const fallbackChars = fallbackGlyphCharacters(text);
  if (fallbackChars.length > 0) {
    warnings.push(`Native renderer used fallback block glyphs for unsupported text characters on layer ${layer.id}: ${fallbackChars.join("")}.`);
  }
  const fontFamily = requestedFontFamily(layer);
  if (fontFamily) {
    warnings.push(`Native renderer ignored the requested font family '${fontFamily}' on layer ${layer.id} and drew block glyphs instead.`);
  }
  return warnings;
}

function readNativeTextNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
