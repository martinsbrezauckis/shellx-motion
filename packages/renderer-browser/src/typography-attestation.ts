import type { Page } from "playwright-core";
import type { MotionFontAsset, MotionPackage } from "@shellx-motion/core";
import {
  bindStyledTextRunEvidence,
  collectBrowserStyledTextRunEvidence,
  hasManifestBoundTextRuns,
  type BrowserTypographyRunEvidence,
} from "./typography-styled-runs";
export type { BrowserTypographyRunEvidence } from "./typography-styled-runs";

export type BrowserTypographyAttestation = "verified" | "unverified" | "not_applicable";
export type BrowserTypographyScopeKind = "motion-ir" | "html-web-canvas";

export interface BrowserTypographyLayerEvidence {
  layerId: string;
  direction: "ltr" | "rtl";
  lang: string | null;
  requestedFontFamily: string | null;
  resolvedFontFamily: string;
  primaryFontAvailable: boolean | null;
  fontProvenance: "manifest-bound" | "unverified";
}

/** Hashes of the embedded package font bytes that back verified requested families. */
export interface BrowserTypographyFontAssetEvidence {
  id: string;
  family: string;
  sha256: string;
}

export interface BrowserTypographyScopeEvidence {
  kind: BrowserTypographyScopeKind;
  attestation: Exclude<BrowserTypographyAttestation, "not_applicable">;
  layerIds: string[];
  reason?: "arbitrary_html_web_canvas_text_unobservable" | "requested_font_not_manifest_bound";
}

/**
 * The browser can prove generated MotionIR typography only when the requested family came from a
 * manifest-declared package font. Arbitrary browser HTML/canvas remains renderable, but it cannot
 * prove which text was drawn or which host fallback Chromium chose.
 */
export interface BrowserTypographyEvidence {
  schema: "shellx-motion/browser-typography@1";
  authority: "chromium";
  attestation: BrowserTypographyAttestation;
  fontProbe: "canvas-metric";
  scopes: BrowserTypographyScopeEvidence[];
  layers: BrowserTypographyLayerEvidence[];
  /** Present only for text-runs@1 layers; omitted to preserve legacy receipt bytes. */
  runs?: BrowserTypographyRunEvidence[];
  fontAssets: BrowserTypographyFontAssetEvidence[];
  fallbackLayerIds: string[];
}

export interface BrowserTypographyPreflightRefusal {
  code: "browser_html_typography_unverified" | "browser_motion_typography_unverified";
  message: string;
  detail: {
    attestation: "font-fallback";
    scope: BrowserTypographyScopeKind;
    layerIds: string[];
  };
}

export class BrowserTypographyAttestationError extends Error {
  readonly code: BrowserTypographyPreflightRefusal["code"];

  constructor(readonly refusal: BrowserTypographyPreflightRefusal) {
    super(refusal.message);
    this.name = "BrowserTypographyAttestationError";
    this.code = refusal.code;
    Object.setPrototypeOf(this, BrowserTypographyAttestationError.prototype);
  }
}

export function browserTypographyAttestationRefusal(
  pkg: MotionPackage
): BrowserTypographyPreflightRefusal | null {
  if (pkg.manifest.quality?.maxFontFallbacks === undefined) return null;
  const browserLayerIds = pkg.motion.layers
    .filter((layer) => layer.visible !== false && (layer.type === "web" || layer.type === "html" || layer.type === "canvas"))
    .map((layer) => layer.id);
  if (browserLayerIds.length > 0) {
    return {
      code: "browser_html_typography_unverified",
      message: "Browser HTML/web/canvas typography cannot satisfy maxFontFallbacks: arbitrary text, canvas text, host fonts, and fallback coverage are not attestable. Use manifest-bound MotionIR text for a font-fallback attestation.",
      detail: { attestation: "font-fallback", scope: "html-web-canvas", layerIds: browserLayerIds }
    };
  }

  const unverifiedLayerIds = pkg.motion.layers
    .filter((layer) => layer.visible !== false && (layer.type === "text" || layer.type === "caption"))
    .filter((layer) => layer.textRuns === undefined
      ? !hasManifestBoundFontFamily(pkg, fontFamilyFromStyle(layer.style, pkg))
      : !hasManifestBoundTextRuns(pkg, layer.textRuns))
    .map((layer) => layer.id);
  if (unverifiedLayerIds.length === 0) return null;
  return {
    code: "browser_motion_typography_unverified",
    message: "Generated MotionIR typography cannot satisfy maxFontFallbacks unless every requested font family is backed by a manifest-declared package font asset.",
    detail: { attestation: "font-fallback", scope: "motion-ir", layerIds: unverifiedLayerIds }
  };
}

