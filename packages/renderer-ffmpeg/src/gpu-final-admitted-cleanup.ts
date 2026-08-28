import type { GpuEffectModuleBeginUseLease } from "@shellx-motion/renderer-browser";

export type GpuFinalAdmittedCleanupScope = "delivery" | "effect-module-lease";

export class GpuFinalAdmittedCleanupError extends Error {
  readonly code = "gpu_final_cleanup_failed";
  constructor(readonly failures: readonly { scope: GpuFinalAdmittedCleanupScope; reason: unknown }[]) {
    super(`GPU final cleanup failed for ${failures.map((failure) => failure.scope).join(" and ")}.`);
    this.name = "GpuFinalAdmittedCleanupError";
  }
}

/**
 * Closes the Browser-backed delivery before returning its opaque lease. Both
 * cleanup actions always settle; failures stay typed so final publication
 * cannot turn a partially cleaned release into a success.
 */
export async function releaseAdmittedGpuFinalDelivery(
  deliveryRelease: () => Promise<void>,
  effectModuleLease?: GpuEffectModuleBeginUseLease
): Promise<{ effectModuleLease: "not-applicable" | "released" | "failed" }> {
  // The lease remains current until Browser/runtime delivery has completely
  // closed. Still settle both phases even when the first phase rejects.
  const [delivery] = await Promise.allSettled([Promise.resolve().then(deliveryRelease)]);
  const [lease] = effectModuleLease
    ? await Promise.allSettled([Promise.resolve().then(async () => await effectModuleLease.release())])
    : [];
  const failures: { scope: GpuFinalAdmittedCleanupScope; reason: unknown }[] = [];
  if (delivery?.status === "rejected") failures.push({ scope: "delivery", reason: delivery.reason });
  if (effectModuleLease && lease?.status === "rejected") failures.push({ scope: "effect-module-lease", reason: lease.reason });
  if (effectModuleLease && lease?.status === "fulfilled" && lease.value.released !== true) {
    failures.push({ scope: "effect-module-lease", reason: new Error("GPU effect-module lease did not report an owned release.") });
  }
  if (failures.length) throw new GpuFinalAdmittedCleanupError(Object.freeze(failures));
  return { effectModuleLease: effectModuleLease ? "released" : "not-applicable" };
}

/** Preserves the original render cause while retaining cleanup failures for callers and tests. */
export function combineGpuFinalRenderAndCleanupFailure(renderFailure: unknown, cleanupFailure: unknown): Error {
  return new AggregateError([renderFailure, cleanupFailure], "GPU final rendering and cleanup both failed.");
}
