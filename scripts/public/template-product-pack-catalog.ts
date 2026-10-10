/**
 * Promoted product-pack catalog + the pure gate predicates the proof lane runs against it.
 *
 * Role: single source of truth for which template families are promoted, plus the side-effect-free
 * helpers behind `scripts/public/template-product-pack-proof.ts` gates. They live here (rather than inside
 * the proof script, which is a top-level-await entrypoint and executes on import) so they can be
 * unit-tested directly in `scripts/public/template-product-pack-catalog.test.ts`.
 *
 * Primary callers: `scripts/public/template-product-pack-proof.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";



/**
 * The template families the product pack ships. Keep this roster explicit so
 * an unexpected directory cannot silently change the published contract.
 */
export const PUBLIC_PRODUCT_TEMPLATE_DIRS = Object.freeze(JSON.parse(readFileSync(new URL("./public-template-roster.json", import.meta.url), "utf8")) as string[]);

/** The shipped product families, independent of local maintainer templates. */
export function expectedProductTemplateDirs(_onDisk: readonly string[]): string[] {
  return [...PUBLIC_PRODUCT_TEMPLATE_DIRS].sort();
}

/** All promised product families must exist in the available source tree. */
export function assertProductTemplateContract(onDisk: readonly string[]): void {
  const present = new Set(onDisk);
  const missing = PUBLIC_PRODUCT_TEMPLATE_DIRS.filter((dir) => !present.has(dir));
  assert.deepEqual(missing, [], `public product-pack families missing from disk: ${missing.join(", ")}`);
}

/**
 * Matches any residual mustache placeholder, including malformed ones. Deliberately broader than
 * the interpolator grammar in `packages/core/src/data.ts` so a typo'd token — which the
 * interpolator leaves in place verbatim — is still caught.
 */
const TEMPLATE_TOKEN_PATTERN = /\{\{[^{}]*\}\}/g;

/**
 * The exact grammar `packages/core/src/data.ts` substitutes. A token matching this is replaced by
 * the row value — or, when the row has no such key, by an EMPTY STRING. That silent-empty path is
 * why scanning for surviving `{{...}}` text is not sufficient on its own.
 */
const INTERPOLATED_TOKEN_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * Poster ink floor. Calibrated  across the 15 shipped posters: the sparsest real render
 * measured a 0.00524 edge ratio (`lower-third-modern`, a deliberately minimal overlay) and the
 * poster captured from the un-instantiated `product-metric-card` measured 0.00180. This threshold
 * sits between them with ~1.7x headroom on both sides.
 */
export const POSTER_MIN_EDGE_RATIO = 0.003;

export interface PosterMeasurement {
  width: number;
  height: number;
  blank: boolean;
  edgeRatio: number;
}

export type PosterGateVerdict =
  | { ok: true }
  | { ok: false; code: "preview_poster_dimension_mismatch" | "preview_poster_not_a_real_render"; reason: string };

export function selectProductTemplateDirectories(packageDirs: string[], onlyValue: string | undefined): string[] {
  if (onlyValue === undefined) return packageDirs;
  const selected = [...new Set(onlyValue.split(",").map((value) => value.trim()).filter(Boolean))].sort();
  assert(selected.length > 0, "--only must name at least one comma-separated template directory");
  for (const packageDir of selected) {
    assert(packageDirs.includes(packageDir), `--only names unknown product-pack template ${packageDir}`);
  }
  return selected;
}

/**
 * Unique, sorted list of `{{...}}` placeholders anywhere inside a JSON value.
 *
 * @param value any JSON-serializable document (motion document, manifest, template sidecar).
 * @returns the literal token strings, e.g. `["{{cta}}", "{{metricValue}}"]`.
 */
export function findTemplateTokens(value: unknown): string[] {
  return [...new Set(JSON.stringify(value ?? null).match(TEMPLATE_TOKEN_PATTERN) ?? [])].sort();
}

/**
 * Unique, sorted list of the data-row keys a document's interpolatable tokens depend on.
 *
 * @param value any JSON-serializable document.
 * @returns key names without braces, e.g. `["layout.titleY", "metricValue"]`.
 */
export function findInterpolatedTokenKeys(value: unknown): string[] {
  const keys = new Set<string>();
  for (const match of JSON.stringify(value ?? null).matchAll(INTERPOLATED_TOKEN_PATTERN)) keys.add(match[1]);
  return [...keys].sort();
}

/**
 * Mirrors the row lookup in `packages/core/src/data.ts`: own property first (which also covers the
 * flattened `"a.b.c"` key form used by CSV row sources), then dotted traversal.
 *
 * @returns the resolved value, or `undefined` when the row cannot back the key at all.
 */
