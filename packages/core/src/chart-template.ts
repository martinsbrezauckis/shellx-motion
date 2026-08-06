import type { MotionLayer } from "./types";

export type ChartTemplateKind =
  | "metric-card"
  | "two-series-comparison"
  | "timeline-progress"
  | "compact-table";

export type ChartValueFormat = "number" | "compact" | "percent" | "currency";

export interface ChartBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChartTheme {
  panel?: string;
  panelMuted?: string;
  accent?: string;
  secondaryAccent?: string;
  text?: string;
  mutedText?: string;
  grid?: string;
}

export interface ChartMetricInput {
  label: string;
  value: number;
  format?: ChartValueFormat;
  unit?: string;
  currency?: string;
  delta?: number;
  deltaFormat?: ChartValueFormat;
  deltaLabel?: string;
  progress?: number;
}

export interface ChartComparisonSeriesInput {
  label: string;
  current: number;
  previous: number;
}

export interface ChartComparisonInput {
  series: ChartComparisonSeriesInput[];
}

export interface ChartTimelineStepInput {
  label: string;
}

export interface ChartTimelineInput {
  progress: number;
  steps: ChartTimelineStepInput[];
}

export interface ChartTableRowInput {
  label: string;
  value: number;
  format?: ChartValueFormat;
  unit?: string;
  currency?: string;
  barValue?: number;
}

export interface ChartTableInput {
  columns?: [string, string];
  rows: ChartTableRowInput[];
}

export interface ChartTemplateInput {
  kind: ChartTemplateKind;
  id: string;
  locale?: string;
  startMs?: number;
  durationMs?: number;
  bounds: ChartBounds;
  theme?: ChartTheme;
  metric?: ChartMetricInput;
  comparison?: ChartComparisonInput;
  timeline?: ChartTimelineInput;
  table?: ChartTableInput;
}

export interface ChartTemplateError {
  path: string;
  message: string;
}

export interface ChartTemplateSummary {
  kind: ChartTemplateKind;
  layerCount: number;
  textLayerCount: number;
  shapeLayerCount: number;
}

export type ChartTemplateCompileResult =
  | { ok: true; layers: MotionLayer[]; summary: ChartTemplateSummary; warnings: string[] }
  | { ok: false; errors: ChartTemplateError[] };

export interface FormatChartValueOptions {
  locale?: string;
  format?: ChartValueFormat;
  unit?: string;
  currency?: string;
  maximumFractionDigits?: number;
}

const DEFAULT_THEME: Required<ChartTheme> = {
  panel: "#101828",
  panelMuted: "#1f2a44",
  accent: "#24d6ff",
  secondaryAccent: "#f2b84b",
  text: "#f8fafc",
  mutedText: "#b9c7d9",
  grid: "rgba(255,255,255,0.18)"
};

export function compileChartTemplate(input: ChartTemplateInput): ChartTemplateCompileResult {
  const errors = validateChartTemplate(input);
  if (errors.length > 0) return { ok: false, errors };

  const context = chartContext(input);
  let layers: MotionLayer[];
  const warnings: string[] = [];

  if (input.kind === "metric-card") {
    layers = compileMetricCard(input.metric as ChartMetricInput, context);
  } else if (input.kind === "two-series-comparison") {
    layers = compileComparisonChart(input.comparison as ChartComparisonInput, context);
  } else if (input.kind === "timeline-progress") {
    const timeline = input.timeline as ChartTimelineInput;
    layers = compileTimelineChart(timeline, context);
    if (timeline.progress !== clamp01(timeline.progress)) warnings.push("timeline.progress was clamped into the 0..1 range");
  } else {
    layers = compileCompactTable(input.table as ChartTableInput, context);
  }

  return {
    ok: true,
    layers,
    summary: summarizeLayers(input.kind, layers),
    warnings
  };
}

export function formatChartValue(value: number, options: FormatChartValueOptions = {}): string {
  const locale = options.locale ?? "en-US";
  const format = options.format ?? "number";
  const maximumFractionDigits = options.maximumFractionDigits ?? (format === "compact" ? 1 : 0);
  const formatter = new Intl.NumberFormat(locale, {
    notation: format === "compact" ? "compact" : "standard",
    style: format === "percent" ? "percent" : format === "currency" ? "currency" : "decimal",
    currency: format === "currency" ? options.currency ?? "USD" : undefined,
    maximumFractionDigits
  });
  const formatted = formatter.format(format === "percent" ? value : value);
  return options.unit && format !== "currency" && format !== "percent"
    ? `${formatted} ${options.unit}`
    : formatted;
}

