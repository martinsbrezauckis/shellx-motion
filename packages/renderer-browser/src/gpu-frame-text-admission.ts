import type { InternalGpuFrameDraw } from "./gpu-runtime-types";

type TextDraw = Extract<InternalGpuFrameDraw, { kind: "text" }>;
type RecordValue = Record<string, unknown>;
type ReadNumber = (value: unknown) => number | null;

/** Re-admits Core's closed text-only fields before any browser canvas allocation. */
export function admitGpuTextShadow(value: unknown, readCoordinate: ReadNumber, readRgba: (value: unknown) => TextDraw["color"] | null): TextDraw["textShadow"] | undefined {
  if (value === null) return null;
  if (!record(value) || Object.keys(value).some((key) => key !== "offsetX" && key !== "offsetY" && key !== "blur" && key !== "color")) return undefined;
  const offsetX = readCoordinate(value.offsetX); const offsetY = readCoordinate(value.offsetY); const blur = readBounded(value.blur, 0, 512); const color = readRgba(value.color);
  return offsetX === null || offsetY === null || blur === null || color === null ? undefined : { offsetX, offsetY, blur, color };
}

/** Safe-area ids have already been lowered to absolute bounded document geometry. */
export function admitGpuTextFit(value: unknown, readCoordinate: ReadNumber, readPositiveSize: ReadNumber): TextDraw["textFit"] | undefined {
  if (value === null) return null;
  if (!record(value) || Object.keys(value).some((key) => key !== "policy" && key !== "safeArea" && key !== "minFontSize")) return undefined;
  const policy = enumValue(value.policy, ["safe", "allow-crop", "auto-fit"] as const);
  const minFontSize = value.minFontSize === null ? null : readPositiveSize(value.minFontSize);
  if (policy === null || (policy === "auto-fit" && minFontSize === null) || (policy !== "auto-fit" && minFontSize !== null)) return undefined;
  if (value.safeArea === null) return policy === "allow-crop" ? { policy, safeArea: null, minFontSize } : undefined;
  if (!record(value.safeArea) || Object.keys(value.safeArea).some((key) => key !== "top" && key !== "right" && key !== "bottom" && key !== "left")) return undefined;
  const top = readCoordinate(value.safeArea.top); const right = readCoordinate(value.safeArea.right); const bottom = readCoordinate(value.safeArea.bottom); const left = readCoordinate(value.safeArea.left);
  return top === null || right === null || bottom === null || left === null || right < left || bottom < top ? undefined : { policy, safeArea: { top, right, bottom, left }, minFontSize };
}

function record(value: unknown): value is RecordValue { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function readBounded(value: unknown, minimum: number, maximum: number): number | null { return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null; }
function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] | null { return typeof value === "string" && values.includes(value) ? value as T[number] : null; }
