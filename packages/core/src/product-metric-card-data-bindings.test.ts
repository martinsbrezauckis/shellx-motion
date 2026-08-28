import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  effectiveLayerAtMs,
  expandMotionPackageRows,
  parseMotionDataRows,
  readMotionDocument,
  readPackageManifest,
  readTemplateDocument,
  validateMotionDocumentInStages,
  type MotionDocument,
  type MotionLayer,
  type MotionPackage
} from "./index";

const ROOT = fileURLToPath(new URL("../../../templates/shellx-product-pack/product-metric-card/", import.meta.url));
const PORTABLE_CHART_FONT_STACK = "Inter, Arial, Helvetica, sans-serif";

describe("chart-composition batch recipes", () => {
  it("materializes deterministic, data-driven FHD and square documents through the regular batch route", async () => {
    const pkg = productMetricPackage();
    const rows = productMetricRows();
    const jobs = expandMotionPackageRows(pkg, rows);
    const repeat = expandMotionPackageRows(pkg, rows);
    const first = job(jobs, "motion_renderer_lane").motion;
    const cut = job(jobs, "cut_generate_lane").motion;
    const square = job(jobs, "canvas_export_lane").motion;

    expect(repeat.map((entry) => entry.motion)).toEqual(jobs.map((entry) => entry.motion));
    expect(first.layers.find((layer) => layer.id === "trend-bar-01")).toBeUndefined();
    expect(first.layers.find((layer) => layer.id === "metric-value")).toBeUndefined();
    expect(layer(first, "chart_product_metric_metric_value")).toMatchObject({ text: "1,200" });
    expect(layer(cut, "chart_product_metric_metric_value")).toMatchObject({ text: "320 min" });
    expect(layer(first, "rail-title")).toMatchObject({ text: "Delivery coverage" });
    expect(layer(cut, "rail-title")).toMatchObject({ text: "Campaign delivery" });

    const firstBar = layer(first, "chart_product_metric_table_row_0_bar");
    const cutBar = layer(cut, "chart_product_metric_table_row_0_bar");
    expect(firstBar.width).toBe(93);
    expect(cutBar.width).toBe(107);
    expect(firstBar.keyframes?.["transform.width"]?.map((frame) => frame.value)).toEqual([0, 93]);
    expect(cutBar.keyframes?.["transform.width"]?.map((frame) => frame.value)).toEqual([0, 107]);
    expect(effectiveLayerAtMs(firstBar, firstBar.keyframes?.["transform.width"]?.[0]?.atMs ?? 0).transform?.width).toBe(0);
    expect(effectiveLayerAtMs(firstBar, firstBar.keyframes?.["transform.width"]?.[1]?.atMs ?? 0).transform?.width).toBe(93);

    expect(square).toMatchObject({ width: 1080, height: 1080, durationMs: 6000 });
    expect(square.layers.find((entry) => entry.id === "trend-bar-01")).toBeUndefined();
    expect(layer(square, "chart_product_metric_metric_value")).toMatchObject({ text: "553" });
    expect(layer(square, "chart_product_metric_comparison_published_current").keyframes?.["transform.width"]?.[1]?.value).toBe(504);
    expect(new Set(jobs.map((entry) => JSON.stringify(entry.motion.layers))).size).toBe(3);

    for (const motion of [first, cut, square]) {
      assertGeneratedTypographyFits(motion);
      await expect(validateMotionDocumentInStages(motion)).resolves.toMatchObject({ ok: true });
    }
  });

  it("refuses malformed chart data before it can produce a document", async () => {
    const pkg = productMetricPackage();
    const [source] = productMetricRows();
    const invalid = JSON.parse(JSON.stringify(source.values)) as Record<string, unknown>;
    const block = invalid.chartComposition as { charts: Array<{ table?: { rows: Array<{ barValue: number }> } }> };
    block.charts[1]!.table!.rows[0]!.barValue = 1.01;

    expect(() => expandMotionPackageRows(pkg, parseMotionDataRows({ rows: [invalid] })))
      .toThrow(/motion_renderer_lane.*chartComposition\.charts\[1\]\.table\.rows\[0\]\.barValue.*0\.\.1/i);
  });

  it("applies the same declarative recipe to a second package without Product Metric Card ids", async () => {
    const pkg = syntheticPackage();
    const rows = parseMotionDataRows({ rows: [syntheticRecipeRow()] });
    const [job] = expandMotionPackageRows(pkg, rows);
    const repeated = expandMotionPackageRows(pkg, rows);

    expect(job?.manifest.id).toBe("pkg_generic_chart_report_second_family_report");
    expect(job?.motion.layers.map((entry) => entry.id)).not.toContain("legacy-chart-panel");
    expect(job?.motion.layers.map((entry) => entry.id).join(" ")).not.toContain("product_metric");
    expect(layer(job!.motion, "chart_weekly_timeline_progress").keyframes?.["transform.width"])
      .toEqual([{ atMs: 140, value: 0, easing: "linear" }, { atMs: 500, value: 526, easing: "linear" }]);
    expect(layer(job!.motion, "report-heading")).toMatchObject({ text: "Weekly release timeline", style: { color: "#22cc88" } });
    expect(layer(job!.motion, "chart_weekly_timeline_step_0_label").textFit)
      .toMatchObject({ policy: "auto-fit", safeAreaId: "content", minFontSize: 22 });
    expect(layer(job!.motion, "chart_weekly_timeline_step_0_label").style)
      .toMatchObject({ fontSize: 22, lineHeight: 1.12, height: 50 });
    expect(repeated.map((entry) => entry.motion)).toEqual([job!.motion]);
    await expect(validateMotionDocumentInStages(job!.motion)).resolves.toMatchObject({ ok: true });
  });

  it("fails closed for unknown keys, layer paths, bounds, and chart text", () => {
    const pkg = syntheticPackage();
    const unknownKey = syntheticRecipeRow();
    (unknownKey.chartComposition as Record<string, unknown>).unreviewed = true;
    expect(() => expandMotionPackageRows(pkg, parseMotionDataRows({ rows: [unknownKey] })))
      .toThrow(/chartComposition has unsupported key/i);

    const malformedPath = syntheticRecipeRow();
    (malformedPath.chartComposition as { replaceLayerIds: string[] }).replaceLayerIds[0] = "../legacy-chart-panel";
    expect(() => expandMotionPackageRows(pkg, parseMotionDataRows({ rows: [malformedPath] })))
      .toThrow(/replaceLayerIds\[0\].*lowercase layer identifier/i);

    const outOfBounds = syntheticRecipeRow();
    const bounds = (outOfBounds.chartComposition as { charts: Array<{ bounds: { x: number; width: number } }> }).charts[0]!.bounds;
    bounds.x = 1000;
    bounds.width = 400;
    expect(() => expandMotionPackageRows(pkg, parseMotionDataRows({ rows: [outOfBounds] })))
      .toThrow(/weekly_timeline exceeds document bounds/i);

    const oversizedText = syntheticRecipeRow();
    const steps = (oversizedText.chartComposition as { charts: Array<{ timeline: { steps: Array<{ label: string }> } }> }).charts[0]!.timeline.steps;
    steps[0]!.label = "A chart label that exceeds twenty-eight";
    expect(() => expandMotionPackageRows(pkg, parseMotionDataRows({ rows: [oversizedText] })))
      .toThrow(/timeline\.steps\[0\]\.label.*at most 28 characters/i);
  });
});

