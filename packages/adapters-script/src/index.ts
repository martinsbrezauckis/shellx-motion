import {
  assertPublicSourceUrl,
  canonicalJsonSha256,
  hashBuffer,
  type MotionDocument,
  type MotionLayer,
  type MotionScene,
  type OperationReceipt,
  type PackageManifest,
  compareCodeUnits,
} from "@shellx-motion/core";
import {
  publishScriptedMotionPackage,
  type WriteScriptedMotionPackageOptions,
  type WrittenScriptedMotionPackage
} from "./scripted-package-publication.js";
import {
  assertScriptedVideoArrayEntryLimit,
  assertScriptedVideoGeneratedWork,
  assertScriptedVideoMetadataAdmission,
  assertScriptedVideoString,
  normalizeScriptedTemplateVariables,
} from "./scripted-video-admission.js";

export type { WriteScriptedMotionPackageOptions, WrittenScriptedMotionPackage } from "./scripted-package-publication.js";

export interface ConvertScriptedFramesOptions {
  createdAt?: string;
  createdBy?: string;
  inputPath?: string;
}

export interface ScriptedMotionExport {
  manifest: PackageManifest;
  motion: MotionDocument;
  receipt: OperationReceipt;
}

type JsonRecord = Record<string, unknown>;

export interface ScriptedVideo {
  schema: "shellx-motion/scripted-video@1";
  id: string;
  name: string;
  sourceApp: string;
  workflow: string;
  intent?: string;
  synopsis?: string;
  review?: ScriptedReview;
  width: number;
  height: number;
  fps: number;
  frames: ScriptedFrame[];
}

interface ScriptedReview {
  status: string;
  required?: boolean;
}

interface ScriptedSourceRef {
  type: string;
  title?: string;
  url?: string;
  path?: string;
}

interface ScriptedTemplateHint {
  id: string;
  engine: string;
  variables?: JsonRecord;
}

interface ScriptedEngineHint {
  id: string;
  mode?: string;
  capability?: string;
}

interface ScriptedFrame {
  id: string;
  title: string;
  body?: string;
  caption?: string;
  durationMs: number;
  background?: string;
  accent?: string;
  reviewStatus?: string;
  agentNote?: string;
  assetRefs: string[];
  sourceRefs: ScriptedSourceRef[];
  tags: string[];
  template?: ScriptedTemplateHint;
  engine?: ScriptedEngineHint;
  effects: ScriptedFrameEffect[];
}

type ScriptedFrameEffectType = "rain" | "signalPulse" | "cameraPush" | "particleField" | "scanSweep";
type ScriptedFrameEffectShape = "rect" | "ellipse" | "star";

interface ScriptedFrameEffect {
  type: ScriptedFrameEffectType;
  intensity?: number;
  speed?: number;
  opacity?: number;
  angle?: number;
  color?: string;
  seed?: string;
  scale?: number;
  x?: number;
  y?: number;
  shape?: ScriptedFrameEffectShape;
}

const DEFAULT_INPUT_PATH = "scripted-video.json";
const MIN_FRAME_DURATION_MS = 100;
const MAX_FRAME_DURATION_MS = 60_000;
const MAX_FRAME_COUNT = 120;
const MAX_TOTAL_DURATION_MS = 600_000;

export function convertScriptedFramesToMotionPackage(input: unknown, options: ConvertScriptedFramesOptions = {}): ScriptedMotionExport {
  const scripted = normalizeScriptedVideoInput(input);
  assertScriptedVideoGeneratedWork(scripted.frames);
  const slug = slugId(scripted.id);
  const packageId = `pkg_script_${slug}`;
  const motionId = `motion_script_${slug}`;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const timelineFrames = scripted.frames.map((frame, index) => {
    const startMs = startMsFor(scripted.frames, index);
    const sceneId = sceneIdFor(frame);
    const layers = frameLayers(frame, {
      startMs,
      width: scripted.width,
      height: scripted.height,
      sceneId
    });
    return { frame, startMs, sceneId, layers };
  });
  const layers = timelineFrames.flatMap((frame) => frame.layers);
  const scenes = timelineFrames.map(({ frame, startMs, sceneId, layers: sceneLayers }) => frameScene(frame, {
    sceneId,
    startMs,
    layerIds: sceneLayers.map((layer) => layer.id)
  }));
  const assetRefs = uniqueSorted(scripted.frames.flatMap((frame) => frame.assetRefs));
  const manifestData = manifestDataFor(scripted);
  const storyboardSummary = storyboardSummaryFor(scripted);
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1",
    id: motionId,
    name: scripted.name,
    durationMs: scripted.frames.reduce((total, frame) => total + frame.durationMs, 0),
    fps: scripted.fps,
    width: scripted.width,
    height: scripted.height,
    background: scripted.frames[0]?.background ?? "#111827",
    scenes,
    layers,
    assets: [],
    provenance: {
      sourceApp: scripted.sourceApp,
      createdBy: options.createdBy ?? "script-adapter",
      workflow: scripted.workflow,
      sourceSchema: scripted.schema
    }
  };
  const manifest: PackageManifest = {
    schema: "shellx-motion/package-manifest@1",
    id: packageId,
    name: scripted.name,
    motion: "motion.json",
    assets: assetRefs,
    sourceApp: scripted.sourceApp,
    compatibility: {
      lanes: ["native", "browser", "ffmpeg", "cut"],
      hosts: ["shellx-motion", "shellx-cut"]
    },
    workflow: scripted.workflow,
    ...(manifestData ? { data: manifestData } : {})
  };

  return {
    manifest,
    motion,
    receipt: createScriptReceipt({
      packageId,
      motionId,
      manifestId: manifest.id,
      sourceApp: scripted.sourceApp,
      workflow: scripted.workflow,
      frameCount: scripted.frames.length,
      layerCount: motion.layers.length,
      durationMs: motion.durationMs,
      storyboard: storyboardSummary,
      createdAt,
      inputPath: options.inputPath ?? DEFAULT_INPUT_PATH,
      inputHash: hashCanonical(scripted)
    })
  };
}

