/** Chromium evidence and package binding checks for closed text-runs@1 spans. */
import type { Page } from "playwright-core";
import type { MotionFontAsset, MotionPackage } from "@shellx-motion/core";

export interface BrowserTypographyRunEvidence {
  layerId: string;
  index: number;
  fontAssetId: string;
  family: string;
  sha256: string;
  weight: number;
  style: "normal" | "italic" | "oblique";
  primaryFontAvailable: boolean | null;
  fontProvenance: "manifest-bound" | "unverified";
}

export async function collectBrowserStyledTextRunEvidence(page: Page): Promise<BrowserTypographyRunEvidence[]> {
  return page.evaluate(() => {
    const genericFamilies = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);
    const primaryAvailable = (family: string, sample: string): boolean | null => {
      try {
        if (!family) return null;
        if (genericFamilies.has(family.toLowerCase())) return true;
        const context = document.createElement("canvas").getContext("2d"), safeFont = family.replace(/["\\\n\r]/g, "");
        return sample ? Boolean(context && safeFont && ["monospace", "sans-serif", "serif"].some((fallback) => { context.font = `72px ${fallback}`; const baseline = context.measureText(sample).width; context.font = `72px "${safeFont}", ${fallback}`; return Math.abs(context.measureText(sample).width - baseline) > 0.01; })) : null;
      } catch { return false; }
    };
    return [...document.querySelectorAll<HTMLElement>("[data-motion-text-run='true']")].map((element) => {
      const parent = element.closest<HTMLElement>("[data-motion-text='true']"), family = element.dataset.motionFontFamily ?? "", index = Number(element.dataset.motionTextRunIndex), style = element.dataset.motionFontStyle;
      return {
        layerId: parent?.dataset.layerId ?? "", index: Number.isSafeInteger(index) && index >= 0 ? index : -1,
        fontAssetId: element.dataset.motionFontAssetId ?? "", family, sha256: element.dataset.motionFontSha256 ?? "", weight: Number(element.dataset.motionFontWeight),
        style: style === "italic" || style === "oblique" ? style as "italic" | "oblique" : "normal" as const,
        primaryFontAvailable: primaryAvailable(family, (element.textContent ?? "").slice(0, 512)),
        fontProvenance: element.dataset.motionFontProvenance === "manifest-bound" ? "manifest-bound" as const : "unverified" as const,
      };
    });
  });
}

export function hasManifestBoundTextRuns(pkg: MotionPackage, value: unknown): boolean {
  const data = record(value);
  if (!data || data.schema !== "shellx-motion/text-runs@1" || !Array.isArray(data.runs) || data.runs.length === 0) return false;
  const fonts = fontsById(pkg);
  return data.runs.every((run: unknown) => {
    const data = record(run), font = typeof data?.fontAssetId === "string" ? fonts.get(data.fontAssetId) : undefined;
    return Boolean(font && pkg.manifest.assets.includes(font.source.path));
  });
}

/** Returns exact run-binding evidence or one refusal explanation; it never repairs mismatches. */
export function bindStyledTextRunEvidence(
  pkg: MotionPackage,
  runs: readonly BrowserTypographyRunEvidence[],
  assetHashes: Readonly<Record<string, string>>,
): { families: string[]; problem?: { layerId: string; message: string } } {
  const fonts = fontsById(pkg), families = new Set<string>();
  for (const run of runs) {
    const font = fonts.get(run.fontAssetId), expectedSha256 = font ? assetHashes[font.source.path] : undefined;
    if (!font || !pkg.manifest.assets.includes(font.source.path) || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expectedSha256)) return { families: [], problem: { layerId: run.layerId, message: `Styled text run ${run.layerId}:${run.index} is not bound to a manifest-declared hashed font asset.` } };
    if (run.fontProvenance !== "manifest-bound" || run.family !== font.family || run.sha256.toLowerCase() !== expectedSha256.toLowerCase() || run.weight !== (font.weight ?? 400) || run.style !== (font.style ?? "normal")) return { families: [], problem: { layerId: run.layerId, message: `Styled text run ${run.layerId}:${run.index} runtime evidence does not match its immutable manifest font asset.` } };
    families.add(font.family.toLowerCase());
  }
  return { families: [...families] };
}

function fontsById(pkg: MotionPackage): Map<string, MotionFontAsset> { return new Map(pkg.motion.assets.map(readFont).filter((font): font is MotionFontAsset => font !== null).map((font) => [font.id, font])); }
function readFont(value: unknown): MotionFontAsset | null {
  const asset = record(value), source = record(asset?.source);
  if (!asset || asset.type !== "font" || !source || typeof asset.id !== "string" || typeof asset.family !== "string" || typeof source.path !== "string" || (source.mimeType !== "font/woff2" && source.mimeType !== "font/woff" && source.mimeType !== "font/ttf" && source.mimeType !== "font/otf")) return null;
  const weight = asset.weight, style = asset.style;
  if (weight !== undefined && (typeof weight !== "number" || !Number.isInteger(weight) || weight < 1 || weight > 1000)) return null;
  if (style !== undefined && style !== "normal" && style !== "italic" && style !== "oblique") return null;
  return { id: asset.id, type: "font", family: asset.family, source: { path: source.path, mimeType: source.mimeType }, ...(weight === undefined ? {} : { weight }), ...(style === undefined ? {} : { style }) };
}
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
