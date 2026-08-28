/**
 * A non-serializable, server-minted capability for the one approved-agent-entry authoring route.
 *
 * Receipt actor fields are attribution only: a transport can observe that a request used MCP, but
 * the method name is not an authorization event. The debug server creates one of these only after
 * a successful MCP initialize exchange on a live WebSocket connection. A wire request cannot
 * construct a WeakSet member by sending an object with matching fields.
 */
declare const serverObservedMcpSessionBrand: unique symbol;

export interface ServerObservedMcpSession {
  readonly [serverObservedMcpSessionBrand]: "server-observed-mcp-session";
}

const serverObservedMcpSessions = new WeakSet<object>();

/** Server transport use only; never accept its result from a Debug/MCP/SDK/CLI request. */
export function establishServerObservedMcpSession(): ServerObservedMcpSession {
  const session = Object.freeze({});
  serverObservedMcpSessions.add(session);
  return session as ServerObservedMcpSession;
}

/** True only for a process-local capability minted by {@link establishServerObservedMcpSession}. */
export function isServerObservedMcpSession(value: unknown): value is ServerObservedMcpSession {
  return typeof value === "object" && value !== null && serverObservedMcpSessions.has(value);
}