export async function writeScriptedMotionPackage(
  scriptedExport: ScriptedMotionExport,
  options: WriteScriptedMotionPackageOptions
): Promise<WrittenScriptedMotionPackage> {
  return await publishScriptedMotionPackage(scriptedExport, options);
}

function frameLayers(frame: ScriptedFrame, layout: { startMs: number; width: number; height: number; sceneId: string }): MotionLayer[] {
  const accent = frame.accent ?? "#38bdf8";
  const background = frame.background ?? "#111827";
  const scale = Math.min(layout.width / 1280, layout.height / 720);
  const frameSlug = slugId(frame.id);
  const layerPrefix = `frame_${frameSlug}`;
  const safeX = Math.round(layout.width * 0.075);
  const signalY = Math.round(layout.height * 0.08);
  const railWidth = Math.max(14, Math.round(layout.width * 0.014));
  const panelX = safeX;
  const panelY = Math.round(layout.height * 0.25);
  const panelWidth = Math.round(layout.width * 0.7);
  const panelHeight = Math.round(layout.height * 0.5);
  const titleX = Math.round(layout.width * 0.1125);
  const titleY = Math.round(layout.height * 0.341);
  const titleWidth = Math.round(layout.width * 0.5875);
  const titleHeight = Math.round(layout.height * 0.176);
  const bodyX = Math.round(layout.width * 0.1146);
  const bodyY = Math.round(layout.height * 0.556);
  const bodyWidth = Math.round(layout.width * 0.575);
  const bodyHeight = Math.round(layout.height * 0.111);
  const captionPlateX = titleX;
  const captionPlateY = Math.round(layout.height * 0.646);
  const captionPlateWidth = Math.round(layout.width * 0.34);
  const captionPlateHeight = Math.round(layout.height * 0.07);
  const captionY = captionPlateY + Math.round(layout.height * 0.019);
  const captionWidth = Math.round(layout.width * 0.29);
  const captionHeight = Math.round(layout.height * 0.04);
  const storyboardRef = { frameId: frame.id, sceneId: layout.sceneId };
  const backgroundLayer: MotionLayer = {
    id: `${layerPrefix}_background`,
    type: "shape",
    shape: "rect",
    startMs: layout.startMs,
    durationMs: frame.durationMs,
    transform: { x: 0, y: 0, scale: 1 },
    width: layout.width,
    height: layout.height,
    style: { fill: background },
    "x-storyboard": storyboardRef
  };
  const accentRailLayer: MotionLayer = {
    id: `${layerPrefix}_accent_rail`,
    type: "shape",
    shape: "rect",
    startMs: layout.startMs,
    durationMs: frame.durationMs,
    transform: { x: 0, y: 0, width: railWidth, height: layout.height, scale: 1 },
    style: { fill: accent },
    "x-storyboard": storyboardRef
  };
  const signalBarLayer: MotionLayer = {
    id: `${layerPrefix}_signal_bar`,
    type: "shape",
    shape: "rect",
    startMs: layout.startMs,
    durationMs: frame.durationMs,
    transform: {
      x: safeX,
      y: signalY,
      width: Math.round(layout.width * 0.18),
      height: Math.max(6, Math.round(layout.height * 0.011)),
      scale: 1
    },
    style: { fill: accent, radius: Math.round(4 * scale) },
    "x-storyboard": storyboardRef
  };
  const panelLayer: MotionLayer = {
    id: `${layerPrefix}_panel`,
    type: "shape",
    shape: "rect",
    startMs: layout.startMs,
    durationMs: frame.durationMs,
    transform: { x: panelX, y: panelY, width: panelWidth, height: panelHeight, scale: 1 },
    style: {
      fill: rgbaFromHex(background, 0.78),
      stroke: accent,
      strokeWidth: Math.max(2, Math.round(1.5 * scale)),
      radius: Math.round(24 * scale)
    },
    "x-storyboard": storyboardRef
  };
  const kickerLayer: MotionLayer = {
    id: `${layerPrefix}_kicker`,
    type: "text",
    text: kickerText(frame),
    startMs: layout.startMs,
    durationMs: frame.durationMs,
    transform: {
      x: titleX,
      y: Math.round(layout.height * 0.305),
      width: Math.round(layout.width * 0.34),
      height: Math.round(layout.height * 0.04),
      scale: 1
    },
    style: {
      color: accent,
      fontSize: Math.round(18 * scale),
      fontWeight: 900,
      lineHeight: 1.05,
      letterSpacing: 0
    },
    "x-storyboard": storyboardRef
  };
  const titleLayer: MotionLayer = {
    id: `${layerPrefix}_title`,
    type: "text",
    text: frame.title,
    startMs: layout.startMs,
    durationMs: frame.durationMs,
    transform: { x: titleX, y: titleY, width: titleWidth, height: titleHeight, scale: 1 },
    style: { color: "#ffffff", fontSize: Math.round(64 * scale), fontWeight: 900, lineHeight: 1.02, width: titleWidth, accent },
    "x-storyboard": storyboardRef
  };
  const rainEffects = frame.effects.filter((effect) => effect.type === "rain");
  const rainLayers = rainEffects.flatMap((effect, rainGroupIndex) =>
    rainLayersForEffect(effect, {
        frame,
        layerPrefix,
        layout,
        rainGroupIndex,
        rainGroupCount: rainEffects.length,
        scale,
        storyboardRef
      })
  );
  const particleEffects = frame.effects.filter((effect) => effect.type === "particleField");
  const particleLayers = particleEffects.flatMap((effect, particleGroupIndex) =>
    particleLayersForEffect(effect, {
      frame,
      layerPrefix,
      layout,
      particleGroupIndex,
      particleGroupCount: particleEffects.length,
      scale,
      storyboardRef
    })
  );
  const scanSweepEffects = frame.effects.filter((effect) => effect.type === "scanSweep");
  const scanSweepLayers = scanSweepEffects.map((effect, scanSweepIndex) =>
    scanSweepLayerForEffect(effect, {
      frame,
      layerPrefix,
      layout,
      scanSweepIndex,
      scanSweepCount: scanSweepEffects.length,
      scale,
      storyboardRef
    })
  );
  const layers = [backgroundLayer, ...rainLayers, ...particleLayers, ...scanSweepLayers, accentRailLayer, signalBarLayer, panelLayer, kickerLayer, titleLayer];
  if (frame.body) {
    layers.push({
      id: `${layerPrefix}_body`,
      type: "text",
      text: frame.body,
      startMs: layout.startMs,
      durationMs: frame.durationMs,
      transform: { x: bodyX, y: bodyY, width: bodyWidth, height: bodyHeight, scale: 1 },
      style: { color: "#d8e6f3", fontSize: Math.round(28 * scale), fontWeight: 650, lineHeight: 1.18, width: bodyWidth },
      "x-storyboard": storyboardRef
    });
  }
  if (frame.caption) {
    layers.push({
      id: `${layerPrefix}_caption_plate`,
      type: "shape",
      shape: "rect",
      startMs: layout.startMs,
      durationMs: frame.durationMs,
      transform: { x: captionPlateX, y: captionPlateY, width: captionPlateWidth, height: captionPlateHeight, scale: 1 },
      style: { fill: rgbaFromHex(accent, 0.16), stroke: accent, strokeWidth: Math.max(1, Math.round(scale)), radius: Math.round(14 * scale) },
      "x-storyboard": storyboardRef
    });
    layers.push({
      id: `${layerPrefix}_caption`,
      type: "caption",
      text: frame.caption,
      startMs: layout.startMs,
      durationMs: frame.durationMs,
      transform: { x: captionPlateX + Math.round(layout.width * 0.018), y: captionY, width: captionWidth, height: captionHeight, scale: 1 },
      style: { color: accent, fontSize: Math.round(22 * scale), fontWeight: 900, width: captionWidth },
      "x-storyboard": storyboardRef
    });
  }

  applySignalPulseEffects(frame.effects, signalBarLayer, layout);
  applyCameraPushEffects(frame.effects, layers, layout);

  return layers;
}

