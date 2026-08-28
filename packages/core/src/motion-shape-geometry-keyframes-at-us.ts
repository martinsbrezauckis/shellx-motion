import { evaluateMotionShapeGeometryKeyframes } from "./motion-shape-geometry-keyframes";
import type { MotionLayer, MotionShapeGeometry } from "./types";

/**
 * Exact Core-only sampling boundary for persisted shape geometry. This is intentionally not wired
 * into generic effective-layer evaluation: every renderer capability card refuses the feature
 * until one renderer owns a truthful exact-atUs lowering path and proof.
 */
export function evaluateMotionShapeGeometryLayerAtUs(layer: MotionLayer, atUs: number): MotionShapeGeometry | null {
  if (layer.geometryKeyframes === undefined) return null;
  if (layer.type !== "shape") throw new Error(`Geometry keyframes are supported only on shape layers; received ${String(layer.type)}.`);
  const record = geometryKeyframeRecord(layer.geometryKeyframes);
  const result = evaluateMotionShapeGeometryKeyframes({ schema: record.schema, atUs, keyframes: record.keyframes });
  if (!result.ok) throw new Error(`Shape geometry keyframe evaluation refused: ${result.message}`);
  return result.evaluation.geometry;
}

function geometryKeyframeRecord(value: unknown): { schema: unknown; keyframes: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw new Error("Shape geometry keyframes must be a plain object.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== 2 || names.some((name) => name !== "schema" && name !== "keyframes")) throw new Error("Shape geometry keyframes has unknown field.");
  for (const name of names) if (!("value" in descriptors[name]!) || !descriptors[name]!.enumerable) throw new Error(`Shape geometry keyframes.${name} must be an enumerable data field.`);
  return value as { schema: unknown; keyframes: unknown };
}
