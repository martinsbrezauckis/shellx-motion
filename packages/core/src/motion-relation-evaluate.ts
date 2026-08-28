import { decomposeMotionSimilarityMatrix, motionAffineMatrix, multiplyMotionAffineMatrices, transformMotionAffinePoint, transformMotionAffineVector, type MotionAffineMatrix } from "./motion-transform-matrix";
import { quantizeMotionProceduralValue } from "./procedural-relationship-evaluate";
import { MAX_MOTION_RELATION_COORDINATE, MAX_MOTION_RELATION_SCALE, MIN_MOTION_RELATION_SCALE, type MotionRelationBinding, type MotionRelationDocument, type MotionRelationWriteMask } from "./motion-relation-types";
import { validateMotionRelations } from "./motion-relation-validate";
import type { MotionLayer, MotionTransform } from "./types";

export interface MotionRelationFrameSample {
  id: string;
  kind: MotionRelationBinding["kind"];
  targetLayerId: string;
  writeMask: readonly MotionRelationWriteMask[];
  transform: Readonly<Pick<MotionTransform, "x" | "y" | "rotation" | "scale">>;
  sourceSha256: string;
  workUnits: number;
}
export interface MotionRelationFrameEvaluation {
  atUs: number;
  /** A fresh frame snapshot. It is intentionally supplied by the future central resolver, not legacy millisecond evaluation. */
  layers: readonly MotionLayer[];
  samples: readonly MotionRelationFrameSample[];
  frameWorkUnits: number;
}
export interface MotionRelationEvaluationInput { baseLayers?: readonly MotionLayer[] }

/**
 * Applies enabled active semantic relations to a supplied exact-time base snapshot. This private
 * foundation deliberately does not call `effectiveLayerAtMs`: later integration must supply the
 * already-resolved keyframe/spatial/procedural/behavior frame at the same integer microsecond.
 * This direct-import evaluator is not package or renderer admission.
 */
export function evaluateMotionRelationFrame(
  motion: MotionRelationDocument,
  atUs: number,
  input: MotionRelationEvaluationInput = {},
): MotionRelationFrameEvaluation {
  assertAtUs(motion, atUs);
  const checked = validateMotionRelations(motion.relations, motion);
  if (!checked.ok) throw new Error(`Motion relations invalid at ${checked.issues[0]!.path}: ${checked.issues[0]!.message}`);
  const layers = structuredClone(input.baseLayers ?? motion.layers);
  const byId = new Map<string, MotionLayer>();
  for (const layer of layers) {
    if (byId.has(layer.id)) throw new Error(`Motion relation base frame contains duplicate layer ${layer.id}.`);
    byId.set(layer.id, layer);
  }
  const bindings = new Map(checked.bindings.map((binding) => [binding.binding.id, binding]));
  const samples: MotionRelationFrameSample[] = [];
  for (const id of checked.relationOrder) {
    const resolved = bindings.get(id)!;
    const binding = resolved.binding;
    if (!binding.enabled || atUs < binding.startUs || atUs > binding.startUs + binding.durationUs) continue;
    const source = byId.get(binding.source.layerId), target = byId.get(binding.target.layerId);
    if (!source || !target) throw new Error(`Motion relation ${binding.id} base frame omitted a validated endpoint.`);
    const transform = binding.kind === "attach" ? applyAttach(binding, source, target) : applyAim(binding, source, target);
    target.transform = { ...(target.transform ?? {}), ...transform };
    samples.push(Object.freeze({ id: binding.id, kind: binding.kind, targetLayerId: target.id, writeMask: resolved.writeMask, transform: Object.freeze(transform), sourceSha256: resolved.sourceSha256, workUnits: resolved.workUnits }));
  }
  return Object.freeze({ atUs, layers: Object.freeze(layers), samples: Object.freeze(samples), frameWorkUnits: samples.reduce((total, sample) => total + sample.workUnits, 0) });
}