function particleLayersForEffect(
  effect: ScriptedFrameEffect,
  input: {
    frame: ScriptedFrame;
    layerPrefix: string;
    layout: { startMs: number; width: number; height: number; sceneId: string };
    particleGroupIndex: number;
    particleGroupCount: number;
    scale: number;
    storyboardRef: JsonRecord;
  }
): MotionLayer[] {
  const count = effect.intensity ?? 12;
  const opacity = effect.opacity ?? 0.34;
  const speed = effect.speed ?? 1;
  const color = effect.color ?? "#f8fafc";
  const shape = effect.shape ?? "ellipse";
  const seed = effect.seed ?? input.frame.id;
  const baseSize = Math.max(5, Math.round(10 * input.scale));
  const driftX = effect.x ?? Math.round(input.layout.width * 0.014 * speed);
  const driftY = effect.y ?? Math.round(-input.layout.height * 0.018 * speed);
  const scalePeak = effect.scale ?? 1.08;
  const startAtMs = input.layout.startMs;
  const midAtMs = input.layout.startMs + Math.round(input.frame.durationMs / 2);
  const endAtMs = input.layout.startMs + input.frame.durationMs;
  const fadeInAtMs = input.layout.startMs + Math.round(input.frame.durationMs * 0.15);
  const fadeOutAtMs = input.layout.startMs + Math.round(input.frame.durationMs * 0.85);

  return Array.from({ length: count }, (_entry, index): MotionLayer => {
    const width = Math.max(3, Math.round(baseSize * (0.55 + seededUnit(seed, index, "size") * 0.9)));
    const height = shape === "rect" ? Math.max(2, Math.round(width * (0.42 + seededUnit(seed, index, "height") * 0.38))) : width;
    const x = Math.round(input.layout.width * (0.08 + seededUnit(seed, index, "x") * 0.84));
    const y = Math.round(input.layout.height * (0.07 + seededUnit(seed, index, "y") * 0.76));
    const deltaXDirection = seededUnit(seed, index, "x-dir") >= 0.5 ? 1 : -1;
    const deltaYDirection = seededUnit(seed, index, "y-dir") >= 0.5 ? 1 : -1;
    const deltaX = nonZeroRound(driftX * deltaXDirection * (0.55 + seededUnit(seed, index, "dx") * 0.9));
    const deltaY = nonZeroRound(driftY * deltaYDirection * (0.55 + seededUnit(seed, index, "dy") * 0.9));
    const startScale = Number((0.7 + seededUnit(seed, index, "scale-start") * 0.35).toFixed(3));
    const endScale = Number((startScale * (0.82 + seededUnit(seed, index, "scale-end") * 0.18)).toFixed(3));
    const layerId = input.particleGroupCount > 1
      ? `${input.layerPrefix}_particle_${String(input.particleGroupIndex).padStart(2, "0")}_${String(index).padStart(2, "0")}`
      : `${input.layerPrefix}_particle_${String(index).padStart(2, "0")}`;
    return {
      id: layerId,
      type: "shape",
      shape,
      startMs: input.layout.startMs,
      durationMs: input.frame.durationMs,
      opacity,
      transform: { x, y, width, height, scale: startScale },
      style: { fill: color, ...(shape === "rect" ? { radius: Math.max(1, Math.round(width / 3)) } : {}) },
      keyframes: {
        "transform.x": [
          { atMs: startAtMs, value: x, easing: "ease-out" },
          { atMs: endAtMs, value: x + deltaX }
        ],
        "transform.y": [
          { atMs: startAtMs, value: y, easing: "ease-out" },
          { atMs: endAtMs, value: y + deltaY }
        ],
        "transform.scale": [
          { atMs: startAtMs, value: startScale, easing: "ease-out" },
          { atMs: midAtMs, value: Number((startScale * scalePeak).toFixed(3)), easing: "ease-in-out" },
          { atMs: endAtMs, value: endScale }
        ],
        opacity: [
          { atMs: startAtMs, value: 0 },
          { atMs: fadeInAtMs, value: opacity, easing: "ease-out" },
          { atMs: fadeOutAtMs, value: opacity, easing: "linear" },
          { atMs: endAtMs, value: 0, easing: "ease-in" }
        ]
      },
      "x-storyboard": {
        ...input.storyboardRef,
        effect: { type: "particleField", groupIndex: input.particleGroupIndex, index, seed }
      }
    };
  });
}

