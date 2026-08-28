/** Server-observed MCP connection state for the sensitive active-script authoring route. */
import { establishServerObservedMcpSession, type ServerObservedMcpSession } from "@shellx-motion/debug-api";
import { MCP_LEGACY_PROTOCOL_VERSION } from "./mcp-modern.js";

export interface McpWebSocketConnectionState {
  /** Stable id for this connection, used as the receipt actor `sessionId`. */
  sessionId: string;
  /** Opaque server-minted job principal. Reconnects get a new principal unless the host configured one. */
  jobOwnerPrincipal: string;
  /** MCP client identity ("name/version") captured from this connection's initialize handshake. */
  clientInfo?: string;
  /** One legacy handshake only; its opaque authorization fact remains connection-local. */
  legacyMcpInitializeAttempted?: boolean;
  observedMcpAgentSession?: ServerObservedMcpSession;
}

/** Observe one legacy initialize without turning caller-owned metadata into an authorization claim. */
export function observeMcpInitialize(connection: McpWebSocketConnectionState, params: Record<string, unknown>): void {
  const firstLegacyInitialize = !connection.legacyMcpInitializeAttempted;
  connection.legacyMcpInitializeAttempted = true;
  const clientInfo = mcpClientInfoLabel(params.clientInfo);
  if (clientInfo) connection.clientInfo = clientInfo;
  if (firstLegacyInitialize && establishesObservedMcpAuthoringSession(params)) {
    connection.observedMcpAgentSession = establishServerObservedMcpSession();
  }
}

/** A closed socket must not retain an authorization fact in a long-lived server. */
export function clearObservedMcpConnection(connection: McpWebSocketConnectionState): void {
  delete connection.observedMcpAgentSession;
  delete connection.clientInfo;
  delete connection.legacyMcpInitializeAttempted;
}

function mcpClientInfoLabel(value: unknown): string | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
  if (!name) return undefined;
  const version = typeof record.version === "string" && record.version.trim() ? record.version.trim() : undefined;
  return version ? `${name}/${version}` : name;
}

function establishesObservedMcpAuthoringSession(params: Record<string, unknown>): boolean {
  const clientInfo = objectRecord(params.clientInfo);
  // Only a complete first supported handshake may mint; ordinary legacy initialize stays compatible.
  return params.protocolVersion === MCP_LEGACY_PROTOCOL_VERSION
    && objectRecord(params.capabilities) !== null
    && typeof clientInfo?.name === "string" && clientInfo.name.trim().length > 0
    && typeof clientInfo.version === "string" && clientInfo.version.trim().length > 0;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
