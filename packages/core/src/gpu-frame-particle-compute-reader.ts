import { GpuFrameIntentError } from "./gpu-frame-intent-error";
import { readGpuFrameEnum, readGpuFrameInteger, isGpuFrameRecord } from "./gpu-frame-intent-readers";
import {
  GPU_COMPUTE_PARTICLE_FIELD_SCHEMA,
  GPU_COMPUTE_PARTICLE_FIELD_V2_SCHEMA,
  GPU_COMPUTE_PARTICLE_MIN_COUNT,
  GPU_COMPUTE_PARTICLE_V2_COMPUTE_DISPATCH_COUNT,
  GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES,
  GPU_COMPUTE_PARTICLE_V2_MAX_RASTER_PASS_COUNT,
  GPU_COMPUTE_PARTICLE_V2_MIN_RASTER_PASS_COUNT,
  GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT
} from "./gpu-particle-compute";
import type { GpuCompositeIntent, GpuRgba } from "./gpu-frame-intent-types";
import type { GpuComputeParticleFieldIntent, GpuComputeParticleFieldV2Intent, GpuComputeParticleIntent } from "./gpu-frame-particle-compute-intent";

type Readers = { seed(value: unknown, name: string): number; finite(value: unknown, name: string): number; bounded(value: unknown, name: string, minimum: number, maximum: number): number; positive(value: unknown, name: string): number; coordinate(value: unknown, name: string): number; rotation(value: unknown, name: string): number; unit(value: unknown, name: string): number; color(value: unknown, name: string): GpuRgba; };

export function readGpuComputeParticleField(draw: Record<string, unknown>, id: string, composite: GpuCompositeIntent, read: Readers, maxCount: number): GpuComputeParticleIntent {
  if (draw.schema === GPU_COMPUTE_PARTICLE_FIELD_SCHEMA) return readV1(draw, id, composite, read, maxCount);
  if (draw.schema === GPU_COMPUTE_PARTICLE_FIELD_V2_SCHEMA) return readV2(draw, id, composite, read, maxCount);
  throw new GpuFrameIntentError(`${id}.schema must be ${GPU_COMPUTE_PARTICLE_FIELD_SCHEMA} or ${GPU_COMPUTE_PARTICLE_FIELD_V2_SCHEMA}.`);
}

function readV1(draw: Record<string, unknown>, id: string, composite: GpuCompositeIntent, read: Readers, maxCount: number): GpuComputeParticleFieldIntent {
  if (composite.blendMode !== "normal" || composite.effects !== null || composite.mask !== undefined) throw new GpuFrameIntentError(`${id} fixed compute particles require normal blend with no effects or mask.`);
  const common = readCommon(draw, id, composite, read, maxCount);
  if (!Array.isArray(draw.sources) || draw.sources.length < 1 || draw.sources.length > 3) throw new GpuFrameIntentError(`${id}.sources must contain 1..3 fixed analytic field sources.`);
  const sources = draw.sources.map((source, index) => { if (!isGpuFrameRecord(source)) throw new GpuFrameIntentError(`${id}.sources[${index}] must be an object.`); return { kind: readGpuFrameEnum(source.kind, `${id}.sources[${index}].kind`, ["radial", "vortex"] as const), centerX: read.unit(source.centerX, `${id}.sources[${index}].centerX`), centerY: read.unit(source.centerY, `${id}.sources[${index}].centerY`), strength: read.bounded(source.strength, `${id}.sources[${index}].strength`, -1, 1), softening: read.bounded(source.softening, `${id}.sources[${index}].softening`, 0.01, 1) }; });
  return { kind: "particleCompute", id, ...composite, schema: GPU_COMPUTE_PARTICLE_FIELD_SCHEMA, ...common, sources };
}

