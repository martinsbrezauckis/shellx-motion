#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Agent, request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const accessRoot = process.env.SHELLX_MOTION_ACCESS_ROOT || join(homedir(), ".shellx-motion");
const discoveryFile = join(accessRoot, "mcp-bridge.discovery.json");
const MCP_BRIDGE_CREDENTIAL_HEADER = "x-shellx-motion-mcp-bridge-credential";
const MCP_BRIDGE_CREDENTIAL_PROTOCOL_PREFIX = "shellx-motion-mcp-bridge.";
const MCP_LISTENER_PROOF_CONTEXT = "shellx-motion-mcp-listener@1:";
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_PROOF_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
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

for await (const framed of boundedLines(process.stdin)) {
  if (framed.oversized) {
    writeResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Motion MCP request exceeds the 1 MB transport limit." } });
    continue;
  }
  const line = framed.line;
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
    active.notify(request);
    return null;
  }
  return active.request(request);
}

async function sendHttpRequest(request, notification) {
  const discovery = await readLiveDiscovery();
  const proven = await proveLiveListener(discovery);
  try {
    const response = await postOnProvenSocket(proven, discovery, request);
    let body = null;
    try {
      body = JSON.parse(response.raw.toString("utf8"));
    } catch {
      // The bounded unreadable-response envelope below is the public compatibility behavior.
    }
    if (notification) return null;
    if (body && typeof body === "object") return body;
    return {
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: { code: -32000, message: `Motion MCP returned an unreadable response (${response.status}).` }
    };
  } finally {
    proven.agent.destroy();
  }
}

async function connectedBridge() {
  if (connection?.open) return connection;
  const discovery = await readLiveDiscovery();
  const proven = await proveLiveListener(discovery);
  const next = await openBridgeConnection(proven, discovery);
  connection = next;
  return next;
}

/** Prove the current listener and retain the exact TCP connection for privileged delivery. */
async function proveLiveListener(discovery) {
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const nonce = randomBytes(32).toString("base64url");
  try {
    const response = await requestResponse({
      agent,
      host: "127.0.0.1",
      port: discovery.port,
      path: `/mcp-bridge/proof?nonce=${encodeURIComponent(nonce)}`,
      method: "GET",
      headers: { accept: "application/json" }
    }, 5_000);
    if (response.status !== 200) throw new Error("Motion MCP listener proof failed.");
    const raw = await readBoundedResponse(response.response, MAX_PROOF_BYTES, "Motion MCP listener proof is oversized.");
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error("Motion MCP listener proof is invalid.");
    }
    const supplied = body && typeof body === "object" && !Array.isArray(body) ? body.proof : undefined;
    if (typeof supplied !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) {
      throw new Error("Motion MCP listener proof is invalid.");
    }
    const expected = createHmac("sha256", discovery.credential)
      .update(`${MCP_LISTENER_PROOF_CONTEXT}${nonce}`, "utf8")
      .digest();
    const actual = Buffer.from(supplied, "base64url");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new Error("Motion MCP listener proof does not match discovery.");
    }
    if (!response.socket || response.socket.destroyed) throw new Error("Motion MCP listener proof connection closed.");
    return { agent, socket: response.socket };
  } catch (error) {
    agent.destroy();
    throw error;
  }
}

function postOnProvenSocket(proven, discovery, request) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(request), "utf8");
    const outgoing = httpRequest({
      agent: proven.agent,
      host: "127.0.0.1",
      port: discovery.port,
      path: "/rpc",
      method: "POST"
    });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error("Motion MCP request timed out.")));
    outgoing.once("error", fail);
    outgoing.once("socket", (socket) => {
      if (socket !== proven.socket || socket.destroyed) {
        outgoing.destroy(new Error("Motion MCP listener changed after proof."));
        return;
      }
      for (const [name, value] of Object.entries(mcpHeaders(request, discovery.credential))) {
        outgoing.setHeader(name, value);
      }
      outgoing.setHeader("content-length", body.byteLength);
      outgoing.end(body);
    });
    outgoing.once("response", async (response) => {
      try {
        const raw = await readBoundedResponse(response, MAX_RESPONSE_BYTES, "Motion MCP response is oversized.");
        if (!settled) {
          settled = true;
          resolve({ status: response.statusCode ?? 0, raw });
        }
      } catch (error) {
        fail(error);
      }
    });
  });
}