function job<T extends { row: { id: string } }>(jobs: T[], rowId: string): T {
  const result = jobs.find((entry) => entry.row.id === rowId);
  if (!result) throw new Error(`missing ${rowId}`);
  return result;
}

function productMetricPackage(): MotionPackage {
  const json = (path: string) => JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
  return {
    root: ROOT,
    manifest: readPackageManifest(json("manifest.json")),
    motion: readMotionDocument(json("motion.json")),
    template: readTemplateDocument(json("template.json"))
  };
}

function productMetricRows() {
  return parseMotionDataRows(JSON.parse(readFileSync(resolve(ROOT, "data/product-metrics.batch.json"), "utf8")));
}

function syntheticPackage(): MotionPackage {
  return {
    root: "/synthetic/generic-chart-report",
    manifest: readPackageManifest({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generic_chart_report",
      name: "Generic Chart Report",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] }
    }),
    motion: readMotionDocument({
      schema: "shellx-motion/motion@1",
      id: "motion_generic_chart_report",
      name: "Generic Chart Report",
      durationMs: 2400,
      fps: 30,
      width: 1280,
      height: 720,
      background: "#08111f",
      safeAreas: { content: { top: 32, right: 32, bottom: 32, left: 32 } },
      layers: [
        { id: "background", type: "shape", shape: "rectangle", fill: "#08111f", startMs: 0, durationMs: 2400, width: 1280, height: 720, transform: { x: 0, y: 0 } },
        { id: "legacy-chart-panel", type: "shape", shape: "rounded-rect", fill: "#18243a", startMs: 0, durationMs: 2400, width: 860, height: 300, transform: { x: 64, y: 160 } },
        { id: "report-heading", type: "text", text: "Base report", startMs: 0, durationMs: 2400, transform: { x: 64, y: 64 }, style: { fontFamily: "Inter, sans-serif", fontSize: 32, fontWeight: 700, lineHeight: 1.1, width: 820, color: "#f4f8ff" } }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "chart-composition-test", workflow: "batch-render" }
    })
  };
}

