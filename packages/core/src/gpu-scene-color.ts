import type { GpuRgba } from "./gpu-frame-intent";
import { parseCanonicalMotionCssNumber, parseMotionColorString } from "./color";

/**
 * Parses the closed color subset shared by GPU scene compilers.
 *
 * The authored Motion surface already uses CSS `rgb()` / `rgba()` for ordinary
 * shape fills, shadows and fixed effects. Keeping this small numeric subset in
 * Core lets an admitted scene preserve those values rather than rewriting an
 * authored decimal alpha to a nearby eight-bit hexadecimal value.
 */
export function parseGpuSceneColor(value: string): GpuRgba | null {
  const parsed = parseMotionColorString(value);
  if (!parsed || parsed.value !== value) return null;
  if (parsed.kind === "keyword") return value === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
  if (parsed.kind === "hex") {
    const hex = parsed.digits.length < 5 ? [...parsed.digits].map((part) => part + part).join("") : parsed.digits;
    const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255;
    return { r: Number.parseInt(hex.slice(0, 2), 16) / 255, g: Number.parseInt(hex.slice(2, 4), 16) / 255, b: Number.parseInt(hex.slice(4, 6), 16) / 255, a: alpha / 255 };
  }
  if (parsed.functionName !== "rgb" && parsed.functionName !== "rgba") return null;
  const parts = splitCommaComponents(parsed.body);
  if (parts.length !== (parsed.functionName === "rgba" ? 4 : 3)) return null;
  const channel = (part: string): number | null => {
    const numeric = parseCanonicalMotionCssNumber(part);
    if (numeric === null) return null;
    return numeric.percentage ? bounded(numeric.value / 100) : bounded(numeric.value / 255);
  };
  const alphaNumber = parts[3] === undefined ? { value: 1, percentage: false } : parseCanonicalMotionCssNumber(parts[3]);
  const alpha = alphaNumber === null ? null : alphaNumber.percentage ? bounded(alphaNumber.value / 100) : bounded(alphaNumber.value);
  const [r, g, b] = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!)];
  return r === null || g === null || b === null || alpha === null ? null : { r, g, b, a: alpha };
}

function bounded(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function splitCommaComponents(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ",") continue;
    parts.push(value.slice(start, index));
    start = index + 1;
  }
  parts.push(value.slice(start));
  return parts;
}