interface ChartContext {
  id: string;
  bounds: ChartBounds;
  startMs: number;
  durationMs: number;
  locale: string;
  theme: Required<ChartTheme>;
}

function compileMetricCard(metric: ChartMetricInput, context: ChartContext): MotionLayer[] {
  const { bounds, theme } = context;
  const progressWidth = Math.round((bounds.width - 80) * clamp01(metric.progress ?? 0));
  const deltaText = metric.delta === undefined
    ? ""
    : `${metric.delta >= 0 ? "+" : ""}${formatChartValue(metric.delta, {
        locale: context.locale,
        format: metric.deltaFormat ?? "percent",
        maximumFractionDigits: metric.deltaFormat === "number" ? 1 : 0
      })}${metric.deltaLabel ? ` ${metric.deltaLabel}` : ""}`;

  return [
    shapeLayer(context, "panel", "rounded-rect", bounds.x, bounds.y, bounds.width, bounds.height, theme.panel, 32),
    textLayer(context, "label", metric.label.toUpperCase(), bounds.x + 40, bounds.y + 42, 28, theme.mutedText, 760, 800),
    textLayer(context, "value", formatChartValue(metric.value, {
      locale: context.locale,
      format: metric.format,
      unit: metric.unit,
      currency: metric.currency
    }), bounds.x + 40, bounds.y + 104, 86, theme.text, 620, 850),
    textLayer(context, "delta", deltaText, bounds.x + 44, bounds.y + 222, 30, theme.accent, 620, 760),
    shapeLayer(context, "progress_track", "rounded-rect", bounds.x + 40, bounds.y + bounds.height - 70, bounds.width - 80, 18, theme.panelMuted, 9),
    shapeLayer(context, "progress_fill", "rounded-rect", bounds.x + 40, bounds.y + bounds.height - 70, progressWidth, 18, theme.accent, 9)
  ];
}

function compileComparisonChart(comparison: ChartComparisonInput, context: ChartContext): MotionLayer[] {
  const { bounds, theme } = context;
  const maxValue = Math.max(...comparison.series.flatMap((entry) => [entry.current, entry.previous]), 1);
  const chartWidth = Math.round(bounds.width * 0.6);
  const rowHeight = Math.max(84, Math.floor((bounds.height - 48) / comparison.series.length));
  const layers: MotionLayer[] = [
    shapeLayer(context, "panel", "rounded-rect", bounds.x, bounds.y, bounds.width, bounds.height, theme.panel, 28)
  ];

  comparison.series.forEach((entry, index) => {
    const y = bounds.y + 42 + index * rowHeight;
    const token = slugToken(entry.label);
    const labelX = bounds.x + 36;
    const barX = bounds.x + Math.round(bounds.width * 0.34);
    const currentWidth = Math.round((entry.current / maxValue) * chartWidth);
    const previousWidth = Math.round((entry.previous / maxValue) * chartWidth);
    layers.push(
      textLayer(context, `${token}_label`, entry.label, labelX, y + 16, 24, theme.text, Math.round(bounds.width * 0.28), 760),
      shapeLayer(context, `${token}_previous`, "rounded-rect", barX, y + 10, previousWidth, 18, theme.grid, 9),
      shapeLayer(context, `${token}_current`, "rounded-rect", barX, y + 40, currentWidth, 24, theme.accent, 12),
      textLayer(context, `${token}_value`, formatChartValue(entry.current, { locale: context.locale }), barX + chartWidth + 22, y + 28, 22, theme.mutedText, 120, 700)
    );
  });

  return layers;
}

