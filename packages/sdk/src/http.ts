/** Browser-safe HTTP transport for the authenticated ShellX Motion SDK endpoint. */
import { MOTION_SDK_SCHEMA, type MotionSdkOperation, type MotionSdkTransport, type MotionSdkTransportRequest, type MotionSdkTransportResponse } from "./types";

export interface MotionSdkHttpTransportOptions {
  baseUrl: string | URL;
  capabilityToken: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowNonLoopback?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;

export function createMotionSdkHttpTransport(options: MotionSdkHttpTransportOptions): MotionSdkTransport {
  const baseUrl = normalizeBaseUrl(options.baseUrl, options.allowNonLoopback === true);
  if (!options.capabilityToken.trim()) throw new TypeError("Motion SDK HTTP capabilityToken is required.");
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new TypeError("Motion SDK HTTP transport requires fetch.");
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const maxResponseBytes = positiveInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
  return {
    async execute<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>): Promise<MotionSdkTransportResponse<K>> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`Motion SDK HTTP request timed out after ${timeoutMs}ms.`)), timeoutMs);
      try {
        const response = await fetcher(new URL("/sdk", baseUrl), {
          method: "POST",
          headers: { authorization: `Bearer ${options.capabilityToken}`, "content-type": "application/json" },
          body: JSON.stringify(request),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal
        });
        const parsed = await readBoundedJson(response, maxResponseBytes);
        if (sdkEnvelopeLike(parsed)) return parsed as MotionSdkTransportResponse<K>;
        const error = record(parsed)?.error;
        const errorRecord = record(error);
        return failed(request, typeof errorRecord?.code === "string" ? errorRecord.code : `http_${response.status}`,
          typeof errorRecord?.message === "string" ? errorRecord.message : `Motion SDK HTTP request failed with status ${response.status}.`, response.status >= 500);
      } catch (error) {
        return failed(request, controller.signal.aborted ? "request_timeout" : "http_transport_failed",
          error instanceof Error ? error.message : String(error), controller.signal.aborted || error instanceof TypeError);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Motion SDK HTTP response exceeds ${maxBytes} bytes.`);
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Motion SDK HTTP response exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes).trim();
  return text ? JSON.parse(text) : {};
}

function normalizeBaseUrl(value: string | URL, allowNonLoopback: boolean): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Motion SDK HTTP baseUrl must use HTTP(S).");
  if (url.username || url.password || url.search || url.hash) throw new TypeError("Motion SDK HTTP baseUrl must not contain credentials, query, or fragment.");
  if (url.pathname !== "/") throw new TypeError("Motion SDK HTTP baseUrl must not contain a path.");
  if (!isLoopback(url.hostname)) {
    if (!allowNonLoopback) throw new TypeError("Motion SDK HTTP transport refuses non-loopback hosts unless allowNonLoopback is explicit.");
    if (url.protocol !== "https:") throw new TypeError("Motion SDK HTTP transport requires HTTPS for non-loopback hosts.");
  }
  return url;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function failed<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>, code: string, message: string, retryable: boolean): MotionSdkTransportResponse<K> {
  return { schema: MOTION_SDK_SCHEMA, operation: request.operation, requestId: request.requestId, cacheKey: request.cacheKey,
    ok: false, error: { code, message, retryable }, warnings: [] };
}

function sdkEnvelopeLike(value: unknown): boolean {
  const envelope = record(value);
  return Boolean(envelope && envelope.schema === MOTION_SDK_SCHEMA && typeof envelope.operation === "string"
    && typeof envelope.requestId === "string" && typeof envelope.cacheKey === "string" && typeof envelope.ok === "boolean");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`Motion SDK HTTP ${label} must be a positive integer.`);
  return value;
}
