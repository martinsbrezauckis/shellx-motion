import { canonicalJsonSha256 } from "./canonical-json";
import { GPU_MAX_FRAME_DIMENSION, GPU_MAX_FRAME_PIXELS } from "./gpu-frame-intent";
import { expandGpuSceneGroupsAtUs } from "./gpu-scene-group";
import type { GpuScene2dFailure } from "./gpu-scene-2d-plan";
import type { MotionDocument, MotionLayer } from "./types";

export const GPU_VIDEO_FRAME_REQUEST_SCHEMA = "shellx-motion/gpu-video-frame-request@1" as const;
/** One retained GPU preview session may own no more than eight visible video sources. */
export const GPU_MAX_VISIBLE_VIDEO_SOURCES = 8;

/** Immutable source facts supplied by the host after it snapshots one admitted media file. */
export interface GpuVideoSourceSnapshot {
  assetRef: string;
  sourceSnapshotSha256: string;
  durationUs: number;
  width: number;
  height: number;
  decodeContractSha256: string;
}

/** The sole Core authority for an exact, visual-only video decode request. */
export interface GpuVideoFrameRequest {
  schema: typeof GPU_VIDEO_FRAME_REQUEST_SCHEMA;
  layerId: string;
  assetRef: string;
  /** Root Motion playhead, quantized once to integer microseconds. */
  atUs: number;
  /** Resolved immutable-source timestamp, always an integer microsecond. */
  sourceAtUs: number;
  sourceAtMs: number;
  trimStartUs: number;
  trimDurationUs: number;
  loop: boolean;
  playbackRate: number;
  sourceSnapshotSha256: string;
  width: number;
  height: number;
  decodeContractSha256: string;
  requestFingerprint: string;
}

/** Fields every decoded frame must carry before GPU lowering may draw it. */
export interface GpuVideoFrameResourceBinding {
  layerId: string;
  sourceAtUs: number;
  sourceAtMs: number;
  sourceSnapshotSha256: string;
  decodedRgbaSha256: string;
  decodeContractSha256: string;
  requestFingerprint: string;
}

export interface GpuVideoFrameRequestInput {
  motion: MotionDocument;
  atUs: number;
  /** Keys are layer ids, so one decoded frame cannot be reused under another layer's authority. */
  snapshots: ReadonlyMap<string, GpuVideoSourceSnapshot>;
}

export type GpuVideoFrameRequestResult =
  | { ok: true; requests: readonly GpuVideoFrameRequest[] }
  | { ok: false; failure: GpuScene2dFailure };

/**
 * Plans every visible video decode at an integer-microsecond playhead. This is intentionally
 * visual-only: audio, temporal-video blur, final staging, and mux ownership remain elsewhere.
 */
export function compileGpuVideoFrameRequests(input: GpuVideoFrameRequestInput): GpuVideoFrameRequestResult {
  if (!isUs(input.atUs)) return requestFailure("gpu_invalid_time", "GPU video frame requests require a non-negative safe integer atUs.");
  const expanded = expandGpuSceneGroupsAtUs(input.motion, input.atUs);
  if (!expanded.ok) return expanded;
  const requests: GpuVideoFrameRequest[] = [];
  for (const entry of expanded.entries) {
    if (entry.kind !== "layer" || entry.sourceLayer.type !== "video") continue;
    if (requests.length >= GPU_MAX_VISIBLE_VIDEO_SOURCES) {
      return requestFailure("gpu_resource_refused", `GPU video preview accepts at most ${GPU_MAX_VISIBLE_VIDEO_SOURCES} visible video layers.`, entry.sourceLayer.id);
    }
    const request = compileRequest(input.motion, entry.sourceLayer, entry.atUs, input.atUs, input.snapshots.get(entry.sourceLayer.id));
    if ("failure" in request) return { ok: false, failure: request.failure };
    requests.push(Object.freeze(request.value));
  }
  return { ok: true, requests: Object.freeze(requests) };
}

/** Deterministically quantizes a legacy millisecond playhead for the exact-time authority. */
export function gpuVideoTimelineAtUs(atMs: number): number | null {
  if (!Number.isFinite(atMs) || atMs < 0) return null;
  const atUs = Math.round(atMs * 1_000);
  return isUs(atUs) ? atUs : null;
}

/** Resolves the same bounded package-local source spellings accepted by Motion video layers. */
export function gpuVideoLayerAssetRef(motion: MotionDocument, layer: MotionLayer): string | null {
  const direct = [layer.assetRef, layer.source, layer.src].find((value) => typeof value === "string" && value.length > 0);
  if (direct) return direct;
  if (!layer.assetId) return null;
  for (const candidate of motion.assets) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const asset = candidate as Record<string, unknown>;
    const source = asset.source;
    if (asset.id !== layer.assetId || !source || typeof source !== "object" || Array.isArray(source)) continue;
    const path = (source as Record<string, unknown>).path;
    if (typeof path === "string" && path.length > 0) return path;
  }
  return null;
}

