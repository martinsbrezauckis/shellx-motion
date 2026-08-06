// One shared rule for "a preset's track lands on a track the author already wrote", so the
// typography and transition families cannot drift about what happens or how it is reported.
import { replaceKeyframeTracks, replacedTrackWarnings } from "./preset-keyframe-tracks";
import type {
  MotionKeyframe,
  MotionKeyframeTarget,
  MotionLayer
} from "./types";
import type { TemplateParitySurface } from "./template-parity";

export type TypographyPresetId =
  | "title-entrance"
  | "subtitle-stagger"
  | "statistic-count-up"
  | "emphasis-pulse"
  | "caption-reveal"
  | "final-callout";

export interface TypographyTextFit {
  maxChars: number;
  minFontSize?: number;
  maxLines?: number;
  safeAreaInsetPct?: number;
}

export interface TypographyPreset {
  id: TypographyPresetId;
  label: string;
  family: "headline" | "supporting" | "metric" | "caption" | "callout";
  description: string;
  defaultDurationMs: number;
  compatibleLanes: string[];
  shellxSurfaces: TemplateParitySurface[];
  bestFor: string[];
  textFit: TypographyTextFit;
}

export interface CompileTypographyPresetOptions {
  durationMs?: number;
  totalDurationMs?: number;
  yOffset?: number;
  scaleFrom?: number;
  easing?: string;
}

export type TypographyKeyframes = Partial<Record<MotionKeyframeTarget, MotionKeyframe[]>>;

export type CompileTypographyPresetResult =
  | {
      ok: true;
      presetId: TypographyPresetId;
      style: Record<string, unknown>;
      keyframes: TypographyKeyframes;
      warnings: string[];
    }
  | {
      ok: false;
      presetId: string;
      error: string;
    };

export type ApplyTypographyPresetResult =
  | {
      ok: true;
      presetId: TypographyPresetId;
      layer: MotionLayer;
      warnings: string[];
    }
  | {
      ok: false;
      presetId: string;
      error: string;
    };

