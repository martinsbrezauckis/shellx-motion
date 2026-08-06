/** Dual-era MCP coverage: modern per-request metadata plus legacy initialize coexist. */
import { afterEach, describe, expect, it } from "vitest";
import { startMotionDebugServer } from "./index";

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function modernServer() {
  const server = await startMotionDebugServer({ host: "127.0.0.1", port: 0, grantedTier: "read_motion" });
  servers.push(server);
  const post = async (input: {
    method: string;
    params?: Record<string, unknown>;
    version?: string;
    methodHeader?: string | false;
    nameHeader?: string | false;
  }) => {
    const version = input.version ?? "2026-07-28";
    const name = typeof input.params?.name === "string" ? input.params.name : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${server.capabilityToken}`,
      "mcp-protocol-version": version
    };
    if (input.methodHeader !== false) headers["mcp-method"] = input.methodHeader ?? input.method;
    if (name && input.nameHeader !== false) headers["mcp-name"] = input.nameHeader ?? name;
    const response = await fetch(new URL("/rpc", server.url), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: input.method,
        method: input.method,
        params: {
          ...(input.params ?? {}),
          _meta: {
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        }
      })
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { post };
}

describe("modern MCP HTTP compatibility", () => {
  it("discovers modern and legacy protocol support without an initialize handshake", async () => {
    const { post } = await modernServer();
    const { status, body } = await post({ method: "server/discover" });

    expect(status).toBe(200);
    expect(body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28", "2025-06-18"],
      capabilities: { tools: {} },
      cacheScope: "private",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "shellx-motion-debug-server"
        }
      }
    });
  });

  it("lists annotated tools and calls read-only tools with complete modern results", async () => {
    const { post } = await modernServer();
    const listed = await post({ method: "tools/list" });
    const called = await post({ method: "tools/call", params: { name: "motion_state", arguments: {} } });

    expect(listed.status).toBe(200);
    expect(listed.body.result.resultType).toBe("complete");
    expect(listed.body.result.tools).toHaveLength(169);
    expect(listed.body.result.tools[0].annotations).toMatchObject({ readOnlyHint: expect.any(Boolean) });
    expect(called.status).toBe(200);
    expect(called.body.result).toMatchObject({
      resultType: "complete",
      isError: false,
      structuredContent: { ok: true, command: "motion.state" }
    });
  });

  it("rejects mismatched mirrored headers with the standard HeaderMismatch error", async () => {
    const { post } = await modernServer();
    const { status, body } = await post({ method: "tools/list", methodHeader: "tools/call" });

    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: -32020, message: expect.stringContaining("Mcp-Method") });
  });

  it("advertises supported versions when a modern client requests an unsupported revision", async () => {
    const { post } = await modernServer();
    const { status, body } = await post({ method: "tools/list", version: "2099-01-01" });

    expect(status).toBe(400);
    expect(body.error).toMatchObject({
      code: -32022,
      data: { supported: ["2026-07-28", "2025-06-18"], requested: "2099-01-01" }
    });
  });

  it("returns HTTP 404 plus JSON-RPC method-not-found for unknown modern methods", async () => {
    const { post } = await modernServer();
    const { status, body } = await post({ method: "unknown/modern" });

    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: -32601 });
  });
});