/** Returns a refusal message when a decoded frame is stale, forged, or bound to another request. */
export function gpuVideoResourceBindingFailure(input: {
  layerId: string;
  assetRef: string | null;
  atUs: number;
  request: GpuVideoFrameRequest | undefined;
  resource: ({ layerId: string; assetRef: string; width: number; height: number; sha256: string; sourceAtMs: number } & Partial<GpuVideoFrameResourceBinding>) | undefined;
}): string | null {
  const { layerId, assetRef, atUs, request, resource } = input;
  if (!assetRef) return `GPU video layer ${layerId} has no package asset reference.`;
  if (!request) return `GPU video layer ${layerId} has no exact-time request authority.`;
  const requestProblem = gpuVideoFrameRequestProblem(request);
  if (requestProblem) return `GPU video layer ${layerId} has an invalid exact-time request: ${requestProblem}`;
  if (request.layerId !== layerId || request.assetRef !== assetRef || request.atUs !== atUs) return `GPU video layer ${layerId} request does not bind this exact layer, asset, and playhead.`;
  if (!resource) return `GPU scene video layer ${layerId} has no prepared exact decoded frame.`;
  if (resource.layerId !== request.layerId || resource.assetRef !== request.assetRef) return `GPU video layer ${layerId} decoded frame binds another layer or asset.`;
  if (resource.width !== request.width || resource.height !== request.height) return `GPU video layer ${layerId} decoded frame dimensions do not match its exact request.`;
  if (resource.sourceAtUs !== request.sourceAtUs || resource.sourceAtMs !== request.sourceAtMs) return `GPU video layer ${layerId} decoded frame is stale for the requested source timestamp.`;
  if (resource.sourceSnapshotSha256 !== request.sourceSnapshotSha256 || resource.decodeContractSha256 !== request.decodeContractSha256) return `GPU video layer ${layerId} decoded frame source snapshot or decode contract does not match its request.`;
  if (!isSha256(resource.decodedRgbaSha256) || resource.sha256 !== resource.decodedRgbaSha256) return `GPU video layer ${layerId} decoded RGBA identity is missing or disagrees with its texture identity.`;
  if (resource.requestFingerprint !== request.requestFingerprint) return `GPU video layer ${layerId} decoded frame request fingerprint does not match the active request.`;
  return null;
}

/** Recomputes the authority fingerprint so consumers can reject forged request objects. */
export function gpuVideoFrameRequestProblem(request: GpuVideoFrameRequest): string | null {
  if (request.schema !== GPU_VIDEO_FRAME_REQUEST_SCHEMA) return "unsupported schema";
  if (!nonEmpty(request.layerId) || !nonEmpty(request.assetRef)) return "layerId and assetRef must be non-empty";
  if (!isUs(request.atUs) || !isUs(request.sourceAtUs) || !isUs(request.trimStartUs) || !isPositiveUs(request.trimDurationUs)) return "timestamps must be safe integer microseconds";
  if (!Number.isSafeInteger(request.trimStartUs + request.trimDurationUs)) return "trim interval must remain within safe integer microseconds";
  if (request.sourceAtMs !== request.sourceAtUs / 1_000) return "sourceAtMs must exactly derive from sourceAtUs";
  if (request.sourceAtUs < request.trimStartUs || request.sourceAtUs >= request.trimStartUs + request.trimDurationUs) return "sourceAtUs must remain inside the trimmed half-open interval";
  if (typeof request.loop !== "boolean" || !isPlaybackRate(request.playbackRate)) return "loop and scalar playbackRate are invalid";
  if (!isSha256(request.sourceSnapshotSha256) || !isSha256(request.decodeContractSha256)) return "source and decode identities must be lowercase SHA-256";
  if (!frameDimensions(request.width, request.height)) return "decoded dimensions exceed the bounded frame contract";
  if (!isSha256(request.requestFingerprint) || request.requestFingerprint !== canonicalJsonSha256(fingerprintPayload(request))) return "request fingerprint is not canonical";
  return null;
}

