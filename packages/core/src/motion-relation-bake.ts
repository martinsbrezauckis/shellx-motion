import { canonicalJsonSha256 } from "./canonical-json";
import { assertMotionRelationTargetsEditable } from "./motion-relation-authoring-guards";
import { evaluateMotionRelationAuthoringFrame, MOTION_RELATION_LEGACY_MILLISECONDS_PER_MICROSECOND } from "./motion-relation-authoring-frame";
import { snapshotMotionRelationData } from "./motion-relation-read";
import { MAX_MOTION_RELATION_DURATION_US, motionRelationWriteMask, type MotionRelationDocument, type MotionRelationWriteMask } from "./motion-relation-types";
import { validateMotionRelations } from "./motion-relation-validate";
import type { MotionKeyframe } from "./types";

export const MAX_MOTION_RELATION_BAKE_SAMPLES = 3_600;
export const MAX_MOTION_RELATION_BAKE_KEYFRAMES = MAX_MOTION_RELATION_BAKE_SAMPLES * 4;
export const MOTION_RELATION_BAKE_SEMANTICS = "sampled_not_equivalent_between_samples" as const;

export interface MotionRelationBakeInput { id: string; sampleEveryUs: number }
export interface MotionRelationBakeResult {
  motion: MotionRelationDocument;
  relationId: string;
  startUs: number;
  endUs: number;
  sampleEveryUs: number;
  sampleCount: number;
  keyframeCount: number;
  changedPaths: readonly string[];
  fingerprint: string;
  bakeSemantics: typeof MOTION_RELATION_BAKE_SEMANTICS;
}

/**
 * Materializes an enabled whole-timeline relation into ordinary linear keyframes, then removes it
 * in the same COW result. Ordinary keyframes clamp at their endpoints, so baking a partial
 * interval would change motion before or after the relation was active; this bounded first slice
 * refuses those bindings rather than inventing pre/post keyframes or hidden continuation rules.
 */
export function bakeMotionRelation(motion: MotionRelationDocument, input: unknown): MotionRelationBakeResult {
  const request = readInput(input);
  const checked = validateMotionRelations(motion.relations, motion);
  if (!checked.ok) throw new Error(`Motion relations invalid at ${checked.issues[0]!.path}: ${checked.issues[0]!.message}`);
  const store = checked.store;
  if (!store) throw new Error("Motion document has no relations to bake.");
  const relationIndex = store.bindings.findIndex((binding) => binding.id === request.id);
  if (relationIndex < 0) throw new Error(`Motion relation '${request.id}' is absent.`);
  const relation = store.bindings[relationIndex]!;
  if (!relation.enabled) throw new Error(`Motion relation '${relation.id}' must be enabled before baking.`);
  const startUs = relation.startUs, endUs = relation.startUs + relation.durationUs;
  const documentDurationUs = exactDocumentDurationUs(motion);
  if (startUs !== 0 || endUs !== documentDurationUs) {
    throw new Error(`Motion relation bake requires full document coverage exactly (startUs=0 and endUs=${documentDurationUs}); partial intervals change ordinary-keyframe motion before or after the relation.`);
  }
  assertMillisecondAligned(startUs, "startUs");
  assertMillisecondAligned(endUs, "endUs");
  assertMillisecondAligned(request.sampleEveryUs, "sampleEveryUs");
  const sampleCount = sampleCountFor(startUs, endUs, request.sampleEveryUs);
  if (sampleCount > MAX_MOTION_RELATION_BAKE_SAMPLES) {
    throw new Error(`Motion relation bake exceeds ${MAX_MOTION_RELATION_BAKE_SAMPLES} samples.`);
  }
  const writeMask = motionRelationWriteMask(relation);
  const keyframeCount = sampleCount * writeMask.length;
  if (keyframeCount > MAX_MOTION_RELATION_BAKE_KEYFRAMES) {
    throw new Error(`Motion relation bake exceeds ${MAX_MOTION_RELATION_BAKE_KEYFRAMES} keyframes.`);
  }
  assertMotionRelationTargetsEditable(motion, [relation.target.layerId]);

  const times = sampleTimes(startUs, endUs, request.sampleEveryUs, sampleCount);
  const frames = new Map<MotionRelationWriteMask, MotionKeyframe[]>();
  for (const mask of writeMask) frames.set(mask, []);
  for (const atUs of times) {
    const evaluation = evaluateMotionRelationAuthoringFrame(motion, atUs);
    const sample = evaluation.samples.find((candidate) => candidate.id === relation.id);
    if (!sample) throw new Error(`Motion relation '${relation.id}' was inactive during its requested bake interval.`);
    for (const mask of writeMask) {
      const value = transformValue(sample.transform, mask, relation.id);
      frames.get(mask)!.push({ atMs: atUs / MOTION_RELATION_LEGACY_MILLISECONDS_PER_MICROSECOND, value, easing: "linear" });
    }
  }

  const next = structuredClone(motion);
  const targetLayerIndex = next.layers.findIndex((layer) => layer.id === relation.target.layerId);
  if (targetLayerIndex < 0) throw new Error(`Motion relation '${relation.id}' target disappeared before baking.`);
  const target = next.layers[targetLayerIndex]!;
  const changedPaths: string[] = [];
  for (const mask of writeMask) {
    if (Object.hasOwn(target.keyframes ?? {}, mask)) {
      throw new Error(`Motion relation '${relation.id}' cannot bake over existing ${mask} keyframes.`);
    }
    target.keyframes = { ...(target.keyframes ?? {}), [mask]: frames.get(mask)! };
    changedPaths.push(`/layers/${targetLayerIndex}/keyframes/${mask}`);
  }
  const remaining = store.bindings.filter((_binding, index) => index !== relationIndex);
  if (remaining.length) next.relations = { schema: store.schema, bindings: remaining };
  else delete next.relations;
  changedPaths.push(remaining.length ? `/relations/bindings/${relationIndex}` : "/relations");
  const revalidated = validateMotionRelations(next.relations, next);
  if (!revalidated.ok) throw new Error(`Baked Motion relations invalid at ${revalidated.issues[0]!.path}: ${revalidated.issues[0]!.message}`);
  const frameFacts = [...frames.entries()].map(([mask, keyframes]) => ({ mask, keyframes }));
  return {
    motion: next,
    relationId: relation.id,
    startUs,
    endUs,
    sampleEveryUs: request.sampleEveryUs,
    sampleCount,
    keyframeCount,
    changedPaths: Object.freeze(changedPaths),
    fingerprint: canonicalJsonSha256({ relationId: relation.id, startUs, endUs, sampleEveryUs: request.sampleEveryUs, times, frames: frameFacts }),
    bakeSemantics: MOTION_RELATION_BAKE_SEMANTICS,
  };
}

