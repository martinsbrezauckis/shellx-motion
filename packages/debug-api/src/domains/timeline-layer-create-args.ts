/** Strict parsing for the rich layer payload accepted by timeline.layer.create. */
import {
  readSupportedKeyframeTarget,
  type MotionAudioDucking,
  type MotionCrop,
  type MotionEffects,
  type MotionEnvironment,
  type MotionKeyframe,
  type MotionLayer,
  type MotionMask,
  type MotionTransition
} from "@shellx-motion/core";
import { objectArg, positiveNumberArg, recordArg, stringArg } from "./args.js";

export function timelineLayerCreateArg(
  args: unknown,
  timing: { startMs?: number; durationMs?: number }
): MotionLayer | null {
  const layerRecord = recordArg(args, "layer");
  const source: Record<string, unknown> = layerRecord ? structuredClone(layerRecord) : {};
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  const type = stringArg(args, "type");
  const trackId = stringArg(args, "trackId") ?? stringArg(args, "track");
  const text = stringArg(args, "text");
  const shape = stringArg(args, "shape");
  const fill = stringArg(args, "fill");
  const mediaSource = stringArg(args, "source");
  const src = stringArg(args, "src");
  const assetId = stringArg(args, "assetId");
  const assetRef = stringArg(args, "assetRef");
  const color = stringArg(args, "color");
  const fontSize = positiveNumberArg(args, "fontSize");
  const width = positiveNumberArg(args, "width");
  const height = positiveNumberArg(args, "height");
  if (fontSize === false || width === false || height === false) return null;

  if (layerId) source.id = layerId;
  if (type) source.type = type;
  if (trackId) source.trackId = trackId;
  if (timing.startMs !== undefined) source.startMs = timing.startMs;
  if (timing.durationMs !== undefined) source.durationMs = timing.durationMs;
  if (text !== null) source.text = text;
  if (shape !== null) source.shape = shape;
  if (fill !== null) source.fill = fill;
  if (mediaSource !== null) source.source = mediaSource;
  if (src !== null) source.src = src;
  if (assetId !== null) source.assetId = assetId;
  if (assetRef !== null) source.assetRef = assetRef;
  if (width !== null) source.width = width;
  if (height !== null) source.height = height;
  if (color !== null || fontSize !== null) {
    source.style = {
      ...(objectArg(source.style) ?? {}),
      ...(color !== null ? { color } : {}),
      ...(fontSize !== null ? { fontSize } : {})
    };
  }

  const id = nonEmptyString(source, "id");
  const layerType = nonEmptyString(source, "type");
  const startMs = finiteNumber(source, "startMs");
  const durationMs = finiteNumber(source, "durationMs");
  if (!id || !layerType || startMs === null || durationMs === null) return null;

  const layer: MotionLayer = { id, type: layerType, startMs, durationMs };
  copyString(source, layer, "name");
  copyString(source, layer, "trackId");
  copyString(source, layer, "text");
  copyString(source, layer, "shape");
  copyString(source, layer, "fill");
  copyString(source, layer, "color");
  copyString(source, layer, "source");
  copyString(source, layer, "src");
  copyString(source, layer, "assetId");
  copyString(source, layer, "assetRef");
  copyString(source, layer, "fit");
  copyNumber(source, layer, "width");
  copyNumber(source, layer, "height");
  copyNumber(source, layer, "opacity");
  copyNumber(source, layer, "trimStartMs");
  copyNumber(source, layer, "trimDurationMs");
  copyNumber(source, layer, "playbackRate");
  copyNumber(source, layer, "volume");
  copyNumber(source, layer, "pan");
  copyNumber(source, layer, "fadeInMs");
  copyNumber(source, layer, "fadeOutMs");
  copyBoolean(source, layer, "visible");
  copyBoolean(source, layer, "locked");
  copyBoolean(source, layer, "loop");
  copyBoolean(source, layer, "includeAudio");
  copyBoolean(source, layer, "muted");
  copyBoolean(source, layer, "normalizeLoudness");

  const style = objectArg(source.style);
  if (style) layer.style = style;
  const label = objectArg(source.label);
  if (label) layer.label = label;
  const ducking = duckingValue(source.ducking);
  if (ducking === false) return null;
  if (ducking) layer.ducking = ducking;
  const crop = cropValue(source.crop);
  if (crop === false) return null;
  if (crop) layer.crop = crop;
  const allowedOrigins = allowedOriginsValue(source.allowedOrigins);
  if (allowedOrigins === false) return null;
  if (allowedOrigins) layer.allowedOrigins = allowedOrigins;
  const transform = transformValue(source.transform);
  if (transform === false) return null;
  if (transform) layer.transform = transform;
  const keyframes = keyframesValue(source.keyframes);
  if (keyframes === false) return null;
  if (keyframes) layer.keyframes = keyframes;
  const transitions = transitionsValue(source.transitions);
  if (transitions === false) return null;
  if (transitions) layer.transitions = transitions;
  const mask = maskValue(source.mask);
  if (mask === false) return null;
  if (mask) layer.mask = mask;
  const effects = effectsValue(source.effects);
  if (effects === false) return null;
  if (effects) layer.effects = effects;
  const environment = environmentValue(source.environment);
  if (environment === false) return null;
  if (environment) layer.environment = environment;
  const blendMode = blendModeValue(source.blendMode);
  if (blendMode === false) return null;
  if (blendMode) layer.blendMode = blendMode;
  return layer;
}

