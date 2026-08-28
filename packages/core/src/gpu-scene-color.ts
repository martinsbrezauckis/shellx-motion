import type { GpuRgba } from "./gpu-frame-intent";

/**
 * Parses the closed color subset shared by GPU scene compilers.
 *
 * The authored Motion surface already uses CSS `rgb()` / `rgba()` for ordinary
 * shape fills, shadows and fixed effects. Keeping this small numeric subset in
 * Core lets an admitted scene preserve those values rather than rewriting an
 * authored decimal alpha to a nearby eight-bit hexadecimal value.
 */
export function parseGpuSceneColor(value: string): GpuRgba | null {
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (match) {
    const hex = match[1].length < 5 ? [...match[1]].map((part) => part + part).join("") : match[1];
    const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255;
    return { r: Number.parseInt(hex.slice(0, 2), 16) / 255, g: Number.parseInt(hex.slice(2, 4), 16) / 255, b: Number.parseInt(hex.slice(4, 6), 16) / 255, a: alpha / 255 };
  }
  const css = /^(rgb|rgba)\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)(?:\s*,\s*([^,]+))?\s*\)$/i.exec(value);
  if (!css || (css[1].toLowerCase() === "rgba") !== (css[5] !== undefined)) return null;
  const channel = (part: string): number | null => {
    const parsed = canonicalCssNumber(part);
    if (parsed === null) return null;
    return part.trim().endsWith("%") ? bounded(parsed / 100) : bounded(parsed / 255);
  };
  const alphaNumber = css[5] === undefined ? 1 : canonicalCssNumber(css[5]);
  const alpha = alphaNumber === null ? null : css[5]?.trim().endsWith("%") ? bounded(alphaNumber / 100) : bounded(alphaNumber);
  const [r, g, b] = [channel(css[2]), channel(css[3]), channel(css[4])];
  return r === null || g === null || b === null || alpha === null ? null : { r, g, b, a: alpha };
}

function bounded(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Reject alternate number spellings so a scene fingerprint has one source grammar. */
function canonicalCssNumber(value: string): number | null {
  const trimmed = value.trim();
  const number = trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed;
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(number)) return null;
  const parsed = Number(number);
  return Number.isFinite(parsed) ? parsed : null;
}
