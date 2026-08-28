import type { MotionPackage } from "@shellx-motion/core";
import type { GpuFrameRenderSession } from "./gpu-frame-renderer";
import type { GpuStreamingJobContext } from "./gpu-process-containment";
import { openGpuStreamingHybridSource, type GpuStreamingHybridFrameResources, type GpuStreamingHybridSource } from "./gpu-streaming-producer-hybrid";
import { openGpuStreamingSegmentedHybrid, type GpuStreamingSegmentedHybrid } from "./gpu-streaming-producer-segmented-hybrid";
import type { GpuRuntimeFailure } from "./gpu-runtime-types";
import type { MutableGpuStreamingEvidence } from "./gpu-streaming-producer-state";
import type { GpuStreamingFrameProducerInput } from "./gpu-streaming-producer-types";
import type { GpuSegmentedHybridRangeCleanupEvidence, GpuSegmentedHybridRangeLedger } from "./gpu-segmented-hybrid-types";

/** One direct or segmented exact-texture lifecycle; never both in one runtime. */
export interface GpuStreamingHybridLifecycle {
  frameResources(input: { readonly index: number; readonly atMs: number; readonly evidence: MutableGpuStreamingEvidence; readonly signal: AbortSignal }): Promise<{ ok: true; resources: GpuStreamingHybridFrameResources } | { ok: false; failure: GpuRuntimeFailure } | null>;
  finish(evidence: MutableGpuStreamingEvidence): void;
  close(): Promise<void>;
  readonly directLedger: GpuSegmentedHybridRangeLedger | undefined;
  readonly segmented: { readonly identity: GpuStreamingSegmentedHybrid["identity"]; readonly ledger: GpuSegmentedHybridRangeLedger | undefined; readonly cleanup: GpuSegmentedHybridRangeCleanupEvidence | undefined } | undefined;
}

export async function openGpuStreamingHybridLifecycle(input: {
  readonly producer: GpuStreamingFrameProducerInput;
  readonly pkg: MotionPackage;
  readonly runtime: GpuFrameRenderSession;
  readonly job: GpuStreamingJobContext;
  readonly range: { readonly index: number; readonly startFrameIndex: number; readonly endFrameIndexExclusive: number };
  readonly loadedInputHashes: Readonly<Record<string, string>>;
  readonly resourceInputHashes: Readonly<Record<string, string>>;
}): Promise<GpuStreamingHybridLifecycle | null> {
  if (input.producer.segmentedHybrid) return segmentedLifecycle(input);
  const direct = await openGpuStreamingHybridSource(input);
  return direct ? directLifecycle(direct) : null;
}

function directLifecycle(direct: GpuStreamingHybridSource): GpuStreamingHybridLifecycle {
  let ledger: GpuSegmentedHybridRangeLedger | undefined;
  return Object.freeze({
    async frameResources(input: { readonly index: number; readonly atMs: number; readonly evidence: MutableGpuStreamingEvidence; readonly signal: AbortSignal }) {
      const result = await direct.capture(input);
      return result.ok ? { ok: true as const, resources: result } : result;
    },
    finish(evidence: MutableGpuStreamingEvidence) { ledger = direct.finish(evidence); },
    close: async () => await direct.close(),
    get directLedger() { return ledger; },
    segmented: undefined,
  });
}

function segmentedLifecycle(input: Parameters<typeof openGpuStreamingHybridLifecycle>[0]): GpuStreamingHybridLifecycle {
  const requested = input.producer.segmentedHybrid!;
  const capture = openGpuStreamingSegmentedHybrid({
    admission: requested.admission,
    schedule: requested.schedule,
    runtime: input.runtime,
    job: input.job,
    range: input.range,
  });
  let ledger: GpuSegmentedHybridRangeLedger | undefined;
  let cleanup: GpuSegmentedHybridRangeCleanupEvidence | undefined;
  const segmented = {
    identity: capture.identity,
    get ledger() { return ledger; },
    get cleanup() { return cleanup; },
  };
  return Object.freeze({
    async frameResources({ index, signal }: { readonly index: number; readonly atMs: number; readonly evidence: MutableGpuStreamingEvidence; readonly signal: AbortSignal }) { return { ok: true as const, resources: await capture.frameResources(index, signal) }; },
    finish() { ledger = capture.finish(); },
    async close() { cleanup = await capture.close(); },
    directLedger: undefined,
    segmented,
  });
}