function openBridgeConnection(proven, discovery) {
  return new Promise((resolve, reject) => {
    const webSocketKey = randomBytes(16).toString("base64");
    const outgoing = httpRequest({
      agent: proven.agent,
      host: "127.0.0.1",
      port: discovery.port,
      path: "/ws",
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": webSocketKey
      }
    });
    const pending = new Map();
    let open = false;
    let settled = false;
    let socket;
    let buffered = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      outgoing.destroy(new Error("Motion MCP WebSocket connection timed out."));
    }, 30_000);
    const fail = (cause) => {
      clearTimeout(timeout);
      open = false;
      const error = cause instanceof Error ? cause : new Error("Motion MCP WebSocket disconnected.");
      for (const resolvePending of pending.values()) resolvePending({ error });
      pending.clear();
      if (connection === bridge) connection = undefined;
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const bridge = {
      get socket() {
        return socket;
      },
      get open() {
        return open && Boolean(socket) && !socket.destroyed;
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
            writeWebSocketFrame(socket, 0x1, Buffer.from(JSON.stringify(request), "utf8"));
          } catch (error) {
            pending.delete(key);
            rejectRequest(error);
          }
        });
      },
      notify(request) {
        writeWebSocketFrame(socket, 0x1, Buffer.from(JSON.stringify(request), "utf8"));
      },
      close() {
        if (socket && !socket.destroyed) {
          try {
            writeWebSocketFrame(socket, 0x8, Buffer.alloc(0));
          } finally {
            socket.destroy();
          }
        }
        proven.agent.destroy();
      }
    };

    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error("Motion MCP WebSocket connection timed out.")));
    outgoing.once("error", fail);
    outgoing.once("socket", (candidate) => {
      if (candidate !== proven.socket || candidate.destroyed) {
        outgoing.destroy(new Error("Motion MCP listener changed after proof."));
        return;
      }
      outgoing.setHeader("sec-websocket-protocol", [
        "shellx-motion-debug-v1",
        `${MCP_BRIDGE_CREDENTIAL_PROTOCOL_PREFIX}${discovery.credential}`
      ]);
      outgoing.end();
    });
    outgoing.once("upgrade", (response, upgraded, head) => {
      const expectedAccept = createHash("sha1").update(`${webSocketKey}${WEB_SOCKET_GUID}`, "utf8").digest("base64");
      if (response.statusCode !== 101
        || response.headers["sec-websocket-accept"] !== expectedAccept
        || response.headers["sec-websocket-protocol"] !== "shellx-motion-debug-v1"
        || upgraded !== proven.socket) {
        upgraded.destroy();
        fail(new Error("Motion MCP WebSocket upgrade was invalid."));
        return;
      }
      socket = upgraded;
      open = true;
      clearTimeout(timeout);
      socket.on("data", (chunk) => {
        try {
          buffered = consumeWebSocketFrames(socket, Buffer.concat([buffered, chunk]), (raw) => {
            let body;
            try {
              body = JSON.parse(raw.toString("utf8"));
            } catch {
              return;
            }
            if (!body || typeof body !== "object" || Array.isArray(body)) return;
            const key = responseKey(body.id);
            const resolvePending = pending.get(key);
            if (!resolvePending) return;
            pending.delete(key);
            resolvePending({ body });
          });
        } catch (error) {
          socket.destroy(error);
        }
      });
      socket.once("close", () => fail());
      socket.once("error", fail);
      if (head.byteLength > 0) socket.emit("data", head);
      if (!settled) {
        settled = true;
        resolve(bridge);
      }
    });
  });
}