function compileTimelineChart(timeline: ChartTimelineInput, context: ChartContext): MotionLayer[] {
  const { bounds, theme } = context;
  const left = bounds.x + 54;
  const right = bounds.x + bounds.width - 54;
  const lineWidth = right - left;
  const y = bounds.y + 96;
  const progressWidth = Math.round(lineWidth * clamp01(timeline.progress));
  const layers: MotionLayer[] = [
    shapeLayer(context, "panel", "rounded-rect", bounds.x, bounds.y, bounds.width, bounds.height, theme.panel, 28),
    shapeLayer(context, "track", "rounded-rect", left, y, lineWidth, 12, theme.panelMuted, 6),
    shapeLayer(context, "progress", "rounded-rect", left, y, progressWidth, 12, theme.secondaryAccent, 6)
  ];
  const denominator = Math.max(timeline.steps.length - 1, 1);
  timeline.steps.forEach((step, index) => {
    const x = Math.round(left + (lineWidth * index) / denominator);
    layers.push(
      shapeLayer(context, `step_${index}_dot`, "ellipse", x - 13, y - 13, 38, 38, index / denominator <= clamp01(timeline.progress) ? theme.secondaryAccent : theme.grid, 19),
      textLayer(context, `step_${index}_label`, step.label, x - 70, y + 44, 22, theme.mutedText, 140, 650)
    );
  });
  return layers;
}

function compileCompactTable(table: ChartTableInput, context: ChartContext): MotionLayer[] {
  const { bounds, theme } = context;
  const rowTop = bounds.y + 78;
  const rowHeight = Math.max(74, Math.floor((bounds.height - 104) / table.rows.length));
  const labelX = bounds.x + 34;
  const valueX = bounds.x + Math.round(bounds.width * 0.56);
  const barWidth = Math.round(bounds.width * 0.2);
  const layers: MotionLayer[] = [
    shapeLayer(context, "panel", "rounded-rect", bounds.x, bounds.y, bounds.width, bounds.height, theme.panel, 28),
    textLayer(context, "head_left", table.columns?.[0] ?? "Metric", labelX, bounds.y + 30, 20, theme.mutedText, 260, 760),
    textLayer(context, "head_right", table.columns?.[1] ?? "Value", valueX, bounds.y + 30, 20, theme.mutedText, 180, 760)
  ];

  table.rows.forEach((row, index) => {
    const y = rowTop + index * rowHeight;
    const rowBarWidth = Math.round(barWidth * clamp01(row.barValue ?? 0));
    layers.push(
      textLayer(context, `row_${index}_label`, row.label, labelX, y, 24, theme.text, Math.round(bounds.width * 0.46), 700),
      textLayer(context, `row_${index}_value`, formatChartValue(row.value, {
        locale: context.locale,
        format: row.format,
        unit: row.unit,
        currency: row.currency
      }), valueX, y, 24, theme.text, 170, 760),
      shapeLayer(context, `row_${index}_bar_track`, "rounded-rect", valueX + 148, y + 9, barWidth, 12, theme.panelMuted, 6),
      shapeLayer(context, `row_${index}_bar`, "rounded-rect", valueX + 148, y + 9, rowBarWidth, 12, theme.accent, 6)
    );
  });

  return layers;
}

function validateChartTemplate(input: ChartTemplateInput): ChartTemplateError[] {
  const errors: ChartTemplateError[] = [];
  if (!input.id || input.id.trim().length === 0) errors.push({ path: "/id", message: "must be a non-empty string" });
  validateBounds(input.bounds, errors);
  if (input.kind === "metric-card") validateMetric(input.metric, errors);
  else if (input.kind === "two-series-comparison") validateComparison(input.comparison, errors);
  else if (input.kind === "timeline-progress") validateTimeline(input.timeline, errors);
  else if (input.kind === "compact-table") validateTable(input.table, errors);
  else errors.push({ path: "/kind", message: "unsupported chart template kind" });
  return errors;
}

function validateBounds(bounds: ChartBounds | undefined, errors: ChartTemplateError[]): void {
  if (!bounds) {
    errors.push({ path: "/bounds", message: "must be an object" });
    return;
  }
  for (const field of ["x", "y", "width", "height"] as const) {
    if (!Number.isFinite(bounds[field]) || (field === "width" || field === "height") && bounds[field] <= 0) {
      errors.push({ path: `/bounds/${field}`, message: field === "width" || field === "height" ? "must be a positive finite number" : "must be a finite number" });
    }
  }
}

function validateMetric(metric: ChartMetricInput | undefined, errors: ChartTemplateError[]): void {
  if (!metric) {
    errors.push({ path: "/metric", message: "must be an object" });
    return;
  }
  validateLabel(metric.label, "/metric/label", 48, errors);
  validateFinite(metric.value, "/metric/value", errors);
  if (metric.delta !== undefined) validateFinite(metric.delta, "/metric/delta", errors);
  if (metric.progress !== undefined) validateFinite(metric.progress, "/metric/progress", errors);
}

