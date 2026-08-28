import { type MotionEffects, type MotionGradient } from "@shellx-motion/core";
import { objectArg } from "./args.js";
import { optionalFiniteNumber, optionalString } from "./timeline-particle-emitter-arg.js";

const EFFECT_NUMBER_KEYS: Array<"blur" | "brightness" | "contrast" | "saturate" | "grayscale"> = [
  "blur", "brightness", "contrast", "saturate", "grayscale"
];

export function timelineEffectsArg(value: unknown): MotionEffects | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record || !onlyKeys(record, [...EFFECT_NUMBER_KEYS, "glow", "motionBlur", "vignette", "filmGrain", "trail"])) return false;
  const effects: MotionEffects = {};
  for (const key of EFFECT_NUMBER_KEYS) {
    const number = optionalFiniteNumber(record, key);
    if (number === false) return false;
    if (number !== null) effects[key] = number;
  }
  const glow = fixedRecord(record.glow, ["radius"], ["color"]);
  if (glow === false) return false;
  if (glow) effects.glow = { radius: glow.numbers.radius, color: glow.strings.color };
  const motionBlur = fixedRecord(record.motionBlur, ["samples", "shutterAngle"], []);
  if (motionBlur === false) return false;
  if (motionBlur) effects.motionBlur = { samples: motionBlur.numbers.samples, shutterAngle: motionBlur.numbers.shutterAngle };
  const vignette = fixedRecord(record.vignette, ["amount", "softness"], ["color"]);
  if (vignette === false) return false;
  if (vignette) effects.vignette = { amount: vignette.numbers.amount, softness: vignette.numbers.softness, color: vignette.strings.color };
  const filmGrain = fixedRecord(record.filmGrain, ["amount", "size", "seed"], []);
  if (filmGrain === false) return false;
  if (filmGrain) effects.filmGrain = { amount: filmGrain.numbers.amount, size: filmGrain.numbers.size, seed: filmGrain.numbers.seed };
  const trail = fixedRecord(record.trail, ["durationMs", "samples"], []);
  if (trail === false) return false;
  if (trail) effects.trail = { durationMs: trail.numbers.durationMs, samples: trail.numbers.samples };
  return Object.keys(effects).length > 0 ? effects : null;
}

export function timelineGradientArg(value: unknown): MotionGradient | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record || !onlyKeys(record, ["type", "angle", "centerX", "centerY", "stops"])) return false;
  const type = optionalString(record, "type");
  const angle = optionalFiniteNumber(record, "angle");
  const centerX = optionalFiniteNumber(record, "centerX");
  const centerY = optionalFiniteNumber(record, "centerY");
  if ((type !== "linear" && type !== "radial") || angle === false || centerX === false || centerY === false || !Array.isArray(record.stops)) return false;
  const stops: MotionGradient["stops"] = [];
  for (const value of record.stops) {
    const stop = objectArg(value);
    if (!stop || !onlyKeys(stop, ["offset", "color"])) return false;
    const offset = optionalFiniteNumber(stop, "offset");
    const color = optionalString(stop, "color");
    if (offset === false || offset === null || color === false || color === null) return false;
    stops.push({ offset, color });
  }
  if (!stops.length) return false;
  return { type, stops, ...(angle !== null ? { angle } : {}), ...(centerX !== null ? { centerX } : {}), ...(centerY !== null ? { centerY } : {}) };
}

function fixedRecord<NumberKey extends string, StringKey extends string>(
  value: unknown,
  numberKeys: readonly NumberKey[],
  stringKeys: readonly StringKey[]
): { numbers: Record<NumberKey, number>; strings: Record<StringKey, string> } | false | null {
  if (value === undefined) return null;
  const record = objectArg(value);
  if (!record || !onlyKeys(record, [...numberKeys, ...stringKeys])) return false;
  const numbers = {} as Record<NumberKey, number>;
  const strings = {} as Record<StringKey, string>;
  for (const key of numberKeys) {
    const number = optionalFiniteNumber(record, key);
    if (number === false || number === null) return false;
    numbers[key] = number;
  }
  for (const key of stringKeys) {
    const string = optionalString(record, key);
    if (string === false || string === null) return false;
    strings[key] = string;
  }
  return { numbers, strings };
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}
