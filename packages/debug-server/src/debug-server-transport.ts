/** Fixed public Debug-server transport vocabulary; deliberately excludes local effect management. */
export interface MotionDebugServerTransportManifest {
  auth: {
    http: "authorization-bearer";
    webSocket: "authenticated-subprotocol";
    tokenEnv: "SHELLX_MOTION_DEBUG_TOKEN";
  };
  rest: { health: "/health"; contracts: "/debug/contracts"; dispatch: "/debug"; sdk: "/sdk"; };
  workbench: {
    ui: "/workbench";
    connections: "/workbench/connections";
    bootstrap: "/workbench/bootstrap";
    artifactSession: "/workbench/artifact-session";
    artifact: "/workbench/artifact";
    poster: "/workbench/poster";
    updateState: "/workbench/update-state";
    selectPath: "/workbench/select-path";
    auth: "one-use-launch-or-session-token-entry";
  };
  jsonRpc: { endpoint: "/rpc"; methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"]; };
  mcp: { endpoint: "/rpc"; methods: ["server/discover", "initialize", "tools/list", "tools/call"]; toolNamePattern: "motion_<debug_command_with_dots_as_underscores>"; };
  webSocket: { endpoint: "/ws"; transport: "websocket-json-rpc"; methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"]; };
}

export const DEBUG_SERVER_TRANSPORT_MANIFEST: MotionDebugServerTransportManifest = {
  auth: { http: "authorization-bearer", webSocket: "authenticated-subprotocol", tokenEnv: "SHELLX_MOTION_DEBUG_TOKEN" },
  rest: { health: "/health", contracts: "/debug/contracts", dispatch: "/debug", sdk: "/sdk" },
  workbench: {
    ui: "/workbench", connections: "/workbench/connections", bootstrap: "/workbench/bootstrap", artifactSession: "/workbench/artifact-session", artifact: "/workbench/artifact",
    poster: "/workbench/poster", updateState: "/workbench/update-state", selectPath: "/workbench/select-path", auth: "one-use-launch-or-session-token-entry"
  },
  jsonRpc: { endpoint: "/rpc", methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"] },
  mcp: { endpoint: "/rpc", methods: ["server/discover", "initialize", "tools/list", "tools/call"], toolNamePattern: "motion_<debug_command_with_dots_as_underscores>" },
  webSocket: { endpoint: "/ws", transport: "websocket-json-rpc", methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"] }
};
