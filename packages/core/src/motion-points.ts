import { canonicalJson } from "./canonical-json";
import { isSupportedMotionColorString } from "./color";
import {
  ABSOLUTE_POINTS_PER_LAYER,
  PORTABLE_POINT_CLOUD_BYTES_PER_LAYER,
  PORTABLE_POINT_STATE_RECORDS_PER_LAYER,
} from "./host-render-capacity";

/**
 * Bounded, ordered point-cloud data for the `points` layer.
 *
 * Point indexes are stable identities. Samples deliberately carry positions by
 * index rather than IDs, which keeps a 4,201-point swarm compact and makes the
 * interpolation order independent of object-key ordering or host locale.
 */
export interface MotionPoint {
  x: number;
  y: number;
  color?: string;
  size?: number;
  opacity?: number;
}

export interface MotionPointSamplePosition {
  x: number;
  y: number;
  size?: number;
  opacity?: number;
}

export interface MotionPointSample {
  /** Absolute `motion@1` milliseconds. v2 exact-time migration owns any replacement. */
  atMs: number;
  /** Exactly one entry for every base `points` index, in that same order. */
  positions: MotionPointSamplePosition[];
}

export interface MotionPointCloud {
  points: MotionPoint[];
  samples?: MotionPointSample[];
}

export interface ResolvedMotionPoint {
  x: number;
  y: number;
  color?: string;
  size: number;
  opacity: number;
}

export const MAX_POINTS_PER_LAYER = ABSOLUTE_POINTS_PER_LAYER;
export const MAX_POINT_SAMPLES_PER_LAYER = 12;
export const MAX_POINT_STATE_RECORDS_PER_LAYER = PORTABLE_POINT_STATE_RECORDS_PER_LAYER * 8;
export const MAX_POINT_CLOUD_BYTES_PER_LAYER = PORTABLE_POINT_CLOUD_BYTES_PER_LAYER * 8;
export const MAX_POINT_LAYERS_PER_DOCUMENT = 4;
export const MAX_POINT_STATE_RECORDS_PER_DOCUMENT = MAX_POINT_STATE_RECORDS_PER_LAYER * MAX_POINT_LAYERS_PER_DOCUMENT;
export const MAX_POINT_CLOUD_BYTES_PER_DOCUMENT = MAX_POINT_CLOUD_BYTES_PER_LAYER * MAX_POINT_LAYERS_PER_DOCUMENT;
export const MAX_POINT_COORDINATE = 1_000_000;
export const MAX_POINT_SIZE = 256;
export const DEFAULT_POINT_SIZE = 2;
export const DEFAULT_POINT_OPACITY = 1;
export const POINT_VALUE_DECIMALS = 6;

export interface MotionPointValidationIssue { path: string; message: string }

/**
 * Runtime semantic authority for the points family. JSON Schema supplies the
 * per-record structural shape; this function owns cross-sample ordering,
 * aggregate budgets, and canonical UTF-8 payload limits.
 */
export function validateMotionPointCloudLayers(
  layers: unknown[],
  documentDurationMs: number | undefined,
  issues: MotionPointValidationIssue[],
): void {
  let pointLayerCount = 0;
  let totalRecords = 0;
  let totalBytes = 0;

  layers.forEach((candidate, index) => {
    const path = `/layers/${index}`;
    const layer = record(candidate);
    if (!layer) return;
    const hasPointCloud = Object.hasOwn(layer, "pointCloud");
    if (layer.type !== "points") {
      if (hasPointCloud) issues.push({ path: `${path}/pointCloud`, message: "is supported only on points layers" });
      return;
    }

    pointLayerCount += 1;
    if (Object.hasOwn(layer, "width") || Object.hasOwn(layer, "height")) {
      issues.push({ path, message: "points layers use the document viewport; width and height are not supported" });
    }
    const transform = record(layer.transform);
    if (transform && (Object.hasOwn(transform, "width") || Object.hasOwn(transform, "height"))) {
      issues.push({ path: `${path}/transform`, message: "points layers support translate, scale, rotation, and origin but not transform width or height" });
    }

    const pointCloud = record(layer.pointCloud);
    if (!pointCloud) {
      issues.push({ path: `${path}/pointCloud`, message: "must be an object on points layers" });
      return;
    }
    const result = validatePointCloud(pointCloud, path, layer, documentDurationMs, issues);
    totalRecords += result.records;
    totalBytes += result.bytes;
  });

  if (pointLayerCount > MAX_POINT_LAYERS_PER_DOCUMENT) {
    issues.push({ path: "/layers", message: `contains more than ${MAX_POINT_LAYERS_PER_DOCUMENT} points layers` });
  }
  if (totalRecords > MAX_POINT_STATE_RECORDS_PER_DOCUMENT) {
    issues.push({ path: "/layers", message: `points state records exceed ${MAX_POINT_STATE_RECORDS_PER_DOCUMENT}` });
  }
  if (totalBytes > MAX_POINT_CLOUD_BYTES_PER_DOCUMENT) {
    issues.push({ path: "/layers", message: `points payload bytes exceed ${MAX_POINT_CLOUD_BYTES_PER_DOCUMENT}` });
  }
}

