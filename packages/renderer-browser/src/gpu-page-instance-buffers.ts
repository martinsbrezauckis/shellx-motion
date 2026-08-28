import type { GpuRuntimeFailure } from "./gpu-runtime-types";

export interface GpuPageInstanceBufferMetrics {
  readonly pointRaster: "gpu-native-instanced";
  readonly positionEvaluation: "core-cpu-exact-time";
  readonly computeField: "not-used";
  readonly immutablePointBufferSlots: number;
  readonly immutablePointBufferBytes: number;
  readonly immutablePointMirrorBytes: number;
  readonly immutablePointBufferHighWaterSlots: number;
  readonly immutablePointBufferHighWaterBytes: number;
  readonly adapterPointInstanceLimit: number;
}

export type GpuPageInstanceBufferInstallOutput =
  | { ok: true }
  | { ok: false; failure: GpuRuntimeFailure };

/**
 * Owns a small, exact-value cache for static instanced point buffers. The CPU
 * mirror prevents a non-cryptographic cache key from ever changing pixels on a
 * collision; both mirror and GPU storage have one fixed session budget.
 */
export async function installWebGpuPageSessionInstanceBuffers(): Promise<GpuPageInstanceBufferInstallOutput> {
  type BufferFacade = { destroy?(): void };
  type Device = { createBuffer(value: unknown): BufferFacade; queue: { writeBuffer(buffer: BufferFacade, offset: number, data: Float32Array): void } };
  type Entry = { buffer: BufferFacade; values: Float32Array; bytes: number };
  const fail = (message: string): GpuPageInstanceBufferInstallOutput => ({ ok: false, failure: { code: "gpu_render_failed", message } });
  const MAX_BYTES = 32 * 1024 * 1024;
  const MAX_SLOTS = 16;
  const POINT_BYTES = 32;
  const browserGlobal = globalThis as unknown as { GPUBufferUsage?: Record<string, number>; __shellxMotionGpuSessionV1?: unknown };
  const state = browserGlobal.__shellxMotionGpuSessionV1 as {
    device?: Device;
    limits?: { maxBufferSize?: number };
    instanceBuffers?: unknown;
  } | undefined;
  const usage = browserGlobal.GPUBufferUsage;
  if (!state?.device || !usage || typeof usage.VERTEX !== "number" || typeof usage.COPY_DST !== "number") return fail("The persistent GPU page session cannot install static instance buffers.");
  const maxBufferSize = state.limits?.maxBufferSize;
  if (typeof maxBufferSize !== "number" || !Number.isSafeInteger(maxBufferSize) || maxBufferSize < POINT_BYTES) return fail("The persistent GPU device did not expose a usable point-instance buffer limit.");
  const fixedMaxBufferSize: number = maxBufferSize;
  if (state.instanceBuffers) return { ok: true };
  const entries: Entry[] = [];
  let bytes = 0;
  let highWaterSlots = 0;
  let highWaterBytes = 0;
  const adapterPointInstanceLimit = Math.min(65_536, Math.floor(fixedMaxBufferSize / POINT_BYTES));
  const equals = (left: Float32Array, right: Float32Array): boolean => {
    if (left.length !== right.length) return false;
    const leftWords = new Uint32Array(left.buffer, left.byteOffset, left.length);
    const rightWords = new Uint32Array(right.buffer, right.byteOffset, right.length);
    for (let index = 0; index < leftWords.length; index += 1) if (leftWords[index] !== rightWords[index]) return false;
    return true;
  };
  const acquire = (values: Float32Array): BufferFacade => {
    if (!(values instanceof Float32Array) || values.byteLength < POINT_BYTES || values.byteLength % POINT_BYTES !== 0) throw new Error("GPU static point instances must use complete 32-byte records.");
    if (values.byteLength > fixedMaxBufferSize || values.length / 8 > adapterPointInstanceLimit) throw new Error("GPU static point instances exceed the explicit adapter buffer limit.");
    const existing = entries.find((entry) => equals(entry.values, values));
    if (existing) return existing.buffer;
    if (entries.length >= MAX_SLOTS || bytes + values.byteLength > MAX_BYTES) throw new Error("GPU static point cache exceeded its fixed 32 MiB or 16-buffer session budget.");
    const buffer = state.device!.createBuffer({ size: values.byteLength, usage: usage.VERTEX | usage.COPY_DST });
    state.device!.queue.writeBuffer(buffer, 0, values);
    entries.push({ buffer, values: values.slice(), bytes: values.byteLength });
    bytes += values.byteLength;
    highWaterSlots = Math.max(highWaterSlots, entries.length);
    highWaterBytes = Math.max(highWaterBytes, bytes);
    return buffer;
  };
  const snapshot = (): GpuPageInstanceBufferMetrics => Object.freeze({
    pointRaster: "gpu-native-instanced",
    positionEvaluation: "core-cpu-exact-time",
    computeField: "not-used",
    immutablePointBufferSlots: entries.length,
    immutablePointBufferBytes: bytes,
    immutablePointMirrorBytes: bytes,
    immutablePointBufferHighWaterSlots: highWaterSlots,
    immutablePointBufferHighWaterBytes: highWaterBytes,
    adapterPointInstanceLimit
  });
  state.instanceBuffers = {
    acquire,
    snapshot,
    destroy() { for (const entry of entries) entry.buffer.destroy?.(); entries.length = 0; bytes = 0; }
  };
  return { ok: true };
}
