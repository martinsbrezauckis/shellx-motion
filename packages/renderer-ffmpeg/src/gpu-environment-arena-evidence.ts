const GPU_ENVIRONMENT_ARENA_EVIDENCE_SCHEMA = "shellx-motion/gpu-environment-arena-evidence@1" as const;

export interface GpuEnvironmentArenaRange {
  index: number;
  startFrame: number;
  endFrameExclusive: number;
  frameCount: number;
}

export interface GpuEnvironmentArenaEvidence {
  schema: typeof GPU_ENVIRONMENT_ARENA_EVIDENCE_SCHEMA;
  staticPlanFingerprint: string;
  canonicalFrameCount: number;
  maxEnvironmentCount: number;
  resourceBudget: {
    maxEnvironmentDrawsPerFrame: number;
    maxEnvironmentUniformBytesPerFrame: number;
  };
  frameArena: {
    reservations: number;
    lateAllocationRefusals: number;
    reconfigurations: number;
    bytes: number;
    highWaterBytes: number;
  };
  uniforms: {
    capacitySlots: number;
    bytes: number;
    highWaterSlots: number;
    highWaterBytes: number;
    lateAllocationRefusals: number;
  };
  environmentDrawsRendered: number;
  environmentEnvelopeReservations: number;
  /** Present only for one durable segmented range; final one-shot receipts remain range-free. */
  range?: GpuEnvironmentArenaRange;
}

export interface GpuEnvironmentArenaInput {
  staticPlan: {
    fingerprint: string;
    canonicalFrameCount: number;
    maxima: { maxEnvironmentCount: number };
  };
  resourceBudget: {
    expectedFrames: number;
    observedFrames: number;
    maxima: { environmentCount: number; environmentUniformBytes: number };
  };
  sessionResources: {
    environmentUniformCapacitySlots?: number;
    environmentUniformBytes?: number;
    environmentUniformHighWaterSlots?: number;
    environmentUniformHighWaterBytes?: number;
    environmentUniformLateAllocationRefusals?: number;
    environmentDrawsRendered?: number;
    environmentEnvelopeReservations?: number;
    frameArenaReservations?: number;
    frameArenaLateAllocationRefusals?: number;
    frameArenaReconfigurations?: number;
    frameArenaBytes?: number;
    frameArenaHighWaterBytes?: number;
  };
  /** Bind a producer-local evidence object to its immutable global range. */
  range?: GpuEnvironmentArenaRange;
}

/**
 * Environment draws use a session-wide fixed uniform arena, but only an environment-bearing
 * static plan may claim that arena in a final receipt. This keeps an injected producer from
 * substituting an otherwise valid no-environment metrics snapshot after V25-A admission.
 */
