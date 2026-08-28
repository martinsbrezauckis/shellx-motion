import type { GpuFrameRenderSession } from "./gpu-frame-renderer";
import type { GpuPageSessionResourceMetrics } from "./gpu-page-session-resources";
import { GPU_SESSION_AFTERIMAGE_STACK_LIVE_FIELDS, GPU_SESSION_AFTERIMAGE_STACK_TERMINAL_FIELDS, gpuSessionAfterimageStackLiveEvidenceProblem } from "./gpu-streaming-producer-afterimage-resources";

const GPU_SESSION_RESOURCE_SCHEMA = "shellx-motion/gpu-page-session-resources@1";
const GPU_SESSION_RESOURCE_FIELDS = [
  "framesRendered",
  "frameArenaReconfigurations",
  "frameTextureSlots",
  "frameTextureBytes",
  "depthTextureBytes",
  "readbackBytes",
  "frameArenaBytes",
  "frameTextureHighWaterSlots",
  "frameTextureHighWaterBytes",
  "frameArenaHighWaterBytes",
  "frameArenaReservations",
  "frameArenaLateAllocationRefusals",
  "dynamicBufferSlots",
  "dynamicBufferBytes",
  "dynamicBufferHighWaterSlots",
  "dynamicBufferHighWaterBytes",
  "environmentUniformCapacitySlots",
  "environmentUniformBytes",
  "environmentUniformHighWaterSlots",
  "environmentUniformHighWaterBytes",
  "environmentUniformLateAllocationRefusals",
  "environmentDrawsRendered",
  "environmentEnvelopeReservations",
  "immutableImageTextures",
  "retainedTextSurfaces",
  "immutablePointBufferSlots",
  "immutablePointBufferBytes",
  "immutablePointMirrorBytes",
  "immutablePointBufferHighWaterSlots",
  "immutablePointBufferHighWaterBytes",
  "adapterPointInstanceLimit",
  "computeParticleBufferSlots",
  "computeParticleBufferBytes",
  "computeParticleBufferHighWaterSlots",
  "computeParticleBufferHighWaterBytes",
  "adapterComputeParticleInstanceLimit",
  "computeParticleDispatches",
  "computeParticleInstanceBytes",
  "computeParticleRetainedBufferCount",
  "computeParticleUniformBytes",
  "computeParticleRasterCalls",
  "computeParticleHeadRasterCalls",
  "computeParticleTrailRasterCalls",
  "computeParticleCapacityReconfigurations",
  "computeParticleLateAllocationRefusals"
] as const;
const GPU_SESSION_RESOURCE_TEXT_FIELDS = [
  "pointRaster",
  "pointPositionEvaluation",
  "pointComputeField",
  "computeParticleAbi"
] as const;
const GPU_SESSION_DYNAMIC_IMAGE_FIELDS = [
  "dynamicImageTextureSlots",
  "dynamicImageTextureBytes",
  "dynamicImageTextureHighWaterSlots",
  "dynamicImageTextureHighWaterBytes",
  "dynamicImageTextureWrites",
  "dynamicImageTextureReplacements",
  "dynamicImageTextureLateRefusals",
  "dynamicImageTextureDestructions"
] as const;

export type GpuSessionResourcesAttestation =
  | { ok: true; metrics: GpuPageSessionResourceMetrics }
  | { ok: false; failure: { code: string; message: string } };