const BLEND_MODES: Array<NonNullable<MotionLayer["blendMode"]>> = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter"
];
const DUCKING_NUMBER_KEYS: Array<"duckToVolume" | "attackMs" | "releaseMs" | "threshold" | "ratio"> = ["duckToVolume", "attackMs", "releaseMs", "threshold", "ratio"];
const TRANSFORM_NUMBER_KEYS: Array<"x" | "y" | "width" | "height" | "opacity" | "scale" | "rotation" | "originX" | "originY"> = [
  "x", "y", "width", "height", "opacity", "scale", "rotation", "originX", "originY"
];
const MASK_INSET_NUMBER_KEYS: Array<"top" | "right" | "bottom" | "left"> = ["top", "right", "bottom", "left"];
const EFFECT_NUMBER_KEYS: Array<"blur" | "brightness" | "contrast" | "saturate" | "grayscale"> = [
  "blur", "brightness", "contrast", "saturate", "grayscale"
];

function duckingValue(value: unknown): MotionAudioDucking | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record) return false;
  const triggerLayerIds = stringArray(record.triggerLayerIds);
  if (!triggerLayerIds) return false;
  const ducking: MotionAudioDucking = { triggerLayerIds };
  // Optional ducking mode ("timed" default, or "sidechain"). Range/enum is
  // re-checked by core package validation before render.
  if (record.mode !== undefined) {
    if (record.mode !== "timed" && record.mode !== "sidechain") return false;
    ducking.mode = record.mode;
  }
  for (const key of DUCKING_NUMBER_KEYS) {
    const number = optionalFiniteNumber(record, key);
    if (number === false) return false;
    if (number !== null) ducking[key] = number;
  }
  return ducking;
}

function cropValue(value: unknown): MotionCrop | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record) return false;
  const x = optionalFiniteNumber(record, "x");
  const y = optionalFiniteNumber(record, "y");
  const width = optionalFiniteNumber(record, "width");
  const height = optionalFiniteNumber(record, "height");
  if (x === false || y === false || width === false || height === false) return false;
  if (x === null || y === null || width === null || height === null) return false;
  return { x, y, width, height };
}

function allowedOriginsValue(value: unknown): unknown[] | false | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? structuredClone(value) : false;
}

function transformValue(value: unknown): MotionLayer["transform"] | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record) return false;
  const transform: NonNullable<MotionLayer["transform"]> = {};
  for (const key of TRANSFORM_NUMBER_KEYS) {
    const number = optionalFiniteNumber(record, key);
    if (number === false) return false;
    if (number !== null) transform[key] = number;
  }
  return Object.keys(transform).length > 0 ? transform : null;
}

