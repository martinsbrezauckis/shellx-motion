import type { MotionPackage, RetainedDirectoryAuthority } from "@shellx-motion/core";
import type {
  GpuPreviewVideoFrameProvider,
  GpuPreviewVideoFrameProviderEvidence,
  GpuPreviewVideoProviderCleanupEvidence
} from "@shellx-motion/renderer-browser";
import type { GpuPreviewFfmpegRunner } from "./gpu-video-preview-provider-primitives.js";

/** Trusted-host construction: expensive source work starts only from `probe(signal)`. */
export interface CreateGpuPreviewVideoFrameProviderOptions {
  pkg: MotionPackage;
  scratchRoot: string;
  scratchAuthority?: RetainedDirectoryAuthority;
  runner: GpuPreviewFfmpegRunner;
}

export interface GpuPreviewVideoDecodedFrameEvidence {
  layerId: string;
  assetRef: string;
  requestFingerprint: string;
  requestedSourceAtUs: number;
  decodedPts: { value: string; timeBase: string };
  decodedPtsUs: string;
  sourceSnapshotSha256: string;
  decodedRgbaSha256: string;
  decodeContractSha256: string;
  cache: "hit" | "miss" | "deduplicated";
}

export interface GpuPreviewVideoProviderDetailedEvidence {
  schema: "shellx-motion/gpu-preview-video-frame-provider-evidence@1";
  surface: "preview-visual-only";
  snapshots: Array<{
    assetRef: string; sourceSnapshotSha256: string; byteLength: number; width: number; height: number;
    durationUs: number; fps: string; frameDuration: string; ffmpegIdentity: string; ffprobeIdentity: string;
    decodeContractSha256: string;
  }>;
  decodedFrames: GpuPreviewVideoDecodedFrameEvidence[];
  decodedFrameCount: number;
  decodedFrameSequenceSha256: string;
  cache: {
    hits: number; misses: number; evictions: number; deduplicated: number; currentEntries: number;
    currentBytes: number; highWaterEntries: number; highWaterBytes: number; capacityEntries: number;
    capacityBytes: number; inFlightRgbaBytes: number; inFlightRgbaHighWaterBytes: number;
  };
  cleanup?: { closed: true; releasedFrames: number; snapshotsReleased: number; privateRootRemoved: boolean };
}

export interface FfmpegGpuPreviewVideoFrameProvider extends GpuPreviewVideoFrameProvider {
  readonly detailedEvidence: Readonly<GpuPreviewVideoProviderDetailedEvidence>;
}

export interface GpuPreviewVideoCacheStats {
  hits: number; misses: number; evictions: number; deduplicated: number; entries: number; bytes: number;
  highWaterEntries: number; highWaterBytes: number; inFlightBytes: number; inFlightHighWaterBytes: number;
}

export type GpuPreviewVideoBaseEvidence = GpuPreviewVideoFrameProviderEvidence;
export type GpuPreviewVideoCleanupEvidence = GpuPreviewVideoProviderCleanupEvidence;
