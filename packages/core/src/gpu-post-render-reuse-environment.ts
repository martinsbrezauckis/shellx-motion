/** V25-A environment reservation proof shared by post-render reuse validation. */
import { canonicalJsonSha256 } from "./canonical-json";

const GPU_ENVIRONMENT_ARENA_EVIDENCE_SCHEMA = "shellx-motion/gpu-environment-arena-evidence@1" as const;

/** Rebuild the final receipt arena identity rather than trusting generic session resource hashes. */
export function assertGpuPostRenderEnvironmentArenaEvidence(
  staticPlan: Record<string, unknown>,
  resourceBudget: Record<string, unknown>,
  sessionResources: Record<string, unknown>,
  hashes: Record<string, string>
): void {
  const maximum = nonnegative(record(staticPlan.maxima, "GPU static environment maxima").maxEnvironmentCount, "GPU static environment maximum");
  const budgetMaxima = record(resourceBudget.maxima, "GPU environment resource-budget maxima");
  const draws = nonnegative(budgetMaxima.environmentCount, "GPU environment resource-budget draw maximum");
  const uniformBytes = nonnegative(budgetMaxima.environmentUniformBytes, "GPU environment resource-budget uniform bytes");
  const frames = staticPlan.canonicalFrameCount;
  if (!positive(frames) || resourceBudget.expectedFrames !== frames || resourceBudget.observedFrames !== frames
    || maximum > 4 || draws > 32 || uniformBytes !== draws * 208) {
    throw new Error("GPU post-render reuse environment resource-budget evidence is invalid.");
  }
  const metrics = readMetrics(sessionResources);
  if (maximum === 0) {
    if (draws !== 0 || metrics.draws !== 0 || metrics.uniformCapacity !== 0 || metrics.uniformBytes !== 0
      || metrics.uniformHighWaterSlots !== 0 || metrics.uniformHighWaterBytes !== 0 || metrics.uniformLateRefusals !== 0
      || metrics.envelopeReservations !== 0 || hashes["gpu-environment-arena"] !== undefined) {
      throw new Error("GPU post-render reuse environment evidence contradicts a no-environment static plan.");
    }
    return;
  }
  if (draws < maximum || metrics.draws < draws || metrics.draws > frames * draws
    || metrics.frameReconfigurations !== 1 || metrics.frameReservations !== frames || metrics.frameLateRefusals !== 0
    || metrics.frameBytes < 1 || metrics.frameHighWaterBytes !== metrics.frameBytes
    || metrics.uniformCapacity !== 36 || metrics.uniformBytes !== 36 * 256
    || metrics.uniformHighWaterSlots !== 36 || metrics.uniformHighWaterBytes !== 36 * 256
    || metrics.uniformLateRefusals !== 0 || metrics.envelopeReservations !== 1) {
    throw new Error("GPU post-render reuse environment reservation or arena evidence is invalid.");
  }
  const arenaSha256 = canonicalJsonSha256({
    schema: GPU_ENVIRONMENT_ARENA_EVIDENCE_SCHEMA,
    staticPlanFingerprint: staticPlan.fingerprint,
    canonicalFrameCount: frames,
    maxEnvironmentCount: maximum,
    resourceBudget: { maxEnvironmentDrawsPerFrame: draws, maxEnvironmentUniformBytesPerFrame: uniformBytes },
    frameArena: {
      reservations: metrics.frameReservations,
      lateAllocationRefusals: metrics.frameLateRefusals,
      reconfigurations: metrics.frameReconfigurations,
      bytes: metrics.frameBytes,
      highWaterBytes: metrics.frameHighWaterBytes
    },
    uniforms: {
      capacitySlots: metrics.uniformCapacity,
      bytes: metrics.uniformBytes,
      highWaterSlots: metrics.uniformHighWaterSlots,
      highWaterBytes: metrics.uniformHighWaterBytes,
      lateAllocationRefusals: metrics.uniformLateRefusals
    },
    environmentDrawsRendered: metrics.draws,
    environmentEnvelopeReservations: metrics.envelopeReservations
  });
  if (hashes["gpu-environment-arena"] !== arenaSha256) {
    throw new Error("GPU post-render reuse receipt does not bind gpu-environment-arena.");
  }
}

function readMetrics(value: Record<string, unknown>) {
  return {
    frameReconfigurations: nonnegative(value.frameArenaReconfigurations, "GPU environment frame-arena reconfigurations"),
    frameReservations: nonnegative(value.frameArenaReservations, "GPU environment frame-arena reservations"),
    frameLateRefusals: nonnegative(value.frameArenaLateAllocationRefusals, "GPU environment frame-arena late allocation refusals"),
    frameBytes: nonnegative(value.frameArenaBytes, "GPU environment frame-arena bytes"),
    frameHighWaterBytes: nonnegative(value.frameArenaHighWaterBytes, "GPU environment frame-arena high-water bytes"),
    uniformCapacity: nonnegative(value.environmentUniformCapacitySlots, "GPU environment uniform capacity"),
    uniformBytes: nonnegative(value.environmentUniformBytes, "GPU environment uniform bytes"),
    uniformHighWaterSlots: nonnegative(value.environmentUniformHighWaterSlots, "GPU environment uniform high-water slots"),
    uniformHighWaterBytes: nonnegative(value.environmentUniformHighWaterBytes, "GPU environment uniform high-water bytes"),
    uniformLateRefusals: nonnegative(value.environmentUniformLateAllocationRefusals, "GPU environment uniform late allocation refusals"),
    draws: nonnegative(value.environmentDrawsRendered, "GPU environment rendered draws"),
    envelopeReservations: nonnegative(value.environmentEnvelopeReservations, "GPU environment envelope reservations")
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is missing or malformed.`);
  return value as Record<string, unknown>;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
  return value;
}