/** Reads scalar pool counters while the page session is still alive, then owns a frozen copy. */
export async function attestGpuSessionResources(
  runtime: GpuFrameRenderSession,
  expectedFrames: number
): Promise<GpuSessionResourcesAttestation> {
  let observed: unknown;
  try {
    observed = await runtime.resourceMetrics?.();
  } catch {
    return { ok: false, failure: { code: "gpu_session_resources_missing", message: "GPU final rendering could not read its persistent session resource evidence before cleanup." } };
  }
  if (!isPlainGpuSessionResources(observed)) {
    return { ok: false, failure: { code: "gpu_session_resources_invalid", message: "GPU final rendering requires a complete plain resource-metrics snapshot before cleanup." } };
  }
  if (observed.framesRendered !== expectedFrames) {
    return { ok: false, failure: { code: "gpu_session_resources_frame_mismatch", message: "GPU session resource evidence does not match the canonical emitted frame count." } };
  }
  return {
    ok: true,
    metrics: Object.freeze({
      schema: GPU_SESSION_RESOURCE_SCHEMA,
      framesRendered: observed.framesRendered,
      frameArenaReconfigurations: observed.frameArenaReconfigurations,
      frameTextureSlots: observed.frameTextureSlots,
      frameTextureBytes: observed.frameTextureBytes,
      depthTextureBytes: observed.depthTextureBytes,
      readbackBytes: observed.readbackBytes,
      frameArenaBytes: observed.frameArenaBytes,
      frameTextureHighWaterSlots: observed.frameTextureHighWaterSlots,
      frameTextureHighWaterBytes: observed.frameTextureHighWaterBytes,
      frameArenaHighWaterBytes: observed.frameArenaHighWaterBytes,
      frameArenaReservations: observed.frameArenaReservations,
      frameArenaLateAllocationRefusals: observed.frameArenaLateAllocationRefusals,
      dynamicBufferSlots: observed.dynamicBufferSlots,
      dynamicBufferBytes: observed.dynamicBufferBytes,
      dynamicBufferHighWaterSlots: observed.dynamicBufferHighWaterSlots,
      dynamicBufferHighWaterBytes: observed.dynamicBufferHighWaterBytes,
      environmentUniformCapacitySlots: observed.environmentUniformCapacitySlots,
      environmentUniformBytes: observed.environmentUniformBytes,
      environmentUniformHighWaterSlots: observed.environmentUniformHighWaterSlots,
      environmentUniformHighWaterBytes: observed.environmentUniformHighWaterBytes,
      environmentUniformLateAllocationRefusals: observed.environmentUniformLateAllocationRefusals,
      environmentDrawsRendered: observed.environmentDrawsRendered,
      environmentEnvelopeReservations: observed.environmentEnvelopeReservations,
      immutableImageTextures: observed.immutableImageTextures,
      ...(observed.dynamicImageTextureSlots === undefined ? {} : {
        dynamicImageTextureSlots: observed.dynamicImageTextureSlots,
        dynamicImageTextureBytes: observed.dynamicImageTextureBytes!,
        dynamicImageTextureHighWaterSlots: observed.dynamicImageTextureHighWaterSlots!,
        dynamicImageTextureHighWaterBytes: observed.dynamicImageTextureHighWaterBytes!,
        dynamicImageTextureWrites: observed.dynamicImageTextureWrites!,
        dynamicImageTextureReplacements: observed.dynamicImageTextureReplacements!,
        dynamicImageTextureLateRefusals: observed.dynamicImageTextureLateRefusals!,
        dynamicImageTextureDestructions: observed.dynamicImageTextureDestructions!
      }),
      ...(observed.afterimageStackUniformBufferSlots === undefined ? {} : {
        afterimageStackUniformBufferSlots: observed.afterimageStackUniformBufferSlots,
        afterimageStackUniformBytes: observed.afterimageStackUniformBytes!,
        afterimageStackBindGroupSlots: observed.afterimageStackBindGroupSlots!,
        afterimageStackPasses: observed.afterimageStackPasses!,
        afterimageStackFrames: observed.afterimageStackFrames!,
        afterimageStackLateAllocationRefusals: observed.afterimageStackLateAllocationRefusals!,
        afterimageStackPersistentTextureCount: observed.afterimageStackPersistentTextureCount!
      }),
      retainedTextSurfaces: observed.retainedTextSurfaces,
      pointRaster: observed.pointRaster,
      pointPositionEvaluation: observed.pointPositionEvaluation,
      pointComputeField: observed.pointComputeField,
      immutablePointBufferSlots: observed.immutablePointBufferSlots,
      immutablePointBufferBytes: observed.immutablePointBufferBytes,
      immutablePointMirrorBytes: observed.immutablePointMirrorBytes,
      immutablePointBufferHighWaterSlots: observed.immutablePointBufferHighWaterSlots,
      immutablePointBufferHighWaterBytes: observed.immutablePointBufferHighWaterBytes,
      adapterPointInstanceLimit: observed.adapterPointInstanceLimit,
      computeParticleBufferSlots: observed.computeParticleBufferSlots,
      computeParticleBufferBytes: observed.computeParticleBufferBytes,
      computeParticleBufferHighWaterSlots: observed.computeParticleBufferHighWaterSlots,
      computeParticleBufferHighWaterBytes: observed.computeParticleBufferHighWaterBytes,
      adapterComputeParticleInstanceLimit: observed.adapterComputeParticleInstanceLimit,
      computeParticleDispatches: observed.computeParticleDispatches,
      computeParticleAbi: observed.computeParticleAbi,
      computeParticleInstanceBytes: observed.computeParticleInstanceBytes,
      computeParticleRetainedBufferCount: observed.computeParticleRetainedBufferCount,
      computeParticleUniformBytes: observed.computeParticleUniformBytes,
      computeParticleRasterCalls: observed.computeParticleRasterCalls,
      computeParticleHeadRasterCalls: observed.computeParticleHeadRasterCalls,
      computeParticleTrailRasterCalls: observed.computeParticleTrailRasterCalls,
      computeParticleCapacityReconfigurations: observed.computeParticleCapacityReconfigurations,
      computeParticleLateAllocationRefusals: observed.computeParticleLateAllocationRefusals
    })
  };
}

