import type { ChartComparisonInput, ChartMetricInput, ChartTableInput, ChartTheme, ChartTimelineInput, ChartValueFormat } from "./chart-template";
import { getTypographyPreset } from "./typography-presets";
import {
  CHART_COMPOSITION_SCHEMA,
  type ChartCompositionBarAnimation,
  type ChartCompositionChromePatch,
  type ChartCompositionInput,
  type ChartCompositionKind,
  type ChartCompositionRecipe,
  type ChartCompositionTypography,
  type ChartCompositionTypographyRule
} from "./chart-composition-recipe-types";

const CHART_KINDS = new Set<ChartCompositionKind>(["metric-card", "two-series-comparison", "timeline-progress", "compact-table"]);
const BAR_SUFFIXES = new Set<ChartCompositionBarAnimation["layerIdSuffixes"][number]>(["progress_fill", "progress", "bar", "current", "previous"]);
const EASINGS = new Set<ChartCompositionBarAnimation["easing"]>(["linear", "ease-in", "ease-out", "ease-in-out"]);
const ID_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

export function readChartCompositionRecipe(value: unknown, rowId: string): ChartCompositionRecipe {
  const recipe = exactRecord(value, "chartComposition", rowId, ["schema", "replaceLayerIds", "charts", "barAnimation", "typography", "chromePatches"]);
  if (recipe.schema !== CHART_COMPOSITION_SCHEMA) throw new Error(`Motion data row ${rowId} chartComposition.schema must equal ${CHART_COMPOSITION_SCHEMA}.`);
  const charts = exactArray(recipe.charts, "chartComposition.charts", rowId, 1, 4).map((entry, index) => readChart(entry, `chartComposition.charts[${index}]`, rowId));
  const ids = charts.map((chart) => chart.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Motion data row ${rowId} chartComposition chart ids must be unique.`);
  return {
    schema: CHART_COMPOSITION_SCHEMA,
    replaceLayerIds: readIds(recipe.replaceLayerIds, "chartComposition.replaceLayerIds", rowId, 1, 80),
    charts,
    barAnimation: readBarAnimation(recipe.barAnimation, rowId),
    typography: readTypography(recipe.typography, rowId),
    chromePatches: recipe.chromePatches === undefined ? [] : readChromePatches(recipe.chromePatches, rowId)
  };
}

function readChart(value: unknown, path: string, rowId: string): ChartCompositionInput {
  const common = exactRecord(value, path, rowId, ["kind", "id", "startMs", "durationMs", "bounds", "theme", "metric", "comparison", "timeline", "table"]);
  if (typeof common.kind !== "string" || !CHART_KINDS.has(common.kind as ChartCompositionKind)) throw new Error(`Motion data row ${rowId} ${path}.kind is unsupported.`);
  const kind = common.kind as ChartCompositionKind;
  const requiredKey = kind === "metric-card" ? "metric" : kind === "two-series-comparison" ? "comparison" : kind === "timeline-progress" ? "timeline" : "table";
  const disallowed = ["metric", "comparison", "timeline", "table"].filter((key) => key !== requiredKey && common[key] !== undefined);
  if (disallowed.length > 0 || common[requiredKey] === undefined) throw new Error(`Motion data row ${rowId} ${path} must carry exactly one ${requiredKey} input.`);
  const base = {
    kind,
    id: readId(common.id, `${path}.id`, rowId),
    startMs: readInteger(common.startMs, `${path}.startMs`, rowId, 0, 86_400_000),
    durationMs: readInteger(common.durationMs, `${path}.durationMs`, rowId, 80, 86_400_000),
    bounds: readBounds(common.bounds, `${path}.bounds`, rowId),
    ...(common.theme === undefined ? {} : { theme: readTheme(common.theme, `${path}.theme`, rowId) })
  };
  if (kind === "metric-card") return { ...base, kind, metric: readMetric(common.metric, `${path}.metric`, rowId) };
  if (kind === "two-series-comparison") return { ...base, kind, comparison: readComparison(common.comparison, `${path}.comparison`, rowId) };
  if (kind === "timeline-progress") return { ...base, kind, timeline: readTimeline(common.timeline, `${path}.timeline`, rowId) };
  return { ...base, kind, table: readTable(common.table, `${path}.table`, rowId) };
}

function readMetric(value: unknown, path: string, rowId: string): ChartMetricInput {
  const metric = exactRecord(value, path, rowId, ["label", "value", "format", "unit", "currency", "delta", "deltaFormat", "deltaLabel", "progress"]);
  return {
    label: readText(metric.label, `${path}.label`, 48, rowId),
    value: readFinite(metric.value, `${path}.value`, rowId),
    ...(metric.format === undefined ? {} : { format: readFormat(metric.format, `${path}.format`, rowId) }),
    ...(metric.unit === undefined ? {} : { unit: readText(metric.unit, `${path}.unit`, 12, rowId) }),
    ...(metric.currency === undefined ? {} : { currency: readCurrency(metric.currency, `${path}.currency`, rowId) }),
    ...(metric.delta === undefined ? {} : { delta: readFinite(metric.delta, `${path}.delta`, rowId) }),
    ...(metric.deltaFormat === undefined ? {} : { deltaFormat: readFormat(metric.deltaFormat, `${path}.deltaFormat`, rowId) }),
    ...(metric.deltaLabel === undefined ? {} : { deltaLabel: readText(metric.deltaLabel, `${path}.deltaLabel`, 32, rowId) }),
    ...(metric.progress === undefined ? {} : { progress: readUnitInterval(metric.progress, `${path}.progress`, rowId) })
  };
}

function readComparison(value: unknown, path: string, rowId: string): ChartComparisonInput {
  const comparison = exactRecord(value, path, rowId, ["series"]);
  const series = exactArray(comparison.series, `${path}.series`, rowId, 1, 4).map((entry, index) => {
    const item = exactRecord(entry, `${path}.series[${index}]`, rowId, ["label", "current", "previous"]);
    return { label: readText(item.label, `${path}.series[${index}].label`, 48, rowId), current: readFinite(item.current, `${path}.series[${index}].current`, rowId), previous: readFinite(item.previous, `${path}.series[${index}].previous`, rowId) };
  });
  return { series };
}

function readTimeline(value: unknown, path: string, rowId: string): ChartTimelineInput {
  const timeline = exactRecord(value, path, rowId, ["progress", "steps"]);
  return {
    progress: readUnitInterval(timeline.progress, `${path}.progress`, rowId),
    steps: exactArray(timeline.steps, `${path}.steps`, rowId, 2, 6).map((entry, index) => {
      const step = exactRecord(entry, `${path}.steps[${index}]`, rowId, ["label"]);
      return { label: readText(step.label, `${path}.steps[${index}].label`, 28, rowId) };
    })
  };
}

function readTable(value: unknown, path: string, rowId: string): ChartTableInput {
  const table = exactRecord(value, path, rowId, ["columns", "rows"]);
  const columns = table.columns === undefined ? undefined : readColumns(table.columns, `${path}.columns`, rowId);
  const rows = exactArray(table.rows, `${path}.rows`, rowId, 1, 6).map((entry, index) => {
    const item = exactRecord(entry, `${path}.rows[${index}]`, rowId, ["label", "value", "format", "unit", "currency", "barValue"]);
    return {
      label: readText(item.label, `${path}.rows[${index}].label`, 36, rowId),
      value: readFinite(item.value, `${path}.rows[${index}].value`, rowId),
      ...(item.format === undefined ? {} : { format: readFormat(item.format, `${path}.rows[${index}].format`, rowId) }),
      ...(item.unit === undefined ? {} : { unit: readText(item.unit, `${path}.rows[${index}].unit`, 12, rowId) }),
      ...(item.currency === undefined ? {} : { currency: readCurrency(item.currency, `${path}.rows[${index}].currency`, rowId) }),
      ...(item.barValue === undefined ? {} : { barValue: readUnitInterval(item.barValue, `${path}.rows[${index}].barValue`, rowId) })
    };
  });
  return { ...(columns ? { columns } : {}), rows };
}

function readBounds(value: unknown, path: string, rowId: string) {
  const bounds = exactRecord(value, path, rowId, ["x", "y", "width", "height"]);
  return { x: readInteger(bounds.x, `${path}.x`, rowId, 0, 100_000), y: readInteger(bounds.y, `${path}.y`, rowId, 0, 100_000), width: readInteger(bounds.width, `${path}.width`, rowId, 1, 100_000), height: readInteger(bounds.height, `${path}.height`, rowId, 1, 100_000) };
}

function readTheme(value: unknown, path: string, rowId: string): ChartTheme {
  const theme = exactRecord(value, path, rowId, ["panel", "panelMuted", "accent", "secondaryAccent", "text", "mutedText", "grid"]);
  const output: ChartTheme = {};
  for (const key of ["panel", "panelMuted", "accent", "secondaryAccent", "text", "mutedText", "grid"] as const) {
    if (theme[key] !== undefined) output[key] = readColor(theme[key], `${path}.${key}`, rowId);
  }
  return output;
}

function readBarAnimation(value: unknown, rowId: string): ChartCompositionBarAnimation {
  const animation = exactRecord(value, "chartComposition.barAnimation", rowId, ["layerIdSuffixes", "delayMs", "staggerMs", "durationMs", "easing"]);
  const layerIdSuffixes = exactArray(animation.layerIdSuffixes, "chartComposition.barAnimation.layerIdSuffixes", rowId, 1, 5).map((entry) => {
    if (typeof entry !== "string" || !BAR_SUFFIXES.has(entry as ChartCompositionBarAnimation["layerIdSuffixes"][number])) throw new Error(`Motion data row ${rowId} chartComposition.barAnimation.layerIdSuffixes has an unsupported suffix.`);
    return entry as ChartCompositionBarAnimation["layerIdSuffixes"][number];
  });
  if (new Set(layerIdSuffixes).size !== layerIdSuffixes.length) throw new Error(`Motion data row ${rowId} chartComposition.barAnimation.layerIdSuffixes must be unique.`);
  const easing = animation.easing;
  if (typeof easing !== "string" || !EASINGS.has(easing as ChartCompositionBarAnimation["easing"])) throw new Error(`Motion data row ${rowId} chartComposition.barAnimation.easing is unsupported.`);
  return { layerIdSuffixes, delayMs: readInteger(animation.delayMs, "chartComposition.barAnimation.delayMs", rowId, 0, 10_000), staggerMs: readInteger(animation.staggerMs, "chartComposition.barAnimation.staggerMs", rowId, 0, 5_000), durationMs: readInteger(animation.durationMs, "chartComposition.barAnimation.durationMs", rowId, 80, 10_000), easing: easing as ChartCompositionBarAnimation["easing"] };
}

function readTypography(value: unknown, rowId: string): ChartCompositionTypography {
  const typography = exactRecord(value, "chartComposition.typography", rowId, ["default", "overrides"]);
  const overrides = exactArray(typography.overrides, "chartComposition.typography.overrides", rowId, 0, 12).map((entry, index) => {
    const rule = exactRecord(entry, `chartComposition.typography.overrides[${index}]`, rowId, ["layerIdSuffix", "preset", "safeAreaId"]);
    return { layerIdSuffix: readSuffix(rule.layerIdSuffix, `chartComposition.typography.overrides[${index}].layerIdSuffix`, rowId), ...readTypographyRule(rule, `chartComposition.typography.overrides[${index}]`, rowId, true) };
  });
  if (new Set(overrides.map((rule) => rule.layerIdSuffix)).size !== overrides.length) throw new Error(`Motion data row ${rowId} chartComposition typography override suffixes must be unique.`);
  return { default: readTypographyRule(typography.default, "chartComposition.typography.default", rowId), overrides };
}

function readTypographyRule(value: unknown, path: string, rowId: string, allowLayerIdSuffix = false): ChartCompositionTypographyRule {
  const rule = exactRecord(value, path, rowId, allowLayerIdSuffix ? ["preset", "safeAreaId", "layerIdSuffix"] : ["preset", "safeAreaId"]);
  const preset = typeof rule.preset === "string" ? getTypographyPreset(rule.preset) : undefined;
  if (!preset) throw new Error(`Motion data row ${rowId} ${path}.preset is unsupported.`);
  return { preset: preset.id, safeAreaId: readLayerId(rule.safeAreaId, `${path}.safeAreaId`, rowId) };
}

function readChromePatches(value: unknown, rowId: string): ChartCompositionChromePatch[] {
  const patches = exactArray(value, "chartComposition.chromePatches", rowId, 0, 32).map((entry, index) => {
    const patch = exactRecord(entry, `chartComposition.chromePatches[${index}]`, rowId, ["layerId", "text", "fill", "styleColor"]);
    if (patch.text === undefined && patch.fill === undefined && patch.styleColor === undefined) throw new Error(`Motion data row ${rowId} chartComposition.chromePatches[${index}] needs a patch value.`);
    return { layerId: readLayerId(patch.layerId, `chartComposition.chromePatches[${index}].layerId`, rowId), ...(patch.text === undefined ? {} : { text: readText(patch.text, `chartComposition.chromePatches[${index}].text`, 160, rowId) }), ...(patch.fill === undefined ? {} : { fill: readColor(patch.fill, `chartComposition.chromePatches[${index}].fill`, rowId) }), ...(patch.styleColor === undefined ? {} : { styleColor: readColor(patch.styleColor, `chartComposition.chromePatches[${index}].styleColor`, rowId) }) };
  });
  if (new Set(patches.map((patch) => patch.layerId)).size !== patches.length) throw new Error(`Motion data row ${rowId} chartComposition.chromePatches must target unique layers.`);
  return patches;
}

function readColumns(value: unknown, path: string, rowId: string): [string, string] {
  const columns = exactArray(value, path, rowId, 2, 2);
  return [readText(columns[0], `${path}[0]`, 28, rowId), readText(columns[1], `${path}[1]`, 28, rowId)];
}

function readIds(value: unknown, path: string, rowId: string, min: number, max: number): string[] {
  const ids = exactArray(value, path, rowId, min, max).map((entry, index) => readLayerId(entry, `${path}[${index}]`, rowId));
  if (new Set(ids).size !== ids.length) throw new Error(`Motion data row ${rowId} ${path} must be unique.`);
  return ids;
}

function readId(value: unknown, path: string, rowId: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`Motion data row ${rowId} ${path} must be a lowercase identifier.`);
  return value;
}

function readLayerId(value: unknown, path: string, rowId: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error(`Motion data row ${rowId} ${path} must be a lowercase layer identifier.`);
  return value;
}

function readSuffix(value: unknown, path: string, rowId: string): string {
  const suffix = readId(value, path, rowId);
  return suffix;
}

function readText(value: unknown, path: string, max: number, rowId: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || Array.from(value).length > max) throw new Error(`Motion data row ${rowId} ${path} must be a non-empty string of at most ${max} characters.`);
  return value;
}

function readColor(value: unknown, path: string, rowId: string): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Motion data row ${rowId} ${path} must be a six-digit hex color.`);
  return value;
}

