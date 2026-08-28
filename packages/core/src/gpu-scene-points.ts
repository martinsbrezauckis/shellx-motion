import { createHash } from "node:crypto";
import { type GpuDrawIntent, type GpuPrimitiveIntent } from "./gpu-frame-intent";
import { effectivePointCloudAtMs, type MotionPointCloud } from "./motion-points";
import { evaluateMotionParticles } from "./particle-evaluator";
import { parseGpuSceneColor } from "./gpu-scene-color";
import { gpuSceneEffects } from "./gpu-scene-effects";
import { compileGpuSceneTrail } from "./gpu-scene-trail";
import { gpuComputeParticleEmitterAbi, gpuComputeParticleEmitterProblem, isGpuComputeParticleEmitter, GPU_COMPUTE_PARTICLE_FIELD_SCHEMA, GPU_COMPUTE_PARTICLE_FIELD_V2_SCHEMA, GPU_COMPUTE_PARTICLE_V2_COMPUTE_DISPATCH_COUNT, GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES, GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT } from "./gpu-particle-compute";
import { normalizeParticleField, normalizeParticleOrigins, normalizeParticleShading, normalizeParticleTrail } from "./particle-field-normalize";
import type { GpuScene2dFailure } from "./gpu-scene-2d-plan";
import type { MotionDocument, MotionLayer } from "./types";

export function compileGpuScenePoints(layer: MotionLayer, sourceLayer: MotionLayer, cloud: MotionPointCloud, motion: MotionDocument, atMs: number): { ok: true; draws: GpuPrimitiveIntent[]; pointCount: number } | { ok: false; failure: GpuScene2dFailure } {
  const transform = layer.transform ?? {};
  const x = finite(transform.x ?? 0), y = finite(transform.y ?? 0), scale = positive(transform.scale ?? 1);
  const originX = finite(transform.originX ?? motion.width / 2), originY = finite(transform.originY ?? motion.height / 2), rotation = finite(transform.rotation ?? 0), opacity = unit(layer.opacity ?? transform.opacity ?? 1);
  if (x === null || y === null || scale === null || originX === null || originY === null || rotation === null || opacity === null) return failure("gpu_unsupported_feature", `GPU scene layer ${layer.id} has invalid point transform or opacity.`, layer.id);
  const fallback = layer.color ?? layer.fill ?? stringStyle(layer, "color") ?? stringStyle(layer, "fill") ?? "#ffffff";
  if (!parseGpuSceneColor(fallback)) return failure("gpu_unsupported_color", `GPU scene layer ${layer.id} uses unsupported fallback color '${fallback}'.`, layer.id);
  const points: Extract<GpuDrawIntent, { kind: "points" }>['points'] = [];
  for (const [index, point] of effectivePointCloudAtMs(cloud, atMs).entries()) {
    const color = parseGpuSceneColor(point.color ?? fallback);
    if (!color) return failure("gpu_unsupported_color", `GPU scene layer ${layer.id} point ${index} uses an unsupported color.`, layer.id);
    const positioned = rotate({ x: x + originX + ((point.x - originX) * scale), y: y + originY + ((point.y - originY) * scale) }, { x: x + originX, y: y + originY }, rotation);
    points.push({ x: positioned.x, y: positioned.y, size: point.size * scale, color: { ...color, a: color.a * point.opacity * opacity } });
  }
  const trail = compileGpuSceneTrail({ layer, atMs, dimensions: motion, viewport: motion, transform: { x, y, scale, originX, originY, rotation }, fallbackColor: fallback, opacity });
  if (!trail.ok) return failure("gpu_unsupported_feature", trail.message, layer.id);
  const instanceBufferMode = sourceLayer.pointCloud?.samples?.length || Object.keys(sourceLayer.keyframes ?? {}).length || sourceLayer.transitions?.in || sourceLayer.transitions?.out ? "dynamic" as const : "static" as const;
  return { ok: true, draws: [...trail.draws, { kind: "points", id: layer.id, blendMode: layer.blendMode ?? "normal", effects: gpuSceneEffects(layer), seed: seed(layer.id), instanceBufferMode, points }], pointCount: trail.pointCount + points.length };
}

