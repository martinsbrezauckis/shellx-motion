import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluatePosterGate,
  evaluateTypographyGate,
  matchFontWeight,
  findInterpolatedTokenKeys,
  findTemplateTokens,
  findUnbackedTokenKeys,
  POSTER_MIN_EDGE_RATIO,
  PUBLIC_PRODUCT_TEMPLATE_DIRS,
  assertProductTemplateContract,
  expectedProductTemplateDirs,
  withheldProductTemplateDirs,
  resolveDataRowValue,
  selectProductTemplateDirectories
} from "./template-product-pack-catalog";

describe("product template proof selection", () => {
  it("keeps the public catalog sorted and unique, and disjoint from the withheld set", () => {
    expect([...PUBLIC_PRODUCT_TEMPLATE_DIRS].sort()).toEqual([...PUBLIC_PRODUCT_TEMPLATE_DIRS]);
    expect(new Set(PUBLIC_PRODUCT_TEMPLATE_DIRS).size).toBe(PUBLIC_PRODUCT_TEMPLATE_DIRS.length);
    // A family cannot both ship and be withheld.
    const overlap = withheldProductTemplateDirs().filter((dir) => PUBLIC_PRODUCT_TEMPLATE_DIRS.includes(dir as never));
    expect(overlap).toEqual([]);
  });

  it("expects public-only in the published tree and public+withheld in the implementation tree", () => {
    const withheld = withheldProductTemplateDirs();
    const implementationManifestPresent = existsSync(resolve("scripts/public-export-manifest.json"));
    expect(withheld).toEqual(implementationManifestPresent
      ? ["data-report-brief", "lower-third-modern", "tutorial-overlay"]
      : []);
    // Published tree: the withheld directories are simply not there.
    expect(expectedProductTemplateDirs([...PUBLIC_PRODUCT_TEMPLATE_DIRS])).toEqual([...PUBLIC_PRODUCT_TEMPLATE_DIRS].sort());
    // Implementation tree: they are, and are expected.
    expect(expectedProductTemplateDirs([...PUBLIC_PRODUCT_TEMPLATE_DIRS, ...withheld]))
      .toEqual([...PUBLIC_PRODUCT_TEMPLATE_DIRS, ...withheld].sort());
  });

  it("fails when a public family stops shipping or an unannounced family appears", () => {
    // Both directions, because a one-directional check is what let 12-vs-15 drift go unnoticed.
    expect(() => assertProductTemplateContract([...PUBLIC_PRODUCT_TEMPLATE_DIRS])).not.toThrow();
    expect(() => assertProductTemplateContract(PUBLIC_PRODUCT_TEMPLATE_DIRS.slice(1)))
      .toThrow(/missing from disk/);
    expect(() => assertProductTemplateContract([...PUBLIC_PRODUCT_TEMPLATE_DIRS, "surprise-family"]))
      .toThrow(/neither in the public contract nor withheld/);
  });

  it("renders the whole catalog by default and a deduplicated targeted subset on demand", () => {
    const catalog = [...PUBLIC_PRODUCT_TEMPLATE_DIRS];
    expect(selectProductTemplateDirectories(catalog, undefined)).toEqual(catalog);
    expect(selectProductTemplateDirectories(catalog, "tracked-callout-overlay, cinematic-fog-title,tracked-callout-overlay")).toEqual([
      "cinematic-fog-title",
      "tracked-callout-overlay"
    ]);
  });

  it("rejects empty and unknown targeted selections", () => {
    const catalog = [...PUBLIC_PRODUCT_TEMPLATE_DIRS];
    expect(() => selectProductTemplateDirectories(catalog, " , ")).toThrow("--only must name at least one");
    expect(() => selectProductTemplateDirectories(catalog, "missing-template")).toThrow("unknown product-pack template missing-template");
  });
});