function compileRequest(motion: MotionDocument, layer: MotionLayer, parentAtUs: number, atUs: number, snapshot: GpuVideoSourceSnapshot | undefined): { value: GpuVideoFrameRequest } | { failure: GpuScene2dFailure } {
  const assetRef = gpuVideoLayerAssetRef(motion, layer);
  if (!assetRef || !snapshot) return fail("gpu_resource_refused", `GPU video layer ${layer.id} has no immutable source snapshot.`, layer.id);
  const snapshotProblem = sourceSnapshotProblem(snapshot);
  if (snapshotProblem) return fail("gpu_resource_refused", `GPU video layer ${layer.id} immutable source snapshot ${snapshotProblem}.`, layer.id);
  if (snapshot.assetRef !== assetRef) return fail("gpu_resource_refused", `GPU video layer ${layer.id} immutable source snapshot binds a different asset.`, layer.id);
  const rate = layer.playbackRate ?? 1;
  if (Array.isArray(layer.keyframes?.playbackRate) && layer.keyframes.playbackRate.length > 0) return fail("gpu_unsupported_feature", `GPU video layer ${layer.id} keyframed playbackRate is not supported in V25-B1.`, layer.id);
  if (!isPlaybackRate(rate)) return fail("gpu_unsupported_feature", `GPU video layer ${layer.id} playbackRate must be a scalar within (0, 16].`, layer.id);
  const trimStartUs = millisecondsToUs(layer.trimStartMs ?? 0);
  if (trimStartUs === null || trimStartUs >= snapshot.durationUs) return fail("gpu_resource_refused", `GPU video layer ${layer.id} trimStartMs must fall before immutable source duration.`, layer.id);
  const declaredTrimUs = layer.trimDurationMs === undefined ? snapshot.durationUs - trimStartUs : millisecondsToUs(layer.trimDurationMs);
  if (declaredTrimUs === null || declaredTrimUs <= 0 || trimStartUs + declaredTrimUs > snapshot.durationUs) return fail("gpu_resource_refused", `GPU video layer ${layer.id} trimDurationMs exceeds immutable source duration.`, layer.id);
  const layerStartUs = millisecondsToUs(layer.startMs);
  if (layerStartUs === null || parentAtUs < layerStartUs) return fail("gpu_invalid_time", `GPU video layer ${layer.id} has an invalid parent-local start time.`, layer.id);
  const sourceOffsetUs = Math.round((parentAtUs - layerStartUs) * rate);
  if (!isUs(sourceOffsetUs)) return fail("gpu_invalid_time", `GPU video layer ${layer.id} playback mapping exceeds integer microsecond precision.`, layer.id);
  if (layer.loop !== true && sourceOffsetUs >= declaredTrimUs) return fail("gpu_resource_refused", `GPU video layer ${layer.id} refuses source time at or beyond its non-loop trimmed half-open end.`, layer.id);
  const sourceAtUs = trimStartUs + (layer.loop === true ? sourceOffsetUs % declaredTrimUs : sourceOffsetUs);
  const base = { schema: GPU_VIDEO_FRAME_REQUEST_SCHEMA, layerId: layer.id, assetRef, atUs, sourceAtUs, sourceAtMs: sourceAtUs / 1_000, trimStartUs, trimDurationUs: declaredTrimUs, loop: layer.loop === true, playbackRate: rate, sourceSnapshotSha256: snapshot.sourceSnapshotSha256, width: snapshot.width, height: snapshot.height, decodeContractSha256: snapshot.decodeContractSha256 } as const;
  return { value: { ...base, requestFingerprint: canonicalJsonSha256(fingerprintPayload(base)) } };
}

function fingerprintPayload(request: Omit<GpuVideoFrameRequest, "requestFingerprint">): Omit<GpuVideoFrameRequest, "requestFingerprint" | "sourceAtMs"> {
  const { sourceAtMs: _sourceAtMs, requestFingerprint: _requestFingerprint, ...payload } = request as GpuVideoFrameRequest;
  return payload;
}
function sourceSnapshotProblem(snapshot: GpuVideoSourceSnapshot): string | null {
  if (!nonEmpty(snapshot.assetRef) || !isSha256(snapshot.sourceSnapshotSha256) || !isSha256(snapshot.decodeContractSha256)) return "must carry an assetRef plus source and decode SHA-256 identities";
  if (!isPositiveUs(snapshot.durationUs)) return "durationUs must be a positive safe integer";
  if (!frameDimensions(snapshot.width, snapshot.height)) return "dimensions exceed the bounded frame contract";
  return null;
}
function millisecondsToUs(value: number): number | null { return Number.isFinite(value) && value >= 0 ? gpuVideoTimelineAtUs(value) : null; }
function isUs(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isPositiveUs(value: unknown): value is number { return isUs(value) && value > 0; }
function isPlaybackRate(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 16; }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function frameDimensions(width: unknown, height: unknown): boolean { return typeof width === "number" && typeof height === "number" && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= GPU_MAX_FRAME_DIMENSION && height <= GPU_MAX_FRAME_DIMENSION && width * height <= GPU_MAX_FRAME_PIXELS; }
function requestFailure(code: GpuScene2dFailure["code"], message: string, layerId?: string): GpuVideoFrameRequestResult { return { ok: false, failure: { code, message, ...(layerId ? { layerId } : {}) } }; }
function fail(code: GpuScene2dFailure["code"], message: string, layerId?: string): { failure: GpuScene2dFailure } { return { failure: { code, message, ...(layerId ? { layerId } : {}) } }; }
