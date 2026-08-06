/**
 * Delivery-target text gate for the ShellX Motion native lane (the text-delivery invariant).
 *
 * Role: decide whether a document's text may be drawn by the native block-glyph rasterizer when the
 * frames are destined for a DELIVERABLE (encoded video, PNG sequence) rather than for a preview.
 *
 * Why a refusal and not a warning: the native capability card already declares this lane as
 * `category: "preview"`, `stability: "degraded"`, `renderTargets: ["preview","still-frame",
 * "fixture-smoke"]`. The code contradicted that card — `--frame-lane native` happily encoded a final
 * MP4 whose text had been case-folded ("Sveiks" -> "SVEIKS"), font-substituted (a requested `Inter`
 * silently ignored), or replaced by codepoint-derived noise boxes. A warning does not help there:
 * the deliverable is already written, it is indistinguishable from a correct render to anything
 * downstream, and the warning is one line in a receipt nobody reads before shipping the file. The
 * refusal names the browser lane, which rasterizes the manifest-bound embedded fonts correctly.
 *
 * Scope: this gate is about DELIVERY only. Preview, still-frame and fixture-smoke renders keep
 * working exactly as before — they warn per layer instead (see `nativeLayerWarnings` in `./index`),
 * because an approximate fast preview is the native lane's declared job.
 *
 * Characters with no bitmap at all in a NON-ASCII range never reach this gate: the capability gate in
 * `@shellx-motion/core` refuses `text.charset.non-ascii` for every render target. What is left here
 * is the subset the rasterizer *can* draw but not faithfully: case-folded lowercase, ASCII
 * punctuation outside the 20-mark table, and ignored font families.
 *
 * Dependencies: `@shellx-motion/core` types, `./native-glyphs` coverage classifiers.
 *
 * Primary callers: `./index.ts` (`createNativeRenderSession` with `renderTarget: "delivery"`), which
 * is in turn driven by the CLI's final-encode and PNG-sequence render paths.
 */
import type { MotionDocument, MotionLayer } from "@shellx-motion/core";
import { caseFoldedCharacters, fallbackGlyphCharacters } from "./native-glyphs";

/** One reason a document's text cannot be delivered from the native lane, shaped like a capability miss. */
export interface NativeTextDeliveryIssue {
  layerId: string;
  feature: string;
  reason: string;
}

/**
 * Collect every reason the native lane must not produce a delivery render of `motion`.
 *
 * Checks each visible text/caption layer for the three ways native text silently diverges from the
 * authored document:
 *   - `text.case.preserved` — lowercase characters exist and would be folded to uppercase.
 *   - `text.block-glyphs.fallback` — characters with no bitmap, drawn as codepoint noise boxes.
 *   - `text.font.family` — a font family was requested and is ignored entirely by this lane.
 *
 * @param motion Motion document about to be rendered.
 * @returns Issues in layer order (empty when the native lane can deliver this document's text).
 */
export function nativeTextDeliveryIssues(motion: MotionDocument): NativeTextDeliveryIssue[] {
  return motion.layers.flatMap((layer) => {
    if (layer.visible === false) return [];
    if (layer.type !== "text" && layer.type !== "caption") return [];
    return layerTextDeliveryIssues(layer);
  });
}

/**
 * Build the typed refusal message for a set of issues.
 *
 * Kept next to the issue collection so the CLI, the session and the tests all quote the same
 * remedy sentence.
 */
export function nativeTextDeliveryMessage(issues: NativeTextDeliveryIssue[]): string {
  const layerCount = new Set(issues.map((issue) => issue.layerId)).size;
  return `Native lane cannot deliver text: ${issues.length} unfaithful text ${issues.length === 1 ? "property" : "properties"} across ${layerCount} ${layerCount === 1 ? "layer" : "layers"}. `
    + "The native lane is a preview/still-frame lane with a fixed uppercase ASCII block-glyph set and no font rasterizer; "
    + "re-run the delivery render with --frame-lane browser, which rasterizes the package's embedded fonts.";
}

function layerTextDeliveryIssues(layer: MotionLayer): NativeTextDeliveryIssue[] {
  const issues: NativeTextDeliveryIssue[] = [];
  const text = typeof layer.text === "string" ? layer.text : "";
  const caseFolded = caseFoldedCharacters(text);
  if (caseFolded.length > 0) {
    issues.push({
      layerId: layer.id,
      feature: "text.case.preserved",
      reason: `Lane native would case-fold delivered text on layer ${layer.id}: ${caseFolded.join("")} have no lowercase block glyph.`
    });
  }
  const fallback = fallbackGlyphCharacters(text);
  if (fallback.length > 0) {
    issues.push({
      layerId: layer.id,
      feature: "text.block-glyphs.fallback",
      reason: `Lane native would draw fallback noise boxes for delivered text on layer ${layer.id}: ${fallback.join("")}.`
    });
  }
  const fontFamily = requestedFontFamily(layer);
  if (fontFamily) {
    issues.push({
      layerId: layer.id,
      feature: "text.font.family",
      reason: `Lane native ignores the requested font family '${fontFamily}' on layer ${layer.id}; delivered text would not use it.`
    });
  }
  return issues;
}

/** The trimmed `style.fontFamily` a layer asks for, or null when it does not ask for one. */
export function requestedFontFamily(layer: MotionLayer): string | null {
  const style = typeof layer.style === "object" && layer.style !== null && !Array.isArray(layer.style)
    ? layer.style as Record<string, unknown>
    : {};
  const fontFamily = typeof style.fontFamily === "string" ? style.fontFamily.trim() : "";
  return fontFamily.length > 0 ? fontFamily : null;
}
