import type { InternalGpuRgba } from "./gpu-runtime-types";

const MAX_COORDINATE = 1_000_000;
const MAX_DIMENSION = 4_096;
const MAX_PRIMITIVE_EXTENT = 131_072;

/** Narrow scalar readers shared by browser-side, pre-allocation frame admission. */
export function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
export function readId(value: unknown): string | null { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : null; }
export function readRgba(value: unknown): InternalGpuRgba | null {
  if (!isRecord(value)) return null;
  const channels = [value.r, value.g, value.b, value.a];
  return channels.every((channel) => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1) ? { r: value.r as number, g: value.g as number, b: value.b as number, a: value.a as number } : null;
}
export function readCoordinate(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE ? value : null; }
export function readPositiveSize(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_DIMENSION ? value : null; }
export function readPositivePrimitiveExtent(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_PRIMITIVE_EXTENT ? value : null; }
export function readInteger(value: unknown, minimum: number, maximum: number): number | null { return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null; }
export function readSeed(value: unknown): number | null { return readInteger(value, 0, 0xffff_ffff); }
export function readRotation(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? value : null; }
export function readUnit(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null; }
export function readPrintable(value: unknown, maximumLength: number): string | null { return typeof value === "string" && value.length >= 1 && value.length <= maximumLength && !/[\u0000-\u001f\u007f]/.test(value) ? value : null; }
export function readFiniteRange(value: unknown, minimumExclusive: number, maximum: number): number | null { return typeof value === "number" && Number.isFinite(value) && value > minimumExclusive && value <= maximum ? value : null; }
export function readInclusiveRange(value: unknown, minimum: number, maximum: number): number | null { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null; }
export function readNonnegativeTime(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null; }
export function readEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] | null { return typeof value === "string" && values.includes(value) ? value as T[number] : null; }
