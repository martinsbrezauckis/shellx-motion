import type { GpuLayerMaskIntent } from "./gpu-frame-intent-types";

const MAX_COORDINATE = 1_000_000;

export function readGpuLayerMask(value: unknown, name: string, refuse: (message: string) => never): GpuLayerMaskIntent | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).some((key) => !["shape", "x", "y", "width", "height", "radius", "rotationDeg", "pivotX", "pivotY", "inverted", "opacity", "featherPx"].includes(key))) refuse(`${name} must be a bounded geometric mask.`);
  const shape = value.shape;
  if (shape !== "rect" && shape !== "ellipse" && shape !== "triangle") refuse(`${name}.shape is unsupported.`);
  const x = coordinate(value.x, `${name}.x`, refuse); const y = coordinate(value.y, `${name}.y`, refuse);
  const width = positive(value.width, `${name}.width`, refuse); const height = positive(value.height, `${name}.height`, refuse);
  const radius = bounded(value.radius, `${name}.radius`, 0, 4_096, refuse);
  const rotationDeg = bounded(value.rotationDeg, `${name}.rotationDeg`, -1_000_000, 1_000_000, refuse);
  const pivotX = coordinate(value.pivotX, `${name}.pivotX`, refuse); const pivotY = coordinate(value.pivotY, `${name}.pivotY`, refuse);
  if (typeof value.inverted !== "boolean") refuse(`${name}.inverted must be boolean.`);
  const opacity = bounded(value.opacity, `${name}.opacity`, 0, 1, refuse);
  const featherPx = bounded(value.featherPx, `${name}.featherPx`, 0, 128, refuse);
  if (shape === "triangle" && radius !== 0) refuse(`${name}.radius must be zero for a triangle track matte.`);
  return { shape, x, y, width, height, radius: Math.min(radius, width / 2, height / 2), rotationDeg, pivotX, pivotY, inverted: value.inverted, opacity, featherPx };
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function finite(value: unknown, name: string, refuse: (message: string) => never): number { if (typeof value !== "number" || !Number.isFinite(value)) refuse(`${name} must be finite.`); return value; }
function bounded(value: unknown, name: string, minimum: number, maximum: number, refuse: (message: string) => never): number { const number = finite(value, name, refuse); if (number < minimum || number > maximum) refuse(`${name} must be in ${minimum}..${maximum}.`); return number; }
function coordinate(value: unknown, name: string, refuse: (message: string) => never): number { return bounded(value, name, -MAX_COORDINATE, MAX_COORDINATE, refuse); }
function positive(value: unknown, name: string, refuse: (message: string) => never): number { return bounded(value, name, Number.MIN_VALUE, 4_096, refuse); }
