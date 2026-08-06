#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const accessRoot = process.env.SHELLX_MOTION_ACCESS_ROOT || join(homedir(), ".shellx-motion");
const tokenFile = join(accessRoot, "access.token");
const portFile = join(accessRoot, "server.port");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

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
    const [token, portText] = await Promise.all([
      readPrivateRegularFile(tokenFile),
      readPrivateRegularFile(portFile)
    ]);
    const port = Number(portText.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid live port");
    const headers = mcpHeaders(request, token.trim());
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000)
    });
    const body = await response.json().catch(() => null);
    if (!notification) {
      if (body && typeof body === "object") writeResponse(body);
      else writeResponse({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32000, message: `Motion MCP returned an unreadable response (${response.status}).` }
      });
    }
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

async function readPrivateRegularFile(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("unsafe Motion access state");
  return readFile(path, "utf8");
}

function mcpHeaders(request, token) {
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
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
