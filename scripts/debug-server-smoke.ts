import assert from "node:assert/strict";
import { DEBUG_COMMAND_CONTRACTS } from "../packages/debug-api/src/index";
import { startMotionDebugServer } from "../packages/debug-server/src/index";

// Host gate for ShellX-owned agents: prove Motion's loopback MCP surface is callable.
const server = await startMotionDebugServer({ port: 0, defaultTier: "read_motion" });

try {
  const health = await getJsonObject(new URL("/health", server.url));
  assert(readObjectField(health, "ok", "health.ok") === true, "debug server health did not pass");
  assert(readObjectField(health, "contractCount", "health.contractCount") === DEBUG_COMMAND_CONTRACTS.length, "debug server health contract count mismatch");

  const initialize = await jsonRpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "shellx-motion-debug-server-smoke", version: "0.0.0" }
  }, "mcp-initialize");
  const initializeResult = readObject(readObjectField(initialize, "result", "initialize.result"), "initialize.result");
  assert(readObjectField(initializeResult, "protocolVersion", "initialize.result.protocolVersion") === "2025-06-18", "MCP initialize protocol mismatch");

  const toolsList = await jsonRpc("tools/list", {}, "mcp-tools");
  const toolsResult = readObject(readObjectField(toolsList, "result", "tools.result"), "tools.result");
  const tools = readArray(readObjectField(toolsResult, "tools", "tools.result.tools"));
  const toolNames = new Set(tools.map((tool) => readString(readObjectField(tool, "name", "tool.name"), "tool.name")));

  assert(toolNames.has("motion_actions_find"), "MCP tools/list missing motion_actions_find");
  assert(toolNames.has("motion_render_final"), "MCP tools/list missing motion_render_final");

  const findTool = tools.find((tool) => readObjectField(tool, "name", "tool.name") === "motion_actions_find");
  assert(findTool, "missing motion_actions_find tool");
  const findInputSchema = readObject(readObjectField(findTool, "inputSchema", "motion_actions_find.inputSchema"), "motion_actions_find.inputSchema");
  const findProperties = readObject(readObjectField(findInputSchema, "properties", "motion_actions_find.inputSchema.properties"), "motion_actions_find.inputSchema.properties");
  assert(Reflect.has(findProperties, "args"), "motion_actions_find MCP input schema missing args");
  assert(Reflect.has(findProperties, "requestedTier"), "motion_actions_find MCP input schema missing requestedTier");

  const findCall = await jsonRpc("tools/call", {
    name: "motion_actions_find",
    arguments: {
      requestedTier: "read_motion",
      args: { request: "show render queue" }
    }
  }, "mcp-call-find");
  const findCallResult = readObject(readObjectField(findCall, "result", "findCall.result"), "findCall.result");
  assert(readObjectField(findCallResult, "isError", "findCall.result.isError") === false, "motion_actions_find MCP call failed");
  const findStructured = readObject(readObjectField(findCallResult, "structuredContent", "findCall.result.structuredContent"), "findCall.result.structuredContent");
  assert(readObjectField(findStructured, "command", "findStructured.command") === "motion.actions.find", "motion_actions_find returned wrong command");
  const findOutput = readObject(readObjectField(findStructured, "result", "findStructured.result"), "findStructured.result");
  assert(readObjectField(findOutput, "id", "findStructured.result.id") === "motion.render.queue", "motion_actions_find did not resolve render queue");

  const deniedCall = await jsonRpc("tools/call", {
    name: "motion_render_final",
    arguments: {
      requestedTier: "read_motion",
      args: { packageRoot: "fixtures/packages/lower-third" }
    }
  }, "mcp-call-denied");
  const deniedResult = readObject(readObjectField(deniedCall, "result", "deniedCall.result"), "deniedCall.result");
  assert(readObjectField(deniedResult, "isError", "deniedCall.result.isError") === true, "motion_render_final should be denied at read tier");
  const deniedStructured = readObject(readObjectField(deniedResult, "structuredContent", "deniedCall.result.structuredContent"), "deniedCall.result.structuredContent");
  const deniedError = readObject(readObjectField(deniedStructured, "error", "deniedStructured.error"), "deniedStructured.error");
  assert(readObjectField(deniedError, "code", "deniedStructured.error.code") === "permission_denied", "motion_render_final denial did not report permission_denied");

  const wsDiscovery = await webSocketJsonRpc("rpc.discover", {}, "ws-discover");
  const wsDiscoveryResult = readObject(readObjectField(wsDiscovery, "result", "wsDiscovery.result"), "wsDiscovery.result");
  assert(readObjectField(wsDiscoveryResult, "transport", "wsDiscovery.result.transport") === "websocket-json-rpc", "WebSocket discovery reported wrong transport");
  const wsMethods = readArray(readObjectField(wsDiscoveryResult, "methods", "wsDiscovery.result.methods"));
  assert(wsMethods.includes("motion.debug.dispatch"), "WebSocket discovery missing motion.debug.dispatch");
  assert(wsMethods.includes("tools/call"), "WebSocket discovery missing tools/call");

  const wsDispatch = await webSocketJsonRpc("motion.debug.dispatch", {
    command: "motion.actions.find",
    requestedTier: "read_motion",
    args: { request: "show render queue" }
  }, "ws-dispatch-find");
  const wsDispatchResult = readObject(readObjectField(wsDispatch, "result", "wsDispatch.result"), "wsDispatch.result");
  assert(readObjectField(wsDispatchResult, "command", "wsDispatch.result.command") === "motion.actions.find", "WebSocket debug dispatch returned wrong command");
  const wsDispatchOutput = readObject(readObjectField(wsDispatchResult, "result", "wsDispatch.result.result"), "wsDispatch.result.result");
  assert(readObjectField(wsDispatchOutput, "id", "wsDispatch.result.result.id") === "motion.render.queue", "WebSocket debug dispatch did not resolve render queue");

  const wsMcpCall = await webSocketJsonRpc("tools/call", {
    name: "motion_actions_find",
    arguments: {
      requestedTier: "read_motion",
      args: { request: "show render queue" }
    }
  }, "ws-mcp-call-find");
  const wsMcpCallResult = readObject(readObjectField(wsMcpCall, "result", "wsMcpCall.result"), "wsMcpCall.result");
  assert(readObjectField(wsMcpCallResult, "isError", "wsMcpCall.result.isError") === false, "WebSocket MCP tools/call failed");
  const wsMcpStructured = readObject(readObjectField(wsMcpCallResult, "structuredContent", "wsMcpCall.result.structuredContent"), "wsMcpCall.result.structuredContent");
  assert(readObjectField(wsMcpStructured, "command", "wsMcpStructured.command") === "motion.actions.find", "WebSocket MCP call returned wrong command");

  console.log(JSON.stringify({
    ok: true,
    command: "debug-server:smoke",
    url: server.url.toString(),
    transports: ["http", "json-rpc", "mcp", "websocket-json-rpc"],
    contractCount: DEBUG_COMMAND_CONTRACTS.length,
    mcp: {
      initialized: true,
      toolCount: tools.length,
      called: "motion_actions_find",
      denied: "motion_render_final"
    },
    webSocket: {
      discovered: true,
      dispatched: "motion.actions.find",
      called: "motion_actions_find"
    }
  }, null, 2));
} finally {
  await server.close();
}

