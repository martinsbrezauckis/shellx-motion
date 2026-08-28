import { createHash } from "node:crypto";
import { GPU_MAX_VISIBLE_VIDEO_SOURCES, gpuVideoTimelineAtUs, type GpuScene2dVideoResource, type GpuVideoFrameRequest } from "@shellx-motion/core";
import type { GpuFrameRenderSession } from "./gpu-frame-renderer";
import type { GpuPageSessionResourceMetrics } from "./gpu-page-session-resources";
import type { GpuSessionDynamicImageReservation } from "./gpu-runtime-types";
import type { GpuPreviewDecodedVideoFrameBatch, GpuPreviewVideoFrameProvider, GpuPreviewVideoProviderProbe } from "./gpu-preview-video-frame-provider";

export interface PreviewVideoReceiptEvidence {
  schema: "shellx-motion/gpu-preview-video-evidence@1";
  scope: "preview-visual-only";
  atMs: number;
  atUs: number;
  provider: GpuPreviewVideoFrameProvider["evidence"];
  sources: readonly { layerId: string; assetRef: string; resourceId: string; sourceSnapshotSha256: string; decodeContractSha256: string; width: number; height: number }[];
  frames: readonly { layerId: string; assetRef: string; resourceId: string; sourceAtUs: number; sourceAtMs: number; sourceSnapshotSha256: string; decodedRgbaSha256: string; decodeContractSha256: string; requestFingerprint: string; selection: { policy: "cfr-floor-request-sourceAtUs-to-stream-pts"; decodedPts: string; timeBase: string; frameDurationPts: string; decodedPtsUs: string } }[];
  texture: GpuPageSessionResourceMetrics | null;
  limitations: readonly ["audio-not-rasterized", "final-not-attested"];
}

export type PreviewVideoReceiptEvidenceResult =
  | { ok: true; evidence: PreviewVideoReceiptEvidence }
  | { ok: false; failure: { code: "gpu_preview_video_provider_refused"; message: string } };

export function previewVideoProbeFailure(probe: GpuPreviewVideoProviderProbe, expectedLayers: ReadonlyMap<string, string>): string | null {
  if (!probe || !(probe.snapshots instanceof Map) || !Array.isArray(probe.slots) || probe.slots.length > GPU_MAX_VISIBLE_VIDEO_SOURCES || probe.snapshots.size !== probe.slots.length || expectedLayers.size !== probe.slots.length) return "GPU preview video probe has no bounded immutable source slots.";
  const layerIds = new Set<string>(), resourceIds = new Set<string>();
  for (const slot of probe.slots) {
    const snapshot = probe.snapshots.get(slot.layerId);
    if (!slot || typeof slot.assetRef !== "string" || expectedLayers.get(slot.layerId) !== slot.assetRef || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slot.resourceId) || !isSha256(slot.sourceSnapshotSha256) || !isSha256(slot.decodeContractSha256) || layerIds.has(slot.layerId) || resourceIds.has(slot.resourceId) || !snapshot || typeof snapshot.assetRef !== "string" || snapshot.assetRef !== slot.assetRef || !isSha256(snapshot.sourceSnapshotSha256) || !isSha256(snapshot.decodeContractSha256) || snapshot.sourceSnapshotSha256 !== slot.sourceSnapshotSha256 || snapshot.decodeContractSha256 !== slot.decodeContractSha256 || !Number.isSafeInteger(snapshot.durationUs) || snapshot.durationUs < 1 || snapshot.width !== slot.width || snapshot.height !== slot.height || !Number.isSafeInteger(snapshot.width) || !Number.isSafeInteger(snapshot.height) || !Number.isInteger(slot.width) || !Number.isInteger(slot.height) || slot.width < 1 || slot.height < 1 || slot.width > 4_096 || slot.height > 4_096) return "GPU preview video probe has an invalid or mismatched stable texture slot.";
    layerIds.add(slot.layerId); resourceIds.add(slot.resourceId);
  }
  return null;
}

