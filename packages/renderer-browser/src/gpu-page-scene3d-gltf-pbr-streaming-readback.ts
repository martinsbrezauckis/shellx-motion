import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export const GPU_PAGE_SCENE3D_GLTF_PBR_STREAMING_READBACK_SCHEMA = "shellx-motion/gpu-page-scene3d-gltf-pbr-streaming-readback@1" as const;

export interface GpuPageScene3dGltfPbrStreamingReadbackInput {
  readonly schema: typeof GPU_PAGE_SCENE3D_GLTF_PBR_STREAMING_READBACK_SCHEMA;
  readonly staticFingerprint: string;
  readonly frameFingerprint: string;
}

export interface GpuPageScene3dGltfPbrStreamingReadbackEvidence {
  readonly schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-streaming-readback-evidence@1";
  readonly bytesPerRow: number;
  readonly mappedByteLength: number;
  readonly reservedReadbackBufferBytes: number;
  readonly readbackBufferAllocations: 1;
  readonly mapOperations: number;
  readonly mappedBufferUnmapped: true;
  readonly retainedReadbackBuffer: true;
  readonly peakGpuResourceBytes: number;
}

export interface GpuPageScene3dGltfPbrStreamingReadbackReleaseEvidence {
  readonly schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-streaming-readback-release@1";
  readonly hadReservedBuffer: boolean;
  readonly destroyedReservedBuffer: boolean;
  readonly remainingReadbackBufferBytes: 0;
  readonly mapOperations: number;
}

type Output =
  | { readonly ok: true; readonly width: 1280; readonly height: 720; readonly bytesPerRow: 5120; readonly paddedBase64: string; readonly evidence: GpuPageScene3dGltfPbrStreamingReadbackEvidence }
  | { readonly ok: false; readonly failure: GpuRuntimeFailure };

/** Reserve one fixed readback buffer during preparation; per-frame calls only copy/map/unmap it. */
export function reserveWebGpuPageSessionScene3dGltfPbrStreamingReadback(input: GpuPageScene3dGltfPbrStreamingReadbackInput): { readonly ok: true } | { readonly ok: false; readonly failure: GpuRuntimeFailure } {
  const BYTE_LENGTH = 1280 * 720 * 4;
  type BufferFacade = { destroy?(): void };
  type Device = { createBuffer(value: unknown): BufferFacade };
  type Resources = { staticFingerprint: string; frameFingerprint: string; metrics: { readbackBufferBytes: number; gpuResourceBytes: number; peakGpuResourceBytes: number } };
  type State = { device?: Device; limits?: { maxBufferSize: number }; gltfPbrResources?: Resources; gltfPbrStreamingReadback?: { staticFingerprint: string; frameFingerprint: string; buffer: BufferFacade; mapOperations: number } };
  const browserGlobal = globalThis as unknown as { GPUBufferUsage?: Record<string, number>; __shellxMotionGpuSessionV1?: State };
  const state = browserGlobal.__shellxMotionGpuSessionV1, resources = state?.gltfPbrResources, usage = browserGlobal.GPUBufferUsage;
  if (!state?.device || !resources || !usage || !valid(input, resources)) return fail("gpu_resource_refused", "The fixed glTF PBR streaming readback has no matching prepared resources.");
  if (resources.metrics.readbackBufferBytes !== BYTE_LENGTH || resources.metrics.peakGpuResourceBytes !== resources.metrics.gpuResourceBytes + BYTE_LENGTH
    || !state.limits || state.limits.maxBufferSize < BYTE_LENGTH || typeof usage.COPY_DST !== "number" || typeof usage.MAP_READ !== "number") {
    return fail("gpu_limits_exceeded", "The fixed glTF PBR streaming readback exceeds its admitted device or byte ceiling.");
  }
  const prior = state.gltfPbrStreamingReadback;
  if (prior) return prior.staticFingerprint === input.staticFingerprint && prior.frameFingerprint === input.frameFingerprint
    ? { ok: true }
    : fail("gpu_resource_refused", "The fixed glTF PBR page permits one streaming readback identity.");
  try {
    state.gltfPbrStreamingReadback = { staticFingerprint: input.staticFingerprint, frameFingerprint: input.frameFingerprint, buffer: state.device.createBuffer({ size: BYTE_LENGTH, usage: usage.COPY_DST | usage.MAP_READ }), mapOperations: 0 };
    return { ok: true };
  } catch { return fail("gpu_render_failed", "The fixed glTF PBR streaming readback buffer could not be reserved."); }

  function fail(code: GpuRuntimeFailure["code"], message: string): { readonly ok: false; readonly failure: GpuRuntimeFailure } { return { ok: false, failure: { code, message } }; }
  function valid(value: unknown, current: Resources): value is GpuPageScene3dGltfPbrStreamingReadbackInput { return !!value && typeof value === "object" && Object.keys(value).sort().join(",") === "frameFingerprint,schema,staticFingerprint" && (value as GpuPageScene3dGltfPbrStreamingReadbackInput).schema === "shellx-motion/gpu-page-scene3d-gltf-pbr-streaming-readback@1" && hash((value as GpuPageScene3dGltfPbrStreamingReadbackInput).staticFingerprint) && hash((value as GpuPageScene3dGltfPbrStreamingReadbackInput).frameFingerprint) && (value as GpuPageScene3dGltfPbrStreamingReadbackInput).staticFingerprint === current.staticFingerprint && (value as GpuPageScene3dGltfPbrStreamingReadbackInput).frameFingerprint === current.frameFingerprint; }
  function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
}

