/** Lease linearization for one module-bearing durable GPU range. */
import {
  gpuEffectModuleFinalReceiptEvidence,
  type GpuEffectModuleBeginUseLease,
  type GpuEffectModuleUseAuthority,
  type GpuEffectModuleUseResolution,
  type GpuStreamingFrameProducer,
  type GpuStreamingFrameSink,
  type GpuStreamingJobContext
} from "@shellx-motion/renderer-browser";
import type { RenderSegmentGpuEffectModuleRangeUseEvidence } from "./segmented-final-internal/render-segment-gpu-effect-module-types.js";

type EffectModuleUse = { authority: GpuEffectModuleUseAuthority; resolution: GpuEffectModuleUseResolution };

/** Range admission is deliberately re-linearized after queueing and before any runtime work. */
export async function beginGpuEffectModuleRangeLease(required: boolean, use: EffectModuleUse | undefined): Promise<GpuEffectModuleBeginUseLease | undefined> {
  if (!required) {
    if (use) throw new Error("GPU segmented module range received an unused opaque use resolution.");
    return undefined;
  }
  if (!use) throw new Error("GPU segmented module range lost its trusted opaque use resolution.");
  return await use.authority.beginUse(use.resolution);
}

/** Setup failures still must prove that the freshly admitted lease was released. */
export async function releaseGpuEffectModuleRangeSetupLease(lease: GpuEffectModuleBeginUseLease | undefined, cause: unknown): Promise<never> {
  if (!lease) throw cause;
  try {
    const released = await lease.release();
    if (!released.released) throw new Error("GPU segmented module range lease did not complete release after range setup failure.");
  } catch (releaseError) {
    throw new AggregateError([cause, releaseError], "GPU segmented module range setup and lease cleanup both failed.");
  }
  throw cause;
}

/** A range that has not entered Browser production still owns its fresh lease. */
export async function abortGpuEffectModuleRangeLease(lease: GpuEffectModuleBeginUseLease | undefined): Promise<void> {
  if (!lease) return;
  const released = await lease.release();
  if (!released.released) throw new Error("GPU segmented module range lease did not complete release during encoder setup cleanup.");
}

/** Browser closes its runtime in `produce`; only then may this release the opaque registry lease. */
export async function produceReleasedGpuEffectModuleRange(input: {
  producer: GpuStreamingFrameProducer;
  sink: GpuStreamingFrameSink;
  job: GpuStreamingJobContext;
  lease: GpuEffectModuleBeginUseLease;
}): Promise<RenderSegmentGpuEffectModuleRangeUseEvidence> {
  let lease: GpuEffectModuleBeginUseLease | undefined = input.lease;
  try {
    await input.producer.produce(input.sink, input.job);
    const pending = input.producer.evidence.effectModules;
    if (!pending || pending.runtimeCleanup !== "complete") {
      throw new Error("GPU segmented module range did not close its Browser runtime before lease release.");
    }
    const releasedLease = lease;
    if (!releasedLease) throw new Error("GPU segmented module range lost its live lease before release.");
    const released = await releasedLease.release();
    lease = undefined;
    if (!released.released) throw new Error("GPU segmented module range lease did not complete release before checkpoint evidence.");
    return Object.freeze({
      schema: "shellx-motion/gpu-effect-module-segment-range-use@1",
      pending,
      released: gpuEffectModuleFinalReceiptEvidence(releasedLease, pending.ledger)
    });
  } catch (error) {
    if (!lease) throw error;
    try {
      const released = await lease.release();
      lease = undefined;
      if (!released.released) throw new Error("GPU segmented module range lease did not complete release after producer failure.");
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "GPU segmented module range producer and lease cleanup both failed.");
    }
    throw error;
  }
}