function scanSweepLayerForEffect(
  effect: ScriptedFrameEffect,
  input: {
    frame: ScriptedFrame;
    layerPrefix: string;
    layout: { startMs: number; width: number; height: number; sceneId: string };
    scanSweepIndex: number;
    scanSweepCount: number;
    scale: number;
    storyboardRef: JsonRecord;
  }
): MotionLayer {
  const intensity = effect.intensity ?? 0.35;
  const opacity = effect.opacity ?? 0.22;
  const speed = effect.speed ?? 1;
  const angle = effect.angle ?? -12;
  const color = effect.color ?? "#ffffff";
  const sweepWidth = Math.max(24, Math.round(input.layout.width * (0.035 + intensity * 0.08)));
  const sweepHeight = Math.round(input.layout.height * 1.35);
  const startX = -sweepWidth - Math.round(input.layout.width * 0.12 * speed);
  const endX = input.layout.width + sweepWidth + Math.round(input.layout.width * 0.12 * speed);
  const y = -Math.round(input.layout.height * 0.16);
  const startAtMs = input.layout.startMs;
  const endAtMs = input.layout.startMs + input.frame.durationMs;
  const fadeInAtMs = input.layout.startMs + Math.round(input.frame.durationMs * 0.2);
  const fadeOutAtMs = input.layout.startMs + Math.round(input.frame.durationMs * 0.8);
  const layerId = input.scanSweepCount > 1
    ? `${input.layerPrefix}_scan_sweep_${String(input.scanSweepIndex).padStart(2, "0")}`
    : `${input.layerPrefix}_scan_sweep`;

  return {
    id: layerId,
    type: "shape",
    shape: "rect",
    startMs: input.layout.startMs,
    durationMs: input.frame.durationMs,
    opacity,
    transform: { x: startX, y, width: sweepWidth, height: sweepHeight, rotation: angle, scale: 1 },
    style: { fill: color, radius: Math.round(18 * input.scale) },
    keyframes: {
      "transform.x": [
        { atMs: startAtMs, value: startX, easing: "ease-out" },
        { atMs: endAtMs, value: endX, easing: "ease-in" }
      ],
      opacity: [
        { atMs: startAtMs, value: 0 },
        { atMs: fadeInAtMs, value: opacity, easing: "ease-out" },
        { atMs: fadeOutAtMs, value: opacity, easing: "linear" },
        { atMs: endAtMs, value: 0, easing: "ease-in" }
      ]
    },
    "x-storyboard": {
      ...input.storyboardRef,
      effect: { type: "scanSweep", groupIndex: input.scanSweepIndex }
    }
  };
}

