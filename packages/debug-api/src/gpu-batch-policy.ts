import { planFinalVideoFrameTransport, readFfmpegExportPreset, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";
import type { BatchRenderRequest } from "./domains/render-batch.js";

export function gpuBatchRequestRefusal(request: Pick<BatchRenderRequest, "frameLane" | "resume" | "keepFrames" | "workflow" | "workflowPath" | "preset">): string | undefined {
  if (request.frameLane !== "gpu") return undefined;
  if (request.resume) return "GPU batch rendering is fresh-only: resume cannot bind pre-render rows to the live GPU adapter and producer evidence.";
  if (request.keepFrames === true || request.workflow || request.workflowPath) return "GPU batch rendering requires strict streamed FFmpeg delivery; keepFrames and browser workflows are not supported.";
  if (!isGpuBatchVideoPreset(request.preset)) return "GPU batch rendering supports streamed FFmpeg video presets only; GIF, still-frame, and image-sequence presets are refused.";
}

export function gpuBatchPlanRefusal(request: Pick<BatchRenderRequest, "frameLane" | "minUniqueFrameHashes">, presets: readonly MotionExportPreset[]): string | undefined {
  if (request.frameLane !== "gpu") return undefined;
  const nonVideo = presets.find((preset) => !isGpuBatchVideoPreset(preset));
  if (nonVideo) return `GPU batch rendering supports strict streamed FFmpeg video only; ${nonVideo} is not eligible.`;
  const transport = gpuBatchFrameTransport(request.minUniqueFrameHashes);
  return transport.delivery === "streamed" ? undefined : `GPU batch rendering requires strict streamed FFmpeg delivery; ${transport.reason} requires materialized frames.`;
}

export function gpuBatchFrameTransport(minUniqueFrameHashes?: number) {
  return planFinalVideoFrameTransport({ exactSourceQuality: false, ...(minUniqueFrameHashes ? { minUniqueFrameHashes } : {}) });
}

export function isGpuBatchVideoPreset(preset: MotionExportPreset): boolean {
  return preset !== "gif" && Boolean(readFfmpegExportPreset(preset));
}
