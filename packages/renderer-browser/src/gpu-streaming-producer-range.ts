import type { GpuStreamingFrameProducerInput } from "./gpu-streaming-producer-types";

export function canonicalGpuStreamingFrameCount(durationMs: number, fps: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(fps) || fps <= 0) return 1;
  return Math.max(1, Math.ceil((durationMs / 1000) * fps));
}

export function admittedGpuStreamingRange(value: GpuStreamingFrameProducerInput["range"], canonicalFrameTotal: number): { index: number; startFrameIndex: number; endFrameIndexExclusive: number } {
  if (!value) return { index: 0, startFrameIndex: 0, endFrameIndexExclusive: canonicalFrameTotal };
  if (!Number.isSafeInteger(value.index) || value.index < 0 || !Number.isSafeInteger(value.startFrameIndex) || !Number.isSafeInteger(value.endFrameIndexExclusive) || value.startFrameIndex < 0 || value.endFrameIndexExclusive <= value.startFrameIndex || value.endFrameIndexExclusive > canonicalFrameTotal) {
    throw new Error("GPU streaming producer range must be a non-empty canonical timeline interval.");
  }
  return Object.freeze({ ...value });
}
