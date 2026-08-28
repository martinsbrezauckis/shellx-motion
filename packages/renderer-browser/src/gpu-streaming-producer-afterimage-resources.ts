/**
 * C2's all-or-nothing live fixed-pass metrics. Terminal release facts are
 * intentionally not admitted into the pre-close general session snapshot.
 */
export const GPU_SESSION_AFTERIMAGE_STACK_LIVE_FIELDS = [
  "afterimageStackUniformBufferSlots", "afterimageStackUniformBytes", "afterimageStackBindGroupSlots",
  "afterimageStackPasses", "afterimageStackFrames", "afterimageStackLateAllocationRefusals", "afterimageStackPersistentTextureCount"
] as const;

export const GPU_SESSION_AFTERIMAGE_STACK_TERMINAL_FIELDS = [
  "afterimageStackPipelineReleases", "afterimageStackPreparedBindGroupReleases", "afterimageStackArenaUniformBufferDestructions"
] as const;

/** Validates the bounded live branch without changing the no-module shape. */
export function gpuSessionAfterimageStackLiveEvidenceProblem(value: Record<string, unknown>, present: boolean): string | null {
  if (!present) return null;
  if (!GPU_SESSION_AFTERIMAGE_STACK_LIVE_FIELDS.every((field) => Number.isSafeInteger(value[field]) && (value[field] as number) >= 0)) return "afterimage stack fields are not bounded non-negative integers";
  const passes = value.afterimageStackPasses as number, frames = value.afterimageStackFrames as number;
  return value.afterimageStackUniformBufferSlots === 1 && value.afterimageStackUniformBytes === 160 && value.afterimageStackBindGroupSlots === 1
    && passes >= 1 && frames >= 1 && passes === frames && value.afterimageStackLateAllocationRefusals === 0 && value.afterimageStackPersistentTextureCount === 0
    ? null : "afterimage stack resource counters are not a fixed live pass";
}
