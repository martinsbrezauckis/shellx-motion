import { compileGpuVideoFrameRequests, gpuVideoTimelineAtUs, type GpuScene2dVideoResource, type GpuVideoFrameRequest, type MotionPackage } from "@shellx-motion/core";
import type { GpuSessionDynamicImageReservation } from "./gpu-runtime-types";
import type { GpuPreviewDecodedVideoFrameBatch, GpuPreviewVideoFrameProvider, GpuPreviewVideoProviderProbe } from "./gpu-preview-video-frame-provider";
import { previewVideoBatchFailure } from "./gpu-preview-video-orchestration";

export interface GpuPreviewVideoProviderAdmission {
  ok: true;
  provider: GpuPreviewVideoFrameProvider;
  probe: GpuPreviewVideoProviderProbe;
}

export interface PreparedGpuPreviewVideo {
  provider: GpuPreviewVideoFrameProvider;
  probe: GpuPreviewVideoProviderProbe;
  batch: GpuPreviewDecodedVideoFrameBatch;
  dynamicSlots: readonly GpuSessionDynamicImageReservation[];
  videos: ReadonlyMap<string, GpuScene2dVideoResource>;
  requests: ReadonlyMap<string, GpuVideoFrameRequest>;
}

export async function prepareGpuPreviewVideo(input: {
  motion: MotionPackage["motion"];
  atMs: number;
  signal: AbortSignal;
  ensure(signal: AbortSignal): Promise<GpuPreviewVideoProviderAdmission | { ok: false; error: { code: string; message: string } }>;
}): Promise<{ ok: true; video: PreparedGpuPreviewVideo } | { ok: false; error: { code: string; message: string; layerId?: string }; integrity?: true }> {
  const opened = await input.ensure(input.signal);
  if (!opened.ok) return opened;
  const atUs = gpuVideoTimelineAtUs(input.atMs);
  if (atUs === null) return { ok: false, error: { code: "gpu_invalid_time", message: "GPU preview playhead cannot be represented as integer microseconds." } };
  const requestResult = compileGpuVideoFrameRequests({ motion: input.motion, atUs, snapshots: opened.probe.snapshots });
  if (!requestResult.ok) return { ok: false, error: requestResult.failure };
  let batch: GpuPreviewDecodedVideoFrameBatch;
  if (requestResult.requests.length === 0) batch = { atUs, frames: [] };
  else try { batch = await opened.provider.framesFor(requestResult.requests, input.signal); }
  catch (error) { return { ok: false, error: { code: input.signal.aborted ? "gpu_cancelled" : "gpu_preview_video_provider_refused", message: error instanceof Error ? error.message : "The host-owned GPU preview video provider could not fulfill an exact frame batch." } }; }
  const fulfilled = previewVideoBatchFailure({ atUs, requests: requestResult.requests, probe: opened.probe, batch });
  return fulfilled.ok
    ? { ok: true, video: { provider: opened.provider, probe: opened.probe, batch, dynamicSlots: fulfilled.dynamicSlots, videos: fulfilled.videos, requests: fulfilled.requests } }
    : { ok: false, error: fulfilled.failure, integrity: true };
}