function rainLayersForEffect(
  effect: ScriptedFrameEffect,
  input: {
    frame: ScriptedFrame;
    layerPrefix: string;
    layout: { startMs: number; width: number; height: number; sceneId: string };
    rainGroupIndex: number;
    rainGroupCount: number;
    scale: number;
    storyboardRef: JsonRecord;
  }
): MotionLayer[] {
  const count = effect.intensity ?? 16;
  const opacity = effect.opacity ?? 0.24;
  const speed = effect.speed ?? 1;
  const angle = effect.angle ?? -10;
  const color = effect.color ?? "#bfdbfe";
  const seed = effect.seed ?? input.frame.id;
  const dropWidth = Math.max(2, Math.round(2 * input.scale));
  const dropHeight = Math.max(32, Math.round(78 * input.scale * speed));
  const travel = Math.round(input.layout.height + dropHeight * 4 + (input.layout.height * 0.18 * speed));
  const startAtMs = input.layout.startMs;
  const endAtMs = input.layout.startMs + input.frame.durationMs;
  const fadeInAtMs = input.layout.startMs + Math.round(input.frame.durationMs * 0.15);
  const fadeOutAtMs = input.layout.startMs + Math.round(input.frame.durationMs * 0.9);

  return Array.from({ length: count }, (_entry, index): MotionLayer => {
    const x = Math.round(seededUnit(seed, index, "x") * input.layout.width);
    const y = -dropHeight - Math.round(seededUnit(seed, index, "y") * input.layout.height * 0.4);
    const layerId = input.rainGroupCount > 1
      ? `${input.layerPrefix}_rain_${String(input.rainGroupIndex).padStart(2, "0")}_${String(index).padStart(2, "0")}`
      : `${input.layerPrefix}_rain_${String(index).padStart(2, "0")}`;
    return {
      id: layerId,
      type: "shape",
      shape: "rect",
      startMs: input.layout.startMs,
      durationMs: input.frame.durationMs,
      opacity,
      transform: { x, y, width: dropWidth, height: dropHeight, rotation: angle, scale: 1 },
      style: { fill: color, radius: Math.max(1, Math.round(dropWidth / 2)) },
      keyframes: {
        "transform.y": [
          { atMs: startAtMs, value: y, easing: "linear" },
          { atMs: endAtMs, value: y + travel }
        ],
        opacity: [
          { atMs: startAtMs, value: 0 },
          { atMs: fadeInAtMs, value: opacity, easing: "ease-out" },
          { atMs: fadeOutAtMs, value: opacity, easing: "linear" },
          { atMs: endAtMs, value: 0, easing: "ease-in" }
        ]
      },
      "x-storyboard": {
        ...input.storyboardRef,
        effect: { type: "rain", groupIndex: input.rainGroupIndex, index, seed }
      }
    };
  });
}

function applySignalPulseEffects(
  effects: ScriptedFrameEffect[],
  signalBarLayer: MotionLayer,
  layout: { startMs: number }
): void {
  const effect = effects.find((entry) => entry.type === "signalPulse");
  if (!effect) return;

  const transform = signalBarLayer.transform ?? {};
  const baseWidth = typeof transform.width === "number" ? transform.width : 0;
  if (baseWidth <= 0) return;

  const durationMs = signalBarLayer.durationMs;
  const startAtMs = layout.startMs;
  const midAtMs = layout.startMs + Math.round(durationMs / 2);
  const endAtMs = layout.startMs + durationMs;
  const intensity = effect.intensity ?? 0.45;
  signalBarLayer.opacity = 0.85;
  signalBarLayer.keyframes = {
    ...(signalBarLayer.keyframes ?? {}),
    "transform.width": [
      { atMs: startAtMs, value: baseWidth, easing: "ease-out" },
      { atMs: midAtMs, value: Math.round(baseWidth * (1 + intensity)), easing: "ease-in-out" },
      { atMs: endAtMs, value: baseWidth, easing: "ease-in" }
    ],
    opacity: [
      { atMs: startAtMs, value: 0.85 },
      { atMs: midAtMs, value: 0.45 },
      { atMs: endAtMs, value: 0.85 }
    ]
  };
}

function applyCameraPushEffects(
  effects: ScriptedFrameEffect[],
  layers: MotionLayer[],
  layout: { startMs: number }
): void {
  const effect = effects.find((entry) => entry.type === "cameraPush");
  if (!effect) return;

  const scale = effect.scale ?? 1.025;
  const x = effect.x ?? -12;
  const y = effect.y ?? -8;
  const startAtMs = layout.startMs;
  const endAtMs = layout.startMs + (layers[0]?.durationMs ?? 0);
  const pushTargets = layers.filter((layer) =>
    !layer.id.endsWith("_background")
    && !layer.id.includes("_rain_")
    && !layer.id.includes("_particle_")
    && !layer.id.includes("_scan_sweep")
    && !layer.id.endsWith("_accent_rail")
  );

  for (const layer of pushTargets) {
    const transform = layer.transform ?? {};
    const baseX = typeof transform.x === "number" ? transform.x : 0;
    const baseY = typeof transform.y === "number" ? transform.y : 0;
    const baseScale = typeof transform.scale === "number" ? transform.scale : 1;
    layer.keyframes = {
      ...(layer.keyframes ?? {}),
      "transform.x": [
        { atMs: startAtMs, value: baseX, easing: "ease-out" },
        { atMs: endAtMs, value: Math.round(baseX + x) }
      ],
      "transform.y": [
        { atMs: startAtMs, value: baseY, easing: "ease-out" },
        { atMs: endAtMs, value: Math.round(baseY + y) }
      ],
      "transform.scale": [
        { atMs: startAtMs, value: baseScale, easing: "ease-out" },
        { atMs: endAtMs, value: Number((baseScale * scale).toFixed(4)) }
      ]
    };
  }
}

function kickerText(frame: ScriptedFrame): string {
  const tag = frame.tags[0];
  if (tag) return tag.toUpperCase();
  return frame.engine?.capability?.toUpperCase() ?? "SHELLX MOTION";
}

