import type {
  ChartComparisonInput,
  ChartMetricInput,
  ChartTableInput,
  ChartTheme,
  ChartTimelineInput
} from "./chart-template";
import type { TypographyPresetId } from "./typography-presets";

export const CHART_COMPOSITION_SCHEMA = "shellx-motion/chart-composition@1";

export type ChartCompositionKind = "metric-card" | "two-series-comparison" | "timeline-progress" | "compact-table";
export type ChartCompositionInput =
  | ChartCompositionCommon & { kind: "metric-card"; metric: ChartMetricInput }
  | ChartCompositionCommon & { kind: "two-series-comparison"; comparison: ChartComparisonInput }
  | ChartCompositionCommon & { kind: "timeline-progress"; timeline: ChartTimelineInput }
  | ChartCompositionCommon & { kind: "compact-table"; table: ChartTableInput };

export interface ChartCompositionCommon {
  kind: ChartCompositionKind;
  id: string;
  startMs: number;
  durationMs: number;
  bounds: { x: number; y: number; width: number; height: number };
  theme?: ChartTheme;
}

export interface ChartCompositionBarAnimation {
  layerIdSuffixes: Array<"progress_fill" | "progress" | "bar" | "current" | "previous">;
  delayMs: number;
  staggerMs: number;
  durationMs: number;
  easing: "linear" | "ease-in" | "ease-out" | "ease-in-out";
}

export interface ChartCompositionTypographyRule {
  preset: TypographyPresetId;
  safeAreaId: string;
}

export interface ChartCompositionTypography {
  default: ChartCompositionTypographyRule;
  overrides: Array<ChartCompositionTypographyRule & { layerIdSuffix: string }>;
}

export interface ChartCompositionChromePatch {
  layerId: string;
  text?: string;
  fill?: string;
  styleColor?: string;
}

export interface ChartCompositionRecipe {
  schema: typeof CHART_COMPOSITION_SCHEMA;
  replaceLayerIds: string[];
  charts: ChartCompositionInput[];
  barAnimation: ChartCompositionBarAnimation;
  typography: ChartCompositionTypography;
  chromePatches: ChartCompositionChromePatch[];
}
