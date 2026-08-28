import type { GpuScene2dVideoResource } from "@shellx-motion/core";
import type { GpuSessionImageResource } from "./gpu-runtime-types";

export interface GpuDecodedVideoFrame {
  layerId: string;
  assetRef: string;
  sourceAtMs: number;
  resource: GpuScene2dVideoResource;
  upload: GpuSessionImageResource;
}

export interface GpuDecodedVideoFrameBatch {
  atMs: number;
  frames: readonly GpuDecodedVideoFrame[];
}

export interface GpuVideoFrameProviderEvidence {
  schema: "shellx-motion/gpu-video-frame-provider@1";
  mode: "immutable-ffmpeg-rgba-stream" | "test";
  sourceCount: number;
  decodedFrameCount: number;
  peakInMemoryFrames: number;
  stagedDecodedBytes: number;
  stagedFrameCount: number;
  sources: Array<{ layerId: string; assetRef: string; sha256: string; width: number; height: number }>;
}

/** Host-owned decoder seam. Browser code accepts only exact RGBA frames, never media paths or URLs. */
export interface GpuVideoFrameProvider {
  readonly inputHashes: Readonly<Record<string, string>>;
  readonly evidence: Readonly<GpuVideoFrameProviderEvidence>;
  frameAt(atMs: number, signal: AbortSignal): Promise<GpuDecodedVideoFrameBatch>;
  close(): Promise<void>;
}
