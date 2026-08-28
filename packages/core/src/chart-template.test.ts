import { describe, expect, it } from "vitest";
import { compileChartTemplate, formatChartValue } from "./chart-template";
import type { MotionLayer } from "./types";

const PORTABLE_CHART_FONT_STACK = "Inter, Arial, Helvetica, sans-serif";

describe("chart/stat template compiler", () => {
  it("compiles metric cards with locale-aware compact values and progress geometry", () => {
    const result = compileChartTemplate({
      kind: "metric-card",
      id: "motion-renders",
      locale: "en-US",
      bounds: { x: 120, y: 90, width: 720, height: 360 },
      metric: {
        label: "Local renders",
        value: 12840,
        format: "compact",
        delta: 0.31,
        deltaFormat: "percent",
        deltaLabel: "vs last release",
        progress: 0.74
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected metric card to compile");

    expect(result.summary).toEqual({
      kind: "metric-card",
      layerCount: 6,
      textLayerCount: 3,
      shapeLayerCount: 3
    });
    expectChartTextUsesPortableStack(result.layers);
    expect(result.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "chart_motion_renders_value",
        type: "text",
        text: "12.8K"
      }),
      expect.objectContaining({
        id: "chart_motion_renders_delta",
        type: "text",
        text: "+31% vs last release"
      }),
      expect.objectContaining({
        id: "chart_motion_renders_progress_fill",
        type: "shape",
        width: 474
      })
    ]));
  });

  it("compiles two-series comparison bars using normalized deterministic widths", () => {
    const result = compileChartTemplate({
      kind: "two-series-comparison",
      id: "host-mix",
      bounds: { x: 80, y: 120, width: 760, height: 420 },
      comparison: {
        series: [
          { label: "Cut Generate", current: 92, previous: 68 },
          { label: "Canvas export", current: 76, previous: 54 }
        ]
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected comparison chart to compile");

    expectChartTextUsesPortableStack(result.layers);
    expect(result.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "chart_host_mix_cut_generate_current", width: 456 }),
      expect.objectContaining({ id: "chart_host_mix_cut_generate_previous", width: 337 }),
      expect.objectContaining({ id: "chart_host_mix_canvas_export_current", width: 377 }),
      expect.objectContaining({ id: "chart_host_mix_canvas_export_previous", width: 268 })
    ]));
  });

  it("compiles timeline progress strips and compact tables", () => {
    const timeline = compileChartTemplate({
      kind: "timeline-progress",
      id: "roadmap",
      bounds: { x: 100, y: 100, width: 900, height: 220 },
      timeline: {
        progress: 0.6,
        steps: [
          { label: "Core" },
          { label: "Render" },
          { label: "Hosts" },
          { label: "Release" }
        ]
      }
    });
    const table = compileChartTemplate({
      kind: "compact-table",
      id: "quality",
      locale: "de-DE",
      bounds: { x: 60, y: 60, width: 680, height: 360 },
      table: {
        columns: ["Surface", "Score"],
        rows: [
          { label: "Motion", value: 0.92, format: "percent", barValue: 0.92 },
          { label: "Cut", value: 0.86, format: "percent", barValue: 0.86 }
        ]
      }
    });

    expect(timeline.ok).toBe(true);
    expect(table.ok).toBe(true);
    if (!timeline.ok || !table.ok) throw new Error("expected charts to compile");

    expect(timeline.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "chart_roadmap_progress", width: 475 }),
      expect.objectContaining({ id: "chart_roadmap_step_3_dot", shape: "ellipse" })
    ]));
    expectChartTextUsesPortableStack(timeline.layers);
    expect(table.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "chart_quality_row_0_value", text: "92\u00a0%" }),
      expect.objectContaining({ id: "chart_quality_row_1_bar", width: 117 })
    ]));
    expectChartTextUsesPortableStack(table.layers);
  });

  it("rejects malformed chart data with helpful paths", () => {
    const result = compileChartTemplate({
      kind: "two-series-comparison",
      id: "bad",
      bounds: { x: 0, y: 0, width: 0, height: 300 },
      comparison: {
        series: [
          { label: "This label is intentionally too long for a compact comparison row", current: Number.NaN, previous: 4 }
        ]
      }
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        { path: "/bounds/width", message: "must be a positive finite number" },
        { path: "/comparison/series/0/label", message: "must be 48 characters or fewer" },
        { path: "/comparison/series/0/current", message: "must be a finite number" }
      ]
    });
  });

  it("formats values consistently for rows and generated labels", () => {
    expect(formatChartValue(12900, { locale: "en-US", format: "compact" })).toBe("12.9K");
    expect(formatChartValue(0.875, { locale: "en-US", format: "percent" })).toBe("88%");
    expect(formatChartValue(42, { locale: "lv-LV", unit: "ms" })).toBe("42 ms");
  });
});

function expectChartTextUsesPortableStack(layers: MotionLayer[]): void {
  for (const layer of layers.filter((layer) => layer.type === "text")) {
    expect(layer.style?.fontFamily, layer.id).toBe(PORTABLE_CHART_FONT_STACK);
  }
}
