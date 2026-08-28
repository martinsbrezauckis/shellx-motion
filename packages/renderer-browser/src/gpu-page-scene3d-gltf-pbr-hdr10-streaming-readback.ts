import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export const GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_STREAMING_READBACK_SCHEMA = "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-streaming-readback@1" as const;
export interface GpuPageScene3dGltfPbrHdr10StreamingReadbackInput { readonly schema: typeof GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_STREAMING_READBACK_SCHEMA; readonly staticFingerprint: string; readonly sdrStaticFingerprint: string; readonly frameFingerprint: string; }
export interface GpuPageScene3dGltfPbrHdr10StreamingReadbackEvidence { readonly schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-streaming-readback-evidence@1"; readonly staticFingerprint: string; readonly sdrStaticFingerprint: string; readonly frameFingerprint: string; readonly bytesPerRow: 10240; readonly mappedByteLength: 7_372_800; readonly reservedReadbackBufferBytes: 7_372_800; readonly readbackBufferAllocations: 1; readonly mapOperations: number; readonly rawRgba16floatSha256: string; readonly mappedBufferUnmapped: true; readonly retainedReadbackBuffer: true; readonly frameGpuBytes: number; readonly peakGpuBytes: number; }
export interface GpuPageScene3dGltfPbrHdr10StreamingReadbackReleaseEvidence { readonly schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-streaming-readback-release@1"; readonly hadReservedBuffer: boolean; readonly destroyedReservedBuffer: boolean; readonly remainingReadbackBufferBytes: 0; readonly mapOperations: number; }
type Output = { readonly ok: true; readonly width: 1280; readonly height: 720; readonly bytesPerRow: 10240; readonly paddedBase64: string; readonly evidence: GpuPageScene3dGltfPbrHdr10StreamingReadbackEvidence } | { readonly ok: false; readonly failure: GpuRuntimeFailure };

/** Reserves one exact HDR float readback buffer; later frames only copy/map/unmap it. */
export function reserveWebGpuPageSessionScene3dGltfPbrHdr10StreamingReadback(input: GpuPageScene3dGltfPbrHdr10StreamingReadbackInput): { readonly ok: true } | { readonly ok: false; readonly failure: GpuRuntimeFailure } {
  const BYTE_LENGTH = 7_372_800;
  type Buffer = { destroy?(): void };
  type Resources = { staticFingerprint: string; sdrStaticFingerprint: string; frameFingerprint: string; metrics: { readbackBytes: number; frameGpuBytes: number; peakGpuBytes: number } };
  type State = { device?: { createBuffer(value: unknown): Buffer }; limits?: { maxBufferSize: number }; resources?: Resources; hdr10StreamingReadback?: { staticFingerprint: string; sdrStaticFingerprint: string; frameFingerprint: string; buffer: Buffer; mapOperations: number } };
  const global = globalThis as unknown as { GPUBufferUsage?: Record<string, number>; __shellxMotionGpuHdr10PbrSessionV1?: State }, state = global.__shellxMotionGpuHdr10PbrSessionV1, resources = state?.resources, usage = global.GPUBufferUsage;
  if (!state?.device || !resources || !usage || !sameInput(input, resources)) return failure("gpu_resource_refused", "The HDR10 PBR streaming readback has no matching prepared resources.");
  if (resources.metrics.readbackBytes !== BYTE_LENGTH || resources.metrics.peakGpuBytes !== resources.metrics.frameGpuBytes + BYTE_LENGTH || !state.limits || state.limits.maxBufferSize < BYTE_LENGTH || typeof usage.COPY_DST !== "number" || typeof usage.MAP_READ !== "number") return failure("gpu_limits_exceeded", "The HDR10 PBR streaming readback exceeds its admitted device or byte ceiling.");
  const prior = state.hdr10StreamingReadback;
  if (prior) return prior.staticFingerprint === input.staticFingerprint && prior.sdrStaticFingerprint === input.sdrStaticFingerprint && prior.frameFingerprint === input.frameFingerprint ? { ok: true } : failure("gpu_resource_refused", "The HDR10 PBR page permits one streaming readback identity.");
  try { state.hdr10StreamingReadback = { ...input, buffer: state.device.createBuffer({ size: BYTE_LENGTH, usage: usage.COPY_DST | usage.MAP_READ }), mapOperations: 0 }; return { ok: true }; }
  catch { return failure("gpu_render_failed", "The HDR10 PBR streaming readback buffer could not be reserved."); }
}

/** Reads one frame through the pre-reserved buffer without a raw-frame cache. */
export async function readWebGpuPageSessionScene3dGltfPbrHdr10StreamingFrame(input: GpuPageScene3dGltfPbrHdr10StreamingReadbackInput): Promise<Output> {
  const WIDTH = 1280, HEIGHT = 720, ROW = 10_240, BYTES = 7_372_800;
  type Buffer = { mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void };
  type Resources = { staticFingerprint: string; sdrStaticFingerprint: string; frameFingerprint: string; target: unknown; metrics: { frameGpuBytes: number; peakGpuBytes: number } };
  type State = { device?: { createCommandEncoder(): { copyTextureToBuffer(source: { texture: unknown }, destination: { buffer: Buffer; bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number; depthOrArrayLayers: number }): void; finish(): unknown }; queue: { submit(commands: readonly unknown[]): void; onSubmittedWorkDone?(): Promise<void> } }; resources?: Resources; lost?: boolean; hdr10StreamingReadback?: { staticFingerprint: string; sdrStaticFingerprint: string; frameFingerprint: string; buffer: Buffer; mapOperations: number } };
  const global = globalThis as unknown as { GPUMapMode?: Record<string, number>; btoa?(value: string): string; crypto?: { subtle?: { digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer> } }; __shellxMotionGpuHdr10PbrSessionV1?: State }, state = global.__shellxMotionGpuHdr10PbrSessionV1, resources = state?.resources, reserved = state?.hdr10StreamingReadback, mapMode = global.GPUMapMode;
  if (!state?.device || !resources || !reserved || !mapMode || !global.crypto?.subtle || !sameInput(input, resources) || !sameReservation(input, reserved)) return fail("gpu_resource_refused", "The HDR10 PBR streaming readback identity is not reserved.");
  if (state.lost || typeof mapMode.READ !== "number") return fail(state.lost ? "gpu_device_lost" : "gpu_limits_exceeded", "The HDR10 PBR streaming readback cannot map its reserved buffer.");
  let mapped = false;
  try {
    const encoder = state.device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture: resources.target }, { buffer: reserved.buffer, bytesPerRow: ROW, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 }); state.device.queue.submit([encoder.finish()]); if (state.device.queue.onSubmittedWorkDone) await state.device.queue.onSubmittedWorkDone();
    await reserved.buffer.mapAsync(mapMode.READ); mapped = true;
    const bytes = new Uint8Array(reserved.buffer.getMappedRange()); if (bytes.byteLength !== BYTES) throw new Error("readback length");
    const [paddedBase64, digest] = await Promise.all([base64(bytes, global.btoa), global.crypto.subtle.digest("SHA-256", bytes)]);
    reserved.buffer.unmap(); mapped = false; reserved.mapOperations += 1;
    return { ok: true, width: WIDTH, height: HEIGHT, bytesPerRow: ROW, paddedBase64, evidence: { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-streaming-readback-evidence@1", staticFingerprint: input.staticFingerprint, sdrStaticFingerprint: input.sdrStaticFingerprint, frameFingerprint: input.frameFingerprint, bytesPerRow: ROW, mappedByteLength: BYTES, reservedReadbackBufferBytes: BYTES, readbackBufferAllocations: 1, mapOperations: reserved.mapOperations, rawRgba16floatSha256: hex(digest), mappedBufferUnmapped: true, retainedReadbackBuffer: true, frameGpuBytes: resources.metrics.frameGpuBytes, peakGpuBytes: resources.metrics.peakGpuBytes } };
  } catch { return fail("gpu_render_failed", "The HDR10 PBR frame could not complete reusable readback."); }
  finally { if (mapped) try { reserved.buffer.unmap(); } catch { /* terminal release destroys the reservation */ } }
  function fail(code: GpuRuntimeFailure["code"], message: string): Output { return { ok: false, failure: { code, message } }; }
}

/** Terminally releases the one retained HDR readback buffer. */
export function releaseWebGpuPageSessionScene3dGltfPbrHdr10StreamingReadback(): GpuPageScene3dGltfPbrHdr10StreamingReadbackReleaseEvidence {
  type Reservation = { buffer: { destroy?(): void }; mapOperations: number };
  const state = (globalThis as unknown as { __shellxMotionGpuHdr10PbrSessionV1?: { hdr10StreamingReadback?: Reservation } }).__shellxMotionGpuHdr10PbrSessionV1, reserved = state?.hdr10StreamingReadback;
  if (!reserved) return { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-streaming-readback-release@1", hadReservedBuffer: false, destroyedReservedBuffer: false, remainingReadbackBufferBytes: 0, mapOperations: 0 };
  let destroyed = true; try { reserved.buffer.destroy?.(); } catch { destroyed = false; } delete state!.hdr10StreamingReadback;
  return { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-hdr10-streaming-readback-release@1", hadReservedBuffer: true, destroyedReservedBuffer: destroyed, remainingReadbackBufferBytes: 0, mapOperations: reserved.mapOperations };
}

function sameInput(value: unknown, resources: { staticFingerprint: string; sdrStaticFingerprint: string; frameFingerprint: string }): value is GpuPageScene3dGltfPbrHdr10StreamingReadbackInput { return !!value && typeof value === "object" && Object.keys(value).sort().join(",") === "frameFingerprint,schema,sdrStaticFingerprint,staticFingerprint" && (value as GpuPageScene3dGltfPbrHdr10StreamingReadbackInput).schema === GPU_PAGE_SCENE3D_GLTF_PBR_HDR10_STREAMING_READBACK_SCHEMA && ["staticFingerprint", "sdrStaticFingerprint", "frameFingerprint"].every((key) => hash((value as Record<string, unknown>)[key])) && (value as GpuPageScene3dGltfPbrHdr10StreamingReadbackInput).staticFingerprint === resources.staticFingerprint && (value as GpuPageScene3dGltfPbrHdr10StreamingReadbackInput).sdrStaticFingerprint === resources.sdrStaticFingerprint && (value as GpuPageScene3dGltfPbrHdr10StreamingReadbackInput).frameFingerprint === resources.frameFingerprint; }
function failure(code: GpuRuntimeFailure["code"], message: string): { readonly ok: false; readonly failure: GpuRuntimeFailure } { return { ok: false, failure: { code, message } }; }
function sameReservation(input: GpuPageScene3dGltfPbrHdr10StreamingReadbackInput, value: { staticFingerprint: string; sdrStaticFingerprint: string; frameFingerprint: string }): boolean { return input.staticFingerprint === value.staticFingerprint && input.sdrStaticFingerprint === value.sdrStaticFingerprint && input.frameFingerprint === value.frameFingerprint; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function hex(value: ArrayBuffer): string { return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function base64(bytes: Uint8Array, encode: ((value: string) => string) | undefined): string { if (typeof encode !== "function") throw new Error("base64 unavailable"); let binary = ""; for (let offset = 0; offset < bytes.length; offset += 65_535) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 65_535))); return encode(binary); }