function syntheticRecipeRow(): Record<string, unknown> {
  return {
    id: "second_family_report",
    chartComposition: {
      schema: "shellx-motion/chart-composition@1",
      replaceLayerIds: ["legacy-chart-panel"],
      charts: [
        {
          kind: "timeline-progress",
          id: "weekly_timeline",
          startMs: 120,
          durationMs: 1800,
          bounds: { x: 64, y: 160, width: 860, height: 220 },
          theme: { panel: "#16253b", panelMuted: "#263b57", secondaryAccent: "#22cc88", text: "#f4f8ff", mutedText: "#bdd0e8", grid: "#60758f" },
          timeline: { progress: 0.7, steps: [{ label: "Plan" }, { label: "Build" }, { label: "Release" }] }
        }
      ],
      barAnimation: { layerIdSuffixes: ["progress"], delayMs: 20, staggerMs: 0, durationMs: 360, easing: "linear" },
      typography: { default: { preset: "caption-reveal", safeAreaId: "content" }, overrides: [] },
      chromePatches: [{ layerId: "report-heading", text: "Weekly release timeline", styleColor: "#22cc88" }]
    }
  };
}

function layer(motion: MotionDocument, id: string): MotionLayer {
  const result = motion.layers.find((entry) => entry.id === id);
  if (!result) throw new Error(`missing ${id}`);
  return result;
}

function assertGeneratedTypographyFits(motion: MotionDocument): void {
  const generated = motion.layers.filter((entry) => entry.id.startsWith("chart_product_metric_") && entry.type === "text");
  expect(generated.length).toBeGreaterThan(0);
  for (const entry of generated) {
    expect(entry.style?.fontFamily, entry.id).toBe(PORTABLE_CHART_FONT_STACK);
    expect(entry.textFit).toMatchObject({ policy: "auto-fit" });
    expect(entry.textFit?.minFontSize, entry.id).toBeGreaterThan(0);
    const safeArea = motion.safeAreas?.[entry.textFit?.safeAreaId ?? ""];
    expect(safeArea, entry.id).toBeDefined();
    const x = Number(entry.transform?.x);
    const y = Number(entry.transform?.y);
    const width = Number(entry.style?.width);
    const fontSize = Number(entry.style?.fontSize);
    const lineHeight = Number(entry.style?.lineHeight);
    const height = Number(entry.style?.height);
    expect(x, entry.id).toBeGreaterThanOrEqual(safeArea?.left ?? 0);
    expect(y, entry.id).toBeGreaterThanOrEqual(safeArea?.top ?? 0);
    expect(x + width, entry.id).toBeLessThanOrEqual(motion.width - (safeArea?.right ?? 0));
    expect(Number.isInteger(height), entry.id).toBe(true);
    expect(height, entry.id).toBeGreaterThanOrEqual(Math.ceil(fontSize * lineHeight));
    expect(y + height, entry.id).toBeLessThanOrEqual(motion.height - (safeArea?.bottom ?? 0));
    for (const frames of Object.values(entry.keyframes ?? {})) {
      expect(frames?.every((frame) => frame.atMs >= entry.startMs), entry.id).toBe(true);
    }
  }
}
