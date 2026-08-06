// One shared rule for "a preset's track lands on a track the author already wrote", so the
// transition and typography families cannot drift about what happens or how it is reported.
import { replaceKeyframeTracks, replacedTrackWarnings } from "./preset-keyframe-tracks";
import type {
  MotionEffects,
  MotionKeyframe,
  MotionKeyframeTarget,
  MotionLayer,
  MotionTransition
} from "./types";
import type { TemplateParitySurface } from "./template-parity";

export type TransitionPresetId =
  | "soft-fade"
  | "slide-cover"
  | "wipe-accent"
  | "card-stack"
  | "push-zoom"
  | "scan-sweep"
  | "split-reveal";

export interface TransitionPreset {
  id: TransitionPresetId;
  label: string;
  family: "subtle" | "spatial" | "accent" | "camera" | "system";
  description: string;
  defaultDurationMs: number;
  compatibleLanes: string[];
  shellxSurfaces: TemplateParitySurface[];
  bestFor: string[];
}

export interface CompileTransitionPresetOptions {
  durationMs?: number;
  totalDurationMs?: number;
  direction?: MotionTransition["direction"];
  distance?: number;
  easing?: string;
}

export type TransitionKeyframes = Partial<Record<MotionKeyframeTarget, MotionKeyframe[]>>;

export type CompileTransitionPresetResult =
  | {
      ok: true;
      presetId: TransitionPresetId;
      transitions: { in?: MotionTransition; out?: MotionTransition };
      keyframes: TransitionKeyframes;
      effects?: MotionEffects;
      warnings: string[];
    }
  | {
      ok: false;
      presetId: string;
      error: string;
    };

export type ApplyTransitionPresetResult =
  | {
      ok: true;
      presetId: TransitionPresetId;
      layer: MotionLayer;
      warnings: string[];
    }
  | {
      ok: false;
      presetId: string;
      error: string;
    };