function rgbaFromHex(value: string, alpha: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) return value;
  const hex = match[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function frameScene(frame: ScriptedFrame, input: { sceneId: string; startMs: number; layerIds: string[] }): MotionScene {
  return {
    id: input.sceneId,
    name: titleCase(frame.id),
    startMs: input.startMs,
    durationMs: frame.durationMs,
    layerIds: input.layerIds,
    "x-storyboard": storyboardMetadataFor(frame)
  };
}

function storyboardMetadataFor(frame: ScriptedFrame): JsonRecord {
  return cleanRecord({
    frameId: frame.id,
    reviewStatus: frame.reviewStatus,
    agentNote: frame.agentNote,
    template: frame.template,
    engine: frame.engine,
    effects: frame.effects.length > 0 ? frame.effects : undefined,
    sourceRefs: frame.sourceRefs.length > 0 ? frame.sourceRefs : undefined,
    assetRefs: frame.assetRefs.length > 0 ? frame.assetRefs : undefined,
    tags: frame.tags.length > 0 ? frame.tags : undefined
  });
}

function manifestDataFor(scripted: ScriptedVideo): JsonRecord | undefined {
  const data = cleanRecord({
    intent: scripted.intent,
    synopsis: scripted.synopsis,
    review: scripted.review
  });
  return Object.keys(data).length > 0 ? data : undefined;
}

function storyboardSummaryFor(scripted: ScriptedVideo): JsonRecord | undefined {
  const assetRefCount = uniqueSorted(scripted.frames.flatMap((frame) => frame.assetRefs)).length;
  const sourceRefCount = scripted.frames.reduce((total, frame) => total + frame.sourceRefs.length, 0);
  const templateHintCount = scripted.frames.filter((frame) => frame.template).length;
  const engineHintCount = scripted.frames.filter((frame) => frame.engine).length;
  const effectHintCount = scripted.frames.reduce((total, frame) => total + frame.effects.length, 0);
  const needsReviewCount = scripted.frames.filter((frame) => frame.reviewStatus === "needs-review").length;
  const hasStoryboardMetadata = Boolean(scripted.intent || scripted.synopsis || scripted.review)
    || assetRefCount > 0
    || sourceRefCount > 0
    || templateHintCount > 0
    || engineHintCount > 0
    || effectHintCount > 0
    || scripted.frames.some((frame) => frame.reviewStatus || frame.agentNote || frame.tags.length > 0);
  if (!hasStoryboardMetadata) return undefined;
  return cleanRecord({
    intent: scripted.intent,
    reviewStatus: scripted.review?.status,
    reviewRequired: scripted.review?.required,
    sceneCount: scripted.frames.length,
    templateHintCount,
    engineHintCount,
    effectHintCount,
    assetRefCount,
    sourceRefCount,
    needsReviewCount
  });
}

function startMsFor(frames: ScriptedFrame[], index: number): number {
  return frames.slice(0, index).reduce((total, frame) => total + frame.durationMs, 0);
}

function createScriptReceipt(input: {
  packageId: string;
  motionId: string;
  manifestId: string;
  sourceApp: string;
  workflow: string;
  frameCount: number;
  layerCount: number;
  durationMs: number;
  storyboard?: JsonRecord;
  createdAt: string;
  inputPath: string;
  inputHash: string;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `receipt_script_compile_${input.packageId}`,
    operation: "script.compile",
    status: "passed",
    packageId: input.packageId,
    inputHashes: {
      [input.inputPath]: input.inputHash
    },
    createdAt: input.createdAt,
    lane: "script",
    output: {
      sourceApp: input.sourceApp,
      workflow: input.workflow,
      motionId: input.motionId,
      manifestId: input.manifestId,
      frameCount: input.frameCount,
      layerCount: input.layerCount,
      durationMs: input.durationMs,
      ...(input.storyboard ? { storyboard: input.storyboard } : {})
    },
    warnings: []
  };
}

/** Normalize the closed scripted-video schema before a caller serializes or retains it. */
export function normalizeScriptedVideoInput(input: unknown): ScriptedVideo {
  const root = expectRecord(input, "scripted video");
  const schema = expectString(root, "schema", "scripted video");
  if (schema !== "shellx-motion/scripted-video@1") {
    throw new Error(`Unsupported scripted video schema: ${schema}`);
  }

  const rawFrames = expectArray(root, "frames", "scripted video");
  if (rawFrames.length === 0) {
    throw new Error("Scripted video requires at least one frame.");
  }
  if (rawFrames.length > MAX_FRAME_COUNT) {
    throw new Error(`Scripted video supports at most ${MAX_FRAME_COUNT} frames.`);
  }
  const frames = rawFrames.map((frame, index) => parseFrame(frame, `frames[${index}]`));
  assertScriptedVideoEnvelope(frames);
  assertScriptedVideoMetadataAdmission(frames);
  assertUniqueFrameSlugs(frames);
  const id = expectString(root, "id", "scripted video");
  const name = expectString(root, "name", "scripted video");
  const sourceApp = expectString(root, "sourceApp", "scripted video");
  const workflow = expectString(root, "workflow", "scripted video");
  const intent = optionalString(root, "intent", "scripted video");
  const synopsis = optionalString(root, "synopsis", "scripted video");
  const review = parseReview(root.review, "scripted video.review");
  assertSourceDerivedStoryboardContract({ workflow, intent, review, frames });

  return {
    schema,
    id,
    name,
    sourceApp,
    workflow,
    intent,
    synopsis,
    review,
    width: expectIntegerInRange(root, "width", "scripted video", 16, 7680),
    height: expectIntegerInRange(root, "height", "scripted video", 16, 4320),
    fps: expectIntegerInRange(root, "fps", "scripted video", 1, 120),
    frames
  };
}

function parseFrame(input: unknown, path: string): ScriptedFrame {
  const frame = expectRecord(input, path);
  const parsed = {
    id: expectString(frame, "id", path),
    title: expectString(frame, "title", path),
    body: optionalString(frame, "body", path),
    caption: optionalString(frame, "caption", path),
    durationMs: expectIntegerInRange(frame, "durationMs", path, MIN_FRAME_DURATION_MS, MAX_FRAME_DURATION_MS),
    background: optionalString(frame, "background", path),
    accent: optionalString(frame, "accent", path),
    reviewStatus: optionalString(frame, "reviewStatus", path),
    agentNote: optionalString(frame, "agentNote", path),
    assetRefs: optionalStringArray(frame, "assetRefs", path, "assetRefs"),
    sourceRefs: parseSourceRefs(frame.sourceRefs, `${path}.sourceRefs`),
    tags: optionalStringArray(frame, "tags", path, "tags"),
    template: parseTemplateHint(frame.template, `${path}.template`),
    engine: parseEngineHint(frame.engine, `${path}.engine`),
    effects: parseFrameEffects(frame.effects, `${path}.effects`)
  };
  return parsed;
}

function parseReview(value: unknown, path: string): ScriptedReview | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, path);
  const review: ScriptedReview = {
    status: expectString(record, "status", path)
  };
  const required = optionalBoolean(record, "required", path);
  if (required !== undefined) review.required = required;
  return review;
}