export async function collectMotionTypographyEvidence(
  page: Page,
  fontReadiness: "ready" | "unsupported" | "timeout" | "error"
): Promise<BrowserTypographyEvidence> {
  const collected = await page.evaluate(() => {
    const genericFamilies = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);
    const primaryAvailable = (family: string | null, sample: string): boolean | null => {
      if (!family) return null;
      try {
        if (genericFamilies.has(family.toLowerCase())) return true;
        const context = document.createElement("canvas").getContext("2d");
        const safeFont = family.replace(/["\\\n\r]/g, "");
        return sample
          ? Boolean(context && safeFont && ["monospace", "sans-serif", "serif"].some((fallback) => {
              context.font = `72px ${fallback}`;
              const baseline = context.measureText(sample).width;
              context.font = `72px "${safeFont}", ${fallback}`;
              return Math.abs(context.measureText(sample).width - baseline) > 0.01;
            }))
          : null;
      } catch { return false; }
    };
    const layers = [...document.querySelectorAll<HTMLElement>("[data-motion-text='true']")].map((element) => {
      const computed = getComputedStyle(element);
      const requestedFontFamily = element.dataset.requestedFontFamily?.trim() || null;
      const primaryFont = requestedFontFamily
        ?.split(",", 1)[0]
        ?.trim()
        .replace(/^['"]|['"]$/g, "") || null;
      return {
        layerId: element.dataset.layerId ?? "",
        direction: computed.direction === "rtl" ? "rtl" as const : "ltr" as const,
        lang: element.getAttribute("lang"),
        requestedFontFamily,
        resolvedFontFamily: computed.fontFamily,
        primaryFontAvailable: primaryAvailable(primaryFont, (element.textContent ?? "").slice(0, 512)),
        fontProvenance: element.dataset.motionFontProvenance === "manifest-bound"
          ? "manifest-bound" as const
          : "unverified" as const
      };
    });
    return { layers };
  });
  const layers = collected.layers;
  const runs = await collectBrowserStyledTextRunEvidence(page);
  const seenLayerIds = new Set<string>();
  const uniqueLayers = layers.filter((layer) => {
    if (!layer.layerId) return true;
    if (seenLayerIds.has(layer.layerId)) return false;
    seenLayerIds.add(layer.layerId);
    return true;
  });
  const runsByLayer = new Map<string, BrowserTypographyRunEvidence[]>();
  for (const run of runs) {
    const current = runsByLayer.get(run.layerId) ?? [];
    current.push(run);
    runsByLayer.set(run.layerId, current);
  }
  const fallbackLayerIds = uniqueLayers.filter((layer) => {
    const styledRuns = runsByLayer.get(layer.layerId);
    return styledRuns
      ? styledRuns.some((run) => run.primaryFontAvailable === false)
      : layer.primaryFontAvailable === false;
  }).map((layer) => layer.layerId);
  const unverifiedLayerIds = uniqueLayers
    .filter((layer) => {
      const styledRuns = runsByLayer.get(layer.layerId);
      return styledRuns
        ? styledRuns.length === 0 || styledRuns.some((run) => run.fontProvenance !== "manifest-bound" || run.primaryFontAvailable !== true)
        : layer.fontProvenance !== "manifest-bound" || layer.primaryFontAvailable !== true;
    })
    .map((layer) => layer.layerId);
  const attestation: BrowserTypographyAttestation = uniqueLayers.length === 0
    ? "not_applicable"
    : fontReadiness === "ready" && unverifiedLayerIds.length === 0 && fallbackLayerIds.length === 0
      ? "verified"
      : "unverified";
  return {
    schema: "shellx-motion/browser-typography@1",
    authority: "chromium",
    attestation,
    fontProbe: "canvas-metric",
    scopes: uniqueLayers.length === 0
      ? []
      : [{
          kind: "motion-ir",
          attestation: attestation === "verified" ? "verified" : "unverified",
          layerIds: uniqueLayers.map((layer) => layer.layerId),
          ...(unverifiedLayerIds.length > 0 ? { reason: "requested_font_not_manifest_bound" as const } : {})
    }],
    layers: uniqueLayers,
    ...(runs.length > 0 ? { runs } : {}),
    fontAssets: [],
    fallbackLayerIds
  };
}

export function unverifiedHtmlTypographyEvidence(layerId: string): BrowserTypographyEvidence {
  return {
    schema: "shellx-motion/browser-typography@1",
    authority: "chromium",
    attestation: "unverified",
    fontProbe: "canvas-metric",
    scopes: [{
      kind: "html-web-canvas",
      attestation: "unverified",
      layerIds: [layerId],
      reason: "arbitrary_html_web_canvas_text_unobservable"
    }],
    layers: [],
    fontAssets: [],
    fallbackLayerIds: []
  };
}

/**
 * Attach byte identities only after the browser builder has regular-file-read and hashed the
 * package faces it embedded. The page probe alone cannot make that filesystem claim.
 */
export function bindManifestTypographyFontAssets(
  pkg: MotionPackage,
  evidence: BrowserTypographyEvidence,
  assetHashes: Readonly<Record<string, string>>
): BrowserTypographyEvidence {
  const verifiedFamilies = new Set(evidence.layers
    .filter((layer) => layer.fontProvenance === "manifest-bound")
    .map((layer) => primaryFamily(layer.requestedFontFamily)?.toLowerCase())
    .filter((family): family is string => Boolean(family)));
  const styled = bindStyledTextRunEvidence(pkg, evidence.runs ?? [], assetHashes);
  if (styled.problem) throw new BrowserTypographyAttestationError({ code: "browser_motion_typography_unverified", message: styled.problem.message, detail: { attestation: "font-fallback", scope: "motion-ir", layerIds: [styled.problem.layerId] } });
  for (const family of styled.families) verifiedFamilies.add(family);
  const fontAssets = pkg.motion.assets
    .map(readMotionFontAsset)
    .filter((asset): asset is MotionFontAsset => asset !== null && verifiedFamilies.has(asset.family.toLowerCase()))
    .flatMap((asset) => {
      const sha256 = assetHashes[asset.source.path];
      return typeof sha256 === "string" && /^[a-f0-9]{64}$/i.test(sha256)
        ? [{ id: asset.id, family: asset.family, sha256: sha256.toLowerCase() }]
        : [];
    })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return { ...evidence, fontAssets };
}

export function htmlTypographyWarning(): string {
  return "Browser HTML/web/canvas typography is unverified: font provenance and fallback coverage are not attestable.";
}

export function enforceTypographyAttestationPolicy(pkg: MotionPackage, evidence: BrowserTypographyEvidence): void {
  if (pkg.manifest.quality?.maxFontFallbacks === undefined || evidence.attestation === "verified" || evidence.attestation === "not_applicable") {
    return;
  }
  throw new BrowserTypographyAttestationError(browserTypographyAttestationRefusal(pkg) ?? {
    code: "browser_motion_typography_unverified",
    message: "Generated MotionIR typography did not produce manifest-bound font evidence required by maxFontFallbacks.",
    detail: {
      attestation: "font-fallback",
      scope: "motion-ir",
      layerIds: evidence.layers.map((layer) => layer.layerId)
    }
  });
}

export function motionFontProvenance(pkg: MotionPackage, requestedFontFamily: string | null): "manifest-bound" | "unverified" {
  return hasManifestBoundFontFamily(pkg, requestedFontFamily) ? "manifest-bound" : "unverified";
}

function hasManifestBoundFontFamily(pkg: MotionPackage, requestedFontFamily: string | null): boolean {
  const requested = primaryFamily(requestedFontFamily);
  if (!requested || isGenericFamily(requested)) return false;
  return pkg.motion.assets.some((asset) => {
    const font = readMotionFontAsset(asset);
    return font !== null
      && font.family.toLowerCase() === requested.toLowerCase()
      && pkg.manifest.assets.includes(font.source.path);
  });
}

function fontFamilyFromStyle(value: unknown, pkg: MotionPackage): string | null {
  if (!isRecord(value)) return null;
  const resolved = resolveTypographyToken(value.fontFamily, pkg);
  if (typeof resolved !== "string") return null;
  const trimmed = resolved.trim();
  return trimmed && !/[;{}<>]/.test(trimmed) && !/(?:url\s*\(|@import)/i.test(trimmed) ? trimmed : null;
}

function resolveTypographyToken(value: unknown, pkg: MotionPackage): unknown {
  if (typeof value !== "string") return value;
  const match = /^\{([^}]+)\}$/.exec(value.trim());
  if (!match) return value;
  let current: unknown = pkg.motion.designTokens;
  for (const key of match[1].split(".")) current = isRecord(current) ? current[key] : undefined;
  return current ?? value;
}

function primaryFamily(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",", 1)[0]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
  return first || null;
}

function isGenericFamily(value: string): boolean {
  return new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]).has(value.toLowerCase());
}

function readMotionFontAsset(value: unknown): MotionFontAsset | null {
  if (!isRecord(value) || value.type !== "font" || !isRecord(value.source)) return null;
  const mimeType = value.source.mimeType;
  if (
    typeof value.id !== "string"
    || typeof value.family !== "string"
    || typeof value.source.path !== "string"
    || (mimeType !== "font/woff2" && mimeType !== "font/woff" && mimeType !== "font/ttf" && mimeType !== "font/otf")
  ) {
    return null;
  }
  const weight = typeof value.weight === "number" ? value.weight : undefined;
  const style = value.style === "normal" || value.style === "italic" || value.style === "oblique"
    ? value.style
    : undefined;
  return {
    id: value.id,
    type: "font",
    family: value.family,
    source: { path: value.source.path, mimeType },
    ...(weight === undefined ? {} : { weight }),
    ...(style === undefined ? {} : { style })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