function keyframesValue(value: unknown): MotionLayer["keyframes"] | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record) return false;
  const keyframes: NonNullable<MotionLayer["keyframes"]> = {};
  for (const [targetValue, framesValue] of Object.entries(record)) {
    const target = readSupportedKeyframeTarget(targetValue);
    if (!target || !Array.isArray(framesValue)) return false;
    const frames: MotionKeyframe[] = [];
    for (const frameValue of framesValue) {
      const frameRecord = objectArg(frameValue);
      if (!frameRecord) return false;
      const atMs = optionalFiniteNumber(frameRecord, "atMs");
      if (atMs === false || atMs === null) return false;
      const frame = keyframeValue(frameRecord.value);
      if (frame === false) return false;
      const easing = optionalString(frameRecord, "easing");
      if (easing === false) return false;
      frames.push({ atMs, value: frame, ...(easing !== null ? { easing } : {}) });
    }
    keyframes[target] = frames;
  }
  return Object.keys(keyframes).length > 0 ? keyframes : null;
}

function transitionsValue(value: unknown): MotionLayer["transitions"] | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record) return false;
  const transitions: NonNullable<MotionLayer["transitions"]> = {};
  const enter = transitionValue(record.in);
  if (enter === false) return false;
  if (enter) transitions.in = enter;
  const exit = transitionValue(record.out);
  if (exit === false) return false;
  if (exit) transitions.out = exit;
  return Object.keys(transitions).length > 0 ? transitions : null;
}

function transitionValue(value: unknown): MotionTransition | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record) return false;
  const type = nonEmptyString(record, "type");
  const durationMs = optionalFiniteNumber(record, "durationMs");
  if (!type || durationMs === false || durationMs === null) return false;
  const transition: MotionTransition = { type, durationMs };
  const easing = optionalString(record, "easing");
  if (easing === false) return false;
  if (easing !== null) transition.easing = easing;
  const direction = optionalString(record, "direction");
  if (direction === false) return false;
  if (direction !== null) transition.direction = direction;
  const distance = optionalFiniteNumber(record, "distance");
  if (distance === false) return false;
  if (distance !== null) transition.distance = distance;
  return transition;
}

function maskValue(value: unknown): MotionMask | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record) return false;
  const type = nonEmptyString(record, "type");
  if (!type) return false;
  const mask: MotionMask = { type };
  const inset = maskInsetValue(record.inset);
  if (inset === false) return false;
  if (inset) mask.inset = inset;
  const radius = optionalFiniteNumber(record, "radius");
  if (radius === false) return false;
  if (radius !== null) mask.radius = radius;
  return mask;
}

function maskInsetValue(value: unknown): NonNullable<MotionMask["inset"]> | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record) return false;
  const inset: NonNullable<MotionMask["inset"]> = {};
  for (const key of MASK_INSET_NUMBER_KEYS) {
    const number = optionalFiniteNumber(record, key);
    if (number === false) return false;
    if (number !== null) inset[key] = number;
  }
  return Object.keys(inset).length > 0 ? inset : null;
}

function effectsValue(value: unknown): MotionEffects | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record) return false;
  const effects: MotionEffects = {};
  for (const key of EFFECT_NUMBER_KEYS) {
    const number = optionalFiniteNumber(record, key);
    if (number === false) return false;
    if (number !== null) effects[key] = number;
  }
  return Object.keys(effects).length > 0 ? effects : null;
}