function parseSourceRefs(value: unknown, path: string): ScriptedSourceRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Expected ${path} to be an array.`);
  assertScriptedVideoArrayEntryLimit(value, path, "sourceRefs");
  return value.map((entry, index) => {
    const record = expectRecord(entry, `${path}[${index}]`);
    const sourceRef: ScriptedSourceRef = {
      type: expectString(record, "type", `${path}[${index}]`)
    };
    const title = optionalString(record, "title", `${path}[${index}]`);
    const url = optionalString(record, "url", `${path}[${index}]`);
    const sourcePath = optionalString(record, "path", `${path}[${index}]`);
    if (title !== undefined) sourceRef.title = title;
    if (url !== undefined) sourceRef.url = url;
    if (sourcePath !== undefined) sourceRef.path = sourcePath;
    return sourceRef;
  });
}

function parseTemplateHint(value: unknown, path: string): ScriptedTemplateHint | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, path);
  const template: ScriptedTemplateHint = {
    id: expectString(record, "id", path),
    engine: expectString(record, "engine", path)
  };
  if (record.variables !== undefined) template.variables = normalizeScriptedTemplateVariables(record.variables, `${path}.variables`);
  return template;
}

function parseEngineHint(value: unknown, path: string): ScriptedEngineHint | undefined {
  if (value === undefined) return undefined;
  const record = expectRecord(value, path);
  const engine: ScriptedEngineHint = {
    id: expectString(record, "id", path)
  };
  const mode = optionalString(record, "mode", path);
  const capability = optionalString(record, "capability", path);
  if (mode !== undefined) engine.mode = mode;
  if (capability !== undefined) engine.capability = capability;
  return engine;
}

function parseFrameEffects(value: unknown, path: string): ScriptedFrameEffect[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Expected ${path} to be an array.`);
  assertScriptedVideoArrayEntryLimit(value, path, "effects");
  return value.map((entry, index) => parseFrameEffect(entry, `${path}[${index}]`));
}

function parseFrameEffect(value: unknown, path: string): ScriptedFrameEffect {
  const record = expectRecord(value, path);
  const type = expectEffectType(record, path);
  const effect: ScriptedFrameEffect = { type };
  const intensity = type === "rain" || type === "particleField"
    ? optionalIntegerInRange(record, "intensity", path, 1, 48)
    : optionalNumberInRange(record, "intensity", path, 0.1, 1);
  const speed = optionalNumberInRange(record, "speed", path, 0.1, 8);
  const opacity = optionalNumberInRange(record, "opacity", path, 0, 1);
  const angle = optionalNumberInRange(record, "angle", path, -45, 45);
  const color = optionalString(record, "color", path);
  const seed = optionalString(record, "seed", path);
  const scale = optionalNumberInRange(record, "scale", path, 1, 1.2);
  const x = optionalNumberInRange(record, "x", path, -1000, 1000);
  const y = optionalNumberInRange(record, "y", path, -1000, 1000);
  const shape = optionalEffectShape(record, "shape", path);
  if (intensity !== undefined) effect.intensity = intensity;
  if (speed !== undefined) effect.speed = speed;
  if (opacity !== undefined) effect.opacity = opacity;
  if (angle !== undefined) effect.angle = angle;
  if (color !== undefined) effect.color = color;
  if (seed !== undefined) effect.seed = seed;
  if (scale !== undefined) effect.scale = scale;
  if (x !== undefined) effect.x = x;
  if (y !== undefined) effect.y = y;
  if (shape !== undefined) effect.shape = shape;
  return effect;
}

function expectEffectType(input: JsonRecord, path: string): ScriptedFrameEffectType {
  const type = expectString(input, "type", path);
  if (type === "rain" || type === "signalPulse" || type === "cameraPush" || type === "particleField" || type === "scanSweep") return type;
  throw new Error(`${path}.type must be one of: rain, signalPulse, cameraPush, particleField, scanSweep.`);
}

function assertScriptedVideoEnvelope(frames: ScriptedFrame[]): void {
  const totalDurationMs = frames.reduce((total, frame) => total + frame.durationMs, 0);
  if (totalDurationMs > MAX_TOTAL_DURATION_MS) {
    throw new Error(`Scripted video total duration must be at most ${MAX_TOTAL_DURATION_MS}ms.`);
  }
}

function assertUniqueFrameSlugs(frames: ScriptedFrame[]): void {
  const seen = new Set<string>();
  for (const frame of frames) {
    const slug = slugId(frame.id);
    if (seen.has(slug)) {
      throw new Error(`Scripted frame IDs must be unique after sanitization; duplicate slug: ${slug}.`);
    }
    seen.add(slug);
  }
}