function requestResponse(options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(options);
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error("Motion MCP listener proof timed out.")));
    outgoing.once("response", (response) => resolve({
      status: response.statusCode ?? 0,
      response,
      socket: response.socket
    }));
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function readBoundedResponse(response, maxBytes, oversizedMessage) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      response.destroy();
      throw new Error(oversizedMessage);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function* boundedLines(input) {
  let chunks = [];
  let bytes = 0;
  let oversized = false;
  const append = (chunk) => {
    if (oversized || chunk.byteLength === 0) return;
    if (bytes + chunk.byteLength > MAX_REQUEST_BYTES) {
      chunks = [];
      bytes = 0;
      oversized = true;
      return;
    }
    chunks.push(chunk);
    bytes += chunk.byteLength;
  };
  for await (const value of input) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const newline = buffer.indexOf(0x0a, offset);
      if (newline === -1) {
        append(buffer.subarray(offset));
        break;
      }
      append(buffer.subarray(offset, newline));
      if (oversized) {
        yield { oversized: true };
      } else {
        const line = Buffer.concat(chunks, bytes);
        const end = line.byteLength > 0 && line[line.byteLength - 1] === 0x0d ? line.byteLength - 1 : line.byteLength;
        yield { oversized: false, line: line.subarray(0, end).toString("utf8") };
      }
      chunks = [];
      bytes = 0;
      oversized = false;
      offset = newline + 1;
    }
  }
  if (oversized) yield { oversized: true };
  else if (bytes > 0) yield { oversized: false, line: Buffer.concat(chunks, bytes).toString("utf8") };
}

function writeWebSocketFrame(socket, opcode, payload) {
  if (!socket || socket.destroyed) throw new Error("Motion MCP WebSocket disconnected.");
  const length = payload.byteLength;
  if (length > MAX_RESPONSE_BYTES) throw new Error("Motion MCP WebSocket request is oversized.");
  const extended = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extended + 4);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (extended === 0 ? length : extended === 2 ? 126 : 127);
  if (extended === 2) header.writeUInt16BE(length, 2);
  else if (extended === 8) header.writeBigUInt64BE(BigInt(length), 2);
  const maskOffset = 2 + extended;
  const mask = randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  socket.write(Buffer.concat([header, masked]));
}

function consumeWebSocketFrames(socket, input, onText) {
  let offset = 0;
  while (input.byteLength - offset >= 2) {
    const first = input[offset];
    const second = input[offset + 1];
    if ((first & 0x70) !== 0 || (first & 0x80) === 0 || (second & 0x80) !== 0) {
      throw new Error("Motion MCP WebSocket returned an unsupported frame.");
    }
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let headerBytes = 2;
    if (length === 126) {
      if (input.byteLength - offset < 4) break;
      length = input.readUInt16BE(offset + 2);
      headerBytes = 4;
    } else if (length === 127) {
      if (input.byteLength - offset < 10) break;
      const wide = input.readBigUInt64BE(offset + 2);
      if (wide > BigInt(MAX_RESPONSE_BYTES)) throw new Error("Motion MCP WebSocket response is oversized.");
      length = Number(wide);
      headerBytes = 10;
    }
    if (length > MAX_RESPONSE_BYTES || input.byteLength - offset < headerBytes + length) break;
    const payload = input.subarray(offset + headerBytes, offset + headerBytes + length);
    offset += headerBytes + length;
    if (opcode === 0x1) onText(payload);
    else if (opcode === 0x8) {
      socket.end();
      break;
    } else if (opcode === 0x9) writeWebSocketFrame(socket, 0xA, payload);
    else if (opcode !== 0xA) throw new Error("Motion MCP WebSocket returned an unsupported frame.");
  }
  if (input.byteLength - offset > MAX_RESPONSE_BYTES + 10) throw new Error("Motion MCP WebSocket response is oversized.");
  return input.subarray(offset);
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