/** Resolve the deterministic, clamped linear point state at an absolute v1 timestamp. */
export function effectivePointCloudAtMs(pointCloud: MotionPointCloud, atMs: number): ResolvedMotionPoint[] {
  const samples = pointCloud.samples ?? [];
  if (!samples.length) return pointCloud.points.map((point) => resolvedPoint(point));
  const pair = samplePair(samples, atMs);
  return pointCloud.points.map((base, index) => {
    const left = pair.left.positions[index] ?? base;
    const right = pair.right.positions[index] ?? left;
    return {
      x: interpolatePointValue(left.x, right.x, pair.progress),
      y: interpolatePointValue(left.y, right.y, pair.progress),
      ...(base.color ? { color: base.color } : {}),
      size: interpolatePointValue(left.size ?? base.size ?? DEFAULT_POINT_SIZE, right.size ?? base.size ?? DEFAULT_POINT_SIZE, pair.progress),
      opacity: interpolatePointValue(left.opacity ?? base.opacity ?? DEFAULT_POINT_OPACITY, right.opacity ?? base.opacity ?? DEFAULT_POINT_OPACITY, pair.progress),
    };
  });
}

/** The host-stable numeric rule shared by point interpolation and trig evaluation. */
export function quantizePointValue(value: number): number {
  const result = Number(value.toFixed(POINT_VALUE_DECIMALS));
  return Object.is(result, -0) ? 0 : result;
}

function validatePointCloud(
  pointCloud: Record<string, unknown>,
  layerPath: string,
  layer: Record<string, unknown>,
  documentDurationMs: number | undefined,
  issues: MotionPointValidationIssue[],
): { records: number; bytes: number } {
  const cloudPath = `${layerPath}/pointCloud`;
  const points = Array.isArray(pointCloud.points) ? pointCloud.points : [];
  if (!Array.isArray(pointCloud.points) || points.length < 1 || points.length > MAX_POINTS_PER_LAYER) {
    issues.push({ path: `${cloudPath}/points`, message: `must contain 1..${MAX_POINTS_PER_LAYER} ordered points` });
  }
  points.forEach((point, index) => validateBasePoint(point, `${cloudPath}/points/${index}`, issues));

  const samples = pointCloud.samples === undefined ? [] : Array.isArray(pointCloud.samples) ? pointCloud.samples : [];
  if (pointCloud.samples !== undefined && (!Array.isArray(pointCloud.samples) || samples.length > MAX_POINT_SAMPLES_PER_LAYER)) {
    issues.push({ path: `${cloudPath}/samples`, message: `must contain at most ${MAX_POINT_SAMPLES_PER_LAYER} samples` });
  }
  let previousAtMs = -Infinity;
  const layerStartMs = finite(layer.startMs);
  const layerDurationMs = finite(layer.durationMs);
  const layerEndMs = layerStartMs !== null && layerDurationMs !== null ? layerStartMs + layerDurationMs : documentDurationMs;
  samples.forEach((sample, sampleIndex) => {
    const samplePath = `${cloudPath}/samples/${sampleIndex}`;
    const value = record(sample);
    if (!value) {
      issues.push({ path: samplePath, message: "must be an object" });
      return;
    }
    const atMs = finite(value.atMs);
    if (atMs === null || atMs <= previousAtMs || (layerStartMs !== null && atMs < layerStartMs) || (layerEndMs !== undefined && atMs > layerEndMs)) {
      issues.push({ path: `${samplePath}/atMs`, message: "must be finite, within the layer timing, and strictly increasing" });
    } else {
      previousAtMs = atMs;
    }
    const positions = Array.isArray(value.positions) ? value.positions : [];
    if (!Array.isArray(value.positions) || positions.length !== points.length) {
      issues.push({ path: `${samplePath}/positions`, message: "must contain exactly one ordered position for each base point" });
    }
    positions.forEach((position, positionIndex) => validateSamplePosition(position, `${samplePath}/positions/${positionIndex}`, issues));
  });

  const records = points.length + samples.reduce((sum, sample) => {
    const positions = record(sample)?.positions;
    return sum + (Array.isArray(positions) ? positions.length : 0);
  }, 0);
  if (records > MAX_POINT_STATE_RECORDS_PER_LAYER) {
    issues.push({ path: cloudPath, message: `state records exceed ${MAX_POINT_STATE_RECORDS_PER_LAYER}` });
  }
  const bytes = canonicalUtf8Bytes(pointCloud, cloudPath, issues);
  if (bytes > MAX_POINT_CLOUD_BYTES_PER_LAYER) {
    issues.push({ path: cloudPath, message: `canonical payload exceeds ${MAX_POINT_CLOUD_BYTES_PER_LAYER} bytes` });
  }
  return { records, bytes };
}