export function gpuEnvironmentArenaEvidence(
  input: GpuEnvironmentArenaInput
): GpuEnvironmentArenaEvidence | null | undefined {
  const { staticPlan, resourceBudget, sessionResources, range } = input;
  const maximum = staticPlan.maxima?.maxEnvironmentCount;
  const budgetEnvironmentDraws = resourceBudget.maxima?.environmentCount;
  const budgetEnvironmentUniformBytes = resourceBudget.maxima?.environmentUniformBytes;
  const renderedFrameCount = range?.frameCount ?? staticPlan.canonicalFrameCount;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 4
    || !Number.isSafeInteger(renderedFrameCount) || renderedFrameCount < 1
    || (range !== undefined && (!Number.isSafeInteger(range.index) || range.index < 0
      || !Number.isSafeInteger(range.startFrame) || !Number.isSafeInteger(range.endFrameExclusive)
      || range.startFrame < 0 || range.endFrameExclusive !== range.startFrame + range.frameCount
      || range.endFrameExclusive > staticPlan.canonicalFrameCount))
    || resourceBudget.expectedFrames !== renderedFrameCount || resourceBudget.observedFrames !== renderedFrameCount
    || !Number.isSafeInteger(budgetEnvironmentDraws) || budgetEnvironmentDraws < 0 || budgetEnvironmentDraws > 32
    || !Number.isSafeInteger(budgetEnvironmentUniformBytes) || budgetEnvironmentUniformBytes !== budgetEnvironmentDraws * 208) return undefined;
  const metrics = sessionResources;
  const environmentFields = [
    metrics.environmentUniformCapacitySlots,
    metrics.environmentUniformBytes,
    metrics.environmentUniformHighWaterSlots,
    metrics.environmentUniformHighWaterBytes,
    metrics.environmentUniformLateAllocationRefusals,
    metrics.environmentDrawsRendered,
    metrics.environmentEnvelopeReservations,
    metrics.frameArenaReservations,
    metrics.frameArenaLateAllocationRefusals,
    metrics.frameArenaReconfigurations,
    metrics.frameArenaBytes,
    metrics.frameArenaHighWaterBytes
  ];
  if (!environmentFields.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return undefined;
  const [
    environmentUniformCapacitySlots,
    environmentUniformBytes,
    environmentUniformHighWaterSlots,
    environmentUniformHighWaterBytes,
    environmentUniformLateAllocationRefusals,
    environmentDrawsRendered,
    environmentEnvelopeReservations,
    frameArenaReservations,
    frameArenaLateAllocationRefusals,
    frameArenaReconfigurations,
    frameArenaBytes,
    frameArenaHighWaterBytes
  ] = environmentFields as number[];
  if (maximum === 0) {
    return budgetEnvironmentDraws === 0
      && environmentDrawsRendered === 0
      && environmentUniformCapacitySlots === 0
      && environmentUniformBytes === 0
      && environmentUniformHighWaterSlots === 0
      && environmentUniformHighWaterBytes === 0
      && environmentUniformLateAllocationRefusals === 0
      && environmentEnvelopeReservations === 0
      ? null
      : undefined;
  }
  const drawRelation = range
    ? (budgetEnvironmentDraws === 0
      ? environmentDrawsRendered === 0
      : environmentDrawsRendered >= budgetEnvironmentDraws
        && environmentDrawsRendered <= renderedFrameCount * budgetEnvironmentDraws)
    : budgetEnvironmentDraws >= maximum
      && environmentDrawsRendered >= budgetEnvironmentDraws
      && environmentDrawsRendered <= renderedFrameCount * budgetEnvironmentDraws;
  if (!drawRelation
    || environmentUniformCapacitySlots !== 36
    || environmentUniformBytes !== 36 * 256
    || environmentUniformHighWaterSlots !== 36
    || environmentUniformHighWaterBytes !== 36 * 256
    || environmentUniformLateAllocationRefusals !== 0
    || environmentEnvelopeReservations !== 1
    || frameArenaReservations !== renderedFrameCount
    || frameArenaLateAllocationRefusals !== 0
    || frameArenaReconfigurations !== 1
    || frameArenaBytes < 1
    || frameArenaHighWaterBytes !== frameArenaBytes) return undefined;
  return Object.freeze({
    schema: GPU_ENVIRONMENT_ARENA_EVIDENCE_SCHEMA,
    staticPlanFingerprint: staticPlan.fingerprint,
    canonicalFrameCount: staticPlan.canonicalFrameCount,
    maxEnvironmentCount: maximum,
    resourceBudget: Object.freeze({
      maxEnvironmentDrawsPerFrame: budgetEnvironmentDraws,
      maxEnvironmentUniformBytesPerFrame: budgetEnvironmentUniformBytes
    }),
    frameArena: Object.freeze({
      reservations: frameArenaReservations,
      lateAllocationRefusals: frameArenaLateAllocationRefusals,
      reconfigurations: frameArenaReconfigurations,
      bytes: frameArenaBytes,
      highWaterBytes: frameArenaHighWaterBytes
    }),
    uniforms: Object.freeze({
      capacitySlots: environmentUniformCapacitySlots,
      bytes: environmentUniformBytes,
      highWaterSlots: environmentUniformHighWaterSlots,
      highWaterBytes: environmentUniformHighWaterBytes,
      lateAllocationRefusals: environmentUniformLateAllocationRefusals
    }),
    environmentDrawsRendered,
    environmentEnvelopeReservations,
    ...(range ? { range: Object.freeze({ ...range }) } : {})
  });
}
