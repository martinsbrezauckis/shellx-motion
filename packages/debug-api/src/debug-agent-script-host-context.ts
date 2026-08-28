import type { AgentScriptProvenanceAuthority } from "@shellx-motion/core";
import type { ServerObservedMcpSession } from "./server-observed-mcp-session.js";

/** Opaque host-only approved-agent-entry authority; never sourced from a wire request. */
export interface DebugAgentScriptHostContext {
  agentScriptAuthority?: AgentScriptProvenanceAuthority;
  /**
   * Process-local authorization fact minted by the debug server after an initialized MCP WebSocket
   * handshake. This is intentionally separate from receipt attribution: a caller-selected
   * `tools/call` method or modern MCP metadata cannot create it.
   */
  observedMcpAgentSession?: ServerObservedMcpSession;
}