function environmentValue(value: unknown): MotionEnvironment | false | null {
  if (value === undefined) return null;
  const environment = objectArg(value);
  if (!environment) return false;
  for (const field of ["code", "script", "source", "fragment", "url"]) {
    if (Object.hasOwn(environment, field)) return false;
  }
  const schema = nonEmptyString(environment, "schema");
  const kind = nonEmptyString(environment, "kind");
  const quality = nonEmptyString(environment, "quality");
  const mode = nonEmptyString(environment, "mode");
  const seed = finiteNumber(environment, "seed");
  if (schema !== "shellx-motion/environment@1" || !kind || !quality || !mode || seed === null) return false;
  if (quality !== "preview" && quality !== "balanced" && quality !== "cinematic") return false;
  if (mode !== "scene" && mode !== "overlay") return false;
  const common = { schema: "shellx-motion/environment@1" as const, quality, mode, seed };
  if (kind === "rain") {
    const numbers = requiredNumberFields(environment, ["intensity", "wind", "dropSpeed", "dropLength", "depthLayers"]);
    const colors = requiredStringFields(environment, ["color", "backgroundColor", "lightColor", "accentColor"]);
    const groundRecord = objectArg(environment.ground);
    const atmosphereRecord = objectArg(environment.atmosphere);
    const ground = groundRecord && requiredNumberFields(groundRecord, ["horizon", "wetness", "roughness", "rippleAmount", "splashAmount", "reflectionStrength"]);
    const atmosphere = atmosphereRecord && requiredNumberFields(atmosphereRecord, ["mist", "lensDroplets"]);
    if (!numbers || !colors || !ground || !atmosphere) return false;
    return { ...common, kind: "rain", ...numbers, ...colors, ground, atmosphere } as MotionEnvironment;
  }
  if (kind === "water") {
    const colors = requiredStringFields(environment, ["backgroundColor", "shallowColor", "deepColor", "reflectionColor", "foamColor"]);
    const surfaceRecord = objectArg(environment.surface);
    const opticsRecord = objectArg(environment.optics);
    const surface = surfaceRecord && requiredNumberFields(surfaceRecord, ["horizon", "waveScale", "waveHeight", "waveSpeed", "direction", "choppiness", "waveOctaves"]);
    const optics = opticsRecord && requiredNumberFields(opticsRecord, ["reflectionStrength", "refractionStrength", "fresnel", "caustics", "clarity", "foam"]);
    if (!colors || !surface || !optics) return false;
    return { ...common, kind: "water", ...colors, surface, optics } as MotionEnvironment;
  }
  if (kind === "snow") {
    const colors = requiredStringFields(environment, ["backgroundColor", "snowColor", "shadowColor", "lightColor"]);
    const fallRecord = objectArg(environment.fall);
    const groundRecord = objectArg(environment.ground);
    const atmosphereRecord = objectArg(environment.atmosphere);
    const fall = fallRecord && requiredNumberFields(fallRecord, ["intensity", "speed", "wind", "turbulence", "flakeSize", "depthLayers", "focusFalloff"]);
    const ground = groundRecord && requiredNumberFields(groundRecord, ["horizon", "accumulation", "drift", "contactAmount"]);
    const atmosphere = atmosphereRecord && requiredNumberFields(atmosphereRecord, ["haze", "depthFade"]);
    if (!colors || !fall || !ground || !atmosphere) return false;
    return { ...common, kind: "snow", ...colors, fall, ground, atmosphere } as MotionEnvironment;
  }
  return false;
}

function requiredNumberFields<const Key extends string>(record: Record<string, unknown>, fields: readonly Key[]): Record<Key, number> | null {
  const output = {} as Record<Key, number>;
  for (const field of fields) {
    const value = finiteNumber(record, field);
    if (value === null) return null;
    output[field] = value;
  }
  return output;
}

function requiredStringFields<const Key extends string>(record: Record<string, unknown>, fields: readonly Key[]): Record<Key, string> | null {
  const output = {} as Record<Key, string>;
  for (const field of fields) {
    const value = nonEmptyString(record, field);
    if (!value) return null;
    output[field] = value;
  }
  return output;
}

function blendModeValue(value: unknown): MotionLayer["blendMode"] | false | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return false;
  return BLEND_MODES.find((candidate) => candidate === value) ?? false;
}

function keyframeValue(value: unknown): MotionKeyframe["value"] | false {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return false;
}

function nonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function finiteNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalFiniteNumber(record: Record<string, unknown>, key: string): number | false | null {
  if (!Object.hasOwn(record, key)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : false;
}

function optionalString(record: Record<string, unknown>, key: string): string | false | null {
  if (!Object.hasOwn(record, key)) return null;
  return typeof record[key] === "string" ? record[key] : false;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : null;
}

function copyString<K extends keyof MotionLayer>(source: Record<string, unknown>, layer: MotionLayer, key: K): void {
  const value = source[key as string];
  if (typeof value === "string") (layer as unknown as Record<string, unknown>)[key as string] = value;
}

function copyNumber<K extends keyof MotionLayer>(source: Record<string, unknown>, layer: MotionLayer, key: K): void {
  const value = source[key as string];
  if (typeof value === "number" && Number.isFinite(value)) (layer as unknown as Record<string, unknown>)[key as string] = value;
}

function copyBoolean<K extends keyof MotionLayer>(source: Record<string, unknown>, layer: MotionLayer, key: K): void {
  const value = source[key as string];
  if (typeof value === "boolean") (layer as unknown as Record<string, unknown>)[key as string] = value;
}