/** Reused at final receipt assembly to keep injected producer evidence fail-closed. */
export function isGpuSessionResources(value: unknown, expectedFrames: number): value is GpuPageSessionResourceMetrics {
  return isPlainGpuSessionResources(value) && value.framesRendered === expectedFrames;
}

export function gpuSessionDynamicImageMetricsProblem(
  value: Partial<GpuPageSessionResourceMetrics>,
  expected: { readonly slots: number; readonly bytes: number; readonly writes: number } | null
): string | null {
  const present = GPU_SESSION_DYNAMIC_IMAGE_FIELDS.filter((field) => value[field] !== undefined).length;
  if (expected === null) return present === 0 ? null : "an unclaimed dynamic texture reservation is present";
  if (present !== GPU_SESSION_DYNAMIC_IMAGE_FIELDS.length) return "the dynamic texture reservation evidence is incomplete";
  return value.dynamicImageTextureSlots === expected.slots
    && value.dynamicImageTextureBytes === expected.bytes
    && value.dynamicImageTextureHighWaterSlots === expected.slots
    && value.dynamicImageTextureHighWaterBytes === expected.bytes
    && value.dynamicImageTextureWrites === expected.writes
    && value.dynamicImageTextureReplacements === expected.writes
    && value.dynamicImageTextureLateRefusals === 0
    && value.dynamicImageTextureDestructions === 0
    ? null
    : "the dynamic texture reservation, write count, or live cleanup counters conflict with the exact capture range";
}

function isPlainGpuSessionResources(value: unknown): value is GpuPageSessionResourceMetrics {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const dynamicFieldCount = GPU_SESSION_DYNAMIC_IMAGE_FIELDS.filter((field) => field in record).length;
  const afterimageLiveFieldCount = GPU_SESSION_AFTERIMAGE_STACK_LIVE_FIELDS.filter((field) => field in record).length;
  const afterimageTerminalFieldCount = GPU_SESSION_AFTERIMAGE_STACK_TERMINAL_FIELDS.filter((field) => field in record).length;
  if (dynamicFieldCount !== 0 && dynamicFieldCount !== GPU_SESSION_DYNAMIC_IMAGE_FIELDS.length) return false;
  if (afterimageLiveFieldCount !== 0 && afterimageLiveFieldCount !== GPU_SESSION_AFTERIMAGE_STACK_LIVE_FIELDS.length) return false;
  // This is the pre-close attestation; terminal cleanup is checked by the
  // producer after `runtime.close()` and must never be forged into a live view.
  if (afterimageTerminalFieldCount !== 0) return false;
  const expected = [
    "schema",
    ...GPU_SESSION_RESOURCE_FIELDS,
    ...GPU_SESSION_RESOURCE_TEXT_FIELDS,
    ...(dynamicFieldCount === 0 ? [] : GPU_SESSION_DYNAMIC_IMAGE_FIELDS),
    ...(afterimageLiveFieldCount === 0 ? [] : GPU_SESSION_AFTERIMAGE_STACK_LIVE_FIELDS)
  ].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && record.schema === GPU_SESSION_RESOURCE_SCHEMA
    && GPU_SESSION_RESOURCE_FIELDS.every((field) => Number.isSafeInteger(record[field]) && (record[field] as number) >= 0)
    && record.pointRaster === "gpu-native-instanced"
    && ["core-cpu-exact-time", "gpu-fixed-analytic-time", "mixed-core-cpu-and-gpu-fixed-analytic-time"].includes(record.pointPositionEvaluation as string)
    && ["not-used", "fixed-analytic-v1", "fixed-analytic-v2"].includes(record.pointComputeField as string)
    && ["not-used", "shellx-motion/gpu-compute-particle-field@1", "shellx-motion/gpu-compute-particle-field@2"].includes(record.computeParticleAbi as string)
    && frameArenaEvidenceIsConsistent(record)
    && dynamicImageEvidenceIsConsistent(record, dynamicFieldCount !== 0)
    && gpuSessionAfterimageStackLiveEvidenceProblem(record, afterimageLiveFieldCount !== 0) === null
    && computeEvidenceIsBounded(record);
}

