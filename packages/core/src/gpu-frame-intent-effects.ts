import type { GpuAdjustmentIntent, GpuLayerEffects, GpuRgba } from "./gpu-frame-intent-types";

type Refuse = (message: string) => never;

/** Independently normalizes bounded layer effects for the GPU frame authority. */
export function readGpuLayerEffects(value: unknown, name: string, refuse: Refuse): GpuLayerEffects | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || Object.keys(value).some((key) => !["blur", "brightness", "contrast", "saturate", "grayscale", "glow"].includes(key))) refuse(`${name} contains unsupported controls.`);
  const blur = readNumber(value.blur ?? 0, `${name}.blur`, 128, refuse);
  const brightness = readNumber(value.brightness ?? 1, `${name}.brightness`, 4, refuse);
  const contrast = readNumber(value.contrast ?? 1, `${name}.contrast`, 4, refuse);
  const saturate = readNumber(value.saturate ?? 1, `${name}.saturate`, 4, refuse);
  const grayscale = readNumber(value.grayscale ?? 0, `${name}.grayscale`, 1, refuse);
  const glow = value.glow === undefined || value.glow === null ? null : readGlow(value.glow, `${name}.glow`, refuse);
  return blur === 0 && brightness === 1 && contrast === 1 && saturate === 1 && grayscale === 0 && glow === null ? null : { blur, brightness, contrast, saturate, grayscale, glow };
}

export function readGpuAdjustmentIntent(value: Record<string, unknown>, id: string, refuse: Refuse): GpuAdjustmentIntent {
  const vignette = value.vignette === null ? null : readVignette(value.vignette, `${id}.vignette`, refuse);
  const filmGrain = value.filmGrain === null ? null : readFilmGrain(value.filmGrain, `${id}.filmGrain`, refuse);
  if (vignette === null && filmGrain === null) refuse(`${id} must declare vignette or film grain.`);
  return { kind: "adjustment", id, vignette, filmGrain };
}

function readGlow(value: unknown, name: string, refuse: Refuse): NonNullable<GpuLayerEffects["glow"]> { if (!isRecord(value) || Object.keys(value).some((key) => key !== "radius" && key !== "color")) refuse(`${name} contains unsupported controls.`); return { radius: readNumber(value.radius, `${name}.radius`, 128, refuse), color: readRgba(value.color, `${name}.color`, refuse) }; }
function readVignette(value: unknown, name: string, refuse: Refuse): NonNullable<GpuAdjustmentIntent["vignette"]> { if (!isRecord(value)) refuse(`${name} must be null or a vignette.`); return { amount: readNumber(value.amount, `${name}.amount`, 1, refuse), softness: readNumber(value.softness, `${name}.softness`, 1, refuse), color: readRgba(value.color, `${name}.color`, refuse) }; }
function readFilmGrain(value: unknown, name: string, refuse: Refuse): NonNullable<GpuAdjustmentIntent["filmGrain"]> { if (!isRecord(value)) refuse(`${name} must be null or film grain.`); return { amount: readNumber(value.amount, `${name}.amount`, 1, refuse), size: readInteger(value.size, `${name}.size`, 1, 8, refuse), frameSeed: readInteger(value.frameSeed, `${name}.frameSeed`, 0, 0xffff_ffff, refuse) }; }
function readNumber(value: unknown, name: string, maximum: number, refuse: Refuse): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) refuse(`${name} must be finite in 0..${maximum}.`); return value; }
function readInteger(value: unknown, name: string, minimum: number, maximum: number, refuse: Refuse): number { if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) refuse(`${name} must be an integer in ${minimum}..${maximum}.`); return value; }
function readRgba(value: unknown, name: string, refuse: Refuse): GpuRgba { if (!isRecord(value) || ![value.r,value.g,value.b,value.a].every((channel)=>typeof channel === "number"&&Number.isFinite(channel)&&channel>=0&&channel<=1)) refuse(`${name} must contain finite r, g, b and a channels in 0..1.`); return { r:value.r as number,g:value.g as number,b:value.b as number,a:value.a as number }; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
