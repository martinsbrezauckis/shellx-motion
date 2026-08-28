/** Post-admission bootstrap lease handling for the durable segmented GPU host. */
import type { GpuEffectModuleBeginUseLease } from "@shellx-motion/renderer-browser";
import type { SegmentedGpuStaticPreflight } from "./segmented-final-gpu-host-types.js";

export async function beginSegmentedGpuBootstrapLease(preflight: SegmentedGpuStaticPreflight | undefined): Promise<GpuEffectModuleBeginUseLease | undefined> {
  const use = preflight?.effectModuleUse;
  return use ? await use.authority.beginUse(use.resolution) : undefined;
}

export async function releaseSegmentedGpuBootstrapLease(lease: GpuEffectModuleBeginUseLease): Promise<void> {
  const released = await lease.release();
  if (!released.released) throw new Error("GPU segmented effect-module bootstrap lease did not complete release.");
}

/** A failed bootstrap release is ordered after producer/runtime cleanup. */
export function segmentedGpuBootstrapCleanup(input: {
  lease?: GpuEffectModuleBeginUseLease;
  releases: readonly (() => Promise<void>)[];
}): Promise<void>[] {
  if (!input.lease) return input.releases.map((release) => Promise.resolve().then(release));
  return [Promise.resolve().then(async () => {
    const failures: unknown[] = [];
    for (const release of input.releases) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    try { await releaseSegmentedGpuBootstrapLease(input.lease!); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "GPU segmented bootstrap host cleanup and lease release both failed.");
  })];
}