export function compileGpuSceneParticles(layer: MotionLayer, atMs: number, motion: Pick<MotionDocument, "width" | "height">): { ok: true; draws: GpuPrimitiveIntent[]; particleCount: number; pointCount: number } | { ok: false; failure: GpuScene2dFailure } {
  const emitter = layer.emitter;
  if (!emitter) return failure("gpu_unsupported_layer", `GPU scene requires emitter data on layer ${layer.id}.`, layer.id);
  const transform = layer.transform ?? {};
  const width = positive(transform.width ?? layer.width ?? numberStyle(layer, "width") ?? 100), height = positive(transform.height ?? layer.height ?? numberStyle(layer, "height") ?? 100);
  const x = finite(transform.x ?? 0), y = finite(transform.y ?? 0), scale = positive(transform.scale ?? 1), opacity = unit(layer.opacity ?? transform.opacity ?? 1);
  const originX = finite(transform.originX ?? (width ?? 0) / 2), originY = finite(transform.originY ?? (height ?? 0) / 2), rotation = finite(transform.rotation ?? 0);
  if (width === null || height === null || x === null || y === null || scale === null || opacity === null || originX === null || originY === null || rotation === null) return failure("gpu_unsupported_feature", `GPU scene layer ${layer.id} has invalid particle geometry, opacity, or transform origin.`, layer.id);
  if (emitter.field?.schema === "shellx-motion/particle-field@2" && emitter.count <= 1_000) return failure("gpu_unsupported_feature", `GPU particle layer ${layer.id} cannot lower ${emitter.field.schema} through the low-count CPU path; it requires the fixed high-density renderer ABI.`, layer.id);
  if (emitter.count > 1_000) {
    const problem = gpuComputeParticleEmitterProblem(emitter);
    if (problem) return failure("gpu_resource_refused", `GPU scene layer ${layer.id} ${problem}`, layer.id);
    if (!isGpuComputeParticleEmitter(emitter)) return failure("gpu_resource_refused", `GPU scene layer ${layer.id} cannot form a fixed compute particle descriptor.`, layer.id);
    if ((layer.blendMode ?? "normal") !== "normal" || layer.effects) {
      return failure("gpu_unsupported_feature", `GPU compute particle layer ${layer.id} requires normal blend with no effects, trails, or temporal blur.`, layer.id);
    }
    const color = parseGpuSceneColor(emitter.color);
    const secondaryColor = parseGpuSceneColor(emitter.secondaryColor ?? emitter.color);
    if (!color || !secondaryColor) return failure("gpu_unsupported_color", `GPU compute particle layer ${layer.id} uses an unsupported particle color.`, layer.id);
    const abi = gpuComputeParticleEmitterAbi(emitter);
    if (!abi) return failure("gpu_resource_refused", `GPU scene layer ${layer.id} cannot form a fixed compute particle ABI.`, layer.id);
    const common = {
      kind: "particleCompute" as const,
      id: layer.id,
      blendMode: "normal" as const,
      effects: null,
      seed: emitter.seed >>> 0,
      count: emitter.count,
      atMs,
      startMs: layer.startMs,
      lifetimeMs: emitter.lifetimeMs,
      width,
      height,
      x,
      y,
      scale,
      originX,
      originY,
      rotationDeg: rotation,
      opacity,
      color,
      secondaryColor,
      minSize: emitter.minSize ?? 2,
      maxSize: emitter.maxSize ?? 8,
      minSpeed: emitter.minSpeed ?? 20,
      maxSpeed: emitter.maxSpeed ?? 80,
      direction: emitter.direction ?? -90,
      spread: emitter.spread ?? 45,
      gravity: emitter.gravity ?? 0,
      fadeOut: emitter.fadeOut !== false
    };
    if (abi === "v1") return {
      ok: true,
      draws: [{ ...common,
        schema: GPU_COMPUTE_PARTICLE_FIELD_SCHEMA,
        sources: emitter.field.sources.map((source) => ({ ...source })) as Array<{ kind: "radial" | "vortex"; centerX: number; centerY: number; strength: number; softening: number }>
      }],
      particleCount: emitter.count,
      pointCount: 0
    };
    const field = normalizeParticleField(emitter.field);
    if (field.schema !== "shellx-motion/particle-field@2") return failure("gpu_resource_refused", `GPU scene layer ${layer.id} has no v2 field source data.`, layer.id);
    const origins = normalizeParticleOrigins(emitter.origins, field.schema);
    const trail = normalizeParticleTrail(emitter.trail, field.schema);
    const shading = normalizeParticleShading(emitter.shading, field.schema);
    const retainedInstanceBytes = emitter.count * GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES * GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT;
    return {
      ok: true,
      draws: [{ ...common, schema: GPU_COMPUTE_PARTICLE_FIELD_V2_SCHEMA,
        sources: field.sources.map((source) => ({ ...source })),
        origins: (origins.length ? origins : [{ x: 0.5, y: 0.5, weight: 1 }]).map((origin) => ({ x: origin.x, y: origin.y, weight: origin.weight, directionOffsetDeg: origin.directionOffsetDeg ?? 0, speedScale: origin.speedScale ?? 1 })),
        trail: trail ? { durationMs: trail.durationMs, samples: trail.samples, opacity: trail.opacity ?? 1 } : null,
        shading: { mode: shading?.mode ?? "flat", sizeJitter: shading?.sizeJitter ?? 0, opacityJitter: shading?.opacityJitter ?? 0, glow: shading?.glow ?? 0 },
        computeDispatchCount: GPU_COMPUTE_PARTICLE_V2_COMPUTE_DISPATCH_COUNT,
        rasterPassCount: trail ? 2 as const : 1 as const,
        instanceBytes: GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES,
        retainedBufferCount: GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT,
        retainedInstanceBytes
      }], particleCount: emitter.count, pointCount: 0
    };
  }
  const samples = evaluateMotionParticles({ emitter, atMs, startMs: layer.startMs, width, height });
  const trail = compileGpuSceneTrail({ layer, atMs, dimensions: { width, height }, viewport: motion, transform: { x, y, scale, originX, originY, rotation }, fallbackColor: emitter.color, opacity });
  if (!trail.ok) return failure("gpu_unsupported_feature", trail.message, layer.id);
  const base = { kind: "points" as const, id: layer.id, blendMode: layer.blendMode ?? "normal", effects: gpuSceneEffects(layer), seed: seed(layer.id), instanceBufferMode: "dynamic" as const };
  if (samples.length === 0) return { ok: true, draws: [...trail.draws, { ...base, points: [] }], particleCount: 0, pointCount: trail.pointCount };
  const pivot = { x: x + originX, y: y + originY };
  if (samples.every((particle) => particle.shape === "circle")) {
    const points: Extract<GpuDrawIntent, { kind: "points" }>['points'] = [];
    for (const [index, particle] of samples.entries()) {
      const color = parseGpuSceneColor(particle.color); if (!color) return failure("gpu_unsupported_color", `GPU scene layer ${layer.id} particle ${index} uses an unsupported color.`, layer.id);
      const diameter = particle.size * scale;
      const positioned = rotate({ x: x + originX + ((particle.x - originX) * scale) + diameter / 2, y: y + originY + ((particle.y - originY) * scale) + diameter / 2 }, pivot, rotation);
      points.push({ x: positioned.x, y: positioned.y, size: diameter, color: { ...color, a: color.a * particle.opacity * opacity } });
    }
    return { ok: true, draws: [...trail.draws, { ...base, points }], particleCount: samples.length, pointCount: trail.pointCount + points.length };
  }
  const temporal = Boolean(layer.effects?.motionBlur);
  if (((layer.blendMode && layer.blendMode !== "normal") || gpuSceneEffects(layer)) && !temporal) return failure("gpu_unsupported_feature", `GPU scene square particle layer ${layer.id} requires temporal grouped compositing.`, layer.id);
  const id = `particle-${createHash("sha256").update(layer.id, "utf8").digest("hex").slice(0, 16)}`;
  const draws: GpuPrimitiveIntent[] = [...trail.draws];
  for (const [index, particle] of samples.entries()) {
    const color = parseGpuSceneColor(particle.color); if (!color) return failure("gpu_unsupported_color", `GPU scene layer ${layer.id} particle ${index} uses an unsupported color.`, layer.id);
    const diameter = particle.size * scale;
    draws.push({ kind: "rect", id: `${id}-${index}`, blendMode: temporal ? layer.blendMode ?? "normal" : "normal", effects: temporal ? gpuSceneEffects(layer) : null, x: x + originX + ((particle.x - originX) * scale), y: y + originY + ((particle.y - originY) * scale), width: diameter, height: diameter, rotationDeg: rotation, pivotX: pivot.x, pivotY: pivot.y, color: { ...color, a: color.a * particle.opacity * opacity } });
  }
  return { ok: true, draws, particleCount: samples.length, pointCount: trail.pointCount };
}

function finite(value: number): number | null { return Number.isFinite(value) ? value : null; }
function positive(value: number): number | null { return Number.isFinite(value) && value > 0 ? value : null; }
function unit(value: number): number | null { return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null; }
function numberStyle(layer: MotionLayer, key: string): number | null { const value = layer.style?.[key]; return typeof value === "number" && Number.isFinite(value) ? value : null; }
function stringStyle(layer: MotionLayer, key: string): string | null { const value = layer.style?.[key]; return typeof value === "string" ? value : null; }
function seed(value: string): number { return createHash("sha256").update(value, "utf8").digest().readUInt32BE(0); }
function rotate(point: { x: number; y: number }, pivot: { x: number; y: number }, rotationDeg: number): { x: number; y: number } { if (Math.abs(rotationDeg % 360) < 0.0001) return point; const r = rotationDeg * (Math.PI / 180), x = point.x - pivot.x, y = point.y - pivot.y; return { x: pivot.x + x * Math.cos(r) - y * Math.sin(r), y: pivot.y + x * Math.sin(r) + y * Math.cos(r) }; }
function failure(code: GpuScene2dFailure["code"], message: string, layerId: string): { ok: false; failure: GpuScene2dFailure } { return { ok: false, failure: { code, message, layerId } }; }
