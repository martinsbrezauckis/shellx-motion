import {
  validateMotionPointCloudLayers,
  type MotionPoint,
  type MotionPointCloud,
  type MotionPointSample,
} from "./motion-points";
import { readExactPointOperationInput } from "./motion-point-authoring-input";
import { motionTrailForLayer } from "./motion-trail";
import type { MotionDocument, MotionLayer, MotionTrail } from "./types";

export { normalizePointBase as normalizeBasePoint, normalizePointSamplePositions as normalizeSamplePositions } from "./motion-point-authoring-input";

export interface PointLayerState {
  layerIndex: number;
  layer: MotionLayer;
  cloud: MotionPointCloud;
  points: MotionPoint[];
  samples: MotionPointSample[];
}

export function readablePointState(motion: MotionDocument, layerId: string, requireEditable: boolean): PointLayerState {
  assertValidPointPayload(motion);
  if (typeof layerId !== "string" || layerId.length === 0) throw new Error("Point layer id must be a non-empty string.");
  const layerIndex = motion.layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex === -1) throw new Error(`Motion layer not found: ${layerId}.`);
  const layer = motion.layers[layerIndex];
  if (layer.type !== "points") throw new Error(`Motion layer ${layerId} is not a points layer.`);
  if (requireEditable && layer.locked) throw new Error(`Cannot edit locked layer: ${layerId}.`);
  const lockedTrack = requireEditable
    ? (motion.tracks ?? []).find((track) => track.locked && (track.id === layer.trackId || track.layerIds?.includes(layer.id)))
    : undefined;
  if (lockedTrack) throw new Error(`Cannot edit points layer on locked track: ${lockedTrack.id}.`);
  const cloud = layer.pointCloud;
  if (!cloud || !Array.isArray(cloud.points)) throw new Error(`Points layer ${layerId} has no readable pointCloud payload.`);
  const samples = cloud.samples ?? [];
  if (!Array.isArray(samples)) throw new Error(`Points layer ${layerId} has malformed point samples.`);
  return { layerIndex, layer, cloud, points: cloud.points, samples };
}

export function assertOperationInput(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  return readExactPointOperationInput(value, allowed, label);
}

export function assertIndex(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in ${minimum}..${maximum}.`);
  }
}

export function assertRange(startIndex: unknown, endIndexExclusive: unknown, pointCount: number, label: string): void {
  assertIndex(startIndex, 0, pointCount - 1, `${label} startIndex`);
  if (!Number.isInteger(endIndexExclusive) || typeof endIndexExclusive !== "number" || endIndexExclusive <= startIndex || endIndexExclusive > pointCount) {
    throw new Error(`${label} must be a non-empty half-open interval [startIndex, endIndexExclusive) within 0..${pointCount}.`);
  }
}

export function moveArrayEntry<T>(items: T[], fromIndex: number, toIndex: number): void {
  const [item] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, item);
}

export function replacePointLayer(motion: MotionDocument, layerIndex: number, pointCloud: MotionPointCloud): { motion: MotionDocument; layerId: string; layer: MotionLayer } {
  const original = motion.layers[layerIndex];
  const layer = { ...structuredClone(original), pointCloud };
  return {
    motion: {
      ...motion,
      layers: motion.layers.map((candidate, index) => index === layerIndex ? layer : structuredClone(candidate)),
    },
    layerId: layer.id,
    layer,
  };
}

export function changedPointPaths(layerId: string, index: number, sampleCount: number, includeSamplePositions: boolean): string[] {
  return [
    `/layers/${layerId}/pointCloud/points/${index}`,
    ...(includeSamplePositions
      ? Array.from({ length: sampleCount }, (_value, sampleIndex) => `/layers/${layerId}/pointCloud/samples/${sampleIndex}/positions/${index}`)
      : []),
  ];
}

export function changedWholePointOrderingPaths(layerId: string, sampleCount: number): string[] {
  return [
    `/layers/${layerId}/pointCloud/points`,
    ...Array.from({ length: sampleCount }, (_value, sampleIndex) => `/layers/${layerId}/pointCloud/samples/${sampleIndex}/positions`),
  ];
}

export function clonePointTrail(layer: MotionLayer): MotionTrail | null {
  const trail = motionTrailForLayer(layer);
  return trail ? structuredClone(trail) : null;
}

export function assertValidPointPayload(motion: MotionDocument): void {
  const errors: Array<{ path: string; message: string }> = [];
  validateMotionPointCloudLayers(motion.layers, motion.durationMs, errors);
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(`Points authoring requires a valid point payload: ${first.path} ${first.message}.`);
  }
}
