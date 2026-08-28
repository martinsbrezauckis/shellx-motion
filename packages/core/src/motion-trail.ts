import { createMotionParticleEvaluator, type MotionParticleSample } from "./particle-evaluator";
import { effectivePointCloudAtMs, quantizePointValue, type ResolvedMotionPoint } from "./motion-points";
import type { MotionLayer, MotionTrail } from "./types";

/** Maximum bounded lookback vertices evaluated over all simultaneously active trail layers. */
export const MAX_ACTIVE_TRAIL_VERTICES = 8_192;
export const MAX_TRAIL_DURATION_MS = 2_000;
export const MIN_TRAIL_SAMPLES = 2;
export const MAX_TRAIL_SAMPLES = 8;
/** CPU line work is counted after renderer transform and output clipping, before paint. */
export const MAX_TRAIL_STROKE_PIXELS = 2_000_000;

export interface MotionTrailSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Resolved newer-vertex diameter in document pixels. */
  width: number;
  /** Resolved newer-vertex alpha including the fixed linear taper. */
  opacity: number;
  /** Point colors are optional because their layer provides the existing fallback color. */
  color?: string;
}

export interface MotionTrailGeometry {
  vertices: number;
  segments: MotionTrailSegment[];
}

export interface MotionTrailTransform {
  x: number;
  y: number;
  scale: number;
  originX: number;
  originY: number;
  rotation?: number;
}

export interface MotionTrailStrokePlan {
  segments: MotionTrailSegment[];
  strokePixels: number;
}

export class MotionTrailDrawBudgetError extends Error {
  readonly code = "trail_draw_budget_exceeded";
  constructor(readonly strokePixels: number) {
    super(`Trail stroke work ${strokePixels} exceeds ${MAX_TRAIL_STROKE_PIXELS} pixels.`);
    this.name = "MotionTrailDrawBudgetError";
  }
}

/** Returns null when the layer has no declared trail. Structural validity belongs to validation. */
export function motionTrailForLayer(layer: MotionLayer): MotionTrail | null {
  const effects = plainRecord(layer.effects);
  const value = effects ? plainRecord(ownValue(effects, "trail")) : null;
  const durationMs = value ? finite(ownValue(value, "durationMs")) : null;
  const samples = value ? finite(ownValue(value, "samples")) : null;
  if (durationMs === null || samples === null || !Number.isInteger(samples)) return null;
  return { durationMs, samples };
}

/**
 * Shared, stateless lookback geometry in document coordinates. It has no cache
 * or retained particle history: the caller's timestamp is its entire clock.
 */
export function evaluateMotionTrail(input: {
  layer: MotionLayer;
  atMs: number;
  particleDimensions?: { width: number; height: number };
}): MotionTrailGeometry {
  const trail = motionTrailForLayer(input.layer);
  if (!trail || !isActive(input.layer, input.atMs)) return { vertices: 0, segments: [] };
  if (input.layer.type === "points") return evaluatePointTrail(input.layer, input.atMs, trail);
  if (input.layer.type === "particles") return evaluateParticleTrail(input.layer, input.atMs, trail, input.particleDimensions ?? { width: 100, height: 100 });
  return { vertices: 0, segments: [] };
}

/**
 * Converts document-coordinate segments into the renderer's scaled/translated
 * output coordinates, clips them, and refuses known excessive CPU stroke work.
 */
export function planMotionTrailStroke(input: {
  segments: readonly MotionTrailSegment[];
  transform: MotionTrailTransform;
  clip: { width: number; height: number };
}): MotionTrailStrokePlan {
  const output: MotionTrailSegment[] = [];
  let strokePixels = 0;
  for (const segment of input.segments) {
    if (segment.opacity <= 0 || segment.width <= 0) continue;
    const transformed = transformSegment(segment, input.transform);
    const clipped = clipSegment(transformed, input.clip.width, input.clip.height);
    if (!clipped) continue;
    const width = clipped.width;
    if (!Number.isFinite(width) || width <= 0) continue;
    const length = Math.hypot(clipped.x1 - clipped.x0, clipped.y1 - clipped.y0);
    strokePixels += Math.ceil(length + width) * Math.ceil(width);
    if (strokePixels > MAX_TRAIL_STROKE_PIXELS) throw new MotionTrailDrawBudgetError(strokePixels);
    output.push(clipped);
  }
  return { segments: output, strokePixels };
}

function evaluatePointTrail(layer: MotionLayer, atMs: number, trail: MotionTrail): MotionTrailGeometry {
  const pointCloud = layer.pointCloud;
  if (!pointCloud) return { vertices: 0, segments: [] };
  const sampleTimes = evenlySpacedTimes(Math.max(layer.startMs, atMs - trail.durationMs), atMs, trail.samples);
  const states = sampleTimes.map((time) => effectivePointCloudAtMs(pointCloud, time));
  return segmentsFromStates(states, (point) => point);
}

