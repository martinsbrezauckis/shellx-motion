import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright-core";
import {
  canonicalJsonSha256,
  expandMotionPackageRows,
  parseMotionDataRows,
  readMotionDocument,
  readPackageManifest,
  readTemplateDocument,
  type MotionPackage
} from "@shellx-motion/core";
import { collectBrowserTextFitEvidence } from "./generated-text-fit";
import { buildGeneratedMotionHtml } from "./index";
import { applyBrowserStyledTextRunStyles, renderBrowserStyledTextRuns } from "./styled-text-runs";

const PRODUCT_METRIC_ROOT = fileURLToPath(new URL("../../../templates/shellx-product-pack/product-metric-card/", import.meta.url));

describe("generated Browser text-fit with styled text-runs", () => {
  it("keeps safe overflow truthful, auto-fits every run at one scale, and preserves the legacy no-run evidence golden", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 240, height: 120 } });
      await page.setContent(html("safe", true));
      await applyBrowserStyledTextRunStyles(page);
      await page.evaluate(async () => { await document.fonts.ready; });
      const safe = await collectBrowserTextFitEvidence(page, textPackage(), 0);
      expect(safe.layers[0]).toMatchObject({ layerId: "title", policy: "safe", status: "failed", textRuns: { scale: 1, runs: [{ inheritsLayerFontSize: false, requestedFontSizePx: 160, effectiveFontSizePx: 160 }, { inheritsLayerFontSize: true, requestedFontSizePx: null, effectiveFontSizePx: 64 }] } });

      await page.setContent(html("auto-fit", true));
      await applyBrowserStyledTextRunStyles(page);
      await page.evaluate(async () => { await document.fonts.ready; });
      const auto = await collectBrowserTextFitEvidence(page, textPackage(), 0);
      const layer = auto.layers[0];
      expect(layer).toMatchObject({ layerId: "title", policy: "auto-fit", status: "auto-fitted", textRuns: { scale: expect.any(Number) } });
      const textRuns = layer?.textRuns;
      if (!layer || !textRuns) throw new Error("expected text-runs text-fit evidence");
      expect(textRuns.scale).toBeGreaterThan(0);
      expect(textRuns.scale).toBeLessThan(1);
      expect(textRuns.runs[0]!.effectiveFontSizePx).toBeCloseTo(160 * textRuns.scale, 1);
      expect(textRuns.runs[1]!.effectiveFontSizePx).toBeCloseTo(layer.appliedFontSize, 1);
      expect(textRuns.runs[0]!.effectiveLetterSpacingPx).toBeCloseTo(4 * textRuns.scale, 1);

      await page.setContent(html("safe", false));
      const legacy = await collectBrowserTextFitEvidence(page, textPackage(), 0);
      expect(legacy.layers[0]).not.toHaveProperty("textRuns");
      expect(canonicalJsonSha256(legacy)).toBe("69e6505670946afa1671f30c934239d1a65e8677e136cd9eaa0cba0946a6bc02");
    } finally {
      await browser.close();
    }
  });

  it("keeps every data-generated Product Metric chart label inside its integer line box at the reported calibration frame", async () => {
    const base = productMetricPackage();
    const jobs = expandMotionPackageRows(base, productMetricRows());
    const browser = await chromium.launch({ headless: true });
    try {
      for (const job of jobs) {
        // Keep the probe output-free; inject the exact header face below so it exercises the
        // chart compiler's line-box geometry without invoking package file loading.
        const pkg: MotionPackage = { ...base, manifest: { ...base.manifest, assets: [] }, motion: { ...job.motion, assets: [] } };
        const page = await browser.newPage({ viewport: { width: pkg.motion.width, height: pkg.motion.height } });
        try {
          const generated = await buildGeneratedMotionHtml(pkg, 875);
          await page.setContent(generated.html.replace("</head>", `<style>${productMetricInterFontFace()}</style></head>`));
          await page.evaluate(async () => { await document.fonts.ready; });
          const evidence = await collectBrowserTextFitEvidence(page, pkg, 875);
          const chartLayers = evidence.layers.filter((layer) => layer.layerId.startsWith("chart_product_metric_"));

          expect(chartLayers.length, job.row.id).toBeGreaterThan(0);
          expect(chartLayers.filter((layer) => layer.status === "failed"), job.row.id).toEqual([]);
          expect(chartLayers.every((layer) => layer.internalOverflowPx.vertical === 0), job.row.id).toBe(true);
          if (job.row.id !== "canvas_export_lane") {
            expect(chartLayers.find((layer) => layer.layerId === "chart_product_metric_table_head_left"), job.row.id)
              .toMatchObject({ status: "passed", internalOverflowPx: { horizontal: 0, vertical: 0 } });
            expect(chartLayers.find((layer) => layer.layerId === "chart_product_metric_table_head_right"), job.row.id)
              .toMatchObject({ status: "passed", internalOverflowPx: { horizontal: 0, vertical: 0 } });
          }
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  });
});

function productMetricPackage(): MotionPackage {
  const json = (path: string) => JSON.parse(readFileSync(resolve(PRODUCT_METRIC_ROOT, path), "utf8"));
  return {
    root: PRODUCT_METRIC_ROOT,
    manifest: readPackageManifest(json("manifest.json")),
    motion: readMotionDocument(json("motion.json")),
    template: readTemplateDocument(json("template.json"))
  };
}

function productMetricRows() {
  return parseMotionDataRows(JSON.parse(readFileSync(resolve(PRODUCT_METRIC_ROOT, "data/product-metrics.batch.json"), "utf8")));
}

function productMetricInterFontFace(): string {
  const source = readFileSync(resolve(PRODUCT_METRIC_ROOT, "assets/fonts/inter-latin-600-normal.woff2")).toString("base64");
  return `@font-face{font-family:Inter;src:url(data:font/woff2;base64,${source}) format("woff2");font-style:normal;font-weight:600;font-display:block}`;
}

function html(policy: "safe" | "auto-fit", styled: boolean): string {
  const content = styled
    ? renderBrowserStyledTextRuns({
      textRuns: { schema: "shellx-motion/text-runs@1", runs: [
        { text: "WW", fontAssetId: "brand", fontSizePx: 160, letterSpacingPx: 4 },
        { text: "W", fontAssetId: "brand" }
      ] },
      fontAssets: [{ id: "brand", type: "font", family: "Brand", source: { path: "assets/brand.woff2", mimeType: "font/woff2" }, weight: 400, style: "normal" }],
      assetHashes: new Map([["assets/brand.woff2", "a".repeat(64)]]), resolveColor: () => "#ffffff"
    })
    : "OK";
  return `<!doctype html><style>${brandFontFace()}</style><main style="position:relative;width:240px;height:120px;overflow:hidden"><div data-layer-id="title" data-motion-text="true" data-text-fit-policy="${policy}" data-text-fit-safe-area="title"${policy === "auto-fit" ? " data-text-fit-min-font-size=\"24\"" : ""} style="position:absolute;left:20px;top:24px;width:200px;height:80px;display:flex;white-space:nowrap;overflow:hidden;font-size:64px;line-height:1"><span style="display:block;width:100%">${content}</span></div></main>`;
}

function brandFontFace(): string {
  const source = readFileSync(resolve(PRODUCT_METRIC_ROOT, "assets/fonts/inter-latin-600-normal.woff2")).toString("base64");
  return `@font-face{font-family:Brand;src:url(data:font/woff2;base64,${source}) format("woff2");font-style:normal;font-weight:400;font-display:block}`;
}

function textPackage(): MotionPackage {
  return {
    root: "/package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_text_fit", name: "Text fit", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion_text_fit", name: "Text fit", durationMs: 1_000, fps: 30, width: 240, height: 120, safeAreas: { title: { top: 16, right: 16, bottom: 16, left: 16 } }, layers: [], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }
  };
}
