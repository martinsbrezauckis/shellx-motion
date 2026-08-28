import {
  readSupportedKeyframeTarget,
  type MotionAudioDucking,
  type MotionCrop,
  type MotionEnvironment,
  type MotionKeyframe,
  type MotionLayer,
  type MotionMask,
  type MotionTransition
} from "@shellx-motion/core";
import { objectArg } from "./args.js";
import { optionalFiniteNumber, optionalString } from "./timeline-particle-emitter-arg.js";

const BLEND_MODES: Array<NonNullable<MotionLayer["blendMode"]>> = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter"
];
const DUCKING_NUMBER_KEYS: Array<"duckToVolume" | "attackMs" | "releaseMs" | "threshold" | "ratio"> = ["duckToVolume", "attackMs", "releaseMs", "threshold", "ratio"];
const TRANSFORM_NUMBER_KEYS: Array<"x" | "y" | "width" | "height" | "opacity" | "scale" | "rotation" | "originX" | "originY"> = [
  "x", "y", "width", "height", "opacity", "scale", "rotation", "originX", "originY"
];
const MASK_INSET_NUMBER_KEYS: Array<"top" | "right" | "bottom" | "left"> = ["top", "right", "bottom", "left"];

export function duckingValue(value: unknown): MotionAudioDucking | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record) return false;
  const triggerLayerIds = stringArray(record.triggerLayerIds);
  if (!triggerLayerIds) return false;
  const ducking: MotionAudioDucking = { triggerLayerIds };
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

export function cropValue(value: unknown): MotionCrop | false | null {
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

export function allowedOriginsValue(value: unknown): unknown[] | false | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? structuredClone(value) : false;
}

export function transformValue(value: unknown): MotionLayer["transform"] | false | null {
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

export function keyframesValue(value: unknown): MotionLayer["keyframes"] | false | null {
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

export function transitionsValue(value: unknown): MotionLayer["transitions"] | false | null {
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

export function maskValue(value: unknown): MotionMask | false | null {
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

export function environmentValue(value: unknown): MotionEnvironment | false | null {
  if (value === undefined) return null;
  const environment = objectArg(value);
  if (!environment) return false;
  for (const field of ["code", "script", "source", "fragment", "url"]) if (Object.hasOwn(environment, field)) return false;
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

export function blendModeValue(value: unknown): MotionLayer["blendMode"] | false | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return false;
  return BLEND_MODES.find((candidate) => candidate === value) ?? false;
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

function keyframeValue(value: unknown): MotionKeyframe["value"] | false {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return false;
}

function nonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finiteNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
    ? value.map((entry) => entry.trim()) : null;
}
