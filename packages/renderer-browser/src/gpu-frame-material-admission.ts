import type { InternalGpuFrameDraw, InternalGpuRgba } from "./gpu-runtime-types";

const PARAMETER_RANGES: Array<readonly [number, number]> = [
  [-4, 4], [0.1, 20], [0, 2], [1, 4], [0, 2], [0, 2], [0, 1], [-1_000, 1_000]
];

/**
 * Reconstructs the closed material ABI at the renderer boundary.  It accepts
 * only scalar preset data; authored shader source is deliberately not part of
 * this representation and cannot reach the browser page.
 */
export function admitGpuMaterial(value: Record<string, unknown>, id: string, composite: Record<string, unknown>): Extract<InternalGpuFrameDraw, { kind: "material" }> | null {
  const preset = enumValue(value.preset, ["plasma", "hologram", "energy", "noise"] as const);
  const seed = integer(value.seed, 0, 0xffff_ffff);
  const timeSeconds = range(value.timeSeconds, 0, 86_400);
  const x = range(value.x, -1_000_000, 1_000_000);
  const y = range(value.y, -1_000_000, 1_000_000);
  const width = range(value.width, Number.MIN_VALUE, 4_096);
  const height = range(value.height, Number.MIN_VALUE, 4_096);
  const rotationDeg = range(value.rotationDeg, -1_000_000, 1_000_000);
  const pivotX = range(value.pivotX, -1_000_000, 1_000_000);
  const pivotY = range(value.pivotY, -1_000_000, 1_000_000);
  const opacity = range(value.opacity, 0, 1);
  if (!preset || seed === null || timeSeconds === null || x === null || y === null || width === null || height === null || rotationDeg === null || pivotX === null || pivotY === null || opacity === null) return null;
  if (!Array.isArray(value.colors) || value.colors.length !== 3 || !Array.isArray(value.parameters) || value.parameters.length !== 8) return null;
  const colors = value.colors.map(rgba);
  const parameters = value.parameters.map((entry, index) => range(entry, ...PARAMETER_RANGES[index]));
  if (colors.some((entry) => entry === null) || parameters.some((entry) => entry === null)) return null;
  return {
    kind: "material", id, ...composite, preset, seed, timeSeconds, x, y, width, height, rotationDeg, pivotX, pivotY, opacity,
    colors: colors as Extract<InternalGpuFrameDraw, { kind: "material" }>["colors"],
    parameters: parameters as Extract<InternalGpuFrameDraw, { kind: "material" }>["parameters"]
  } as Extract<InternalGpuFrameDraw, { kind: "material" }>;
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function range(value: unknown, min: number, max: number): number | null { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null; }
function integer(value: unknown, min: number, max: number): number | null { return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null; }
function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] | null { return typeof value === "string" && values.includes(value) ? value as T[number] : null; }
function rgba(value: unknown): InternalGpuRgba | null {
  if (!record(value)) return null;
  const r = range(value.r, 0, 1), g = range(value.g, 0, 1), b = range(value.b, 0, 1), a = range(value.a, 0, 1);
  return r === null || g === null || b === null || a === null ? null : { r, g, b, a };
}
