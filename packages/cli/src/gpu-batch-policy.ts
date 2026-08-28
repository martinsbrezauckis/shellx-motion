import { planFinalVideoFrameTransport, readFfmpegExportPreset, type MotionExportPreset } from "@shellx-motion/renderer-ffmpeg";

export type BatchFrameLane = "browser" | "native" | "gpu";

export function readBatchFrameLane(value: string | undefined): BatchFrameLane | undefined {
  return value === "browser" || value === "native" || value === "gpu" ? value : undefined;
}

export function gpuBatchPreflightRefusal(input: {
  frameLane: BatchFrameLane;
  resume: boolean;
  workflowPath?: string;
  presets?: readonly MotionExportPreset[];
  quality?: { minUniqueFrameHashes: number };
}): string | undefined {
  if (input.frameLane !== "gpu") return undefined;
  if (input.resume) return "GPU batch rendering is fresh-only: --resume cannot bind pre-render rows to the live GPU adapter and producer evidence.";
  if (input.workflowPath) return "GPU batch rendering does not support browser workflows; it never falls back to browser materialization.";
  const nonVideo = input.presets?.find((preset) => !isGpuBatchVideoPreset(preset));
  if (nonVideo) return `GPU batch rendering supports streamed FFmpeg video only; ${nonVideo} is not eligible.`;
  const transport = gpuBatchFrameTransport(input.quality);
  return transport.delivery === "streamed" ? undefined : `GPU batch rendering requires strict streamed FFmpeg delivery; ${transport.reason} requires materialized frames.`;
}

export function gpuBatchFrameTransport(quality?: { minUniqueFrameHashes: number }) {
  return planFinalVideoFrameTransport({ exactSourceQuality: false, ...(quality ? { minUniqueFrameHashes: quality.minUniqueFrameHashes } : {}) });
}

export function isGpuBatchVideoPreset(preset: MotionExportPreset): boolean {
  return preset !== "gif" && Boolean(readFfmpegExportPreset(preset));
}