const TYPOGRAPHY_PRESETS: TypographyPreset[] = [
  {
    id: "title-entrance",
    label: "Title Entrance",
    family: "headline",
    description: "Large headline reveal with vertical settle and strong weight.",
    defaultDurationMs: 680,
    compatibleLanes: ["browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["launch titles", "scene openers", "hero cards"],
    textFit: { maxChars: 44, minFontSize: 54, maxLines: 2, safeAreaInsetPct: 8 }
  },
  {
    id: "subtitle-stagger",
    label: "Subtitle Stagger",
    family: "supporting",
    description: "Supporting copy reveal with restrained spacing movement.",
    defaultDurationMs: 520,
    compatibleLanes: ["browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["product explainers", "feature descriptions", "support copy"],
    textFit: { maxChars: 96, minFontSize: 28, maxLines: 3, safeAreaInsetPct: 8 }
  },
  {
    id: "statistic-count-up",
    label: "Statistic Count Up",
    family: "metric",
    description: "Metric emphasis with scale and opacity beats; data value interpolation is handled by the template compiler.",
    defaultDurationMs: 780,
    compatibleLanes: ["browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["metric cards", "batch renders", "comparison stats"],
    textFit: { maxChars: 16, minFontSize: 72, maxLines: 1, safeAreaInsetPct: 10 }
  },
  {
    id: "emphasis-pulse",
    label: "Emphasis Pulse",
    family: "callout",
    description: "Short attention beat for keywords, badges, and product proof points.",
    defaultDurationMs: 420,
    compatibleLanes: ["browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["badges", "keywords", "CTA emphasis"],
    textFit: { maxChars: 28, minFontSize: 34, maxLines: 1, safeAreaInsetPct: 8 }
  },
  {
    id: "caption-reveal",
    label: "Caption Reveal",
    family: "caption",
    description: "Readable caption fade with letter-spacing settle.",
    defaultDurationMs: 360,
    compatibleLanes: ["browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["captions", "lower thirds", "timeline notes"],
    textFit: { maxChars: 72, minFontSize: 28, maxLines: 2, safeAreaInsetPct: 8 }
  },
  {
    id: "final-callout",
    label: "Final Callout",
    family: "callout",
    description: "Closing statement with calm scale settle and high readability.",
    defaultDurationMs: 620,
    compatibleLanes: ["browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["end cards", "release names", "next action copy"],
    textFit: { maxChars: 38, minFontSize: 48, maxLines: 2, safeAreaInsetPct: 10 }
  }
];

export function listTypographyPresets(): TypographyPreset[] {
  return TYPOGRAPHY_PRESETS.map(cloneTypographyPreset);
}

export function getTypographyPreset(id: string): TypographyPreset | undefined {
  const preset = TYPOGRAPHY_PRESETS.find((preset) => preset.id === id);
  return preset ? cloneTypographyPreset(preset) : undefined;
}

export function compileTypographyPreset(id: string, options: CompileTypographyPresetOptions = {}): CompileTypographyPresetResult {
  const preset = TYPOGRAPHY_PRESETS.find((preset) => preset.id === id);
  if (!preset) {
    return {
      ok: false,
      presetId: id,
      error: `unknown typography preset: ${id}`
    };
  }

  const durationMs = normalizeDuration(options.durationMs ?? preset.defaultDurationMs);
  const totalDurationMs = normalizeDuration(options.totalDurationMs ?? durationMs);
  const easing = options.easing ?? "ease-out";
  const yOffset = options.yOffset ?? 24;
  const scaleFrom = options.scaleFrom ?? 0.96;
  const keyframes: TypographyKeyframes = {};
  let style: Record<string, unknown>;

  switch (preset.id) {
    case "title-entrance":
      style = { fontWeight: 800, lineHeight: 1.02 };
      keyframes.opacity = opacityIn(durationMs, easing);
      keyframes["transform.y"] = [
        { atMs: 0, value: yOffset, easing },
        { atMs: durationMs, value: 0, easing }
      ];
      break;
    case "subtitle-stagger":
      style = { fontWeight: 500, lineHeight: 1.18 };
      keyframes.opacity = opacityIn(durationMs, easing);
      keyframes["style.letterSpacing"] = [
        { atMs: 0, value: 0.8, easing },
        { atMs: durationMs, value: 0, easing }
      ];
      break;
    case "statistic-count-up":
      style = { fontWeight: 850, lineHeight: 0.96 };
      keyframes.opacity = opacityIn(durationMs, easing);
      keyframes["transform.scale"] = [
        { atMs: 0, value: scaleFrom, easing },
        { atMs: durationMs, value: 1, easing },
        { atMs: totalDurationMs, value: 1, easing: "linear" }
      ];
      break;
    case "emphasis-pulse":
      style = { fontWeight: 750, lineHeight: 1.04 };
      keyframes.opacity = [
        { atMs: 0, value: 0.65, easing },
        { atMs: Math.round(durationMs / 2), value: 1, easing },
        { atMs: durationMs, value: 0.92, easing }
      ];
      keyframes["transform.scale"] = [
        { atMs: 0, value: 0.98, easing },
        { atMs: Math.round(durationMs / 2), value: 1.03, easing },
        { atMs: durationMs, value: 1, easing }
      ];
      break;
    case "caption-reveal":
      style = { fontWeight: 600, lineHeight: 1.12 };
      keyframes.opacity = opacityIn(durationMs, easing);
      keyframes["style.letterSpacing"] = [
        { atMs: 0, value: 1.6, easing },
        { atMs: durationMs, value: 0, easing }
      ];
      break;
    case "final-callout":
      style = { fontWeight: 800, lineHeight: 1.06 };
      keyframes.opacity = opacityIn(durationMs, easing);
      keyframes["transform.scale"] = [
        { atMs: 0, value: scaleFrom, easing },
        { atMs: durationMs, value: 1, easing }
      ];
      break;
  }

  return {
    ok: true,
    presetId: preset.id,
    style,
    keyframes,
    warnings: []
  };
}

export function applyTypographyPresetToLayer(
  layer: MotionLayer,
  id: string,
  options: CompileTypographyPresetOptions = {}
): ApplyTypographyPresetResult {
  if (layer.type !== "text" && layer.type !== "caption") {
    return {
      ok: false,
      presetId: id,
      error: `typography presets require a text or caption layer, received ${layer.type}`
    };
  }

  const compiled = compileTypographyPreset(id, { ...options, totalDurationMs: options.totalDurationMs ?? layer.durationMs });
  if (!compiled.ok) return compiled;
  // Every typography preset writes `opacity`, so applying one to a layer the author had already
  // animated used to discard that curve in silence. Same shared rule as the transition presets.
  const merged = replaceKeyframeTracks(layer.keyframes, compiled.keyframes);
  return {
    ok: true,
    presetId: compiled.presetId,
    layer: {
      ...layer,
      style: {
        ...(layer.style ?? {}),
        ...compiled.style
      },
      keyframes: merged.keyframes
    },
    warnings: [...compiled.warnings, ...replacedTrackWarnings(compiled.presetId, layer.id, merged.replaced)]
  };
}

function cloneTypographyPreset(preset: TypographyPreset): TypographyPreset {
  return {
    ...preset,
    compatibleLanes: [...preset.compatibleLanes],
    shellxSurfaces: [...preset.shellxSurfaces],
    bestFor: [...preset.bestFor],
    textFit: { ...preset.textFit }
  };
}

function normalizeDuration(value: number): number {
  return Math.max(80, Math.round(value));
}

function opacityIn(durationMs: number, easing: string): MotionKeyframe[] {
  return [
    { atMs: 0, value: 0, easing },
    { atMs: durationMs, value: 1, easing }
  ];
}