function assertSourceDerivedStoryboardContract(input: {
  workflow: string;
  intent?: string;
  review?: ScriptedReview;
  frames: ScriptedFrame[];
}): void {
  if (!isSourceDerivedStoryboard(input.workflow, input.intent)) return;
  if (input.review?.required !== true) {
    throw new Error("Source-derived scripted videos require review.required to be true.");
  }
  input.frames.forEach((frame, frameIndex) => {
    if (frame.sourceRefs.length === 0) {
      throw new Error(`frames[${frameIndex}].sourceRefs must include at least one source reference for source-derived storyboard workflows.`);
    }
    frame.sourceRefs.forEach((sourceRef, refIndex) => {
      const path = `frames[${frameIndex}].sourceRefs[${refIndex}].url`;
      if (!sourceRef.url) {
        throw new Error(`${path} is required for source-derived storyboard workflows.`);
      }
      try {
        assertPublicSourceUrl(sourceRef.url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${path} must be a public http(s) URL: ${message}`);
      }
    });
  });
}

function isSourceDerivedStoryboard(workflow: string, intent: string | undefined): boolean {
  return workflow === "source-to-scripted-video" || intent === "source_to_storyboard";
}

function expectRecord(input: unknown, path: string): JsonRecord {
  if (typeof input === "object" && input !== null && !Array.isArray(input)
    && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)) return input as JsonRecord;
  throw new Error(`Expected ${path} to be an object.`);
}

function expectArray(input: JsonRecord, key: string, path: string): unknown[] {
  const value = input[key];
  if (Array.isArray(value)) return value;
  throw new Error(`Expected ${path}.${key} to be an array.`);
}

function expectString(input: JsonRecord, key: string, path: string): string {
  const value = input[key];
  if (typeof value === "string" && value.length > 0) return assertScriptedVideoString(value, `${path}.${key}`);
  throw new Error(`Expected ${path}.${key} to be a non-empty string.`);
}

function expectNumber(input: JsonRecord, key: string, path: string): number {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Expected ${path}.${key} to be a finite number.`);
}

function expectIntegerInRange(input: JsonRecord, key: string, path: string, min: number, max: number): number {
  const value = expectNumber(input, key, path);
  if (Number.isInteger(value) && value >= min && value <= max) return value;
  throw new Error(`${path}.${key} must be an integer between ${min} and ${max}.`);
}

function optionalString(input: JsonRecord, key: string, path: string): string | undefined {
  if (!(key in input)) return undefined;
  const value = input[key];
  if (typeof value === "string") return assertScriptedVideoString(value, `${path}.${key}`);
  throw new Error(`Expected ${path}.${key} to be a string.`);
}

function optionalBoolean(input: JsonRecord, key: string, path: string): boolean | undefined {
  if (!(key in input)) return undefined;
  const value = input[key];
  if (typeof value === "boolean") return value;
  throw new Error(`Expected ${path}.${key} to be a boolean.`);
}

function optionalIntegerInRange(input: JsonRecord, key: string, path: string, min: number, max: number): number | undefined {
  if (!(key in input)) return undefined;
  const value = input[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
  throw new Error(`${path}.${key} must be an integer between ${min} and ${max}.`);
}

function optionalNumberInRange(input: JsonRecord, key: string, path: string, min: number, max: number): number | undefined {
  if (!(key in input)) return undefined;
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value;
  throw new Error(`${path}.${key} must be a finite number between ${min} and ${max}.`);
}

function optionalEffectShape(input: JsonRecord, key: string, path: string): ScriptedFrameEffectShape | undefined {
  if (!(key in input)) return undefined;
  const value = input[key];
  if (value === "rect" || value === "ellipse" || value === "star") return value;
  throw new Error(`${path}.${key} must be one of: rect, ellipse, star.`);
}

function optionalStringArray(input: JsonRecord, key: string, path: string, collection: "assetRefs" | "tags"): string[] {
  if (!(key in input)) return [];
  const value = input[key];
  if (!Array.isArray(value)) throw new Error(`Expected ${path}.${key} to be an array.`);
  assertScriptedVideoArrayEntryLimit(value, `${path}.${key}`, collection);
  return value.map((entry, index) => {
    if (typeof entry === "string") return assertScriptedVideoString(entry, `${path}.${key}[${index}]`);
    throw new Error(`Expected ${path}.${key}[${index}] to be a string.`);
  });
}

function cleanRecord(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([_key, value]) => value !== undefined));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => compareCodeUnits(left, right));
}

function sceneIdFor(frame: ScriptedFrame): string {
  return `scene_${slugId(frame.id)}`;
}

function titleCase(value: string): string {
  return slugId(value).split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/**
 * Content address of the scripted-video input recorded in the conversion receipt.
 *
 * Delegates to core `canonicalJsonSha256`. The local sorter this replaced sorted with the right
 * comparator but rebuilt each object with `Object.fromEntries`, which re-orders integer-like keys
 * on insertion — so its output was not the code-unit order it had just computed.
 */
function hashCanonical(value: unknown): string {
  return canonicalJsonSha256(value);
}

function slugId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "untitled";
}

function seededUnit(seed: string, index: number, field: string): number {
  const hex = hashBuffer(Buffer.from(`${seed}:${index}:${field}`)).slice(0, 8);
  return parseInt(hex, 16) / 0xffffffff;
}

function nonZeroRound(value: number): number {
  const rounded = Math.round(value);
  if (rounded !== 0) return rounded;
  return value < 0 ? -1 : 1;
}