function dynamicImageEvidenceIsConsistent(record: Record<string, unknown>, present: boolean): boolean {
  if (!present) return true;
  if (!GPU_SESSION_DYNAMIC_IMAGE_FIELDS.every((field) => Number.isSafeInteger(record[field]) && (record[field] as number) >= 0)) return false;
  const slots = record.dynamicImageTextureSlots as number;
  const bytes = record.dynamicImageTextureBytes as number;
  const writes = record.dynamicImageTextureWrites as number;
  return slots >= 1 && slots <= 64
    && bytes >= slots * 4 && bytes <= 256 * 1024 * 1024 && bytes % 4 === 0
    && record.dynamicImageTextureHighWaterSlots === slots
    && record.dynamicImageTextureHighWaterBytes === bytes
    && record.dynamicImageTextureReplacements === writes
    && writes <= (record.framesRendered as number) * slots
    && record.dynamicImageTextureLateRefusals === 0
    && record.dynamicImageTextureDestructions === 0;
}

function frameArenaEvidenceIsConsistent(record: Record<string, unknown>): boolean {
  const framesRendered = record.framesRendered as number;
  const frameArenaReconfigurations = record.frameArenaReconfigurations as number;
  const frameTextureSlots = record.frameTextureSlots as number;
  const frameTextureBytes = record.frameTextureBytes as number;
  const depthTextureBytes = record.depthTextureBytes as number;
  const readbackBytes = record.readbackBytes as number;
  const frameArenaBytes = record.frameArenaBytes as number;
  const frameTextureHighWaterSlots = record.frameTextureHighWaterSlots as number;
  const frameTextureHighWaterBytes = record.frameTextureHighWaterBytes as number;
  const frameArenaHighWaterBytes = record.frameArenaHighWaterBytes as number;
  const dynamicBufferSlots = record.dynamicBufferSlots as number;
  const dynamicBufferBytes = record.dynamicBufferBytes as number;
  const dynamicBufferHighWaterSlots = record.dynamicBufferHighWaterSlots as number;
  const dynamicBufferHighWaterBytes = record.dynamicBufferHighWaterBytes as number;
  const frameArenaReservations = record.frameArenaReservations as number;
  const frameArenaLateAllocationRefusals = record.frameArenaLateAllocationRefusals as number;
  const environmentUniformCapacitySlots = record.environmentUniformCapacitySlots as number;
  const environmentUniformBytes = record.environmentUniformBytes as number;
  const environmentUniformHighWaterSlots = record.environmentUniformHighWaterSlots as number;
  const environmentUniformHighWaterBytes = record.environmentUniformHighWaterBytes as number;
  const environmentUniformLateAllocationRefusals = record.environmentUniformLateAllocationRefusals as number;
  const environmentDrawsRendered = record.environmentDrawsRendered as number;
  const environmentEnvelopeReservations = record.environmentEnvelopeReservations as number;
  const computedArenaBytes = frameTextureBytes + readbackBytes;
  if (!Number.isSafeInteger(computedArenaBytes)) return false;
  const frameTexturePair = (frameTextureSlots === 0) === (frameTextureBytes === 0);
  const dynamicBufferPair = (dynamicBufferSlots === 0) === (dynamicBufferBytes === 0);
  const noArenaHasOnlyZeroCounters = frameArenaReconfigurations !== 0 || (
    frameTextureSlots === 0
    && frameTextureBytes === 0
    && depthTextureBytes === 0
    && readbackBytes === 0
    && frameArenaBytes === 0
    && frameTextureHighWaterSlots === 0
    && frameTextureHighWaterBytes === 0
    && frameArenaHighWaterBytes === 0
  );
  const renderedFramesRetainAnArena = framesRendered === 0 || (
    frameArenaReconfigurations > 0
    && frameTextureSlots > 0
    && frameTextureBytes > 0
    && readbackBytes > 0
    && frameArenaBytes > 0
  );
  const environmentUnused = environmentDrawsRendered === 0 && environmentEnvelopeReservations === 0 && environmentUniformCapacitySlots === 0 && environmentUniformBytes === 0 && environmentUniformHighWaterSlots === 0 && environmentUniformHighWaterBytes === 0 && environmentUniformLateAllocationRefusals === 0;
  const environmentReserved = environmentEnvelopeReservations === 1 && environmentUniformCapacitySlots === 36 && environmentUniformBytes === 36 * 256 && environmentUniformHighWaterSlots === 36 && environmentUniformHighWaterBytes === 36 * 256 && environmentUniformLateAllocationRefusals === 0 && environmentDrawsRendered <= framesRendered * 32;
  return frameTexturePair
    && dynamicBufferPair
    && depthTextureBytes <= frameTextureBytes
    && (depthTextureBytes === 0 || (frameTextureSlots >= 2 && frameTextureBytes >= depthTextureBytes * 2))
    && frameArenaBytes === computedArenaBytes
    && frameTextureHighWaterSlots >= frameTextureSlots
    && frameTextureHighWaterBytes >= frameTextureBytes
    && frameArenaHighWaterBytes >= frameArenaBytes
    && dynamicBufferHighWaterSlots >= dynamicBufferSlots
    && dynamicBufferHighWaterBytes >= dynamicBufferBytes
    && frameArenaReservations === framesRendered
    && frameArenaLateAllocationRefusals === 0
    && (environmentUnused || environmentReserved)
    && noArenaHasOnlyZeroCounters
    && renderedFramesRetainAnArena;
}