function readV2(draw: Record<string, unknown>, id: string, composite: GpuCompositeIntent, read: Readers, maxCount: number): GpuComputeParticleFieldV2Intent {
  if (composite.blendMode !== "normal" || composite.effects !== null) throw new GpuFrameIntentError(`${id} fixed v2 compute particles require normal blend with no effects.`);
  rejectUnknown(draw, ["kind", "id", "blendMode", "effects", "mask", "schema", "seed", "count", "atMs", "startMs", "lifetimeMs", "width", "height", "x", "y", "scale", "originX", "originY", "rotationDeg", "opacity", "color", "secondaryColor", "minSize", "maxSize", "minSpeed", "maxSpeed", "direction", "spread", "gravity", "fadeOut", "sources", "origins", "trail", "shading", "computeDispatchCount", "rasterPassCount", "instanceBytes", "retainedBufferCount", "retainedInstanceBytes"], id);
  const common = readCommon(draw, id, composite, read, maxCount);
  if (!Array.isArray(draw.sources) || draw.sources.length < 1 || draw.sources.length > 4) throw new GpuFrameIntentError(`${id}.sources must contain 1..4 fixed v2 sources.`);
  if (!Array.isArray(draw.origins) || draw.origins.length < 1 || draw.origins.length > 4) throw new GpuFrameIntentError(`${id}.origins must contain 1..4 fixed origins.`);
  const sources = draw.sources.map((source, index) => readV2Source(source, `${id}.sources[${index}]`, read));
  const origins = draw.origins.map((origin, index) => { if (!isGpuFrameRecord(origin)) throw new GpuFrameIntentError(`${id}.origins[${index}] must be an object.`); rejectUnknown(origin, ["x", "y", "weight", "directionOffsetDeg", "speedScale"], `${id}.origins[${index}]`); return { x: read.unit(origin.x, `${id}.origins[${index}].x`), y: read.unit(origin.y, `${id}.origins[${index}].y`), weight: read.bounded(origin.weight, `${id}.origins[${index}].weight`, 0.01, 1), directionOffsetDeg: read.rotation(origin.directionOffsetDeg, `${id}.origins[${index}].directionOffsetDeg`), speedScale: read.bounded(origin.speedScale, `${id}.origins[${index}].speedScale`, 0.25, 4) }; });
  const trail = draw.trail === null ? null : readV2Trail(draw.trail, `${id}.trail`, read);
  const shading = readV2Shading(draw.shading, `${id}.shading`, read);
  const expectedRasterPassCount = trail ? GPU_COMPUTE_PARTICLE_V2_MAX_RASTER_PASS_COUNT : GPU_COMPUTE_PARTICLE_V2_MIN_RASTER_PASS_COUNT;
  const retainedInstanceBytes = common.count * GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES * GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT;
  if (draw.computeDispatchCount !== GPU_COMPUTE_PARTICLE_V2_COMPUTE_DISPATCH_COUNT || draw.rasterPassCount !== expectedRasterPassCount || draw.instanceBytes !== GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES || draw.retainedBufferCount !== GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT || draw.retainedInstanceBytes !== retainedInstanceBytes) throw new GpuFrameIntentError(`${id} v2 fixed pass or retained-memory evidence does not match the admitted ABI.`);
  return { kind: "particleCompute", id, ...composite, schema: GPU_COMPUTE_PARTICLE_FIELD_V2_SCHEMA, ...common, sources, origins, trail, shading, computeDispatchCount: GPU_COMPUTE_PARTICLE_V2_COMPUTE_DISPATCH_COUNT, rasterPassCount: expectedRasterPassCount, instanceBytes: GPU_COMPUTE_PARTICLE_V2_INSTANCE_BYTES, retainedBufferCount: GPU_COMPUTE_PARTICLE_V2_PING_PONG_BUFFER_COUNT, retainedInstanceBytes };
}

function readCommon(draw: Record<string, unknown>, id: string, composite: GpuCompositeIntent, read: Readers, maxCount: number) {
  const count = readGpuFrameInteger(draw.count, `${id}.count`, GPU_COMPUTE_PARTICLE_MIN_COUNT, maxCount), minSize = read.positive(draw.minSize, `${id}.minSize`), maxSize = read.positive(draw.maxSize, `${id}.maxSize`), minSpeed = read.bounded(draw.minSpeed, `${id}.minSpeed`, 0, 2_000), maxSpeed = read.bounded(draw.maxSpeed, `${id}.maxSpeed`, 0, 2_000);
  if (maxSize < minSize) throw new GpuFrameIntentError(`${id}.maxSize must be greater than or equal to minSize.`);
  if (maxSpeed < minSpeed || typeof draw.fadeOut !== "boolean") throw new GpuFrameIntentError(`${id} compute particle speed range or fadeOut is invalid.`);
  return { seed: read.seed(draw.seed, `${id}.seed`), count, atMs: nonNegative(read.finite(draw.atMs, `${id}.atMs`), `${id}.atMs`), startMs: nonNegative(read.finite(draw.startMs, `${id}.startMs`), `${id}.startMs`), lifetimeMs: read.bounded(draw.lifetimeMs, `${id}.lifetimeMs`, 0.000001, 60_000), width: read.positive(draw.width, `${id}.width`), height: read.positive(draw.height, `${id}.height`), x: read.coordinate(draw.x, `${id}.x`), y: read.coordinate(draw.y, `${id}.y`), scale: positiveUnitless(read.finite(draw.scale, `${id}.scale`), `${id}.scale`), originX: read.coordinate(draw.originX, `${id}.originX`), originY: read.coordinate(draw.originY, `${id}.originY`), rotationDeg: read.rotation(draw.rotationDeg, `${id}.rotationDeg`), opacity: read.unit(draw.opacity, `${id}.opacity`), color: read.color(draw.color, `${id}.color`), secondaryColor: read.color(draw.secondaryColor, `${id}.secondaryColor`), minSize, maxSize, minSpeed, maxSpeed, direction: read.rotation(draw.direction, `${id}.direction`), spread: read.bounded(draw.spread, `${id}.spread`, 0, 360), gravity: read.bounded(draw.gravity, `${id}.gravity`, -5_000, 5_000), fadeOut: draw.fadeOut };
}

