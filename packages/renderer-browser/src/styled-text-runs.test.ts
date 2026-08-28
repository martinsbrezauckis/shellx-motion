import { describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { applyBrowserStyledTextRunStyles, renderBrowserStyledTextRuns } from "./styled-text-runs";
import { launchConfiguredTestBrowser } from "./test-support/configured-browser";
import { bindManifestTypographyFontAssets, browserTypographyAttestationRefusal } from "./typography-attestation";
import { collectBrowserStyledTextRunEvidence } from "./typography-styled-runs";

describe("Browser manifest-bound styled text runs", () => {
  it("emits escaped mixed-font spans with only asset-derived face evidence", () => {
    const html = renderBrowserStyledTextRuns({ textRuns: runs(), fontAssets: fonts(), assetHashes: new Map([["assets/regular.woff2", hash("a")], ["assets/bold.woff2", hash("b")]]), resolveColor: (value) => value });
    expect(html).toContain('data-motion-font-asset-id="brand-regular"');
    expect(html).toContain('data-motion-font-family="Brand Regular"');
    expect(html).toContain(`data-motion-font-sha256="${hash("a")}"`);
    expect(html).toContain('data-motion-font-weight="700"');
    expect(html).toContain('data-motion-run-letter-spacing-px="1.5"');
    expect(html).not.toMatch(/<span[^>]*\sstyle=/);
    expect(html).toContain("&lt;trusted&amp;text&gt;");
    expect(html).not.toContain("<trusted&text>");
    expect(() => renderBrowserStyledTextRuns({ textRuns: runs(), fontAssets: fonts(), assetHashes: new Map(), resolveColor: (value) => value })).toThrow("lacks the generated manifest-bound SHA-256");
  });

  it("binds every runtime run to exact package id, family, face, and immutable hash", () => {
    const pkg = packageFor();
    const evidence = {
      schema: "shellx-motion/browser-typography@1" as const, authority: "chromium" as const, attestation: "verified" as const, fontProbe: "canvas-metric" as const,
      scopes: [{ kind: "motion-ir" as const, attestation: "verified" as const, layerIds: ["title"] }],
      layers: [{ layerId: "title", direction: "ltr" as const, lang: null, requestedFontFamily: null, resolvedFontFamily: "Brand Regular", primaryFontAvailable: null, fontProvenance: "manifest-bound" as const }],
      runs: [
        { layerId: "title", index: 0, fontAssetId: "brand-regular", family: "Brand Regular", sha256: hash("a"), weight: 400, style: "normal" as const, primaryFontAvailable: true, fontProvenance: "manifest-bound" as const },
        { layerId: "title", index: 1, fontAssetId: "brand-bold", family: "Brand Bold", sha256: hash("b"), weight: 700, style: "normal" as const, primaryFontAvailable: true, fontProvenance: "manifest-bound" as const },
      ],
      fontAssets: [], fallbackLayerIds: [],
    };
    expect(bindManifestTypographyFontAssets(pkg, evidence, { "assets/regular.woff2": hash("a"), "assets/bold.woff2": hash("b") }).fontAssets).toEqual([
      { id: "brand-bold", family: "Brand Bold", sha256: hash("b") }, { id: "brand-regular", family: "Brand Regular", sha256: hash("a") },
    ]);
    expect(() => bindManifestTypographyFontAssets(pkg, { ...evidence, runs: [{ ...evidence.runs[0], sha256: hash("c") }] }, { "assets/regular.woff2": hash("a"), "assets/bold.woff2": hash("b") })).toThrow("runtime evidence does not match");
  });

  it("preflights mixed text runs as manifest-bound while rejecting a missing font asset", () => {
    expect(browserTypographyAttestationRefusal(packageFor())).toBeNull();
    const invalid = packageFor(); (invalid.motion.layers[0]!.textRuns!.runs[0] as { fontAssetId: string }).fontAssetId = "missing";
    expect(browserTypographyAttestationRefusal(invalid)).toMatchObject({ code: "browser_motion_typography_unverified", detail: { layerIds: ["title"] } });
  });

  it("installs the fixed source-mode serialization binding before applying run styles", async () => {
    const browser = await launchConfiguredTestBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent('<main><span data-motion-text-run="true" data-motion-font-family="Brand" data-motion-font-weight="400" data-motion-font-style="normal"></span></main>');
      await expect(page.evaluate("typeof globalThis.__name")).resolves.toBe("undefined");

      await applyBrowserStyledTextRunStyles(page);
      // Context reuse is intentional in Motion browser sessions. A fresh
      // document must retain the already-owned immutable runtime rather than
      // treating it as an untrusted foreign helper.
      await applyBrowserStyledTextRunStyles(page);

      // This is the exact TSX/esbuild source-mode shape that previously
      // failed in a real template-to-Cut connector process.
      await expect(page.evaluate('__name((value) => value, "sourceModeCallback")("ok")')).resolves.toBe("ok");
    } finally {
      await browser.close();
    }
  });

  it("parses quoted/backslashed manifest family data as one safe DOM span and attests its CSSOM face", async () => {
    const family = 'Brand "Quoted" \\ Slash';
    const html = renderBrowserStyledTextRuns({
      textRuns: { schema: "shellx-motion/text-runs@1", runs: [{ text: '<img src=x onerror="globalThis.injected=1">', fontAssetId: "quoted", fontSizePx: 32, letterSpacingPx: 1 }] },
      fontAssets: [{ id: "quoted", type: "font", family, source: { path: "assets/quoted.woff2", mimeType: "font/woff2" }, weight: 700, style: "italic" }],
      assetHashes: new Map([["assets/quoted.woff2", hash("c")]]), resolveColor: () => "#102030"
    });
    expect(html).toContain("&quot;Quoted&quot;");
    expect(html).not.toContain("font-family:");
    const browser = await launchConfiguredTestBrowser();
    try {
      const page = await browser.newPage();
      await page.setContent(`<main data-layer-id="title" data-motion-text="true">${html}</main>`);
      await applyBrowserStyledTextRunStyles(page);
      const parsed = await page.evaluate(() => {
        const run = document.querySelector<HTMLElement>("[data-motion-text-run='true']");
        return {
          spanCount: document.querySelectorAll("[data-motion-text-run='true']").length,
          imageCount: document.images.length,
          text: run?.textContent,
          family: getComputedStyle(run!).fontFamily,
          fontSize: getComputedStyle(run!).fontSize,
          letterSpacing: getComputedStyle(run!).letterSpacing,
          injected: (globalThis as Record<string, unknown>).injected ?? null,
        };
      });
      expect(parsed).toMatchObject({ spanCount: 1, imageCount: 0, text: '<img src=x onerror="globalThis.injected=1">', fontSize: "32px", letterSpacing: "1px", injected: null });
      expect(parsed.family).toContain("Brand");
      await expect(collectBrowserStyledTextRunEvidence(page)).resolves.toMatchObject([{ layerId: "title", fontAssetId: "quoted", family, sha256: hash("c"), weight: 700, style: "italic", fontProvenance: "manifest-bound" }]);
    } finally {
      await browser.close();
    }
  });
});

