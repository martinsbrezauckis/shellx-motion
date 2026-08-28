import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export const GPU_PAGE_SCENE3D_GLTF_PBR_READBACK_SCHEMA = "shellx-motion/gpu-page-scene3d-gltf-pbr-readback@1" as const;

export interface GpuPageScene3dGltfPbrReadbackInput {
  readonly schema: typeof GPU_PAGE_SCENE3D_GLTF_PBR_READBACK_SCHEMA;
  readonly staticFingerprint: string;
  readonly frameFingerprint: string;
}
export interface GpuPageScene3dGltfPbrReadbackEvidence {
  readonly schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-readback-evidence@1";
  readonly bytesPerRow: number;
  readonly mappedByteLength: number;
  readonly transientReadbackBufferBytes: number;
  readonly peakGpuResourceBytes: number;
  readonly mapOperations: 1;
  readonly mappedBufferUnmapped: true;
  readonly mappedBufferDestroyed: true;
}
export type GpuPageScene3dGltfPbrReadbackOutput =
  | { readonly ok: true; readonly width: 1280; readonly height: 720; readonly bytesPerRow: number; readonly paddedBase64: string; readonly evidence: GpuPageScene3dGltfPbrReadbackEvidence }
  | { readonly ok: false; readonly failure: GpuRuntimeFailure };

/** Copies the fixed PBR target once into one preflighted MAP_READ buffer and destroys it before return. */
export async function readWebGpuPageSessionScene3dGltfPbrFrame(input: GpuPageScene3dGltfPbrReadbackInput): Promise<GpuPageScene3dGltfPbrReadbackOutput> {
  const WIDTH = 1280, HEIGHT = 720, BYTES_PER_ROW = WIDTH * 4, BYTE_LENGTH = BYTES_PER_ROW * HEIGHT, MAX_BYTE_LENGTH = 4 * 1024 * 1024;
  type Texture = unknown;
  type ReadbackBuffer = { mapAsync(mode: number): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void; destroy?(): void };
  type Device = { createBuffer(value: unknown): ReadbackBuffer; createCommandEncoder(): { copyTextureToBuffer(source: { texture: Texture }, destination: { buffer: ReadbackBuffer; bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number; depthOrArrayLayers: number }): void; finish(): unknown }; queue: { submit(commands: readonly unknown[]): void; onSubmittedWorkDone?(): Promise<void> } };
  type Resources = { staticFingerprint: string; frameFingerprint: string; target: Texture; metrics: { gpuResourceBytes: number; readbackBufferBytes: number; peakGpuResourceBytes: number } };
  type State = { device?: Device; limits?: { maxTextureDimension2D: number; maxBufferSize: number }; gltfPbrResources?: Resources; lost?: boolean };
  const browserGlobal = globalThis as unknown as { GPUBufferUsage?: Record<string, number>; GPUMapMode?: Record<string, number>; btoa?(value: string): string; __shellxMotionGpuSessionV1?: State };
  const state = browserGlobal.__shellxMotionGpuSessionV1, resources = state?.gltfPbrResources, limits = state?.limits, usage = browserGlobal.GPUBufferUsage, mapMode = browserGlobal.GPUMapMode;
  if (!state?.device || !resources || !usage || !mapMode) return fail("gpu_device_unavailable", "The fixed glTF PBR readback has no prepared page resources.");
  if (!validInput(input, resources) || state.lost) return fail(state.lost ? "gpu_device_lost" : "gpu_resource_refused", "The fixed glTF PBR readback identity does not match its prepared resources.");
  if (BYTE_LENGTH > MAX_BYTE_LENGTH || !limits || limits.maxTextureDimension2D < WIDTH || limits.maxTextureDimension2D < HEIGHT || limits.maxBufferSize < BYTE_LENGTH || resources.metrics.readbackBufferBytes !== BYTE_LENGTH || resources.metrics.peakGpuResourceBytes !== resources.metrics.gpuResourceBytes + BYTE_LENGTH || resources.metrics.peakGpuResourceBytes > 64 * 1024 * 1024 || typeof usage.COPY_DST !== "number" || typeof usage.MAP_READ !== "number" || typeof mapMode.READ !== "number") return fail("gpu_limits_exceeded", "The fixed glTF PBR readback exceeds its admitted row, byte, or device limit.");
  let buffer: ReadbackBuffer | undefined, mapped = false, cleanupError = false, result: GpuPageScene3dGltfPbrReadbackOutput | undefined;
  try {
    buffer = state.device.createBuffer({ size: BYTE_LENGTH, usage: usage.COPY_DST | usage.MAP_READ });
    const encoder = state.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: resources.target }, { buffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT }, { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 });
    state.device.queue.submit([encoder.finish()]); if (state.device.queue.onSubmittedWorkDone) await state.device.queue.onSubmittedWorkDone();
    await buffer.mapAsync(mapMode.READ); mapped = true;
    const paddedBase64 = base64(new Uint8Array(buffer.getMappedRange()));
    result = { ok: true, width: WIDTH, height: HEIGHT, bytesPerRow: BYTES_PER_ROW, paddedBase64, evidence: { schema: "shellx-motion/gpu-page-scene3d-gltf-pbr-readback-evidence@1", bytesPerRow: BYTES_PER_ROW, mappedByteLength: BYTE_LENGTH, transientReadbackBufferBytes: BYTE_LENGTH, peakGpuResourceBytes: resources.metrics.peakGpuResourceBytes, mapOperations: 1, mappedBufferUnmapped: true, mappedBufferDestroyed: true } };
  } catch { result = fail("gpu_render_failed", "The fixed glTF PBR frame could not complete its bounded readback."); }
  finally {
    try { if (mapped) buffer?.unmap(); } catch { cleanupError = true; }
    try { buffer?.destroy?.(); } catch { cleanupError = true; }
  }
  return cleanupError ? fail("gpu_render_failed", "The fixed glTF PBR mapped readback buffer did not terminally release.") : result!;

  function fail(code: GpuRuntimeFailure["code"], message: string): GpuPageScene3dGltfPbrReadbackOutput { return { ok: false, failure: { code, message } }; }
  function validInput(value: unknown, current: Resources): value is GpuPageScene3dGltfPbrReadbackInput { return !!value && typeof value === "object" && Object.keys(value).sort().join(",") === "frameFingerprint,schema,staticFingerprint" && (value as GpuPageScene3dGltfPbrReadbackInput).schema === "shellx-motion/gpu-page-scene3d-gltf-pbr-readback@1" && hash((value as GpuPageScene3dGltfPbrReadbackInput).staticFingerprint) && hash((value as GpuPageScene3dGltfPbrReadbackInput).frameFingerprint) && (value as GpuPageScene3dGltfPbrReadbackInput).staticFingerprint === current.staticFingerprint && (value as GpuPageScene3dGltfPbrReadbackInput).frameFingerprint === current.frameFingerprint; }
  function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
  function base64(bytes: Uint8Array): string { if (bytes.byteLength !== BYTE_LENGTH || typeof browserGlobal.btoa !== "function") throw new Error("readback base64"); let binary = ""; for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!); return browserGlobal.btoa(binary); }
}