async function getJsonObject(url: URL): Promise<object> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${server.capabilityToken}` }
  });
  assert(response.ok, `${url.pathname} returned HTTP ${response.status}`);
  return readObject(await response.json(), url.pathname);
}

async function jsonRpc(method: string, params: object, id: string): Promise<object> {
  const response = await fetch(new URL("/rpc", server.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.capabilityToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })
  });
  assert(response.ok, `JSON-RPC ${method} returned HTTP ${response.status}`);
  const body = readObject(await response.json(), `JSON-RPC ${method} body`);
  assert(readObjectField(body, "jsonrpc", `${method}.jsonrpc`) === "2.0", `JSON-RPC ${method} response version mismatch`);
  assert(readObjectField(body, "id", `${method}.id`) === id, `JSON-RPC ${method} response id mismatch`);
  assert(!Reflect.has(body, "error"), `JSON-RPC ${method} returned an error: ${JSON.stringify(body)}`);
  return body;
}

async function webSocketJsonRpc(method: string, params: object, id: string): Promise<object> {
  const socket = new WebSocket(
    new URL("/ws", server.url).toString().replace(/^http/, "ws"),
    ["shellx-motion-debug-v1", `shellx-motion-token.${server.capabilityToken}`]
  );
  try {
    await waitForSocketOpen(socket);
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    }));
    const body = readObject(await readSocketJson(socket), `WebSocket JSON-RPC ${method} body`);
    assert(readObjectField(body, "jsonrpc", `${method}.jsonrpc`) === "2.0", `WebSocket JSON-RPC ${method} response version mismatch`);
    assert(readObjectField(body, "id", `${method}.id`) === id, `WebSocket JSON-RPC ${method} response id mismatch`);
    assert(!Reflect.has(body, "error"), `WebSocket JSON-RPC ${method} returned an error: ${JSON.stringify(body)}`);
    return body;
  } finally {
    socket.close();
  }
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket open.")), 1000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket failed to open."));
    }, { once: true });
  });
}

function readSocketJson(socket: WebSocket): Promise<object> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message.")), 1000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      try {
        resolve(readObject(JSON.parse(String(event.data)), "WebSocket message"));
      } catch (error) {
        reject(error);
      }
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket errored while waiting for a message."));
    }, { once: true });
  });
}

function readObject(value: unknown, label: string): object {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value;
}

function readObjectField(value: unknown, key: string, label: string): unknown {
  const record = readObject(value, label);
  return Reflect.get(record, key);
}

function readArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "expected array");
  return value;
}

function readString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `missing ${label}`);
  return value;
}
