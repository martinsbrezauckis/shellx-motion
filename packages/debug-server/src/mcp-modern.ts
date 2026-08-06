/** Modern (2026-07-28) MCP request metadata and HTTP-header validation. */
import type { IncomingHttpHeaders } from "node:http";
import { jsonRpcError, type JsonRpcId, type JsonRpcResponseBody } from "./transport-refusals.js";

export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [MCP_MODERN_PROTOCOL_VERSION, MCP_LEGACY_PROTOCOL_VERSION] as const;

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

export interface ModernMcpRequestContext {
  protocolVersion: typeof MCP_MODERN_PROTOCOL_VERSION;
  clientInfo?: string;
}

export type ModernMcpHttpInspection =
  | { mode: "legacy" }
  | { mode: "modern"; context: ModernMcpRequestContext }
  | { mode: "error"; status: 400; body: JsonRpcResponseBody };

export function inspectModernMcpHttpRequest(
  payload: { id?: unknown; method?: unknown; params?: unknown },
  headers: IncomingHttpHeaders
): ModernMcpHttpInspection {
  const method = typeof payload.method === "string" ? payload.method : undefined;
  const params = record(payload.params);
  const meta = record(params?._meta);
  const bodyVersion = meta?.[PROTOCOL_VERSION_KEY];
  const headerVersion = header(headers, "mcp-protocol-version");
  const headerMethod = header(headers, "mcp-method");
  const headerName = header(headers, "mcp-name");
  const modernSignal = method === "server/discover"
    || bodyVersion !== undefined
    || headerVersion !== undefined
    || headerMethod !== undefined
    || headerName !== undefined;
  if (!modernSignal) return { mode: "legacy" };

  const id = jsonRpcId(payload.id);
  if (typeof payload.id !== "string" && typeof payload.id !== "number") {
    return { mode: "error", status: 400, body: jsonRpcError(id, -32600, "Modern MCP requests require a string or number id.") };
  }
  if (typeof bodyVersion !== "string" || !record(meta?.[CLIENT_CAPABILITIES_KEY])) {
    return {
      mode: "error",
      status: 400,
      body: jsonRpcError(id, -32602, "Modern MCP requests require protocolVersion and clientCapabilities in params._meta.")
    };
  }
  if (bodyVersion !== MCP_MODERN_PROTOCOL_VERSION) {
    return {
      mode: "error",
      status: 400,
      body: {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32022,
          message: "Unsupported protocol version",
          data: { supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS], requested: bodyVersion }
        }
      }
    };
  }
  const headerError = requiredHeaderMismatch({
    headerVersion,
    bodyVersion,
    headerMethod,
    bodyMethod: method,
    headerName,
    bodyName: method === "tools/call" && typeof params?.name === "string" ? params.name : undefined
  });
  if (headerError) {
    return { mode: "error", status: 400, body: jsonRpcError(id, -32020, headerError) };
  }

  const clientInfo = clientInfoLabel(meta?.[CLIENT_INFO_KEY]);
  return {
    mode: "modern",
    context: {
      protocolVersion: MCP_MODERN_PROTOCOL_VERSION,
      ...(clientInfo ? { clientInfo } : {})
    }
  };
}

export function modernMcpResult(result: Record<string, unknown>, serverVersion: string): Record<string, unknown> {
  const existingMeta = record(result._meta) ?? {};
  return {
    ...result,
    resultType: "complete",
    _meta: {
      ...existingMeta,
      "io.modelcontextprotocol/serverInfo": {
        name: "shellx-motion-debug-server",
        version: serverVersion
      }
    }
  };
}

export function modernMcpHttpStatus(body: JsonRpcResponseBody, modern: boolean): number {
  return modern && body.error?.code === -32601 ? 404 : 200;
}

function requiredHeaderMismatch(input: {
  headerVersion?: string;
  bodyVersion: string;
  headerMethod?: string;
  bodyMethod?: string;
  headerName?: string;
  bodyName?: string;
}): string | null {
  if (input.headerVersion !== input.bodyVersion) {
    return input.headerVersion === undefined
      ? "Header mismatch: MCP-Protocol-Version header is required."
      : "Header mismatch: MCP-Protocol-Version does not match params._meta protocolVersion.";
  }
  if (!input.bodyMethod || input.headerMethod !== input.bodyMethod) {
    return input.headerMethod === undefined
      ? "Header mismatch: Mcp-Method header is required."
      : "Header mismatch: Mcp-Method does not match the JSON-RPC method.";
  }
  if (input.bodyMethod === "tools/call") {
    const decoded = decodeHeaderValue(input.headerName);
    if (!input.bodyName || decoded !== input.bodyName) {
      return input.headerName === undefined
        ? "Header mismatch: Mcp-Name header is required for tools/call."
        : "Header mismatch: Mcp-Name does not match params.name.";
    }
  }
  return null;
}

function decodeHeaderValue(value: string | undefined): string | undefined {
  if (!value?.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice("=?base64?".length, -2);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  return Buffer.from(encoded, "base64").toString("utf8");
}

function clientInfoLabel(value: unknown): string | undefined {
  const info = record(value);
  const name = typeof info?.name === "string" && info.name.trim() ? info.name.trim() : undefined;
  if (!name) return undefined;
  const version = typeof info?.version === "string" && info.version.trim() ? info.version.trim() : undefined;
  return version ? `${name}/${version}` : name;
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function jsonRpcId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" ? value : null;
}