function validateComparison(comparison: ChartComparisonInput | undefined, errors: ChartTemplateError[]): void {
  if (!comparison || !Array.isArray(comparison.series)) {
    errors.push({ path: "/comparison/series", message: "must be an array" });
    return;
  }
  if (comparison.series.length === 0 || comparison.series.length > 4) {
    errors.push({ path: "/comparison/series", message: "must include 1 to 4 series rows" });
  }
  comparison.series.forEach((entry, index) => {
    validateLabel(entry.label, `/comparison/series/${index}/label`, 48, errors);
    validateFinite(entry.current, `/comparison/series/${index}/current`, errors);
    validateFinite(entry.previous, `/comparison/series/${index}/previous`, errors);
  });
}

function validateTimeline(timeline: ChartTimelineInput | undefined, errors: ChartTemplateError[]): void {
  if (!timeline || !Array.isArray(timeline.steps)) {
    errors.push({ path: "/timeline/steps", message: "must be an array" });
    return;
  }
  validateFinite(timeline.progress, "/timeline/progress", errors);
  if (timeline.steps.length < 2 || timeline.steps.length > 6) {
    errors.push({ path: "/timeline/steps", message: "must include 2 to 6 steps" });
  }
  timeline.steps.forEach((entry, index) => validateLabel(entry.label, `/timeline/steps/${index}/label`, 28, errors));
}

function validateTable(table: ChartTableInput | undefined, errors: ChartTemplateError[]): void {
  if (!table || !Array.isArray(table.rows)) {
    errors.push({ path: "/table/rows", message: "must be an array" });
    return;
  }
  if (table.rows.length === 0 || table.rows.length > 6) {
    errors.push({ path: "/table/rows", message: "must include 1 to 6 rows" });
  }
  table.rows.forEach((entry, index) => {
    validateLabel(entry.label, `/table/rows/${index}/label`, 36, errors);
    validateFinite(entry.value, `/table/rows/${index}/value`, errors);
    if (entry.barValue !== undefined) validateFinite(entry.barValue, `/table/rows/${index}/barValue`, errors);
  });
}

function validateLabel(value: unknown, path: string, maxLength: number, errors: ChartTemplateError[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({ path, message: "must be a non-empty string" });
    return;
  }
  if (value.length > maxLength) {
    errors.push({ path, message: `must be ${maxLength} characters or fewer` });
  }
}

function validateFinite(value: unknown, path: string, errors: ChartTemplateError[]): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push({ path, message: "must be a finite number" });
  }
}

function chartContext(input: ChartTemplateInput): ChartContext {
  return {
    id: slugToken(input.id),
    bounds: input.bounds,
    startMs: input.startMs ?? 0,
    durationMs: input.durationMs ?? 3000,
    locale: input.locale ?? "en-US",
    theme: { ...DEFAULT_THEME, ...input.theme }
  };
}

function textLayer(
  context: ChartContext,
  suffix: string,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  color: string,
  width: number,
  fontWeight: number
): MotionLayer {
  return {
    id: `chart_${context.id}_${suffix}`,
    type: "text",
    text,
    startMs: context.startMs,
    durationMs: context.durationMs,
    transform: { x, y },
    style: {
      fontFamily: "Inter",
      fontSize,
      fontWeight,
      lineHeight: 1.08,
      width,
      color
    }
  };
}

function shapeLayer(
  context: ChartContext,
  suffix: string,
  shape: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  radius: number
): MotionLayer {
  return {
    id: `chart_${context.id}_${suffix}`,
    type: "shape",
    shape,
    fill,
    startMs: context.startMs,
    durationMs: context.durationMs,
    width,
    height,
    transform: { x, y },
    style: { fill, radius }
  };
}

function summarizeLayers(kind: ChartTemplateKind, layers: MotionLayer[]): ChartTemplateSummary {
  return {
    kind,
    layerCount: layers.length,
    textLayerCount: layers.filter((layer) => layer.type === "text").length,
    shapeLayerCount: layers.filter((layer) => layer.type === "shape").length
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function slugToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "chart";
}
