import type { MotionDebugContext, ReceiptActor } from "@shellx-motion/debug-api";

type MotionPermissionTier = MotionDebugContext["tier"];

/** Stamps receipt attribution from server-observed transport facts; never use it for ownership. */
export function inferredServerActor(input: {
  wire: "http" | "ws";
  protocol: "mcp" | "raw";
  grantedTier: MotionPermissionTier;
  sessionId: string;
  clientInfo?: string;
}): ReceiptActor {
  if (input.protocol === "mcp") {
    return {
      kind: "agent",
      label: input.clientInfo ?? "mcp client",
      transport: "mcp",
      ...(input.clientInfo ? { clientInfo: input.clientInfo } : {}),
      sessionId: input.sessionId,
      grantedTier: input.grantedTier
    };
  }
  return {
    kind: "unknown",
    label: input.wire === "ws" ? "ws client" : "http client",
    transport: input.wire,
    sessionId: input.sessionId,
    grantedTier: input.grantedTier
  };
}

/** Returns only a host-authenticated or connection-minted job owner principal. */
export function authenticatedJobOwnerPrincipal(
  configuredPrincipal: string | undefined,
  connectionPrincipal?: string
): string | undefined {
  return configuredPrincipal?.trim() || connectionPrincipal;
}
