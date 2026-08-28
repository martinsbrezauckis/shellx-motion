import { canonicalJsonSha256 } from "@shellx-motion/core";
import type { GpuPreviewVideoFrameProviderEvidence } from "@shellx-motion/renderer-browser";
import {
  MAX_GPU_PREVIEW_VIDEO_CACHE_BYTES,
  MAX_GPU_PREVIEW_VIDEO_CACHE_ENTRIES,
  MAX_GPU_PREVIEW_VIDEO_RECENT_FRAME_EVIDENCE
} from "./gpu-video-preview-provider-primitives.js";
import type {
  GpuPreviewVideoCacheStats,
  GpuPreviewVideoDecodedFrameEvidence,
  GpuPreviewVideoProviderDetailedEvidence
} from "./gpu-video-preview-provider-contracts.js";

/** Bounded local evidence ledger; Browser independently retains the current batch receipt. */
export class GpuPreviewVideoProviderEvidenceLedger {
  readonly base: GpuPreviewVideoFrameProviderEvidence = {
    schema: "shellx-motion/gpu-preview-video-frame-provider@1", surface: "preview-visual-only", sourceCount: 0, decodedFrameCount: 0,
    cache: { hits: 0, misses: 0, evictions: 0, deduplicated: 0, entries: 0, bytes: 0, highWaterEntries: 0, highWaterBytes: 0, capacityEntries: MAX_GPU_PREVIEW_VIDEO_CACHE_ENTRIES, capacityBytes: MAX_GPU_PREVIEW_VIDEO_CACHE_BYTES, inFlightBytes: 0, inFlightHighWaterBytes: 0 }
  };
  readonly detailed: GpuPreviewVideoProviderDetailedEvidence = {
    schema: "shellx-motion/gpu-preview-video-frame-provider-evidence@1", surface: "preview-visual-only", snapshots: [], decodedFrames: [], decodedFrameCount: 0,
    decodedFrameSequenceSha256: canonicalJsonSha256({ schema: "shellx-motion/gpu-preview-video-frame-sequence@1", frames: [] }),
    cache: { hits: 0, misses: 0, evictions: 0, deduplicated: 0, currentEntries: 0, currentBytes: 0, highWaterEntries: 0, highWaterBytes: 0, capacityEntries: MAX_GPU_PREVIEW_VIDEO_CACHE_ENTRIES, capacityBytes: MAX_GPU_PREVIEW_VIDEO_CACHE_BYTES, inFlightRgbaBytes: 0, inFlightRgbaHighWaterBytes: 0 }
  };

  record(frame: GpuPreviewVideoDecodedFrameEvidence): void {
    this.detailed.decodedFrameCount += 1;
    this.detailed.decodedFrameSequenceSha256 = canonicalJsonSha256({ prior: this.detailed.decodedFrameSequenceSha256, frame: { layerId: frame.layerId, requestFingerprint: frame.requestFingerprint, requestedSourceAtUs: frame.requestedSourceAtUs, decodedPts: frame.decodedPts, sourceSnapshotSha256: frame.sourceSnapshotSha256, decodedRgbaSha256: frame.decodedRgbaSha256, decodeContractSha256: frame.decodeContractSha256, cache: frame.cache } });
    if (this.detailed.decodedFrames.length === MAX_GPU_PREVIEW_VIDEO_RECENT_FRAME_EVIDENCE) this.detailed.decodedFrames.shift();
    this.detailed.decodedFrames.push(frame);
  }

  syncCache(stats: Readonly<GpuPreviewVideoCacheStats>): void {
    Object.assign(this.base.cache, stats);
    Object.assign(this.detailed.cache, { hits: stats.hits, misses: stats.misses, evictions: stats.evictions, deduplicated: stats.deduplicated, currentEntries: stats.entries, currentBytes: stats.bytes, highWaterEntries: stats.highWaterEntries, highWaterBytes: stats.highWaterBytes, inFlightRgbaBytes: stats.inFlightBytes, inFlightRgbaHighWaterBytes: stats.inFlightHighWaterBytes });
  }
}