function readInput(value: unknown): MotionRelationBakeInput {
  const snapshot = snapshotMotionRelationData(value);
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) throw new Error("Motion relation bake must be an exact plain object.");
  const record = snapshot as Record<string, unknown>, keys = Object.keys(record);
  const unknown = keys.find((key) => key !== "id" && key !== "sampleEveryUs");
  if (unknown) throw new Error(`Motion relation bake has unknown field '${unknown}'.`);
  if (!Object.hasOwn(record, "id") || !Object.hasOwn(record, "sampleEveryUs")) throw new Error("Motion relation bake requires id and sampleEveryUs.");
  if (typeof record.id !== "string" || record.id.length === 0) throw new Error("Motion relation bake.id must be a non-empty string.");
  if (typeof record.sampleEveryUs !== "number" || !Number.isSafeInteger(record.sampleEveryUs) || record.sampleEveryUs <= 0 || record.sampleEveryUs > MAX_MOTION_RELATION_DURATION_US) {
    throw new Error(`Motion relation bake.sampleEveryUs must be a safe integer in 1..${MAX_MOTION_RELATION_DURATION_US} microseconds.`);
  }
  return { id: record.id, sampleEveryUs: record.sampleEveryUs };
}

function assertMillisecondAligned(value: number, label: string): void {
  if (value % MOTION_RELATION_LEGACY_MILLISECONDS_PER_MICROSECOND !== 0) {
    throw new Error(`Motion relation bake ${label} must be exactly whole-millisecond representable.`);
  }
}
function exactDocumentDurationUs(motion: MotionRelationDocument): number {
  const durationUs = motion.durationMs * MOTION_RELATION_LEGACY_MILLISECONDS_PER_MICROSECOND;
  if (!Number.isSafeInteger(motion.durationMs) || motion.durationMs < 0 || !Number.isSafeInteger(durationUs)) {
    throw new Error("Motion relation bake requires a safe integer document duration representable in microseconds.");
  }
  return durationUs;
}
function sampleCountFor(startUs: number, endUs: number, stepUs: number): number {
  const span = endUs - startUs;
  return Math.floor(span / stepUs) + 1 + (span % stepUs === 0 ? 0 : 1);
}
function sampleTimes(startUs: number, endUs: number, stepUs: number, count: number): number[] {
  const times: number[] = [];
  for (let atUs = startUs; atUs < endUs; atUs += stepUs) times.push(atUs);
  if (times.at(-1) !== endUs) times.push(endUs);
  if (times.length !== count) throw new Error("Motion relation bake sample grid was not deterministic.");
  return times;
}
function transformValue(transform: Record<string, unknown>, mask: MotionRelationWriteMask, relationId: string): number {
  const key = mask.slice("transform.".length);
  const value = transform[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Motion relation '${relationId}' did not produce finite ${mask} during baking.`);
  }
  return value;
}
