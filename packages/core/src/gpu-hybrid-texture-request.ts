import { canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { GPU_MAX_FRAME_DIMENSION, GPU_MAX_FRAME_PIXELS } from "./gpu-frame-intent";
import { isGpuBrowserSurfaceLayer } from "./gpu-scene-2d-admission";
import { expandGpuSceneGroupsAtUs } from "./gpu-scene-group";
import { gpuSceneImageAssetRef } from "./gpu-scene-media";
import { gpuRestrictedShaderAssetRef, gpuRestrictedShaderTextureDimensions, isGpuRestrictedShaderHybridLayer } from "./gpu-scene-restricted-shader";
import { isSafeShaderUniformName } from "./shader-plugin";
import type { GpuScene2dFailure, GpuScene2dImageResource } from "./gpu-scene-2d-plan";
import type { MotionDocument, MotionLayer } from "./types";

export const GPU_HYBRID_TEXTURE_STATIC_DESCRIPTOR_SCHEMA = "shellx-motion/gpu-hybrid-texture-static-descriptor@1" as const;
export const GPU_HYBRID_TEXTURE_SOURCE_SNAPSHOT_SCHEMA = "shellx-motion/gpu-hybrid-texture-source-snapshot@1" as const;
export const GPU_HYBRID_TEXTURE_REQUEST_SCHEMA = "shellx-motion/gpu-hybrid-texture-request@1" as const;
export const GPU_HYBRID_TEXTURE_RESOURCE_BINDING_SCHEMA = "shellx-motion/gpu-hybrid-texture-resource-binding@1" as const;
export const GPU_MAX_HYBRID_TEXTURE_SOURCES = 1;
export const GPU_MAX_STRICT_HTML_SOURCE_BYTES = 8 * 1024 * 1024;
export const GPU_MAX_RESTRICTED_GLSL_SOURCE_BYTES = 16 * 1024;

/** Closed producer names derived from admitted Motion layer data, never from a package request. */
export type GpuHybridTextureProducer = "strict-data-only-html" | "isolated-restricted-glsl";

export interface GpuHybridTextureStaticDescriptor {
  schema: typeof GPU_HYBRID_TEXTURE_STATIC_DESCRIPTOR_SCHEMA;
  layerId: string;
  producer: GpuHybridTextureProducer;
  assetRef: string;
  width: number;
  height: number;
  /** Declared restricted GLSL metadata only; source bytes remain host-owned. */
  restrictedShader?: {
    schema: "shellx-motion/shader-plugin@1";
    language: "glsl-es-100-expression";
    seed: number;
    uniformNames: readonly string[];
  };
  descriptorFingerprint: string;
}

/** Immutable source and capture-policy facts supplied after host-side stable reading. */
export interface GpuHybridTextureSourceSnapshot {
  schema: typeof GPU_HYBRID_TEXTURE_SOURCE_SNAPSHOT_SCHEMA;
  layerId: string;
  producer: GpuHybridTextureProducer;
  assetRef: string;
  width: number;
  height: number;
  staticDescriptorFingerprint: string;
  sourceSnapshotSha256: string;
  sourceByteLength: number;
  /** Opaque SHA-256 of the host-owned data-only/restricted capture contract. */
  captureContractSha256: string;
  snapshotFingerprint: string;
}

/** The exact root Motion timestamp at which one closed hybrid producer must make a texture. */
export interface GpuHybridTextureRequest {
  schema: typeof GPU_HYBRID_TEXTURE_REQUEST_SCHEMA;
  layerId: string;
  producer: GpuHybridTextureProducer;
  assetRef: string;
  width: number;
  height: number;
  atUs: number;
  staticDescriptorFingerprint: string;
  sourceSnapshotSha256: string;
  sourceByteLength: number;
  captureContractSha256: string;
  snapshotFingerprint: string;
  requestFingerprint: string;
}

/** The only texture form the strict B2 frame path may lower. `sha256` is decoded RGBA identity. */
export interface GpuHybridTextureResourceBinding extends GpuScene2dImageResource {
  schema: typeof GPU_HYBRID_TEXTURE_RESOURCE_BINDING_SCHEMA;
  layerId: string;
  producer: GpuHybridTextureProducer;
  atUs: number;
  staticDescriptorFingerprint: string;
  sourceSnapshotSha256: string;
  sourceByteLength: number;
  captureContractSha256: string;
  snapshotFingerprint: string;
  decodedRgbaSha256: string;
  requestFingerprint: string;
}

export interface GpuHybridTextureRequestInput {
  motion: MotionDocument;
  atUs: number;
  /** Keys are exact layer ids; inactive timestamps must carry no source snapshot. */
  snapshots: ReadonlyMap<string, GpuHybridTextureSourceSnapshot>;
}
export interface GpuHybridTextureSourceSnapshotInput {
  descriptor: GpuHybridTextureStaticDescriptor;
  sourceSnapshotSha256: string;
  sourceByteLength: number;
  captureContractSha256: string;
}
export interface GpuHybridTextureResourceBindingInput {
  request: GpuHybridTextureRequest;
  resourceId: string;
  decodedRgbaSha256: string;
}

export type GpuHybridTextureRequestResult =
  | { ok: true; requests: readonly GpuHybridTextureRequest[] }
  | { ok: false; failure: GpuScene2dFailure };

/** Derives one closed producer descriptor from an already-admitted layer. */
export function deriveGpuHybridTextureStaticDescriptor(motion: MotionDocument, layer: MotionLayer): GpuHybridTextureStaticDescriptor | null {
  if (isGpuBrowserSurfaceLayer(layer.type)) {
    const assetRef = gpuSceneImageAssetRef(motion, layer);
    if (!assetRef || !dimensions(motion.width, motion.height)) return null;
    return freezeDescriptor({ schema: GPU_HYBRID_TEXTURE_STATIC_DESCRIPTOR_SCHEMA, layerId: layer.id, producer: "strict-data-only-html", assetRef, width: motion.width, height: motion.height });
  }
  if (!isGpuRestrictedShaderHybridLayer(layer)) return null;
  const assetRef = gpuRestrictedShaderAssetRef(motion, layer);
  const texture = gpuRestrictedShaderTextureDimensions(motion, layer);
  const shader = layer.shader;
  if (!assetRef || !texture || !shader) return null;
  return freezeDescriptor({
    schema: GPU_HYBRID_TEXTURE_STATIC_DESCRIPTOR_SCHEMA,
    layerId: layer.id,
    producer: "isolated-restricted-glsl",
    assetRef,
    width: texture.width,
    height: texture.height,
    restrictedShader: { schema: shader.schema, language: shader.language, seed: shader.seed, uniformNames: [...Object.keys(shader.uniforms ?? {})].sort(compareCodeUnits) }
  });
}

/** Mints a host snapshot only from one already-Core-derived closed descriptor. */
export function createGpuHybridTextureSourceSnapshot(input: GpuHybridTextureSourceSnapshotInput): GpuHybridTextureSourceSnapshot {
  const descriptorProblem = gpuHybridTextureStaticDescriptorProblem(input.descriptor);
  if (descriptorProblem) throw new Error(`GPU hybrid texture static descriptor ${descriptorProblem}.`);
  const base = {
    schema: GPU_HYBRID_TEXTURE_SOURCE_SNAPSHOT_SCHEMA,
    layerId: input.descriptor.layerId,
    producer: input.descriptor.producer,
    assetRef: input.descriptor.assetRef,
    width: input.descriptor.width,
    height: input.descriptor.height,
    staticDescriptorFingerprint: input.descriptor.descriptorFingerprint,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    sourceByteLength: input.sourceByteLength,
    captureContractSha256: input.captureContractSha256
  } as const;
  const snapshot = { ...base, snapshotFingerprint: canonicalJsonSha256(base) };
  const problem = snapshotProblem(snapshot, input.descriptor);
  if (problem) throw new Error(`GPU hybrid texture source snapshot ${problem}.`);
  return Object.freeze(snapshot);
}

/** Mints the fixed image-resource binding with the decoded RGBA texture identity. */
export function createGpuHybridTextureResourceBinding(input: GpuHybridTextureResourceBindingInput): GpuHybridTextureResourceBinding {
  const requestProblem = gpuHybridTextureRequestProblem(input.request);
  if (requestProblem) throw new Error(`GPU hybrid texture request ${requestProblem}.`);
  const binding: GpuHybridTextureResourceBinding = {
    schema: GPU_HYBRID_TEXTURE_RESOURCE_BINDING_SCHEMA,
    resourceId: input.resourceId,
    assetRef: input.request.assetRef,
    width: input.request.width,
    height: input.request.height,
    sha256: input.decodedRgbaSha256,
    layerId: input.request.layerId,
    producer: input.request.producer,
    atUs: input.request.atUs,
    staticDescriptorFingerprint: input.request.staticDescriptorFingerprint,
    sourceSnapshotSha256: input.request.sourceSnapshotSha256,
    sourceByteLength: input.request.sourceByteLength,
    captureContractSha256: input.request.captureContractSha256,
    snapshotFingerprint: input.request.snapshotFingerprint,
    decodedRgbaSha256: input.decodedRgbaSha256,
    requestFingerprint: input.request.requestFingerprint
  };
  const problem = gpuHybridTextureResourceBindingProblem(binding);
  if (problem) throw new Error(`GPU hybrid texture resource binding ${problem}.`);
  return Object.freeze(binding);
}

/** Plans every active hybrid texture at one exact root Motion microsecond. */
export function compileGpuHybridTextureRequests(input: GpuHybridTextureRequestInput): GpuHybridTextureRequestResult {
  if (!isUs(input.atUs) || input.atUs > timelineDurationUs(input.motion)) return requestFailure("gpu_invalid_time", "GPU hybrid texture requests require an in-range non-negative safe integer atUs.");
  const active = activeDescriptors(input.motion, input.atUs);
  if (!active.ok) return active;
  if (!mapHasOnly(input.snapshots, active.descriptors.map((descriptor) => descriptor.layerId))) return requestFailure("gpu_resource_refused", "GPU hybrid texture source snapshots must contain exactly the active governed layer ids.");
  const requests: GpuHybridTextureRequest[] = [];
  for (const descriptor of active.descriptors) {
    const snapshot = input.snapshots.get(descriptor.layerId);
    const problem = snapshotProblem(snapshot, descriptor);
    if (problem) return requestFailure("gpu_resource_refused", `GPU hybrid texture layer ${descriptor.layerId} immutable source snapshot ${problem}.`, descriptor.layerId);
    const base = {
      schema: GPU_HYBRID_TEXTURE_REQUEST_SCHEMA,
      layerId: descriptor.layerId,
      producer: descriptor.producer,
      assetRef: descriptor.assetRef,
      width: descriptor.width,
      height: descriptor.height,
      atUs: input.atUs,
      staticDescriptorFingerprint: descriptor.descriptorFingerprint,
      sourceSnapshotSha256: snapshot!.sourceSnapshotSha256,
      sourceByteLength: snapshot!.sourceByteLength,
      captureContractSha256: snapshot!.captureContractSha256,
      snapshotFingerprint: snapshot!.snapshotFingerprint
    } as const;
    requests.push(Object.freeze({ ...base, requestFingerprint: canonicalJsonSha256(base) }));
  }
  return { ok: true, requests: Object.freeze(requests) };
}

/** Rejects malformed or forged host snapshots before a request can be minted. */
export function gpuHybridTextureSourceSnapshotProblem(snapshot: GpuHybridTextureSourceSnapshot): string | null {
  return snapshotProblem(snapshot);
}

/** Recomputes the derived static descriptor to reject host-forged producer metadata. */
export function gpuHybridTextureStaticDescriptorProblem(descriptor: GpuHybridTextureStaticDescriptor): string | null {
  const hasRestricted = descriptor.producer === "isolated-restricted-glsl";
  if (!record(hasRestricted ? restrictedDescriptorKeys : htmlDescriptorKeys, descriptor)) return "contains unknown or missing fields";
  if (descriptor.schema !== GPU_HYBRID_TEXTURE_STATIC_DESCRIPTOR_SCHEMA || !producer(descriptor.producer) || !nonEmpty(descriptor.layerId) || !nonEmpty(descriptor.assetRef) || !dimensions(descriptor.width, descriptor.height)) return "has an invalid schema, producer, layerId, assetRef, or dimensions";
  if (hasRestricted) {
    const shader = descriptor.restrictedShader;
    if (!shader || shader.schema !== "shellx-motion/shader-plugin@1" || shader.language !== "glsl-es-100-expression" || !Number.isInteger(shader.seed) || shader.seed < 0 || shader.seed > 0xffff_ffff || !Array.isArray(shader.uniformNames) || shader.uniformNames.length > 16 || new Set(shader.uniformNames).size !== shader.uniformNames.length || shader.uniformNames.some((name) => !isSafeShaderUniformName(name))) return "has invalid restricted GLSL metadata";
  }
  if (!isSha256(descriptor.descriptorFingerprint) || descriptor.descriptorFingerprint !== canonicalJsonSha256(descriptorPayload(descriptor))) return "descriptor fingerprint is not canonical";
  return null;
}

/** Recomputes the request identity, including the exact root integer-us timestamp. */
export function gpuHybridTextureRequestProblem(request: GpuHybridTextureRequest): string | null {
  if (!record(requestKeys, request)) return "contains unknown or missing fields";
  if (request.schema !== GPU_HYBRID_TEXTURE_REQUEST_SCHEMA || !producer(request.producer) || !nonEmpty(request.layerId) || !nonEmpty(request.assetRef)) return "has an invalid schema, producer, layerId, or assetRef";
  if (!dimensions(request.width, request.height) || !isUs(request.atUs) || !isSha256(request.staticDescriptorFingerprint) || !isSha256(request.sourceSnapshotSha256) || !isSha256(request.captureContractSha256) || !isSha256(request.snapshotFingerprint)) return "has invalid dimensions, time, or identity hashes";
  if (!sourceByteLength(request.producer, request.sourceByteLength)) return "exceeds its producer source-byte limit";
  if (!isSha256(request.requestFingerprint) || request.requestFingerprint !== canonicalJsonSha256(requestPayload(request))) return "request fingerprint is not canonical";
  return null;
}

/** Recomputes the exact texture-binding contract before the compositor receives it. */
export function gpuHybridTextureResourceBindingProblem(binding: GpuHybridTextureResourceBinding): string | null {
  if (!record(bindingKeys, binding)) return "contains unknown or missing fields";
  if (binding.schema !== GPU_HYBRID_TEXTURE_RESOURCE_BINDING_SCHEMA || !producer(binding.producer) || !nonEmpty(binding.layerId) || !nonEmpty(binding.assetRef) || !nonEmpty(binding.resourceId)) return "has an invalid schema, producer, layerId, assetRef, or resourceId";
  if (!dimensions(binding.width, binding.height) || !isUs(binding.atUs) || !isSha256(binding.sha256) || !isSha256(binding.staticDescriptorFingerprint) || !isSha256(binding.sourceSnapshotSha256) || !isSha256(binding.captureContractSha256) || !isSha256(binding.snapshotFingerprint) || !isSha256(binding.decodedRgbaSha256) || !isSha256(binding.requestFingerprint)) return "has invalid dimensions, time, or identity hashes";
  if (!sourceByteLength(binding.producer, binding.sourceByteLength)) return "exceeds its producer source-byte limit";
  if (binding.sha256 !== binding.decodedRgbaSha256) return "texture sha256 must equal decoded RGBA identity";
  return null;
}

/** Validates a request and uploaded texture against the active Core-derived descriptor. */
export function gpuHybridTextureResourceBindingFailure(input: {
  motion: MotionDocument;
  layer: MotionLayer;
  atUs: number;
  request: GpuHybridTextureRequest | undefined;
  resource: GpuHybridTextureResourceBinding | undefined;
}): string | null {
  const descriptor = deriveGpuHybridTextureStaticDescriptor(input.motion, input.layer);
  if (!descriptor) return `GPU hybrid texture layer ${input.layer.id} has no admitted closed producer descriptor.`;
  const request = input.request;
  const requestProblem = request ? gpuHybridTextureRequestProblem(request) : "is missing";
  if (requestProblem) return `GPU hybrid texture layer ${input.layer.id} exact-time request ${requestProblem}.`;
  if (!sameRequestDescriptor(request!, descriptor, input.atUs)) return `GPU hybrid texture layer ${input.layer.id} request does not bind this exact descriptor and root playhead.`;
  const resource = input.resource;
  const resourceProblem = resource ? gpuHybridTextureResourceBindingProblem(resource) : "is missing";
  if (resourceProblem) return `GPU hybrid texture layer ${input.layer.id} texture binding ${resourceProblem}.`;
  if (!sameBindingRequest(resource!, request!)) return `GPU hybrid texture layer ${input.layer.id} texture binding does not match the active exact-time request.`;
  return null;
}

/** Fail-closed paired-map validation used only by the strict B2 frame path. */
export function gpuHybridTextureFrameResourcesProblem(input: {
  motion: MotionDocument;
  atUs: number;
  requests: ReadonlyMap<string, GpuHybridTextureRequest> | undefined;
  textures: ReadonlyMap<string, GpuHybridTextureResourceBinding> | undefined;
}): string | null {
  if (!input.requests || !input.textures) return "GPU strict hybrid texture lowering requires both request and texture maps.";
  const active = activeDescriptors(input.motion, input.atUs);
  if (!active.ok) return active.failure.message;
  const keys = active.descriptors.map((descriptor) => descriptor.layerId);
  if (!mapHasOnly(input.requests, keys) || !mapHasOnly(input.textures, keys)) return "GPU strict hybrid texture maps must contain exactly the active governed layer ids.";
  for (const descriptor of active.descriptors) {
    const layer = active.layers.get(descriptor.layerId);
    if (!layer) return "GPU strict hybrid texture active-layer topology changed.";
    const problem = gpuHybridTextureResourceBindingFailure({ motion: input.motion, layer, atUs: input.atUs, request: input.requests.get(descriptor.layerId), resource: input.textures.get(descriptor.layerId) });
    if (problem) return problem;
  }
  return null;
}

function activeDescriptors(motion: MotionDocument, atUs: number): { ok: true; descriptors: readonly GpuHybridTextureStaticDescriptor[]; layers: ReadonlyMap<string, MotionLayer> } | { ok: false; failure: GpuScene2dFailure } {
  const expanded = expandGpuSceneGroupsAtUs(motion, atUs);
  if (!expanded.ok) return expanded;
  const values: Array<{ descriptor: GpuHybridTextureStaticDescriptor; layer: MotionLayer }> = [];
  for (const entry of expanded.entries) {
    if (entry.kind !== "layer") continue;
    const descriptor = deriveGpuHybridTextureStaticDescriptor(motion, entry.sourceLayer);
    if (!descriptor) continue;
    values.push({ descriptor, layer: entry.sourceLayer });
  }
  if (values.length > GPU_MAX_HYBRID_TEXTURE_SOURCES) return { ok: false, failure: { code: "gpu_resource_refused", message: `GPU hybrid texture requests accept at most ${GPU_MAX_HYBRID_TEXTURE_SOURCES} active governed source.`, ...(values[1]?.layer.id ? { layerId: values[1].layer.id } : {}) } };
  values.sort((left, right) => compareCodeUnits(left.descriptor.layerId, right.descriptor.layerId));
  return { ok: true, descriptors: Object.freeze(values.map((value) => value.descriptor)), layers: new Map(values.map((value) => [value.descriptor.layerId, value.layer])) };
}

function freezeDescriptor(input: Omit<GpuHybridTextureStaticDescriptor, "descriptorFingerprint">): GpuHybridTextureStaticDescriptor {
  const base = input.restrictedShader ? { ...input, restrictedShader: Object.freeze({ ...input.restrictedShader, uniformNames: Object.freeze([...input.restrictedShader.uniformNames]) }) } : input;
  return Object.freeze({ ...base, descriptorFingerprint: canonicalJsonSha256(base) });
}
function snapshotProblem(snapshot: GpuHybridTextureSourceSnapshot | undefined, descriptor?: GpuHybridTextureStaticDescriptor): string | null {
  if (!snapshot) return "is missing";
  if (!record(snapshotKeys, snapshot)) return "contains unknown or missing fields";
  if (snapshot.schema !== GPU_HYBRID_TEXTURE_SOURCE_SNAPSHOT_SCHEMA || !producer(snapshot.producer) || !nonEmpty(snapshot.layerId) || !nonEmpty(snapshot.assetRef)) return "has an invalid schema, producer, layerId, or assetRef";
  if (!dimensions(snapshot.width, snapshot.height) || !isSha256(snapshot.staticDescriptorFingerprint) || !isSha256(snapshot.sourceSnapshotSha256) || !isSha256(snapshot.captureContractSha256)) return "has invalid dimensions or identity hashes";
  if (!sourceByteLength(snapshot.producer, snapshot.sourceByteLength)) return "exceeds its producer source-byte limit";
  if (!isSha256(snapshot.snapshotFingerprint) || snapshot.snapshotFingerprint !== canonicalJsonSha256(snapshotPayload(snapshot))) return "snapshot fingerprint is not canonical";
  if (descriptor && (snapshot.layerId !== descriptor.layerId || snapshot.producer !== descriptor.producer || snapshot.assetRef !== descriptor.assetRef || snapshot.width !== descriptor.width || snapshot.height !== descriptor.height || snapshot.staticDescriptorFingerprint !== descriptor.descriptorFingerprint)) return "does not bind the active Core-derived descriptor";
  return null;
}
function sameRequestDescriptor(request: GpuHybridTextureRequest, descriptor: GpuHybridTextureStaticDescriptor, atUs: number): boolean {
  return request.layerId === descriptor.layerId && request.producer === descriptor.producer && request.assetRef === descriptor.assetRef && request.width === descriptor.width && request.height === descriptor.height && request.atUs === atUs && request.staticDescriptorFingerprint === descriptor.descriptorFingerprint;
}
function sameBindingRequest(binding: GpuHybridTextureResourceBinding, request: GpuHybridTextureRequest): boolean {
  return binding.layerId === request.layerId && binding.producer === request.producer && binding.assetRef === request.assetRef && binding.width === request.width && binding.height === request.height && binding.atUs === request.atUs && binding.staticDescriptorFingerprint === request.staticDescriptorFingerprint && binding.sourceSnapshotSha256 === request.sourceSnapshotSha256 && binding.sourceByteLength === request.sourceByteLength && binding.captureContractSha256 === request.captureContractSha256 && binding.snapshotFingerprint === request.snapshotFingerprint && binding.requestFingerprint === request.requestFingerprint;
}
function descriptorPayload(descriptor: Omit<GpuHybridTextureStaticDescriptor, "descriptorFingerprint">): Omit<GpuHybridTextureStaticDescriptor, "descriptorFingerprint"> { const { descriptorFingerprint: _descriptorFingerprint, ...payload } = descriptor as GpuHybridTextureStaticDescriptor; return payload; }
function snapshotPayload(snapshot: Omit<GpuHybridTextureSourceSnapshot, "snapshotFingerprint">): Omit<GpuHybridTextureSourceSnapshot, "snapshotFingerprint"> { const { snapshotFingerprint: _snapshotFingerprint, ...payload } = snapshot as GpuHybridTextureSourceSnapshot; return payload; }
function requestPayload(request: Omit<GpuHybridTextureRequest, "requestFingerprint">): Omit<GpuHybridTextureRequest, "requestFingerprint"> { const { requestFingerprint: _requestFingerprint, ...payload } = request as GpuHybridTextureRequest; return payload; }
function timelineDurationUs(motion: MotionDocument): number { const value = Math.round(motion.durationMs * 1_000); return Number.isSafeInteger(value) && value >= 0 ? value : -1; }
function producer(value: unknown): value is GpuHybridTextureProducer { return value === "strict-data-only-html" || value === "isolated-restricted-glsl"; }
function dimensions(width: unknown, height: unknown): boolean { return typeof width === "number" && typeof height === "number" && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= GPU_MAX_FRAME_DIMENSION && height <= GPU_MAX_FRAME_DIMENSION && width * height <= GPU_MAX_FRAME_PIXELS; }
function sourceByteLength(kind: GpuHybridTextureProducer, value: unknown): boolean { const maximum = kind === "strict-data-only-html" ? GPU_MAX_STRICT_HTML_SOURCE_BYTES : GPU_MAX_RESTRICTED_GLSL_SOURCE_BYTES; return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum; }
function isUs(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function mapHasOnly<T>(map: ReadonlyMap<string, T>, keys: readonly string[]): boolean { return map.size === keys.length && keys.every((key) => map.has(key)); }
function record(keys: readonly string[], value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.keys(value as object).sort(compareCodeUnits).join("\u0000") === [...keys].sort(compareCodeUnits).join("\u0000"); }
const snapshotKeys = ["schema", "layerId", "producer", "assetRef", "width", "height", "staticDescriptorFingerprint", "sourceSnapshotSha256", "sourceByteLength", "captureContractSha256", "snapshotFingerprint"] as const;
const requestKeys = ["schema", "layerId", "producer", "assetRef", "width", "height", "atUs", "staticDescriptorFingerprint", "sourceSnapshotSha256", "sourceByteLength", "captureContractSha256", "snapshotFingerprint", "requestFingerprint"] as const;
const bindingKeys = ["schema", "resourceId", "assetRef", "width", "height", "sha256", "layerId", "producer", "atUs", "staticDescriptorFingerprint", "sourceSnapshotSha256", "sourceByteLength", "captureContractSha256", "snapshotFingerprint", "decodedRgbaSha256", "requestFingerprint"] as const;
const htmlDescriptorKeys = ["schema", "layerId", "producer", "assetRef", "width", "height", "descriptorFingerprint"] as const;
const restrictedDescriptorKeys = ["schema", "layerId", "producer", "assetRef", "width", "height", "restrictedShader", "descriptorFingerprint"] as const;
function requestFailure(code: GpuScene2dFailure["code"], message: string, layerId?: string): GpuHybridTextureRequestResult { return { ok: false, failure: { code, message, ...(layerId ? { layerId } : {}) } }; }