function computeEvidenceIsBounded(record: Record<string, unknown>): boolean {
  const fields = record.computeParticleBufferSlots as number;
  const bytes = record.computeParticleBufferBytes as number;
  const highWaterSlots = record.computeParticleBufferHighWaterSlots as number;
  const highWaterBytes = record.computeParticleBufferHighWaterBytes as number;
  const limit = record.adapterComputeParticleInstanceLimit as number;
  const dispatches = record.computeParticleDispatches as number;
  const instanceBytes = record.computeParticleInstanceBytes as number;
  const retainedBuffers = record.computeParticleRetainedBufferCount as number;
  const uniformBytes = record.computeParticleUniformBytes as number;
  const rasterCalls = record.computeParticleRasterCalls as number;
  const headRasterCalls = record.computeParticleHeadRasterCalls as number;
  const trailRasterCalls = record.computeParticleTrailRasterCalls as number;
  const capacityReconfigurations = record.computeParticleCapacityReconfigurations as number;
  const lateAllocationRefusals = record.computeParticleLateAllocationRefusals as number;
  const zero = fields === 0 && bytes === 0 && highWaterSlots === 0 && highWaterBytes === 0 && dispatches === 0 && instanceBytes === 0 && retainedBuffers === 0 && uniformBytes === 0 && rasterCalls === 0 && headRasterCalls === 0 && trailRasterCalls === 0 && capacityReconfigurations === 0 && lateAllocationRefusals === 0;
  if (record.pointComputeField === "not-used") return zero && limit <= 131_072 && record.computeParticleAbi === "not-used" && record.pointPositionEvaluation === "core-cpu-exact-time";
  if (fields !== 2 || highWaterSlots !== 2 || highWaterBytes !== bytes || limit > 131_072 || dispatches < 1 || headRasterCalls !== dispatches || rasterCalls !== headRasterCalls + trailRasterCalls) return false;
  if (record.pointComputeField === "fixed-analytic-v1") return bytes >= 100_000 * 32 * 2 && bytes <= 131_072 * 32 * 2 && bytes % (32 * 2) === 0 && limit >= bytes / (32 * 2) && record.computeParticleAbi === "shellx-motion/gpu-compute-particle-field@1" && instanceBytes === 32 && retainedBuffers === 2 && uniformBytes === 240 && trailRasterCalls === 0 && capacityReconfigurations === 0 && lateAllocationRefusals === 0 && (record.pointPositionEvaluation === "gpu-fixed-analytic-time" || record.pointPositionEvaluation === "mixed-core-cpu-and-gpu-fixed-analytic-time");
  return record.pointComputeField === "fixed-analytic-v2" && bytes >= 100_000 * 64 * 2 && bytes <= 16 * 1024 * 1024 && bytes % (64 * 2) === 0 && limit >= bytes / (64 * 2) && record.computeParticleAbi === "shellx-motion/gpu-compute-particle-field@2" && instanceBytes === 64 && retainedBuffers === 2 && uniformBytes === 432 && (trailRasterCalls === 0 || trailRasterCalls === dispatches) && capacityReconfigurations === 0 && lateAllocationRefusals === 0 && (record.pointPositionEvaluation === "gpu-fixed-analytic-time" || record.pointPositionEvaluation === "mixed-core-cpu-and-gpu-fixed-analytic-time");
}
