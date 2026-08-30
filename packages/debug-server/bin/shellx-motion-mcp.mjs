#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const accessRoot = process.env.SHELLX_MOTION_ACCESS_ROOT || join(homedir(), ".shellx-motion");
const discoveryFile = join(accessRoot, "mcp-bridge.discovery.json");
const MCP_BRIDGE_CREDENTIAL_HEADER = "x-shellx-motion-mcp-bridge-credential";
const MCP_BRIDGE_CREDENTIAL_PROTOCOL_PREFIX = "shellx-motion-mcp-bridge.";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
const COORDINATOR_TOOL_NAMES = new Set([
  "motion_job_submit",
  "motion_connector_submit",
  "motion_job_get",
  "motion_job_list",
  "motion_job_events",
  "motion_job_cancel",
  "motion_job_retry"
]);
let connection;

for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    writeResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Motion MCP received invalid JSON." } });
    continue;
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    writeResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Motion MCP requires a JSON-RPC object." } });
    continue;
  }
  const notification = !("id" in request);
  try {
    const body = await sendMcpRequest(request, notification);
    if (!notification && body) writeResponse(body);
  } catch {
    if (!notification) {
      writeResponse({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: {
          code: -32000,
          message: "ShellX Motion is not running. Start Motion, then retry this tool call."
        }
      });
    }
  }
}

connection?.close();

/**
 * Coordinator tools need a server-minted connection owner. Keep just that bounded surface on one
 * WebSocket for the stdio process; ordinary MCP calls retain the stateless HTTP transport and its
 * modern-header compatibility.
 */
async function sendMcpRequest(request, notification) {
  if (!isCoordinatorTool(request)) return await sendHttpRequest(request, notification);
  const active = await connectedBridge();
  if (notification) {
    active.socket.send(JSON.stringify(request));
    return null;
  }
  return active.request(request);
}

async function sendHttpRequest(request, notification) {
  const discovery = await readLiveDiscovery();
  const response = await fetch(`http://127.0.0.1:${discovery.port}/rpc`, {
    method: "POST",
    headers: mcpHeaders(request, discovery.credential),
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json().catch(() => null);
  if (notification) return null;
  if (body && typeof body === "object") return body;
  return {
    jsonrpc: "2.0",
    id: request.id ?? null,
    error: { code: -32000, message: `Motion MCP returned an unreadable response (${response.status}).` }
  };
}

async function connectedBridge() {
  if (connection?.open) return connection;
  const discovery = await readLiveDiscovery();

  const next = await openBridgeConnection(discovery.port, discovery.credential);
  connection = next;
  return next;
}

function openBridgeConnection(port, credential) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, [
      "shellx-motion-debug-v1",
      `${MCP_BRIDGE_CREDENTIAL_PROTOCOL_PREFIX}${credential}`
    ]);
    const pending = new Map();
    let open = false;
    let settled = false;
    const timeout = setTimeout(() => {
      socket.close();
      fail();
    }, 30_000);
    const fail = () => {
      clearTimeout(timeout);
      const error = new Error("Motion MCP WebSocket disconnected.");
      for (const resolvePending of pending.values()) resolvePending({ error });
      pending.clear();
      if (connection?.socket === socket) connection = undefined;
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const bridge = {
      socket,
      get open() {
        return open && socket.readyState === WebSocket.OPEN;
      },
      request(request) {
        return new Promise((resolveRequest, rejectRequest) => {
          const key = responseKey(request.id);
          if (!key || pending.has(key)) {
            rejectRequest(new Error("Motion MCP requests require a unique string or number id."));
            return;
          }
          pending.set(key, ({ body, error }) => error ? rejectRequest(error) : resolveRequest(body));
          try {
            socket.send(JSON.stringify(request));
          } catch (error) {
            pending.delete(key);
            rejectRequest(error);
          }
        });
      },
      close() {
        socket.close();
      }
    };
    socket.addEventListener("open", () => {
      open = true;
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve(bridge);
      }
    }, { once: true });
    socket.addEventListener("message", (event) => {
      let body;
      try {
        body = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return;
      const resolvePending = pending.get(responseKey(body.id));
      if (!resolvePending) return;
      pending.delete(responseKey(body.id));
      resolvePending({ body });
    });
    socket.addEventListener("close", fail, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
}

function responseKey(value) {
  return typeof value === "string" ? `string:${value}`
    : typeof value === "number" && Number.isFinite(value) ? `number:${value}`
      : null;
}

function isCoordinatorTool(request) {
  if (request.method !== "tools/call") return false;
  const params = request.params;
  return params && typeof params === "object" && !Array.isArray(params)
    && COORDINATOR_TOOL_NAMES.has(params.name);
}

async function readPrivateRegularFile(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("unsafe Motion access state");
  return readFile(path, "utf8");
}

async function readLiveDiscovery() {
  const raw = await readPrivateRegularFile(discoveryFile);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid live Motion bridge discovery");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid live Motion bridge discovery");
  }
  const { port, credential } = parsed;
  if (!Number.isInteger(port) || port < 1 || port > 65535
    || typeof credential !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(credential)) {
    throw new Error("invalid live Motion bridge discovery");
  }
  return { port, credential };
}

function mcpHeaders(request, credential) {
  const headers = {
    accept: "application/json, text/event-stream",
    [MCP_BRIDGE_CREDENTIAL_HEADER]: credential,
    "content-type": "application/json"
  };
  const method = typeof request.method === "string" ? request.method : "";
  const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params
    : {};
  const meta = params._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
    ? params._meta
    : {};
  const modernVersion = meta["io.modelcontextprotocol/protocolVersion"];
  if (typeof modernVersion === "string" && modernVersion) {
    headers["mcp-protocol-version"] = modernVersion;
    headers["mcp-method"] = method;
    if (method === "tools/call" && typeof params.name === "string") headers["mcp-name"] = params.name;
  }
  return headers;
}

function writeResponse(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
