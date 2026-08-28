import type { GpuHybridTextureRequest, GpuHybridTextureResourceBinding } from "@shellx-motion/core";
import type { GpuFrameRenderSession } from "./gpu-frame-renderer";
import type { GpuStreamingJobContext } from "./gpu-process-containment";
import { openGpuSegmentedHybridRangeCapture } from "./gpu-segmented-hybrid-range";
import type {
  GpuSegmentedHybridAdmission,
  GpuSegmentedHybridRangeCleanupEvidence,
  GpuSegmentedHybridRangeLedger,
  GpuSegmentedHybridRangeScheduleEntry,
} from "./gpu-segmented-hybrid-types";

/** Keeps the opaque B2 range lifecycle out of the generic final producer. */
export interface GpuStreamingSegmentedHybrid {
  readonly identity: GpuSegmentedHybridAdmission["identity"];
  frameResources(index: number, signal: AbortSignal): Promise<{
    readonly hybridTextureRequests: ReadonlyMap<string, GpuHybridTextureRequest>;
    readonly hybridTextures: ReadonlyMap<string, GpuHybridTextureResourceBinding>;
  }>;
  finish(): GpuSegmentedHybridRangeLedger;
  close(): Promise<GpuSegmentedHybridRangeCleanupEvidence>;
}

export function openGpuStreamingSegmentedHybrid(input: {
  readonly admission: GpuSegmentedHybridAdmission;
  readonly schedule: readonly GpuSegmentedHybridRangeScheduleEntry[];
  readonly runtime: GpuFrameRenderSession;
  readonly job: GpuStreamingJobContext;
  readonly range: { readonly index: number; readonly startFrameIndex: number; readonly endFrameIndexExclusive: number };
}): GpuStreamingSegmentedHybrid {
  const capture = openGpuSegmentedHybridRangeCapture({
    admission: input.admission,
    runtime: input.runtime,
    job: input.job,
    range: input.range,
    schedule: input.schedule,
  });
  const schedule = new Map(input.schedule.map((entry) => [entry.index, entry] as const));
  return Object.freeze({
    identity: input.admission.identity,
    async frameResources(index: number, signal: AbortSignal) {
      const hybridTextureRequests = new Map<string, GpuHybridTextureRequest>();
      const hybridTextures = new Map<string, GpuHybridTextureResourceBinding>();
      const exact = schedule.get(index);
      if (exact) {
        const resource = await capture.capture({ ...exact, signal });
        hybridTextureRequests.set(exact.request.layerId, exact.request);
        hybridTextures.set(exact.request.layerId, resource);
      }
      return Object.freeze({ hybridTextureRequests, hybridTextures });
    },
    finish: () => capture.finish(),
    close: () => capture.close(),
  });
}