/** Reads one rendered frame without allocating or retaining a raw host-frame cache. */
export async function readWebGpuPageSessionScene3dGltfPbrStreamingFrame(input: GpuPageScene3dGltfPbrStreamingReadbackInput): Promise<Output> {
  const WIDTH = 1280, HEIGHT = 720, BYTES_PER_ROW = WIDTH * 4, BYTE_LENGTH = BYTES_PER_ROW * HEIGHT;
  type Texture = unknown;
  type ReadbackBuffer = { mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void };
  type Device = { createCommandEncoder(): { copyTextureToBuffer(source: { texture: Texture }, destination: { buffer: ReadbackBuffer; bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number; depthOrArrayLayers: number }): void; finish(): unknown }; queue: { submit(commands: readonly unknown[]): void; onSubmittedWorkDone?(): Promise<void> } };
  type Resources = { staticFingerprint: string; frameFingerprint: string; target: Texture; metrics: { gpuResourceBytes: number; peakGpuResourceBytes: number } };
  type State = { device?: Device; lost?: boolean; gltfPbrResources?: Resources; gltfPbrStreamingReadback?: { staticFingerprint: string; frameFingerprint: string; buffer: ReadbackBuffer; mapOperations: number } };
  const browserGlobal = globalThis as unknown as { GPUMapMode?: Record<string, number>; btoa?(value: string): string; __shellxMotionGpuSessionV1?: State };
  const state = browserGlobal.__shellxMotionGpuSessionV1, resources = state?.gltfPbrResources, reservation = state?.gltfPbrStreamingReadback, mapMode = browserGlobal.GPUMapMode;
  if (!state?.device || !resources || !reservation || !mapMode || !valid(input, resources)
    || reservation.staticFingerprint !== input.staticFingerprint || reservation.frameFingerprint !== input.frameFingerprint) {
    return fail("gpu_resource_refused", "The fixed glTF PBR streaming readback identity is not reserved.");
  }
  if (state.lost || typeof mapMode.READ !== "number") return fail(state.lost ? "gpu_device_lost" : "gpu_limits_exceeded", "The fixed glTF PBR streaming readback cannot map its reserved buffer.");
  let mapped = false;
  try {
    const encoder = state.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: resources.target }, { buffer: reservation.buffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
    state.device.queue.submit([encoder.finish()]); if (state.device.queue.onSubmittedWorkDone) await state.device.queue.onSubmittedWorkDone();
    await reservation.buffer.mapAsync(mapMode.READ); mapped = true;
    const paddedBase64 = base64(new Uint8Array(reservation.buffer.getMappedRange()));
    reservation.buffer.unmap(); mapped = false; reservation.mapOperations += 1;
    return { ok: true, width: WIDTH, height: HEIGHT, bytesPerRow: 5120 as const, paddedBase64, evidence: {
      schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-streaming-readback-evidence@1", bytesPerRow: BYTES_PER_ROW, mappedByteLength: BYTE_LENGTH,
      reservedReadbackBufferBytes: BYTE_LENGTH, readbackBufferAllocations: 1, mapOperations: reservation.mapOperations,
      mappedBufferUnmapped: true, retainedReadbackBuffer: true, peakGpuResourceBytes: resources.metrics.peakGpuResourceBytes,
    } };
  } catch { return fail("gpu_render_failed", "The fixed glTF PBR frame could not complete its reusable readback."); }
  finally { if (mapped) try { reservation.buffer.unmap(); } catch { /* terminal release still owns destruction */ } }

  function fail(code: GpuRuntimeFailure["code"], message: string): Output { return { ok: false, failure: { code, message } }; }
  function base64(bytes: Uint8Array): string { if (bytes.byteLength !== BYTE_LENGTH || typeof browserGlobal.btoa !== "function") throw new Error("readback base64"); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return browserGlobal.btoa(binary); }
  function valid(value: unknown, current: Resources): value is GpuPageScene3dGltfPbrStreamingReadbackInput { return !!value && typeof value === "object" && Object.keys(value).sort().join(",") === "frameFingerprint,schema,staticFingerprint" && (value as GpuPageScene3dGltfPbrStreamingReadbackInput).schema === "shellx-motion/gpu-page-scene3d-gltf-pbr-streaming-readback@1" && hash((value as GpuPageScene3dGltfPbrStreamingReadbackInput).staticFingerprint) && hash((value as GpuPageScene3dGltfPbrStreamingReadbackInput).frameFingerprint) && (value as GpuPageScene3dGltfPbrStreamingReadbackInput).staticFingerprint === current.staticFingerprint && (value as GpuPageScene3dGltfPbrStreamingReadbackInput).frameFingerprint === current.frameFingerprint; }
  function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
}

/** Terminally destroys the one pre-reserved buffer. This is required on success, refusal and cancellation. */
export function releaseWebGpuPageSessionScene3dGltfPbrStreamingReadback(): GpuPageScene3dGltfPbrStreamingReadbackReleaseEvidence {
  type Reservation = { buffer: { destroy?(): void }; mapOperations: number };
  const state = (globalThis as unknown as { __shellxMotionGpuSessionV1?: { gltfPbrStreamingReadback?: Reservation } }).__shellxMotionGpuSessionV1;
  const reservation = state?.gltfPbrStreamingReadback;
  if (!reservation) return { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-streaming-readback-release@1", hadReservedBuffer: false, destroyedReservedBuffer: false, remainingReadbackBufferBytes: 0, mapOperations: 0 };
  let destroyed = true; try { reservation.buffer.destroy?.(); } catch { destroyed = false; }
  delete state!.gltfPbrStreamingReadback;
  return { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-streaming-readback-release@1", hadReservedBuffer: true, destroyedReservedBuffer: destroyed, remainingReadbackBufferBytes: 0, mapOperations: reservation.mapOperations };
}