export function resolveDataRowValue(rowValues: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(rowValues, key)) return rowValues[key];
  let current: unknown = rowValues;
  for (const segment of key.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return undefined;
    current = record[segment];
  }
  return current;
}

/**
 * Token keys a row cannot back. Each one expands to an empty string at render time, leaving a
 * token-free document with a blanked layer — the same shipped defect as a visible `{{token}}`,
 * only harder to see.
 */
export function findUnbackedTokenKeys(tokenKeys: string[], rowValues: Record<string, unknown>): string[] {
  return tokenKeys.filter((key) => resolveDataRowValue(rowValues, key) === undefined);
}

/**
 * Pure poster verdict: the shipped catalog poster must match the template's own output size and be
 * a real render rather than an empty frame.
 *
 * @param measurement dimensions plus `inspectPngFile` blank/edge statistics.
 * @param width expected output width of the instantiated template.
 * @param height expected output height of the instantiated template.
 */
export function evaluatePosterGate(measurement: PosterMeasurement, width: number, height: number): PosterGateVerdict {
  if (measurement.width !== width || measurement.height !== height) {
    return {
      ok: false,
      code: "preview_poster_dimension_mismatch",
      reason: `poster is ${measurement.width}x${measurement.height} but the template renders ${width}x${height}`
    };
  }
  if (measurement.blank || measurement.edgeRatio < POSTER_MIN_EDGE_RATIO) {
    return {
      ok: false,
      code: "preview_poster_not_a_real_render",
      reason: `poster is blank or near-empty (blank=${measurement.blank}, edgeRatio=${measurement.edgeRatio.toFixed(5)}, ` +
        `min ${POSTER_MIN_EDGE_RATIO})`
    };
  }
  return { ok: true };
}

/**
 * CSS generic font families. A stack that ends in one of these always has a defined last resort;
 * a stack that does not falls through to the browser's *default* font, which in Chromium is a
 * serif — that is how ten pack families shipped a geometric-sans design painted in Times.
 */
const CSS_GENERIC_FONT_FAMILIES: ReadonlySet<string> = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong"
]);

/**
 * Weight ladder a complete static font family exposes. The typography gate requires the weights a
 * package bundles to select the SAME face, for every weight its layers declare, as this complete
 * ladder would — so trimming the bundle to the faces a family actually needs can never silently
 * change which face a layer gets.
 */
const REFERENCE_WEIGHT_LADDER = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/** Renderer default when a text layer declares no `style.fontWeight`. */
const DEFAULT_TEXT_FONT_WEIGHT = 500;

export interface TypographyGateInput {
  /** The motion document that will actually be rendered (row-expanded, for data families). */
  motion: unknown;
  /** `manifest.assets` of the same package. */
  manifestAssets: readonly string[];
}

export type TypographyGateVerdict =
  | { ok: true; bundledFamilies: string[]; hostGenericOnlyLayers: number }
  | {
      ok: false;
      code:
        | "font_stack_missing_generic_fallback"
        | "font_family_not_bundled"
        | "font_asset_not_in_manifest"
        | "font_weight_selects_wrong_face";
      reason: string;
    };

interface PackagedFontFace {
  family: string;
  weight: number;
  path: string;
}

interface DeclaredTextStyle {
  layerId: string;
  fontFamily: string;
  fontWeight: number;
}

/**
 * CSS Fonts 4 §5.2 font-weight matching, restricted to the weights a family actually provides.
 *
 * @param desired the weight the layer asks for.
 * @param available the weights the family provides; must be non-empty.
 * @returns the weight CSS would select.
 */
export function matchFontWeight(desired: number, available: readonly number[]): number {
  const ascending = [...new Set(available)].sort((left, right) => left - right);
  const descending = [...ascending].reverse();
  if (ascending.length === 0) throw new Error("matchFontWeight requires at least one available weight");
  if (desired >= 400 && desired <= 500) {
    return ascending.find((weight) => weight >= desired && weight <= 500)
      ?? descending.find((weight) => weight < desired)
      ?? ascending.find((weight) => weight > 500)!;
  }
  if (desired < 400) {
    return descending.find((weight) => weight <= desired) ?? ascending.find((weight) => weight > desired)!;
  }
  return ascending.find((weight) => weight >= desired) ?? descending.find((weight) => weight < desired)!;
}

/**
 * Typography gate: a shipped family must render the same typeface everywhere.
 *
 * Three fail-closed rules:
 *   1. every declared `fontFamily` stack ends in a CSS generic, so the worst case is a sans face
 *      rather than the browser's default serif;
 *   2. every non-generic family named by a text layer is bundled in the package (declared both as
 *      a `type: "font"` record in `motion.assets` and as a file in `manifest.assets`);
 *   3. the bundled weights select, for every weight the layers declare, the same face a complete
 *      100-900 static family would — so a trimmed bundle cannot silently restyle a layer.
 *
 * A layer that names only a CSS generic is allowed and counted separately: that is the explicit
 * "use the host's own UI type" choice, the one case where output is host-dependent by design.
 */