/** Base cache evidence is intentionally bounded at this browser/host seam. */
export function previewVideoProviderEvidenceFailure(evidence: GpuPreviewVideoFrameProvider["evidence"], minimumDecodedFrames: number = 0): string | null {
  const cache = evidence?.cache;
  if (!cache || evidence.schema !== "shellx-motion/gpu-preview-video-frame-provider@1" || evidence.surface !== "preview-visual-only") return "GPU preview video provider has no preview-only evidence contract.";
  const values = [evidence.sourceCount, evidence.decodedFrameCount, cache.hits, cache.misses, cache.evictions, cache.deduplicated, cache.entries, cache.bytes, cache.highWaterEntries, cache.highWaterBytes, cache.capacityEntries, cache.capacityBytes, cache.inFlightBytes, cache.inFlightHighWaterBytes];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return "GPU preview video provider cache evidence is not bounded integer telemetry.";
  if (cache.capacityEntries !== 32 || cache.capacityBytes !== 128 * 1024 * 1024 || cache.inFlightBytes > 64 * 1024 * 1024 || cache.inFlightHighWaterBytes > 64 * 1024 * 1024 || cache.entries > cache.highWaterEntries || cache.highWaterEntries > cache.misses || cache.entries > cache.misses || cache.evictions > cache.misses || cache.bytes > cache.highWaterBytes || cache.highWaterBytes > cache.capacityBytes || (cache.entries === 0) !== (cache.bytes === 0) || (cache.highWaterEntries === 0) !== (cache.highWaterBytes === 0) || cache.inFlightBytes > cache.inFlightHighWaterBytes || evidence.decodedFrameCount < minimumDecodedFrames || cache.hits + cache.misses + cache.deduplicated < evidence.decodedFrameCount) return "GPU preview video provider cache evidence exceeds the fixed preview cache contract.";
  return null;
}

export function previewVideoBatchFailure(input: { atUs: number; requests: readonly GpuVideoFrameRequest[]; probe: GpuPreviewVideoProviderProbe; batch: GpuPreviewDecodedVideoFrameBatch }): { ok: true; dynamicSlots: readonly GpuSessionDynamicImageReservation[]; videos: ReadonlyMap<string, GpuScene2dVideoResource>; requests: ReadonlyMap<string, GpuVideoFrameRequest> } | { ok: false; failure: { code: string; message: string; layerId?: string } } {
  if (!input.batch || input.batch.atUs !== input.atUs || input.batch.frames.length !== input.requests.length) return { ok: false, failure: { code: "gpu_preview_video_provider_refused", message: "GPU preview video provider returned a batch for another exact playhead or request count." } };
  const requests = new Map(input.requests.map((request) => [request.layerId, request]));
  if (requests.size !== input.requests.length) return { ok: false, failure: { code: "gpu_preview_video_provider_refused", message: "Core generated duplicate GPU video frame requests." } };
  const slots = new Map(input.probe.slots.map((slot) => [slot.layerId, slot]));
  const videos = new Map<string, GpuScene2dVideoResource>();
  for (const frame of input.batch.frames) {
    const expected = requests.get(frame.request.layerId), slot = slots.get(frame.request.layerId);
    const resource = frame.resource, upload = frame.upload;
    if (!expected || !slot || videos.has(frame.request.layerId) || frame.request.requestFingerprint !== expected.requestFingerprint || frame.request.atUs !== expected.atUs || frame.request.sourceAtUs !== expected.sourceAtUs || frame.request.sourceAtMs !== expected.sourceAtMs || frame.request.sourceSnapshotSha256 !== expected.sourceSnapshotSha256 || frame.request.decodeContractSha256 !== expected.decodeContractSha256 || frame.request.width !== expected.width || frame.request.height !== expected.height) return { ok: false, failure: { code: "gpu_preview_video_provider_refused", message: "GPU preview provider returned a frame for another Core request.", layerId: frame.request.layerId } };
    if (resource.layerId !== expected.layerId || resource.assetRef !== expected.assetRef || resource.resourceId !== slot.resourceId || resource.width !== expected.width || resource.height !== expected.height || resource.sourceAtUs !== expected.sourceAtUs || resource.sourceAtMs !== expected.sourceAtMs || resource.sourceSnapshotSha256 !== expected.sourceSnapshotSha256 || resource.decodeContractSha256 !== expected.decodeContractSha256 || resource.requestFingerprint !== expected.requestFingerprint || resource.sha256 !== resource.decodedRgbaSha256) return { ok: false, failure: { code: "gpu_preview_video_provider_refused", message: "GPU preview provider frame resource does not bind its Core request exactly.", layerId: expected.layerId } };
    if (!isCfrSelection(frame.selection)) return { ok: false, failure: { code: "gpu_preview_video_provider_refused", message: "GPU preview provider frame has no bounded CFR selection evidence.", layerId: expected.layerId } };
    if (upload.id !== slot.resourceId || upload.width !== resource.width || upload.height !== resource.height || upload.sha256 !== resource.sourceSnapshotSha256 || upload.decodedSha256 !== resource.decodedRgbaSha256 || upload.rgba.byteLength !== resource.width * resource.height * 4 || createHash("sha256").update(upload.rgba).digest("hex") !== resource.decodedRgbaSha256) return { ok: false, failure: { code: "gpu_preview_video_provider_refused", message: "GPU preview provider RGBA upload changed its source, dimensions, or decoded identity.", layerId: expected.layerId } };
    videos.set(expected.layerId, resource);
  }
  if (videos.size !== requests.size) return { ok: false, failure: { code: "gpu_preview_video_provider_refused", message: "GPU preview video provider omitted a Core-requested exact frame." } };
  return { ok: true, dynamicSlots: input.probe.slots.map((slot) => ({ id: slot.resourceId, width: slot.width, height: slot.height, sourceSha256: slot.sourceSnapshotSha256 })), videos, requests };
}