function readCurrency(value: unknown, path: string, rowId: string): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new Error(`Motion data row ${rowId} ${path} must be a three-letter ISO currency.`);
  return value;
}

function readFinite(value: unknown, path: string, rowId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Motion data row ${rowId} ${path} must be finite.`);
  return value;
}

function readInteger(value: unknown, path: string, rowId: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Motion data row ${rowId} ${path} must be an integer within ${min}..${max}.`);
  return value as number;
}

function readUnitInterval(value: unknown, path: string, rowId: string): number {
  const number = readFinite(value, path, rowId);
  if (number < 0 || number > 1) throw new Error(`Motion data row ${rowId} ${path} must be within 0..1.`);
  return number;
}

function readFormat(value: unknown, path: string, rowId: string): ChartValueFormat {
  if (value !== "number" && value !== "compact" && value !== "percent" && value !== "currency") throw new Error(`Motion data row ${rowId} ${path} is unsupported.`);
  return value;
}

function exactRecord(value: unknown, path: string, rowId: string, keys: string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Motion data row ${rowId} ${path} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`Motion data row ${rowId} ${path} has unsupported key(s): ${unknown.join(", ")}.`);
  return value;
}

function exactArray(value: unknown, path: string, rowId: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Motion data row ${rowId} ${path} must contain ${min} to ${max} item(s).`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