function runs() { return { schema: "shellx-motion/text-runs@1" as const, runs: [{ text: "<trusted&text>", fontAssetId: "brand-regular", color: "#ffffff", fontSizePx: 32 }, { text: " Bold", fontAssetId: "brand-bold", letterSpacingPx: 1.5 }] }; }
function fonts() { return [{ id: "brand-regular", type: "font" as const, family: "Brand Regular", source: { path: "assets/regular.woff2", mimeType: "font/woff2" as const }, weight: 400, style: "normal" as const }, { id: "brand-bold", type: "font" as const, family: "Brand Bold", source: { path: "assets/bold.woff2", mimeType: "font/woff2" as const }, weight: 700, style: "normal" as const }]; }
function packageFor(): MotionPackage { return { root: "/pkg", manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_text_runs", name: "Styled text", motion: "motion.json", assets: ["assets/regular.woff2", "assets/bold.woff2"], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] }, quality: { maxFontFallbacks: 0 } }, motion: { schema: "shellx-motion/motion@1", id: "motion_text_runs", name: "Styled text", durationMs: 1000, fps: 30, width: 100, height: 100, layers: [{ id: "title", type: "text", startMs: 0, durationMs: 1000, textRuns: runs(), style: { color: "#ffffff", fontSize: 24 } }], assets: fonts(), provenance: { sourceApp: "test", createdBy: "test" } } }; }
function hash(char: string): string { return char.repeat(64); }
