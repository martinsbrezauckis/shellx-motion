import { MAX_ACTIVE_TRAIL_VERTICES, MAX_TRAIL_DURATION_MS, MAX_TRAIL_SAMPLES, MAX_TRAIL_STROKE_PIXELS, MIN_TRAIL_SAMPLES, motionTrailForLayer } from "./motion-trail";
import type { MotionLayer } from "./types";

/** Fail-closed semantic validation plus the active-interval vertex budget. */
export function validateMotionTrailLayers(layers: unknown[], errors: Array<{ path: string; message: string }>): void {
  const events: Array<{ atMs: number; delta: number }> = [];
  layers.forEach((candidate, index) => validateLayer(candidate, index, errors, events));
  let active = 0;
  let maximum = 0;
  events.sort((left, right) => left.atMs - right.atMs || left.delta - right.delta);
  for (const event of events) {
    active += event.delta;
    maximum = Math.max(maximum, active);
  }
  if (maximum > MAX_ACTIVE_TRAIL_VERTICES) {
    errors.push({ path: "/layers", message: `concurrent trail vertex budget ${maximum} exceeds ${MAX_ACTIVE_TRAIL_VERTICES}` });
  }
}

/** Bounded aggregate facts for preflight/receipt routes that already own such evidence. */
export function inspectMotionTrailBudget(layers: readonly MotionLayer[]): {
  activeVertexCeiling: number;
  activeSegmentCeiling: number;
  longestDurationMs: number;
  maxSamples: number;
  strokePixelCeiling: number;
} {
  const events: Array<{ atMs: number; vertices: number; segments: number }> = [];
  let longestDurationMs = 0;
  let maxSamples = 0;
  for (const layer of layers) {
    const trail = motionTrailForLayer(layer);
    if (!trail || (layer.type !== "particles" && layer.type !== "points")) continue;
    const instances = layer.type === "particles" ? layer.emitter?.count ?? 0 : layer.pointCloud?.points.length ?? 0;
    const vertices = instances * trail.samples;
    events.push({ atMs: layer.startMs, vertices, segments: instances * (trail.samples - 1) }, { atMs: layer.startMs + layer.durationMs, vertices: -vertices, segments: -instances * (trail.samples - 1) });
    longestDurationMs = Math.max(longestDurationMs, trail.durationMs);
    maxSamples = Math.max(maxSamples, trail.samples);
  }
  let vertices = 0;
  let segments = 0;
  let activeVertexCeiling = 0;
  let activeSegmentCeiling = 0;
  events.sort((left, right) => left.atMs - right.atMs || left.vertices - right.vertices);
  for (const event of events) {
    vertices += event.vertices;
    segments += event.segments;
    activeVertexCeiling = Math.max(activeVertexCeiling, vertices);
    activeSegmentCeiling = Math.max(activeSegmentCeiling, segments);
  }
  return { activeVertexCeiling, activeSegmentCeiling, longestDurationMs, maxSamples, strokePixelCeiling: MAX_TRAIL_STROKE_PIXELS };
}

function validateLayer(
  candidate: unknown,
  index: number,
  errors: Array<{ path: string; message: string }>,
  events: Array<{ atMs: number; delta: number }>
): void {
  const layer = plainRecord(candidate);
  if (!layer) return;
  const path = `/layers/${index}`;
  const effectsField = ownDataField(layer, "effects");
  if (!effectsField.present) return;
  if (!effectsField.data) return void errors.push({ path: `${path}/effects`, message: "must be a plain data object" });
  const effects = objectRecord(effectsField.value);
  if (!effects) return void errors.push({ path: `${path}/effects`, message: "must be a plain data object" });
  const accessorKey = firstAccessorProperty(effects);
  if (accessorKey) return void errors.push({ path: `${path}/effects/${accessorKey}`, message: "must be a data property" });
  const trailField = ownDataField(effects, "trail");
  if (!trailField.present) return;
  if (!trailField.data) return void errors.push({ path: `${path}/effects/trail`, message: "must be a plain data object" });
  const trail = plainRecord(trailField.value);
  if (!trail) return void errors.push({ path: `${path}/effects/trail`, message: "must be a plain data object" });
  const type = ownValue(layer, "type");
  if (type !== "particles" && type !== "points") errors.push({ path: `${path}/effects/trail`, message: "is supported only on particles and points layers" });
  for (const key of Object.keys(trail)) {
    if (key !== "durationMs" && key !== "samples") errors.push({ path: `${path}/effects/trail/${key}`, message: "is not supported" });
  }
  const durationMs = finite(ownValue(trail, "durationMs"));
  if (durationMs === null || durationMs < 1 || durationMs > MAX_TRAIL_DURATION_MS) {
    errors.push({ path: `${path}/effects/trail/durationMs`, message: `must be a finite number between 1 and ${MAX_TRAIL_DURATION_MS}` });
  }
  const samples = finite(ownValue(trail, "samples"));
  if (samples === null || !Number.isInteger(samples) || samples < MIN_TRAIL_SAMPLES || samples > MAX_TRAIL_SAMPLES) {
    errors.push({ path: `${path}/effects/trail/samples`, message: `must be an integer between ${MIN_TRAIL_SAMPLES} and ${MAX_TRAIL_SAMPLES}` });
  }
  const emitter = plainRecord(ownValue(layer, "emitter"));
  const pointCloud = plainRecord(ownValue(layer, "pointCloud"));
  const instances = type === "particles"
    ? finite(emitter ? ownValue(emitter, "count") : undefined)
    : Array.isArray(pointCloud ? ownValue(pointCloud, "points") : undefined) ? (ownValue(pointCloud!, "points") as unknown[]).length : null;
  const startMs = finite(ownValue(layer, "startMs"));
  const layerDurationMs = finite(ownValue(layer, "durationMs"));
  if (samples !== null && instances !== null && instances > 0 && startMs !== null && layerDurationMs !== null && layerDurationMs > 0) {
    const vertices = Math.floor(instances) * samples;
    events.push({ atMs: startMs, delta: vertices }, { atMs: startMs + layerDurationMs, delta: -vertices });
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  const result = objectRecord(value);
  if (!result || firstAccessorProperty(result)) return null;
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

function ownDataField(value: Record<string, unknown>, key: string): { present: boolean; data: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { present: false, data: false, value: undefined };
  return "value" in descriptor ? { present: true, data: true, value: descriptor.value } : { present: true, data: false, value: undefined };
}

function firstAccessorProperty(value: Record<string, unknown>): string | null {
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) return key;
  }
  return null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