function applyAttach(binding: Extract<MotionRelationBinding, { kind: "attach" }>, source: MotionLayer, target: MotionLayer): Pick<MotionTransform, "x" | "y" | "rotation" | "scale"> {
  const sourceMatrix = matrixFor(source), targetMatrix = matrixFor(target);
  const sourceAnchor = transformMotionAffinePoint(sourceMatrix, [binding.source.anchor.x, binding.source.anchor.y]);
  if (binding.mode === "follow") {
    const vector = binding.offset.space === "source"
      ? transformMotionAffineVector(sourceMatrix, [binding.offset.x, binding.offset.y])
      : [binding.offset.x, binding.offset.y] as [number, number];
    const targetAnchor = transformMotionAffinePoint(targetMatrix, [binding.target.anchor.x, binding.target.anchor.y]);
    const base = transformFor(target);
    return {
      x: coordinate(base.x + sourceAnchor[0] + vector[0] - targetAnchor[0], `${binding.id}.x`),
      y: coordinate(base.y + sourceAnchor[1] + vector[1] - targetAnchor[1], `${binding.id}.y`),
    };
  }
  const offset = motionAffineMatrix({ x: binding.offset.x, y: binding.offset.y, originX: 0, originY: 0, rotation: binding.offset.rotationDeg, scaleX: binding.offset.scale, scaleY: binding.offset.scale });
  const prefix = binding.offset.space === "source"
    ? multiplyMotionAffineMatrices(sourceMatrix, translation(binding.source.anchor.x, binding.source.anchor.y))
    : translation(sourceAnchor[0], sourceAnchor[1]);
  const matrix = multiplyMotionAffineMatrices(multiplyMotionAffineMatrices(prefix, offset), translation(-binding.target.anchor.x, -binding.target.anchor.y));
  const base = transformFor(target);
  const result = decomposeMotionSimilarityMatrix(matrix, { x: base.originX, y: base.originY });
  if (!result) throw new Error(`Motion relation ${binding.id} produced a non-similarity transform.`);
  return {
    x: coordinate(result.x, `${binding.id}.x`),
    y: coordinate(result.y, `${binding.id}.y`),
    rotation: quantized(normalizeDegrees(result.rotation), `${binding.id}.rotation`),
    scale: scale(result.scale, `${binding.id}.scale`),
  };
}

function applyAim(binding: Extract<MotionRelationBinding, { kind: "aim" }>, source: MotionLayer, target: MotionLayer): Pick<MotionTransform, "rotation"> {
  const sourceAnchor = transformMotionAffinePoint(matrixFor(source), [binding.source.anchor.x, binding.source.anchor.y]);
  const targetAnchor = transformMotionAffinePoint(matrixFor(target), [binding.target.anchor.x, binding.target.anchor.y]);
  const dx = sourceAnchor[0] - targetAnchor[0], dy = sourceAnchor[1] - targetAnchor[1];
  if (dx === 0 && dy === 0) throw new Error(`Motion relation ${binding.id} aim refuses a zero-length source vector at ${binding.startUs}..${binding.startUs + binding.durationUs}us.`);
  return { rotation: quantized(normalizeDegrees((Math.atan2(dy, dx) * 180 / Math.PI) + binding.rotationOffsetDeg), `${binding.id}.rotation`) };
}

function transformFor(layer: MotionLayer): Required<Pick<MotionTransform, "x" | "y" | "originX" | "originY" | "rotation" | "scale">> {
  const source = layer.transform ?? {};
  const number = (key: keyof MotionTransform, fallback: number): number => {
    const value = source[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Motion relation base transform ${layer.id}.${key} must be finite.`);
    return value;
  };
  const result = { x: number("x", 0), y: number("y", 0), originX: number("originX", 0), originY: number("originY", 0), rotation: number("rotation", 0), scale: number("scale", 1) };
  if (result.scale <= 0) throw new Error(`Motion relation base transform ${layer.id}.scale must be positive.`);
  return result;
}
function matrixFor(layer: MotionLayer): MotionAffineMatrix {
  const transform = transformFor(layer);
  return motionAffineMatrix({ ...transform, scaleX: transform.scale, scaleY: transform.scale });
}
function translation(x: number, y: number): MotionAffineMatrix { return [1, 0, 0, 1, x, y]; }
function coordinate(value: number, label: string): number {
  const result = quantized(value, label);
  if (Math.abs(result) > MAX_MOTION_RELATION_COORDINATE) throw new Error(`Motion relation ${label} exceeds coordinate limit ${MAX_MOTION_RELATION_COORDINATE}.`);
  return result;
}
function scale(value: number, label: string): number {
  const result = quantized(value, label);
  if (result < MIN_MOTION_RELATION_SCALE || result > MAX_MOTION_RELATION_SCALE) throw new Error(`Motion relation ${label} is outside ${MIN_MOTION_RELATION_SCALE}..${MAX_MOTION_RELATION_SCALE}.`);
  return result;
}
function quantized(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`Motion relation ${label} is non-finite.`);
  return quantizeMotionProceduralValue(value);
}
function normalizeDegrees(value: number): number {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}
function assertAtUs(motion: MotionRelationDocument, atUs: number): void {
  const durationUs = motion.durationMs * 1_000;
  if (!Number.isSafeInteger(atUs) || atUs < 0 || !Number.isSafeInteger(durationUs) || atUs > durationUs) {
    throw new Error("Motion relation evaluation requires a safe integer microsecond playhead within the document duration.");
  }
}
