import { canonicalJson, type GpuFramePlan } from "@shellx-motion/core";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { GpuRuntimeFailure, InternalGpuFramePlan } from "./gpu-runtime-types";

export const GPU_PAGE_FRAME_TRANSPORT_SCHEMA = "shellx-motion/gpu-page-frame-transport@1" as const;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_GZIP_BYTES = 8 * 1024 * 1024;

export interface GpuPageFrameTransport {
  schema: typeof GPU_PAGE_FRAME_TRANSPORT_SCHEMA;
  codec: "gzip-json";
  gzipBase64: string;
  uncompressedBytes: number;
  sha256: string;
}

export type GpuPageFrameTransportInstallOutput =
  | { ok: true }
  | { ok: false; failure: GpuRuntimeFailure };

/** Compress an already-admitted immutable frame plan for the isolated page boundary. */
export function createGpuPageFrameTransport(plan: InternalGpuFramePlan | GpuFramePlan): GpuPageFrameTransport {
  const json = Buffer.from(canonicalJson(plan), "utf8");
  if (json.byteLength < 1 || json.byteLength > MAX_JSON_BYTES) throw new Error("GPU page frame JSON exceeds its fixed transport budget.");
  const gzip = gzipSync(json, { level: 1 });
  if (gzip.byteLength < 1 || gzip.byteLength > MAX_GZIP_BYTES) throw new Error("GPU page frame gzip exceeds its fixed transport budget.");
  return Object.freeze({
    schema: GPU_PAGE_FRAME_TRANSPORT_SCHEMA,
    codec: "gzip-json",
    gzipBase64: gzip.toString("base64"),
    uncompressedBytes: json.byteLength,
    sha256: createHash("sha256").update(json).digest("hex")
  });
}

/** Install the fixed in-page decoder used by the provenance-bound render function. */
export function installGpuPageFrameTransport(): GpuPageFrameTransportInstallOutput {
  const schema="shellx-motion/gpu-page-frame-transport@1",maxJsonBytes=32*1024*1024,maxGzipBytes=8*1024*1024,sha256Pattern=/^[a-f0-9]{64}$/;
  const fail = (message: string): GpuPageFrameTransportInstallOutput => ({ ok: false, failure: { code: "gpu_render_failed", message } });
  const browserGlobal = globalThis as unknown as {
    atob?(value: string): string;
    btoa?(value: string): string;
    crypto?: { subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
    DecompressionStream?: new (format: "gzip") => TransformStream<Uint8Array, Uint8Array>;
    Response?: typeof Response;
    TextDecoder?: typeof TextDecoder;
    __shellxMotionDecodeGpuFrameTransportV1?: (input: unknown) => Promise<unknown>;
  };
  const subtle=browserGlobal.crypto?.subtle,DecompressionStreamCtor=browserGlobal.DecompressionStream,ResponseCtor=browserGlobal.Response,TextDecoderCtor=browserGlobal.TextDecoder;
  if (browserGlobal.__shellxMotionDecodeGpuFrameTransportV1 || typeof browserGlobal.atob !== "function" || typeof browserGlobal.btoa !== "function" || !subtle || !DecompressionStreamCtor || !ResponseCtor || !TextDecoderCtor) return fail("The GPU page frame decoder is unavailable.");
  const decoder = async (input: unknown): Promise<unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("GPU page frame transport is malformed.");
    const value = input as Record<string, unknown>;
    if (value.schema !== schema || value.codec !== "gzip-json" || typeof value.gzipBase64 !== "string" || value.gzipBase64.length < 4 || value.gzipBase64.length > Math.ceil(maxGzipBytes / 3) * 4 || !Number.isSafeInteger(value.uncompressedBytes) || (value.uncompressedBytes as number) < 1 || (value.uncompressedBytes as number) > maxJsonBytes || typeof value.sha256 !== "string" || !sha256Pattern.test(value.sha256)) throw new Error("GPU page frame transport metadata is invalid.");
    const binary = browserGlobal.atob!(value.gzipBase64); if (binary.length < 1 || binary.length > maxGzipBytes || browserGlobal.btoa!(binary) !== value.gzipBase64) throw new Error("GPU page frame gzip is not canonical bounded base64.");
    const gzip = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) gzip[index] = binary.charCodeAt(index);
    const stream = new ResponseCtor(gzip).body?.pipeThrough(new DecompressionStreamCtor("gzip")); if (!stream) throw new Error("GPU page frame gzip stream is unavailable.");
    const json = new Uint8Array(await new ResponseCtor(stream).arrayBuffer()); if (json.byteLength !== value.uncompressedBytes) throw new Error("GPU page frame JSON length does not match its declaration.");
    const digest = Array.from(new Uint8Array(await subtle.digest("SHA-256", json))).map((byte) => byte.toString(16).padStart(2, "0")).join(""); if (digest !== value.sha256) throw new Error("GPU page frame JSON hash does not match its declaration.");
    return JSON.parse(new TextDecoderCtor("utf-8", { fatal: true }).decode(json));
  };
  Object.defineProperty(browserGlobal, "__shellxMotionDecodeGpuFrameTransportV1", { value: decoder, configurable: false, enumerable: false, writable: false });
  return { ok: true };
}
