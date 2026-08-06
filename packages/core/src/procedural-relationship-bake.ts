import { canonicalJsonSha256 } from "./canonical-json";
import { evaluateMotionProceduralLayers, readMotionProceduralProperty } from "./procedural-relationship-evaluate";
import { validateMotionProceduralGraph } from "./procedural-relationship-validate";
import {
  MAX_PROCEDURAL_BAKE_SAMPLES,
  type MotionProceduralGraph,
  type MotionProceduralProperty,
} from "./procedural-relationship-types";
import type { MotionDocument, MotionKeyframe, MotionKeyframeTarget } from "./types";

export interface MotionProceduralBakeInput {
  relationshipIds?: string[];
  startMs?: number;
  endMs?: number;
  sampleEveryFrames?: number;
}

export interface MotionProceduralBakeResult {
  motion: MotionDocument;
  relationshipIds: string[];
  sampleCount: number;
  keyframeCount: number;
  changedPaths: string[];
  fingerprint: string;
}

/** Bake selected relationships to ordinary numeric keyframes and detach them atomically. */
export function bakeMotionProceduralRelationships(motion: MotionDocument, input: MotionProceduralBakeInput = {}): MotionProceduralBakeResult {
  if (!motion.relationships) throw new Error("Motion document has no procedural relationships to bake.");
  const validation = validateMotionProceduralGraph(motion.relationships, motion);
  if (!validation.ok) throw new Error(`Cannot bake invalid procedural graph at ${validation.issues[0].path}: ${validation.issues[0].message}`);
  const graph = motion.relationships as MotionProceduralGraph;
  if (input.relationshipIds && input.relationshipIds.length === 0) {
    throw new Error("Procedural bake relationshipIds must not be empty.");
  }
  const requested = input.relationshipIds ? [...new Set(input.relationshipIds)] : graph.relationships.filter((item) => item.enabled).map((item) => item.id);
  if (!requested.length) throw new Error("Procedural bake requires at least one enabled relationship.");
  const selected = graph.relationships.filter((item) => requested.includes(item.id));
  if (selected.length !== requested.length) throw new Error("Procedural bake references an unknown relationship id.");
  if (selected.some((item) => !item.enabled)) throw new Error("Disabled procedural relationships must be enabled before baking.");
  const startMs = boundedTime(input.startMs ?? 0, motion.durationMs, "startMs");
  const endMs = boundedTime(input.endMs ?? motion.durationMs, motion.durationMs, "endMs");
  if (endMs < startMs) throw new Error("Procedural bake endMs must be at or after startMs.");
  const stride = input.sampleEveryFrames ?? 1;
  if (!Number.isInteger(stride) || stride < 1 || stride > 120) throw new Error("sampleEveryFrames must be an integer from 1 to 120.");
  const frameMs = 1000 / motion.fps;
  const times = bakeTimes(startMs, endMs, frameMs * stride);
  if (times.length > MAX_PROCEDURAL_BAKE_SAMPLES) throw new Error(`Procedural bake exceeds ${MAX_PROCEDURAL_BAKE_SAMPLES} samples.`);
  const next = structuredClone(motion);
  const frames = new Map<string, MotionKeyframe[]>();
  for (const atMs of times) {
    const evaluation = evaluateMotionProceduralLayers(motion, atMs);
    const layers = new Map(evaluation.layers.map((layer) => [layer.id, layer]));
    for (const relationship of selected) {
      const key = `${relationship.target.layerId}/${relationship.target.property}`;
      const value = readMotionProceduralProperty(layers.get(relationship.target.layerId)!, relationship.target.property);
      frames.set(key, [...(frames.get(key) ?? []), { atMs, value, easing: "linear" }]);
    }
  }
  const changedPaths: string[] = [];
  for (const relationship of selected) {
    const layer = next.layers.find((item) => item.id === relationship.target.layerId)!;
    if (layer.locked) throw new Error(`Cannot bake relationship ${relationship.id} into locked layer ${layer.id}.`);
    const target = relationship.target.property as MotionKeyframeTarget;
    layer.keyframes = { ...(layer.keyframes ?? {}), [target]: frames.get(`${layer.id}/${target}`)! };
    changedPaths.push(`/layers/${layer.id}/keyframes/${target}`, `/relationships/relationships/${relationship.id}`);
  }
  const selectedIds = new Set(selected.map((item) => item.id));
  const remaining = graph.relationships.filter((item) => !selectedIds.has(item.id));
  if (remaining.length) next.relationships = { ...structuredClone(graph), relationships: remaining };
  else delete next.relationships;
  // Canonical serialization, not JSON.stringify and not a local key-sorter: `frames` is a Map
  // spread into entries, so both its key order and (before this) the locale-sensitive comparator
  // that sorted the nested keyframe objects could move this fingerprint between machines.
  const fingerprint = canonicalJsonSha256({ relationshipIds: requested, times, frames: [...frames] });
  return {
    motion: next,
    relationshipIds: requested,
    sampleCount: times.length,
    keyframeCount: times.length * selected.length,
    changedPaths,
    fingerprint,
  };
}

function bakeTimes(startMs: number, endMs: number, stepMs: number): number[] {
  const values: number[] = [];
  for (let value = startMs; value < endMs; value += stepMs) values.push(roundTime(value));
  values.push(roundTime(endMs));
  return [...new Set(values)];
}
function boundedTime(value: number, durationMs: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > durationMs) throw new Error(`${label} must be within 0..${durationMs}ms.`);
  return value;
}
function roundTime(value: number): number { return Number(value.toFixed(6)); }
