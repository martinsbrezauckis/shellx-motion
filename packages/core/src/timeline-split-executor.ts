/** Private common executor for guarded root-layer and composed group splits. */
import { assertReadableLayerKeyframes } from "./keyframe-readability";
import { COLOR_KEYFRAME_TARGETS, DISCRETE_STRING_KEYFRAME_TARGETS } from "./keyframe-targets";
import { cloneMotionKeyframe } from "./spatial-path";
import { interpolateColor, interpolateNumber, interpolateString, type LayerSplitAtMs, type LayerSplitAtMsResult } from "./timeline";
import { uniqueSplitLayerId } from "./timeline-layer-ids";
import type { MotionDocument, MotionKeyframe, MotionKeyframeTarget, MotionLayer } from "./types";

/** This leaf deliberately bypasses group ownership checks; callers must establish their own boundary. */
export function executeLayerSplit(motion: MotionDocument, input: LayerSplitAtMs): LayerSplitAtMsResult {
  if (!isNonEmptyString(input.layerId)) throw new Error("Layer id is required.");
  if (!isNonNegativeFinite(input.atMs)) throw new Error("Layer split atMs must be a non-negative finite number.");
  const layerIndex = motion.layers.findIndex((layer) => layer.id === input.layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${input.layerId}.`);
  const layer = motion.layers[layerIndex];
  const layerEndMs = layer.startMs + layer.durationMs;
  if (input.atMs <= layer.startMs || input.atMs >= layerEndMs) throw new Error("Layer split point must be inside the layer duration.");
  const newLayerId = input.newLayerId?.trim() || uniqueSplitLayerId(motion, layer.id, input.atMs);
  if (!isNonEmptyString(newLayerId)) throw new Error("New layer id is required.");
  if (motion.layers.some((candidate) => candidate.id === newLayerId)) throw new Error(`Motion layer id already exists: ${newLayerId}.`);
  const tracks = motion.tracks ?? [];
  const sourceTrackIndexes = tracks.map((track, index) => (track.id === layer.trackId || track.layerIds?.includes(layer.id) ? index : -1)).filter((index) => index !== -1);
  for (const trackIndex of sourceTrackIndexes) if (tracks[trackIndex].locked) throw new Error(`Source track is locked: ${tracks[trackIndex].id}.`);
  if (layer.locked === true) throw new Error(`Cannot edit locked layer: ${layer.id}.`);
  assertReadableLayerKeyframes(layer, layerIndex, "Layer split");
  assertArrayKeyframeTracks(layer, layerIndex);

  const splitOffsetMs = input.atMs - layer.startMs;
  const sourceOffsetMs = sourceOffsetForLayerSplit(layer, splitOffsetMs);
  const splitKeyframes = splitLayerKeyframes(layer.keyframes, input.atMs);
  const splitTransitions = splitLayerTransitions(layer);
  const originalLayer: MotionLayer = { ...layer, durationMs: splitOffsetMs, ...(splitKeyframes.original ? { keyframes: splitKeyframes.original } : {}) };
  if (!splitKeyframes.original) delete originalLayer.keyframes;
  applyOriginalSourceTrim(originalLayer, layer, sourceOffsetMs);
  if (splitTransitions.original) originalLayer.transitions = splitTransitions.original; else delete originalLayer.transitions;
  const newLayer: MotionLayer = { ...layer, id: newLayerId, startMs: input.atMs, durationMs: layerEndMs - input.atMs, ...(splitKeyframes.split ? { keyframes: splitKeyframes.split } : {}) };
  if (!splitKeyframes.split) delete newLayer.keyframes;
  applySplitSourceTrim(newLayer, layer, sourceOffsetMs);
  if (splitTransitions.split) newLayer.transitions = splitTransitions.split; else delete newLayer.transitions;

  const changedPaths = [`/layers/${layer.id}/durationMs`];
  if (originalLayer.trimDurationMs !== layer.trimDurationMs) changedPaths.push(`/layers/${layer.id}/trimDurationMs`);
  changedPaths.push(`/layers/${newLayerId}`);
  const nextTracks = motion.tracks?.map((track, trackIndex) => {
    const layerIds = track.layerIds ? [...track.layerIds] : undefined;
    if (!layerIds) return track;
    const existingIndex = layerIds.indexOf(layer.id);
    if (existingIndex === -1) return { ...track, layerIds };
    layerIds.splice(existingIndex + 1, 0, newLayerId);
    changedPaths.push(`/tracks/${trackIndex}/layerIds`);
    return { ...track, layerIds };
  });
  return {
    motion: { ...motion, layers: [...motion.layers.slice(0, layerIndex), originalLayer, newLayer, ...motion.layers.slice(layerIndex + 1)], ...(nextTracks ? { tracks: nextTracks } : {}) },
    changedPaths, action: "split", layerId: layer.id, newLayerId, atMs: input.atMs, splitOffsetMs, sourceOffsetMs,
    originalLayer, newLayer, oldTiming: timingSnapshot(layer), newTimings: { original: timingSnapshot(originalLayer), split: timingSnapshot(newLayer) }
  };
}

function sourceOffsetForLayerSplit(layer: MotionLayer, splitOffsetMs: number): number | undefined {
  if (layer.type !== "video" && layer.type !== "audio" && typeof layer.trimStartMs !== "number" && typeof layer.trimDurationMs !== "number") return undefined;
  return splitOffsetMs * readPositiveNumber(layer.playbackRate, 1);
}
function applyOriginalSourceTrim(target: MotionLayer, source: MotionLayer, sourceOffsetMs: number | undefined): void {
  if (sourceOffsetMs !== undefined && typeof source.trimDurationMs === "number") target.trimDurationMs = Math.min(source.trimDurationMs, sourceOffsetMs);
}
function applySplitSourceTrim(target: MotionLayer, source: MotionLayer, sourceOffsetMs: number | undefined): void {
  if (sourceOffsetMs === undefined) return;
  target.trimStartMs = readNumber(source.trimStartMs, 0) + sourceOffsetMs;
  if (typeof source.trimDurationMs === "number") target.trimDurationMs = Math.max(0, source.trimDurationMs - sourceOffsetMs);
}
function splitLayerTransitions(layer: MotionLayer): { original: MotionLayer["transitions"] | undefined; split: MotionLayer["transitions"] | undefined } {
  return { original: layer.transitions?.in ? { in: { ...layer.transitions.in } } : undefined, split: layer.transitions?.out ? { out: { ...layer.transitions.out } } : undefined };
}
function assertArrayKeyframeTracks(layer: MotionLayer, layerIndex: number): void {
  for (const [target, entries] of Object.entries(layer.keyframes ?? {})) {
    if (!Array.isArray(entries)) throw new Error(`Layer split would rewrite this layer's keyframes, and /layers/${layerIndex}/keyframes/${target} is not an array. A keyframe track is a list of { "atMs": <milliseconds>, "value": <number or string> } objects. Rewriting it now would drop the whole track without a trace, so this refuses instead.`);
  }
}
function splitLayerKeyframes(keyframes: MotionLayer["keyframes"], atMs: number): { original: MotionLayer["keyframes"] | undefined; split: MotionLayer["keyframes"] | undefined } {
  if (!keyframes) return { original: undefined, split: undefined };
  const original: Record<string, MotionKeyframe[]> = {};
  const split: Record<string, MotionKeyframe[]> = {};
  for (const [target, frames] of Object.entries(keyframes)) {
    if (!Array.isArray(frames) || frames.length === 0) continue;
    const sorted = [...frames].sort((left, right) => left.atMs - right.atMs);
    const boundary = boundaryKeyframe(target, sorted, atMs);
    const before = sorted.filter((frame) => frame.atMs < atMs).map(cloneMotionKeyframe);
    const after = sorted.filter((frame) => frame.atMs > atMs).map(cloneMotionKeyframe);
    const exact = sorted.find((frame) => frame.atMs === atMs);
    original[target] = [...before, cloneMotionKeyframe(exact ?? boundary)];
    split[target] = [cloneMotionKeyframe(exact ?? boundary), ...after];
  }
  return { original: Object.keys(original).length ? original as MotionLayer["keyframes"] : undefined, split: Object.keys(split).length ? split as MotionLayer["keyframes"] : undefined };
}
function boundaryKeyframe(target: string, keyframes: MotionKeyframe[], atMs: number): MotionKeyframe {
  const isColor = COLOR_KEYFRAME_TARGETS.has(target as MotionKeyframeTarget);
  const isDiscreteString = DISCRETE_STRING_KEYFRAME_TARGETS.has(target as MotionKeyframeTarget);
  const value = isColor ? interpolateColor(keyframes, atMs) : isDiscreteString ? interpolateString(keyframes, atMs) : interpolateNumber(keyframes, atMs);
  if (value === null) {
    const expected = isColor ? "a colour string" : isDiscreteString ? "a string" : "a finite number";
    throw new Error(`Layer split cannot compute a boundary value for ${target} at ${atMs}ms: every keyframe on this target must hold ${expected}, and at least one does not. Fix the values on ${target} and split again; inventing a boundary value here would write animation the author never authored.`);
  }
  const activeFrame = [...keyframes].reverse().find((frame) => frame.atMs < atMs);
  return { atMs, value, ...(activeFrame?.easing ? { easing: activeFrame.easing } : {}) };
}
function timingSnapshot(layer: MotionLayer) {
  return { startMs: layer.startMs, durationMs: layer.durationMs, ...(typeof layer.trimStartMs === "number" ? { trimStartMs: layer.trimStartMs } : {}), ...(typeof layer.trimDurationMs === "number" ? { trimDurationMs: layer.trimDurationMs } : {}) };
}
function readNumber(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function readPositiveNumber(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback; }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isNonNegativeFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