function evaluateParticleTrail(
  layer: MotionLayer,
  atMs: number,
  trail: MotionTrail,
  dimensions: { width: number; height: number }
): MotionTrailGeometry {
  if (!layer.emitter) return { vertices: 0, segments: [] };
  const evaluator = createMotionParticleEvaluator({ emitter: layer.emitter, atMs, startMs: layer.startMs, ...dimensions });
  const segments: MotionTrailSegment[] = [];
  for (let index = 0; index < evaluator.count; index += 1) {
    const historyStart = Math.max(layer.startMs, evaluator.cycleStartAt(index, atMs), atMs - trail.durationMs);
    const states = evenlySpacedTimes(historyStart, atMs, trail.samples).map((time) => evaluator.sampleAt(index, time));
    appendSegments(segments, states, (sample) => ({ ...sample, x: sample.x + sample.size / 2, y: sample.y + sample.size / 2 }));
  }
  return { vertices: evaluator.count * trail.samples, segments };
}

function segmentsFromStates<T extends ResolvedMotionPoint | MotionParticleSample>(states: T[][], normalize: (value: T) => T): MotionTrailGeometry {
  const segments: MotionTrailSegment[] = [];
  const count = states[0]?.length ?? 0;
  for (let index = 0; index < count; index += 1) appendSegments(segments, states.map((state) => state[index]), normalize);
  return { vertices: count * states.length, segments };
}

function appendSegments<T extends ResolvedMotionPoint | MotionParticleSample>(segments: MotionTrailSegment[], states: T[], normalize: (value: T) => T): void {
  for (let i = 1; i < states.length; i += 1) {
    const older = normalize(states[i - 1]);
    const newer = normalize(states[i]);
    const opacity = quantizePointValue(newer.opacity * (i / (states.length - 1)));
    if (older.x === newer.x && older.y === newer.y) continue;
    segments.push({
      x0: older.x, y0: older.y, x1: newer.x, y1: newer.y,
      width: newer.size,
      opacity,
      ...(newer.color ? { color: newer.color } : {})
    });
  }
}

function evenlySpacedTimes(startMs: number, endMs: number, samples: number): number[] {
  const span = Math.max(0, endMs - startMs);
  return Array.from({ length: samples }, (_value, index) => quantizePointValue(startMs + (span * index) / (samples - 1)));
}

function transformSegment(segment: MotionTrailSegment, transform: MotionTrailTransform): MotionTrailSegment {
  const scale = finite(transform.scale) ?? 1;
  const map = (x: number, y: number) => ({
    x: quantizePointValue(transform.x + transform.originX + (x - transform.originX) * scale),
    y: quantizePointValue(transform.y + transform.originY + (y - transform.originY) * scale)
  });
  const a = map(segment.x0, segment.y0);
  const b = map(segment.x1, segment.y1);
  const rotation = ((finite(transform.rotation) ?? 0) * Math.PI) / 180;
  const rotate = (point: { x: number; y: number }) => {
    const anchorX = transform.x + transform.originX;
    const anchorY = transform.y + transform.originY;
    const dx = point.x - anchorX;
    const dy = point.y - anchorY;
    return {
      x: quantizePointValue(anchorX + dx * Math.cos(rotation) - dy * Math.sin(rotation)),
      y: quantizePointValue(anchorY + dx * Math.sin(rotation) + dy * Math.cos(rotation))
    };
  };
  const rotatedA = rotate(a);
  const rotatedB = rotate(b);
  return { ...segment, x0: rotatedA.x, y0: rotatedA.y, x1: rotatedB.x, y1: rotatedB.y, width: segment.width * Math.abs(scale) };
}

function clipSegment(segment: MotionTrailSegment, width: number, height: number): MotionTrailSegment | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  let x0 = segment.x0;
  let y0 = segment.y0;
  let x1 = segment.x1;
  let y1 = segment.y1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  let start = 0;
  let end = 1;
  const radius = Math.max(0, segment.width / 2);
  for (const [p, q] of [[-dx, x0 + radius], [dx, width + radius - x0], [-dy, y0 + radius], [dy, height + radius - y0]] as const) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const ratio = q / p;
    if (p < 0) {
      if (ratio > end) return null;
      start = Math.max(start, ratio);
    } else {
      if (ratio < start) return null;
      end = Math.min(end, ratio);
    }
  }
  x0 += start * dx;
  y0 += start * dy;
  x1 = segment.x0 + end * dx;
  y1 = segment.y0 + end * dy;
  return { ...segment, x0: quantizePointValue(x0), y0: quantizePointValue(y0), x1: quantizePointValue(x1), y1: quantizePointValue(y1) };
}

function isActive(layer: MotionLayer, atMs: number): boolean {
  return layer.visible !== false && atMs >= layer.startMs && atMs < layer.startMs + layer.durationMs;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  const result = objectRecord(value);
  if (!result) return null;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(result))) {
    if (!("value" in descriptor)) return null;
  }
  return result;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