function validateBasePoint(value: unknown, path: string, issues: MotionPointValidationIssue[]): void {
  const point = record(value);
  if (!point) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  validateCoordinates(point, path, issues);
  if (point.color !== undefined && !isSupportedMotionColorString(point.color)) {
    issues.push({ path: `${path}/color`, message: "must be a supported static color string" });
  }
  validateOptionalSizeAndOpacity(point, path, issues);
}

function validateSamplePosition(value: unknown, path: string, issues: MotionPointValidationIssue[]): void {
  const point = record(value);
  if (!point) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  if (Object.hasOwn(point, "color")) issues.push({ path: `${path}/color`, message: "is static on the base point and cannot be sampled" });
  validateCoordinates(point, path, issues);
  validateOptionalSizeAndOpacity(point, path, issues);
}

function validateCoordinates(point: Record<string, unknown>, path: string, issues: MotionPointValidationIssue[]): void {
  for (const key of ["x", "y"] as const) {
    const value = finite(point[key]);
    if (value === null || Math.abs(value) > MAX_POINT_COORDINATE) {
      issues.push({ path: `${path}/${key}`, message: `must be a finite number between -${MAX_POINT_COORDINATE} and ${MAX_POINT_COORDINATE}` });
    }
  }
}

function validateOptionalSizeAndOpacity(point: Record<string, unknown>, path: string, issues: MotionPointValidationIssue[]): void {
  if (point.size !== undefined && (finite(point.size) === null || Number(point.size) <= 0 || Number(point.size) > MAX_POINT_SIZE)) {
    issues.push({ path: `${path}/size`, message: `must be a finite number greater than 0 and at most ${MAX_POINT_SIZE}` });
  }
  if (point.opacity !== undefined && (finite(point.opacity) === null || Number(point.opacity) < 0 || Number(point.opacity) > 1)) {
    issues.push({ path: `${path}/opacity`, message: "must be a finite number between 0 and 1" });
  }
}

function canonicalUtf8Bytes(value: unknown, path: string, issues: MotionPointValidationIssue[]): number {
  try {
    return new TextEncoder().encode(canonicalJson(value)).byteLength;
  } catch {
    issues.push({ path, message: "must be canonically serializable" });
    return MAX_POINT_CLOUD_BYTES_PER_LAYER + 1;
  }
}

function samplePair(samples: MotionPointSample[], atMs: number): { left: MotionPointSample; right: MotionPointSample; progress: number } {
  if (atMs <= samples[0].atMs) return { left: samples[0], right: samples[0], progress: 0 };
  const last = samples.at(-1)!;
  if (atMs >= last.atMs) return { left: last, right: last, progress: 0 };
  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].atMs <= atMs) low = middle;
    else high = middle;
  }
  const left = samples[low];
  const right = samples[high];
  return { left, right, progress: (atMs - left.atMs) / (right.atMs - left.atMs) };
}

function resolvedPoint(point: MotionPoint): ResolvedMotionPoint {
  return {
    x: quantizePointValue(point.x),
    y: quantizePointValue(point.y),
    ...(point.color ? { color: point.color } : {}),
    size: quantizePointValue(point.size ?? DEFAULT_POINT_SIZE),
    opacity: quantizePointValue(point.opacity ?? DEFAULT_POINT_OPACITY),
  };
}

function interpolatePointValue(left: number, right: number, progress: number): number {
  return quantizePointValue(left + (right - left) * progress);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