describe("instantiation gate predicates", () => {
  it("finds residual mustache placeholders anywhere in a document", () => {
    const motion = {
      name: "Card {{surfaceLabel}}",
      background: "{{theme.background}}",
      layers: [
        { id: "title", text: "{{title}}", transform: { x: "{{layout.safeX}}" } },
        { id: "static", text: "Channel coverage" }
      ]
    };
    expect(findTemplateTokens(motion)).toEqual([
      "{{layout.safeX}}",
      "{{surfaceLabel}}",
      "{{theme.background}}",
      "{{title}}"
    ]);
  });

  it("reports a fully instantiated document as token-free", () => {
    expect(findTemplateTokens({ layers: [{ id: "title", text: "Creative output is up across every channel" }] })).toEqual([]);
  });

  it("still catches a malformed token that the interpolator would leave in place", () => {
    // The interpolator only substitutes /\{\{[A-Za-z0-9_.-]+\}\}/, so this survives expansion and
    // would be painted on screen verbatim.
    expect(findTemplateTokens({ text: "{{not a key}}" })).toEqual(["{{not a key}}"]);
    expect(findInterpolatedTokenKeys({ text: "{{not a key}}" })).toEqual([]);
  });

  it("extracts the row keys a document depends on", () => {
    expect(findInterpolatedTokenKeys({ a: "{{ metricValue }}", b: "{{layout.titleY}}", c: "{{layout.titleY}}" })).toEqual([
      "layout.titleY",
      "metricValue"
    ]);
  });

  it("resolves row values by own key, dotted path, and flattened CSV key", () => {
    const row = { metricValue: "18 real outputs", layout: { titleY: 188 }, "theme.accent": "#24d6ff" };
    expect(resolveDataRowValue(row, "metricValue")).toBe("18 real outputs");
    expect(resolveDataRowValue(row, "layout.titleY")).toBe(188);
    expect(resolveDataRowValue(row, "theme.accent")).toBe("#24d6ff");
    expect(resolveDataRowValue(row, "layout.missing")).toBeUndefined();
    expect(resolveDataRowValue(row, "metricValue.nested")).toBeUndefined();
  });

  it("flags tokens a row cannot back, because those expand to empty content instead of failing", () => {
    const row = { title: "Creative output is up across every channel", layout: { safeX: 140 } };
    expect(findUnbackedTokenKeys(["title", "layout.safeX"], row)).toEqual([]);
    expect(findUnbackedTokenKeys(["title", "progressWidth", "theme.accent"], row)).toEqual(["progressWidth", "theme.accent"]);
  });

  it("treats an explicit null row value as backed", () => {
    expect(findUnbackedTokenKeys(["subtitle"], { subtitle: null })).toEqual([]);
  });
});

describe("poster gate", () => {
  const realRender = { width: 1920, height: 1080, blank: false, edgeRatio: 0.02147 };

  it("accepts a real instantiated render at the template's own size", () => {
    expect(evaluatePosterGate(realRender, 1920, 1080)).toEqual({ ok: true });
  });

  it("rejects a poster whose size does not match the template output", () => {
    expect(evaluatePosterGate(realRender, 1080, 1080)).toMatchObject({ ok: false, code: "preview_poster_dimension_mismatch" });
  });

  it("rejects the blank poster captured from an un-instantiated document", () => {
    // Measured from the shipped pre-fix product-metric-card poster.
    expect(evaluatePosterGate({ width: 1920, height: 1080, blank: true, edgeRatio: 0.0018 }, 1920, 1080)).toMatchObject({
      ok: false,
      code: "preview_poster_not_a_real_render"
    });
  });

  it("keeps the sparsest legitimate overlay poster above the ink floor", () => {
    // Measured from the shipped lower-third-modern poster, the sparsest real render in the pack.
    expect(0.00524).toBeGreaterThan(POSTER_MIN_EDGE_RATIO);
    expect(evaluatePosterGate({ width: 1920, height: 1080, blank: false, edgeRatio: 0.00524 }, 1920, 1080)).toEqual({ ok: true });
  });
});