function readV2Source(value: unknown, path: string, read: Readers) {
  if (!isGpuFrameRecord(value)) throw new GpuFrameIntentError(`${path} must be an object.`);
  if (value.kind === "radial" || value.kind === "vortex") { rejectUnknown(value, ["kind", "centerX", "centerY", "strength", "softening"], path); return { kind: value.kind, centerX: read.unit(value.centerX, `${path}.centerX`), centerY: read.unit(value.centerY, `${path}.centerY`), strength: read.bounded(value.strength, `${path}.strength`, -1, 1), softening: read.bounded(value.softening, `${path}.softening`, 0.01, 1) } as const; }
  if (value.kind === "flow") { rejectUnknown(value, ["kind", "angleDeg", "strength"], path); return { kind: "flow" as const, angleDeg: read.bounded(value.angleDeg, `${path}.angleDeg`, -360, 360), strength: read.bounded(value.strength, `${path}.strength`, -1, 1) }; }
  if (value.kind === "turbulence") { rejectUnknown(value, ["kind", "scale", "strength"], path); return { kind: "turbulence" as const, scale: read.bounded(value.scale, `${path}.scale`, 0.01, 4), strength: read.bounded(value.strength, `${path}.strength`, -1, 1) }; }
  if (value.kind === "impact") { rejectUnknown(value, ["kind", "centerX", "centerY", "radius", "strength", "startProgress", "durationProgress"], path); const startProgress = read.unit(value.startProgress, `${path}.startProgress`), durationProgress = read.bounded(value.durationProgress, `${path}.durationProgress`, 0.01, 1); if (startProgress + durationProgress > 1) throw new GpuFrameIntentError(`${path}.impact must end within progress 0..1.`); return { kind: "impact" as const, centerX: read.unit(value.centerX, `${path}.centerX`), centerY: read.unit(value.centerY, `${path}.centerY`), radius: read.bounded(value.radius, `${path}.radius`, 0.01, 1), strength: read.bounded(value.strength, `${path}.strength`, -1, 1), startProgress, durationProgress }; }
  if (value.kind === "collision") { rejectUnknown(value, ["kind", "axis", "position", "restitution"], path); return { kind: "collision" as const, axis: readGpuFrameEnum(value.axis, `${path}.axis`, ["x", "y"] as const), position: read.unit(value.position, `${path}.position`), restitution: read.unit(value.restitution, `${path}.restitution`) }; }
  throw new GpuFrameIntentError(`${path}.kind is not an admitted v2 source.`);
}

function readV2Trail(value: unknown, path: string, read: Readers) { if (!isGpuFrameRecord(value)) throw new GpuFrameIntentError(`${path} must be null or an object.`); rejectUnknown(value, ["durationMs", "samples", "opacity"], path); return { durationMs: read.bounded(value.durationMs, `${path}.durationMs`, 1, 1_000), samples: readGpuFrameInteger(value.samples, `${path}.samples`, 2, 4), opacity: read.bounded(value.opacity, `${path}.opacity`, 0.05, 1) }; }
function readV2Shading(value: unknown, path: string, read: Readers) { if (!isGpuFrameRecord(value)) throw new GpuFrameIntentError(`${path} must be an object.`); rejectUnknown(value, ["mode", "sizeJitter", "opacityJitter", "glow"], path); return { mode: readGpuFrameEnum(value.mode, `${path}.mode`, ["flat", "soft", "glow"] as const), sizeJitter: read.unit(value.sizeJitter, `${path}.sizeJitter`), opacityJitter: read.unit(value.opacityJitter, `${path}.opacityJitter`), glow: read.unit(value.glow, `${path}.glow`) }; }
function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], path: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new GpuFrameIntentError(`${path}.${key} is not supported by the fixed v2 particle ABI.`); }
function nonNegative(value: number, name: string): number { if (value < 0) throw new GpuFrameIntentError(`${name} must be non-negative.`); return value; }
function positiveUnitless(value: number, name: string): number { if (value <= 0 || value > 64) throw new GpuFrameIntentError(`${name} must be positive and no more than 64.`); return value; }