export function evaluateTypographyGate(input: TypographyGateInput): TypographyGateVerdict {
  const motion = asRecord(input.motion);
  const faces = readPackagedFontFaces(motion);
  const styles = readDeclaredTextStyles(motion);
  const manifestAssets = new Set(input.manifestAssets);
  const bundledFamilies = new Set<string>();
  let hostGenericOnlyLayers = 0;

  for (const style of styles) {
    const parts = style.fontFamily.split(",").map((part) => part.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    if (parts.length === 0) continue;
    const last = parts[parts.length - 1].toLowerCase();
    if (!CSS_GENERIC_FONT_FAMILIES.has(last)) {
      return {
        ok: false,
        code: "font_stack_missing_generic_fallback",
        reason: `text layer ${style.layerId} declares "${style.fontFamily}", which does not end in a CSS generic ` +
          `family. Without a generic terminator the host falls through to the browser default font — a serif in ` +
          `Chromium. Declare e.g. "${parts[0]}, Arial, Helvetica, sans-serif".`
      };
    }
    const named = parts.filter((part) => !CSS_GENERIC_FONT_FAMILIES.has(part.toLowerCase()));
    if (named.length === 0) {
      hostGenericOnlyLayers += 1;
      continue;
    }
    // Only the FIRST named family can win; later named entries are host-dependent fallbacks that
    // must never be reached, so the primary family is the one that has to be bundled.
    const primary = named[0];
    const familyFaces = faces.filter((face) => face.family.toLowerCase() === primary.toLowerCase());
    if (familyFaces.length === 0) {
      bundledFamilies.delete(primary);
      return {
        ok: false,
        code: "font_family_not_bundled",
        reason: `text layer ${style.layerId} renders in "${primary}" but the package bundles no font asset for that ` +
          `family. A template that depends on a host-installed font does not render the same on another machine.`
      };
    }
    for (const face of familyFaces) {
      if (!manifestAssets.has(face.path)) {
        return {
          ok: false,
          code: "font_asset_not_in_manifest",
          reason: `font asset ${face.path} is bound in motion.assets but is not declared in manifest.assets, so the ` +
            `browser lane refuses to embed it.`
        };
      }
    }
    const bundledWeights = familyFaces.map((face) => face.weight);
    const selected = matchFontWeight(style.fontWeight, bundledWeights);
    const reference = matchFontWeight(style.fontWeight, REFERENCE_WEIGHT_LADDER);
    if (selected !== reference) {
      return {
        ok: false,
        code: "font_weight_selects_wrong_face",
        reason: `text layer ${style.layerId} declares fontWeight ${style.fontWeight}; the bundled ` +
          `${primary} weights [${[...new Set(bundledWeights)].sort((a, b) => a - b).join(", ")}] select ${selected}, ` +
          `but a complete 100-900 family would select ${reference}. Bundle inter-latin-${reference}-normal.woff2 ` +
          `(or the equivalent face) so the trimmed bundle cannot restyle the layer.`
      };
    }
    bundledFamilies.add(primary);
  }

  return { ok: true, bundledFamilies: [...bundledFamilies].sort(), hostGenericOnlyLayers };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** `motion.assets` entries of `type: "font"`, in declaration order. */
function readPackagedFontFaces(motion: Record<string, unknown>): PackagedFontFace[] {
  const assets = Array.isArray(motion.assets) ? motion.assets : [];
  const faces: PackagedFontFace[] = [];
  for (const entry of assets) {
    const record = asRecord(entry);
    if (record.type !== "font") continue;
    const family = typeof record.family === "string" ? record.family : "";
    const source = asRecord(record.source);
    const path = typeof source.path === "string" ? source.path : "";
    const weight = typeof record.weight === "number" ? record.weight : 400;
    if (family && path) faces.push({ family, weight, path });
  }
  return faces;
}

/** Every text layer's effective family + weight, including layers nested under procedural groups. */
function readDeclaredTextStyles(motion: Record<string, unknown>): DeclaredTextStyle[] {
  const styles: DeclaredTextStyle[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const record = asRecord(node);
    if (Object.keys(record).length === 0) return;
    if (record.type === "text") {
      const style = asRecord(record.style);
      const fontFamily = typeof style.fontFamily === "string" ? style.fontFamily : "";
      if (fontFamily.trim()) {
        styles.push({
          layerId: typeof record.id === "string" ? record.id : "<unknown>",
          fontFamily,
          fontWeight: typeof style.fontWeight === "number" ? style.fontWeight : DEFAULT_TEXT_FONT_WEIGHT
        });
      }
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(motion.layers);
  return styles;
}