describe("font weight matching", () => {
  const ladder = [100, 200, 300, 400, 500, 600, 700, 800, 900];

  it("implements the CSS Fonts 4 weight rules against a complete ladder", () => {
    expect(matchFontWeight(400, ladder)).toBe(400);
    expect(matchFontWeight(500, ladder)).toBe(500);
    // 400-500 window: search up to 500 first, then downward.
    expect(matchFontWeight(450, [400, 700])).toBe(400);
    expect(matchFontWeight(450, [500, 700])).toBe(500);
    // Above 500: nearest at-or-above wins, otherwise the heaviest below.
    expect(matchFontWeight(850, [700, 900])).toBe(900);
    expect(matchFontWeight(850, [600, 700])).toBe(700);
    // Below 400: nearest at-or-below wins, otherwise the lightest above.
    expect(matchFontWeight(200, [300, 400])).toBe(300);
    expect(matchFontWeight(200, [100, 400])).toBe(100);
  });
});

describe("typography gate", () => {
  const interFace = (weight: number) => ({
    id: `font_inter_${weight}`,
    type: "font",
    family: "Inter",
    source: { path: `assets/fonts/inter-latin-${weight}-normal.woff2`, mimeType: "font/woff2" },
    weight,
    style: "normal"
  });
  const textLayer = (id: string, fontFamily: string, fontWeight: number) => ({
    id,
    type: "text",
    text: "ShellX",
    style: { fontFamily, fontWeight }
  });

  it("accepts a family that bundles the weights its layers select", () => {
    expect(evaluateTypographyGate({
      motion: {
        layers: [textLayer("title", "Inter, Arial, Helvetica, sans-serif", 900), textLayer("body", "Inter, Arial, Helvetica, sans-serif", 700)],
        assets: [interFace(700), interFace(900)]
      },
      manifestAssets: ["assets/fonts/inter-latin-700-normal.woff2", "assets/fonts/inter-latin-900-normal.woff2"]
    })).toEqual({ ok: true, bundledFamilies: ["Inter"], hostGenericOnlyLayers: 0 });
  });

  it("allows the deliberate host-generic choice and counts it separately", () => {
    expect(evaluateTypographyGate({
      motion: { layers: [textLayer("title", "sans-serif", 820)], assets: [] },
      manifestAssets: []
    })).toEqual({ ok: true, bundledFamilies: [], hostGenericOnlyLayers: 1 });
  });

  it("rejects the bare-Inter stack that shipped a geometric sans as a browser-default serif", () => {
    expect(evaluateTypographyGate({
      motion: { layers: [textLayer("title", "Inter", 900)], assets: [interFace(900)] },
      manifestAssets: ["assets/fonts/inter-latin-900-normal.woff2"]
    })).toMatchObject({ ok: false, code: "font_stack_missing_generic_fallback" });
  });

  it("rejects a named family the package does not carry", () => {
    expect(evaluateTypographyGate({
      motion: { layers: [textLayer("title", "Inter, Arial, Helvetica, sans-serif", 900)], assets: [] },
      manifestAssets: []
    })).toMatchObject({ ok: false, code: "font_family_not_bundled" });
  });

  it("rejects a font bound in motion.assets but missing from manifest.assets", () => {
    expect(evaluateTypographyGate({
      motion: { layers: [textLayer("title", "Inter, Arial, Helvetica, sans-serif", 900)], assets: [interFace(900)] },
      manifestAssets: []
    })).toMatchObject({ ok: false, code: "font_asset_not_in_manifest" });
  });

  it("rejects a trimmed bundle that silently restyles a layer", () => {
    // 700 is present but 900 is not: a complete family would give this layer Black, the bundle
    // gives it Bold.
    expect(evaluateTypographyGate({
      motion: { layers: [textLayer("title", "Inter, Arial, Helvetica, sans-serif", 850)], assets: [interFace(700)] },
      manifestAssets: ["assets/fonts/inter-latin-700-normal.woff2"]
    })).toMatchObject({ ok: false, code: "font_weight_selects_wrong_face" });
  });

  it("checks text layers nested inside procedural groups, not just top-level layers", () => {
    expect(evaluateTypographyGate({
      motion: {
        layers: [{ id: "group", type: "group", children: [textLayer("nested", "Inter", 700)] }],
        assets: [interFace(700)]
      },
      manifestAssets: ["assets/fonts/inter-latin-700-normal.woff2"]
    })).toMatchObject({ ok: false, code: "font_stack_missing_generic_fallback" });
  });
});