export async function previewVideoReceiptEvidence(provider: GpuPreviewVideoFrameProvider | undefined, fulfilled: { batch: GpuPreviewDecodedVideoFrameBatch; probe: GpuPreviewVideoProviderProbe }, runtime: GpuFrameRenderSession | undefined, atMs: number, expectedWrites: number): Promise<PreviewVideoReceiptEvidenceResult> {
  const atUs = gpuVideoTimelineAtUs(atMs);
  if (!provider || atUs === null) return { ok: false, failure: { code: "gpu_preview_video_provider_refused", message: "GPU preview video receipt lost its exact provider evidence." } };
  const providerFailure = previewVideoProviderEvidenceFailure(provider.evidence, fulfilled.batch.frames.length);
  if (providerFailure) return { ok: false, failure: { code: "gpu_preview_video_provider_refused", message: providerFailure } };
  const texture = await runtime?.resourceMetrics?.() ?? null;
  const textureFailure = previewVideoTextureMetricsFailure(texture, fulfilled.probe.slots, expectedWrites);
  if (textureFailure) return { ok: false, failure: { code: "gpu_preview_video_provider_refused", message: textureFailure } };
  return { ok: true, evidence: Object.freeze({
    schema: "shellx-motion/gpu-preview-video-evidence@1" as const,
    scope: "preview-visual-only" as const,
    atMs,
    atUs,
    provider: Object.freeze({ ...provider.evidence, cache: Object.freeze({ ...provider.evidence.cache }) }),
    sources: Object.freeze(fulfilled.probe.slots.map((slot) => Object.freeze({ layerId: slot.layerId, assetRef: slot.assetRef, resourceId: slot.resourceId, sourceSnapshotSha256: slot.sourceSnapshotSha256, decodeContractSha256: slot.decodeContractSha256, width: slot.width, height: slot.height }))),
    frames: Object.freeze(fulfilled.batch.frames.map((frame) => Object.freeze({ layerId: frame.resource.layerId, assetRef: frame.resource.assetRef, resourceId: frame.resource.resourceId, sourceAtUs: frame.resource.sourceAtUs!, sourceAtMs: frame.resource.sourceAtMs, sourceSnapshotSha256: frame.resource.sourceSnapshotSha256!, decodedRgbaSha256: frame.resource.decodedRgbaSha256!, decodeContractSha256: frame.resource.decodeContractSha256!, requestFingerprint: frame.resource.requestFingerprint!, selection: Object.freeze({ ...frame.selection }) }))),
    texture,
    limitations: Object.freeze(["audio-not-rasterized", "final-not-attested"] as const)
  }) };
}

function previewVideoTextureMetricsFailure(metrics: GpuPageSessionResourceMetrics | null, slots: readonly GpuPreviewVideoProviderProbe["slots"][number][], expectedWrites: number): string | null {
  if (!metrics) return "GPU preview video session did not retain dynamic texture metrics.";
  const expectedBytes = slots.reduce((total, slot) => total + slot.width * slot.height * 4, 0);
  if (!Number.isSafeInteger(expectedWrites) || expectedWrites < 0 || !Number.isSafeInteger(expectedBytes)) return "GPU preview video texture metric expectation overflowed.";
  if (metrics.dynamicImageTextureSlots !== slots.length || metrics.dynamicImageTextureBytes !== expectedBytes || metrics.dynamicImageTextureHighWaterSlots !== slots.length || metrics.dynamicImageTextureHighWaterBytes !== expectedBytes || metrics.dynamicImageTextureLateRefusals !== 0 || metrics.dynamicImageTextureWrites !== expectedWrites || metrics.dynamicImageTextureReplacements !== expectedWrites) return "GPU preview video texture metrics do not bind the reserved slots and exact replacement history.";
  return null;
}

function isCfrSelection(selection: unknown): selection is { policy: "cfr-floor-request-sourceAtUs-to-stream-pts"; decodedPts: string; timeBase: string; frameDurationPts: string; decodedPtsUs: string } {
  if (!selection || typeof selection !== "object") return false;
  const value = selection as Record<string, unknown>;
  return value.policy === "cfr-floor-request-sourceAtUs-to-stream-pts"
    && typeof value.decodedPts === "string" && /^(?:0|[1-9]\d{0,31})$/.test(value.decodedPts)
    && typeof value.timeBase === "string" && /^\d{1,16}\/[1-9]\d{0,16}$/.test(value.timeBase)
    && typeof value.frameDurationPts === "string" && /^[1-9]\d{0,31}$/.test(value.frameDurationPts)
    && typeof value.decodedPtsUs === "string" && /^(?:0|[1-9]\d{0,31})(?:\.\d{1,12})?$/.test(value.decodedPtsUs);
}

function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
