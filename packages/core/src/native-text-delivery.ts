/**
 * Delivery-fidelity contract for the native block-glyph frame lane.
 *
 * The native renderer can make fast preview PNGs with deliberate approximations, but a frame
 * sequence handed to a final encoder must preserve text exactly. This policy lives in core so
 * capability planning and the native session apply the same target-aware refusal without making
 * the core package depend on a renderer implementation.
 */
import type { MotionDocument, MotionLayer } from "./types";

export interface NativeTextDeliveryIssue {
  layerId: string;
  feature: string;
  reason: string;
}

const NATIVE_BLOCK_GLYPH_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;!?-_+/\\'\"()[]#%&";
const nativeBlockGlyphs = new Set(NATIVE_BLOCK_GLYPH_CHARACTERS);

/** The exact bitmap repertoire the delivery policy permits, sorted for renderer-regression tests. */
export function nativeBlockGlyphRepertoire(): string[] {
  return [...nativeBlockGlyphs].sort();
}

/** Collect the text properties that make native frames ineligible for delivery. */
export function nativeTextDeliveryIssues(motion: MotionDocument): NativeTextDeliveryIssue[] {
  return motion.layers.flatMap((layer) => {
    if (layer.visible === false || (layer.type !== "text" && layer.type !== "caption")) return [];
    const issues: NativeTextDeliveryIssue[] = [];
    const text = typeof layer.text === "string" ? layer.text : "";
    const caseFolded = nativeCaseFoldedCharacters(text);
    if (caseFolded.length > 0) {
      issues.push({
        layerId: layer.id,
        feature: "text.case.preserved",
        reason: `Lane native would case-fold delivered text on layer ${layer.id}: ${caseFolded.join("")} have no lowercase block glyph.`
      });
    }
    const fallback = nativeFallbackGlyphCharacters(text);
    if (fallback.length > 0) {
      issues.push({
        layerId: layer.id,
        feature: "text.block-glyphs.fallback",
        reason: `Lane native would draw fallback noise boxes for delivered text on layer ${layer.id}: ${fallback.join("")}.`
      });
    }
    const fontFamily = requestedNativeTextFontFamily(layer);
    if (fontFamily) {
      issues.push({
        layerId: layer.id,
        feature: "text.font.family",
        reason: `Lane native ignores the requested font family '${fontFamily}' on layer ${layer.id}; delivered text would not use it.`
      });
    }
    return issues;
  });
}

/** Shared refusal text for native delivery callers. */
export function nativeTextDeliveryMessage(issues: NativeTextDeliveryIssue[]): string {
  const layerCount = new Set(issues.map((issue) => issue.layerId)).size;
  return `Native lane cannot deliver text: ${issues.length} unfaithful text ${issues.length === 1 ? "property" : "properties"} across ${layerCount} ${layerCount === 1 ? "layer" : "layers"}. `
    + "The native lane is a preview/still-frame lane with a fixed uppercase ASCII block-glyph set and no font rasterizer; "
    + "re-run the delivery render with --frame-lane browser, which rasterizes the package's embedded fonts.";
}

/** The requested native text font, if any. Delivery rejects it because the lane cannot honor it. */
export function requestedNativeTextFontFamily(layer: MotionLayer): string | null {
  const style = typeof layer.style === "object" && layer.style !== null && !Array.isArray(layer.style)
    ? layer.style as Record<string, unknown>
    : {};
  const fontFamily = typeof style.fontFamily === "string" ? style.fontFamily.trim() : "";
  return fontFamily.length > 0 ? fontFamily : null;
}

function nativeFallbackGlyphCharacters(text: string): string[] {
  const unsupported = new Set<string>();
  for (const char of text) {
    if (!isNativeTextWhitespace(char) && !nativeBlockGlyphs.has(char.toUpperCase())) unsupported.add(char);
  }
  return [...unsupported];
}

function nativeCaseFoldedCharacters(text: string): string[] {
  const folded = new Set<string>();
  for (const char of text) {
    const upper = char.toUpperCase();
    if (!isNativeTextWhitespace(char) && upper !== char && nativeBlockGlyphs.has(upper)) folded.add(char);
  }
  return [...folded];
}

function isNativeTextWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}
