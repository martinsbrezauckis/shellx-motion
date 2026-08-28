/** Safe DOM lowering for closed manifest-bound Motion text-runs@1. */
import type { Page } from "playwright-core";
import type { MotionFontAsset, MotionTextRuns } from "@shellx-motion/core";
import { GPU_PAGE_SERIALIZATION_RUNTIME } from "./gpu-page-serialization-runtime";

export interface BrowserStyledTextRunsInput {
  textRuns: MotionTextRuns;
  fontAssets: readonly MotionFontAsset[];
  assetHashes: ReadonlyMap<string, string>;
  resolveColor: (value: string, fallback: string) => string;
}

/**
 * Runs never accept CSS face names. Each span derives family, weight, style,
 * and hash-bound provenance exclusively from its referenced font asset.
 */
export function renderBrowserStyledTextRuns(input: BrowserStyledTextRunsInput): string {
  const fonts = new Map(input.fontAssets.map((font) => [font.id, font]));
  return input.textRuns.runs.map((run, index) => {
    const font = fonts.get(run.fontAssetId);
    if (!font) throw new Error(`Text run ${index} references a missing Motion font asset: ${run.fontAssetId}.`);
    const sha256 = input.assetHashes.get(font.source.path);
    if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new Error(`Text run ${index} font asset ${font.id} lacks the generated manifest-bound SHA-256.`);
    }
    return `<span data-motion-text-run="true" data-motion-text-run-index="${index}" data-motion-font-provenance="manifest-bound" data-motion-font-asset-id="${escapeAttr(font.id)}" data-motion-font-family="${escapeAttr(font.family)}" data-motion-font-sha256="${sha256.toLowerCase()}" data-motion-font-weight="${font.weight ?? 400}" data-motion-font-style="${font.style ?? "normal"}"${run.color === undefined ? "" : ` data-motion-run-color="${escapeAttr(input.resolveColor(run.color, "#111827"))}"`}${run.fontSizePx === undefined ? "" : ` data-motion-run-font-size-px="${numberData(run.fontSizePx, `Text run ${index} fontSizePx`)}"`}${run.letterSpacingPx === undefined ? "" : ` data-motion-run-letter-spacing-px="${numberData(run.letterSpacingPx, `Text run ${index} letterSpacingPx`)}"`}>${escapeHtml(run.text)}</span>`;
  }).join("");
}

/**
 * Apply the manifest-derived run styles through CSSOM, never through an HTML
 * style attribute. Attribute values are data only; CSS parsing cannot turn a
 * quote, backslash, or delimiter in a family name into markup.
 */
export async function applyBrowserStyledTextRunStyles(page: Page): Promise<void> {
  // `tsx` serializes the callback below into Chromium and injects `__name` for
  // its nested helpers.  This is the first browser-side callback on generated
  // template renders, so install the fixed compatibility binding before that
  // callback crosses the Node-to-page boundary.
  const serializationRuntime = await page.evaluate(GPU_PAGE_SERIALIZATION_RUNTIME);
  if (serializationRuntime !== true) {
    throw new Error("The browser page could not install Motion's fixed serialization runtime.");
  }
  await page.evaluate(() => {
    const finite = (value: string | undefined): number | null => {
      if (value === undefined || value.trim() === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    for (const element of document.querySelectorAll<HTMLElement>("[data-motion-text-run='true']")) {
      const family = element.dataset.motionFontFamily;
      const weight = finite(element.dataset.motionFontWeight);
      const style = element.dataset.motionFontStyle;
      if (!family || weight === null || !Number.isInteger(weight) || weight < 1 || weight > 1000 || (style !== "normal" && style !== "italic" && style !== "oblique")) {
        throw new Error("Generated text run has invalid manifest-derived font data.");
      }
      // JSON's quoted-string grammar safely escapes the quote/backslash subset
      // admitted by the manifest alias contract. It is passed to CSSOM, never
      // interpolated into HTML markup.
      element.style.fontFamily = JSON.stringify(family);
      element.style.fontWeight = String(weight);
      element.style.fontStyle = style;
      const color = element.dataset.motionRunColor;
      if (color !== undefined) element.style.color = color;
      const fontSize = finite(element.dataset.motionRunFontSizePx);
      if (fontSize !== null && fontSize > 0) element.style.fontSize = `${fontSize}px`;
      else if (element.dataset.motionRunFontSizePx !== undefined) throw new Error("Generated text run has invalid fontSizePx.");
      const letterSpacing = finite(element.dataset.motionRunLetterSpacingPx);
      if (letterSpacing !== null) element.style.letterSpacing = `${letterSpacing}px`;
      else if (element.dataset.motionRunLetterSpacingPx !== undefined) throw new Error("Generated text run has invalid letterSpacingPx.");
    }
  });
}

function numberData(value: number, label: string): string {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return String(value);
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }
function escapeAttr(value: string): string { return escapeHtml(value); }