const TRANSITION_PRESETS: TransitionPreset[] = [
  {
    id: "soft-fade",
    label: "Soft Fade",
    family: "subtle",
    description: "Clean opacity transition for readable titles, captions, and product UI callouts.",
    defaultDurationMs: 420,
    compatibleLanes: ["native", "browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["lower thirds", "captions", "intro/outro copy"]
  },
  {
    id: "slide-cover",
    label: "Slide Cover",
    family: "spatial",
    description: "Directional cover movement for product cards and timeline insertions.",
    defaultDurationMs: 560,
    compatibleLanes: ["native", "browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["card changes", "timeline overlays", "feature callouts"]
  },
  {
    id: "wipe-accent",
    label: "Wipe Accent",
    family: "accent",
    description: "Fast wipe with a small saturation and brightness lift for branded reveals.",
    defaultDurationMs: 480,
    compatibleLanes: ["browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["launch bumpers", "section changes", "brand bars"]
  },
  {
    id: "card-stack",
    label: "Card Stack",
    family: "spatial",
    description: "Layered card movement that keeps product panels readable while adding depth.",
    defaultDurationMs: 620,
    compatibleLanes: ["browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["social cards", "comparison cards", "dashboard snapshots"]
  },
  {
    id: "push-zoom",
    label: "Push Zoom",
    family: "camera",
    description: "Subtle camera push for hero media and screenshots.",
    defaultDurationMs: 640,
    compatibleLanes: ["browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["hero media", "screen captures", "feature reveals"]
  },
  {
    id: "scan-sweep",
    label: "Scan Sweep",
    family: "system",
    description: "Technical scan movement for diagnostics, render passes, and automation-themed clips.",
    defaultDurationMs: 520,
    compatibleLanes: ["browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["debug visuals", "release clips", "automation callouts"]
  },
  {
    id: "split-reveal",
    label: "Split Reveal",
    family: "accent",
    description: "Opposing directional movement for before/after and multi-surface story beats.",
    defaultDurationMs: 580,
    compatibleLanes: ["browser", "ffmpeg"],
    shellxSurfaces: ["motion", "cut", "canvas"],
    bestFor: ["before after", "Cut Canvas Motion handoffs", "comparison beats"]
  }
];

export function listTransitionPresets(): TransitionPreset[] {
  return TRANSITION_PRESETS.map(cloneTransitionPreset);
}

export function getTransitionPreset(id: string): TransitionPreset | undefined {
  const preset = TRANSITION_PRESETS.find((preset) => preset.id === id);
  return preset ? cloneTransitionPreset(preset) : undefined;
}

export function compileTransitionPreset(id: string, options: CompileTransitionPresetOptions = {}): CompileTransitionPresetResult {
  const preset = TRANSITION_PRESETS.find((preset) => preset.id === id);
  if (!preset) {
    return {
      ok: false,
      presetId: id,
      error: `unknown transition preset: ${id}`
    };
  }

  const durationMs = normalizeDuration(options.durationMs ?? preset.defaultDurationMs);
  const totalDurationMs = normalizeDuration(options.totalDurationMs ?? durationMs);
  const easing = options.easing ?? defaultEasing(preset.id);
  const halfDurationMs = Math.max(80, Math.round(durationMs / 2));
  const keyframes: TransitionKeyframes = {};
  let transitions: { in?: MotionTransition; out?: MotionTransition };
  let effects: MotionEffects | undefined;

  switch (preset.id) {
    case "soft-fade":
      transitions = {
        in: { type: "fade", durationMs, easing },
        out: { type: "fade", durationMs: halfDurationMs, easing }
      };
      break;
    case "slide-cover":
      transitions = {
        in: { type: "slide", durationMs, direction: options.direction ?? "up", distance: options.distance ?? 96, easing },
        out: { type: "fade", durationMs: halfDurationMs, easing }
      };
      break;
    case "wipe-accent":
      transitions = {
        in: { type: "wipe", durationMs, direction: options.direction ?? "left", easing },
        out: { type: "fade", durationMs: halfDurationMs, easing }
      };
      effects = { brightness: 1.08, saturate: 1.12 };
      break;
    case "card-stack":
      transitions = {
        in: { type: "slide", durationMs, direction: options.direction ?? "up", distance: options.distance ?? 72, easing },
        out: { type: "slide", durationMs: halfDurationMs, direction: "down", distance: Math.round((options.distance ?? 72) / 2), easing }
      };
      keyframes["transform.rotation"] = [
        { atMs: 0, value: -1.5, easing },
        { atMs: durationMs, value: 0, easing }
      ];
      break;
    case "push-zoom":
      transitions = {
        in: { type: "fade", durationMs, easing },
        out: { type: "fade", durationMs: halfDurationMs, easing }
      };
      keyframes["transform.scale"] = [
        { atMs: 0, value: 0.96, easing: "ease-out" },
        { atMs: durationMs, value: 1, easing: "ease-out" },
        { atMs: totalDurationMs, value: 1.04, easing: "ease-in" }
      ];
      break;
    case "scan-sweep":
      transitions = {
        in: { type: "wipe", durationMs, direction: options.direction ?? "right", easing },
        out: { type: "wipe", durationMs: halfDurationMs, direction: options.direction ?? "right", easing }
      };
      effects = { brightness: 1.1, contrast: 1.08, saturate: 1.04 };
      break;
    case "split-reveal":
      transitions = {
        in: { type: "slide", durationMs, direction: options.direction ?? "left", distance: options.distance ?? 120, easing },
        out: { type: "slide", durationMs: halfDurationMs, direction: "right", distance: options.distance ?? 120, easing }
      };
      break;
  }

  return {
    ok: true,
    presetId: preset.id,
    transitions,
    keyframes,
    ...(effects ? { effects } : {}),
    warnings: []
  };
}

export function applyTransitionPresetToLayer(
  layer: MotionLayer,
  id: string,
  options: CompileTransitionPresetOptions = {}
): ApplyTransitionPresetResult {
  const compiled = compileTransitionPreset(id, { ...options, totalDurationMs: options.totalDurationMs ?? layer.durationMs });
  if (!compiled.ok) return compiled;
  const merged = replaceKeyframeTracks(layer.keyframes, compiled.keyframes);
  return {
    ok: true,
    presetId: compiled.presetId,
    layer: {
      ...layer,
      transitions: {
        ...(layer.transitions ?? {}),
        ...compiled.transitions
      },
      keyframes: merged.keyframes,
      ...(compiled.effects ? { effects: { ...(layer.effects ?? {}), ...compiled.effects } } : {})
    },
    warnings: [...compiled.warnings, ...replacedTrackWarnings(compiled.presetId, layer.id, merged.replaced)]
  };
}

function cloneTransitionPreset(preset: TransitionPreset): TransitionPreset {
  return {
    ...preset,
    compatibleLanes: [...preset.compatibleLanes],
    shellxSurfaces: [...preset.shellxSurfaces],
    bestFor: [...preset.bestFor]
  };
}

function normalizeDuration(value: number): number {
  return Math.max(80, Math.round(value));
}

function defaultEasing(id: TransitionPresetId): string {
  return id === "push-zoom" ? "ease-out" : "ease-out";
}

