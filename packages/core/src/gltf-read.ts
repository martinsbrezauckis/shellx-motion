import type { MotionScene3DMeshObject, MotionVec3 } from "./types";

export function gltfRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

export function gltfArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

export function gltfIndexArray(value: unknown, upper: number, label: string, optional = false): number[] {
  if (optional && value === undefined) return [];
  return gltfArray(value, label).map((item) => gltfInteger(item, label, 0, upper - 1));
}

export function gltfInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return Number(value);
}

export function gltfBoundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  return gltfInteger(value ?? fallback, label, min, max);
}

export function gltfTuple(
  value: unknown,
  fallback: MotionVec3,
  min: number,
  max: number,
  label: string,
): MotionVec3 {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => !boundedNumber(item, min, max))) {
    throw new Error(`${label} must contain three finite numbers from ${min} to ${max}.`);
  }
  return [...value] as MotionVec3;
}

export function gltfTuple4(
  value: unknown,
  min: number,
  max: number,
  label: string,
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => !boundedNumber(item, min, max))) {
    throw new Error(`${label} must contain four finite numbers from ${min} to ${max}.`);
  }
  return [...value] as [number, number, number, number];
}

export function gltfColorFactor(
  value: unknown,
  fallback: [number, number, number, number],
  label: string,
): [number, number, number, number] {
  return value === undefined ? fallback : gltfTuple4(value, 0, 1, label);
}

export function gltfString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function boundedGltfCreatedBy(value?: string): string {
  return value?.trim().slice(0, 128) || "shellx-motion-gltf-import";
}

export function uniqueGltfObjectId(value: string, objects: MotionScene3DMeshObject[]): string {
  const base = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "").slice(0, 56) || "mesh";
  let id = base;
  let suffix = 2;
  while (objects.some((object) => object.id === id)) id = `${base}-${suffix++}`;
  return id;
}

function boundedNumber(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
