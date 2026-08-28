import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DEBUG_COMMAND_CONTRACTS } from "@shellx-motion/debug-api";
import { MOTION_SDK_SCHEMA, createMotionSdk, createMotionSdkHttpTransport, motionSdkCacheKey } from "@shellx-motion/sdk";
import { startMotionDebugServer, type MotionDebugServerHandle, type MotionDebugServerOptions } from "./index";

const TEST_CAPABILITY_TOKEN = "test-capability-token-000000000000000000000000";
const TEST_WEBSOCKET_PROTOCOL = "shellx-motion-debug-v1";
// Absolute path to a template fixture, resolved from this test file up to the repo /fixtures root.
const EDITABLE_LOWER_THIRD = resolve(fileURLToPath(import.meta.url), "../../../../fixtures/packages/editable-lower-third");

function startTestServer(options: MotionDebugServerOptions = {}): Promise<MotionDebugServerHandle> {
  return startMotionDebugServer({ ...options, capabilityToken: TEST_CAPABILITY_TOKEN });
}

function fetch(url: URL, init: RequestInit = {}): Promise<Response> {
  return globalThis.fetch(url, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${TEST_CAPABILITY_TOKEN}`
    }
  });
}

function authenticatedSocket(server: MotionDebugServerHandle): WebSocket {
  return new WebSocket(
    new URL("/ws", server.url).toString().replace(/^http/, "ws"),
    [TEST_WEBSOCKET_PROTOCOL, `shellx-motion-token.${TEST_CAPABILITY_TOKEN}`]
  );
}

describe("motion debug loopback server", () => {
  it("exposes only minimal health without a capability", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      expect(server.capabilityToken).toBe(TEST_CAPABILITY_TOKEN);
      expect(Object.keys(server)).not.toContain("capabilityToken");
      expect({ ...server }).not.toHaveProperty("capabilityToken");
      const health = await globalThis.fetch(new URL("/health", server.url));
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, name: "shellx-motion-debug-server" });

      const contracts = await globalThis.fetch(new URL("/debug/contracts", server.url));
      expect(contracts.status).toBe(401);
      expect(contracts.headers.get("www-authenticate")).toBe("Bearer realm=\"shellx-motion-debug\"");
      expect(await contracts.json()).toMatchObject({ ok: false, error: { code: "unauthorized" } });

      const rpc = await globalThis.fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "anonymous", method: "rpc.discover", params: {} })
      });
      expect(rpc.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("exchanges a Start Motion bootstrap value once without placing the capability in static files", async () => {
    const bootstrap = "workbench-bootstrap-000000000000000000000000";
    const server = await startTestServer({ port: 0, workbenchBootstrapToken: bootstrap });
    try {
      const wrong = await globalThis.fetch(new URL("/workbench/bootstrap", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bootstrap: "wrong-bootstrap-00000000000000000000000000" })
      });
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toMatchObject({ error: { code: "invalid_bootstrap" } });

      const claimed = await globalThis.fetch(new URL("/workbench/bootstrap", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bootstrap })
      });
      expect(claimed.status).toBe(200);
      expect(await claimed.json()).toEqual({ ok: true, capabilityToken: TEST_CAPABILITY_TOKEN });

      const replay = await globalThis.fetch(new URL("/workbench/bootstrap", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bootstrap })
      });
      expect(replay.status).toBe(401);

      const workbench = await globalThis.fetch(new URL("/workbench", server.url));
      expect(await workbench.text()).not.toContain(TEST_CAPABILITY_TOKEN);
    } finally {
      await server.close();
    }
  });

  it("rejects cross-origin, forged-host, and non-JSON command requests", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const crossOrigin = await fetch(new URL("/debug/contracts", server.url), {
        headers: { origin: "https://attacker.example" }
      });
      expect(crossOrigin.status).toBe(403);
      expect(await crossOrigin.json()).toMatchObject({ error: { code: "forbidden_origin" } });

      const forgedHost = await httpStatus(new URL("/debug/contracts", server.url), {
        authorization: `Bearer ${TEST_CAPABILITY_TOKEN}`,
        host: "attacker.example"
      });
      expect(forgedHost).toBe(403);

      const csrf = await fetch(new URL("/debug", server.url), {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ command: "motion.actions.find", args: { request: "show render queue" } })
      });
      expect(csrf.status).toBe(415);
      expect(await csrf.json()).toMatchObject({ error: { code: "unsupported_media_type" } });
    } finally {
      await server.close();
    }
  });

  it("binds the maximum permission tier to the authenticated server launch", async () => {
    const readServer = await startTestServer({ port: 0, grantedTier: "read_motion" });
    try {
      const direct = await fetch(new URL("/debug", readServer.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "motion.package.patch",
          requestedTier: "write_local",
          args: { packageRoot: "/tmp/not-used" }
        })
      });
      expect(direct.status).toBe(403);
      expect(await direct.json()).toMatchObject({
        error: {
          code: "permission_denied",
          message: expect.stringContaining("exceeds the authenticated server grant read_motion")
        }
      });

      const rpc = await fetch(new URL("/rpc", readServer.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tier-escalation",
          method: "tools/call",
          params: {
            name: "motion_package_patch",
            arguments: { requestedTier: "edit_motion", args: { packageRoot: "/tmp/not-used" } }
          }
        })
      });
      // The refusal names the host operator's change and states that self-elevation does not exist.
      // Before that, an agent that hit -32001 had a bare "exceeds the grant" and no next step, so
      // the only behaviour left to it was to retry the same escalation. See permission-refusal.ts.
      expect(await rpc.json()).toEqual({
        jsonrpc: "2.0",
        id: "tier-escalation",
        error: {
          code: -32001,
          message: "Requested Motion permission tier edit_motion exceeds the authenticated server grant read_motion. "
            + "A caller cannot raise the grant; the host operator must restart the Motion debug server with `--tier edit_motion --trusted-local-tier`.",
          data: {
            suggestedAction: expect.stringContaining("the host operator must restart the Motion debug server with `--tier edit_motion --trusted-local-tier`"),
            detail: {
              requiredTier: "edit_motion",
              grantedTier: "read_motion",
              selfElevation: "unavailable",
              resolvedBy: "host_operator",
              hostAction: "restart the Motion debug server with `--tier edit_motion --trusted-local-tier`"
            }
          }
        }
      });
    } finally {
      await readServer.close();
    }

    const editServer = await startTestServer({ port: 0, grantedTier: "edit_motion" });
    try {
      const lowerTier = await fetch(new URL("/debug", editServer.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "motion.actions.find",
          requestedTier: "read_motion",
          args: { request: "show render queue" }
        })
      });
      expect(lowerTier.status).toBe(200);

      const writeEscalation = await fetch(new URL("/debug", editServer.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "motion.package.archive",
          requestedTier: "write_local",
          args: {}
        })
      });
      expect(writeEscalation.status).toBe(403);
    } finally {
      await editServer.close();
    }
  });

  it("authenticates WebSocket upgrades and rejects arbitrary browser origins", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      await expect(webSocketUpgradeStatus(server, {})).resolves.toBe(401);
      await expect(webSocketUpgradeStatus(server, {
        origin: "https://attacker.example",
        "sec-websocket-protocol": `${TEST_WEBSOCKET_PROTOCOL}, shellx-motion-token.${TEST_CAPABILITY_TOKEN}`
      })).resolves.toBe(403);
    } finally {
      await server.close();
    }
  });

  it("bounds concurrent authenticated WebSocket connections", async () => {
    const server = await startTestServer({ port: 0, maxWebSocketConnections: 1 });
    const first = authenticatedSocket(server);
    try {
      await waitForSocketOpen(first);
      await expect(webSocketUpgradeStatus(server, {
        "sec-websocket-protocol": `${TEST_WEBSOCKET_PROTOCOL}, shellx-motion-token.${TEST_CAPABILITY_TOKEN}`
      })).resolves.toBe(429);
    } finally {
      first.close();
      await server.close();
    }
  });

  it("refuses non-loopback binding and weak injected capabilities by default", async () => {
    await expect(startMotionDebugServer({ host: "0.0.0.0", port: 0 })).rejects.toThrow("direct non-loopback binding is disabled");
    await expect(startMotionDebugServer({ port: 0, capabilityToken: "too-short" })).rejects.toThrow("at least 32 URL-safe characters");
    await expect(startMotionDebugServer({ port: 0, capabilityToken: "not a websocket-safe capability token" })).rejects.toThrow("URL-safe characters");
  });

  it("serves debug contracts from the shared debug registry", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const response = await fetch(new URL("/debug/contracts", server.url));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        transport: "http",
        contracts: DEBUG_COMMAND_CONTRACTS
      });
    } finally {
      await server.close();
    }
  });

  it("dispatches read-only debug commands over loopback JSON", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const response = await fetch(new URL("/debug", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "motion.actions.find",
          requestedTier: "read_motion",
          args: { request: "show render queue" }
        })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.command).toBe("motion.actions.find");
      expect(body.result).toMatchObject({
        id: "motion.render.queue",
        permission: "read_motion"
      });
      expect(body.warnings).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("serves JSON-RPC discovery and debug contracts for agent hosts", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const discovery = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "discover-1",
          method: "rpc.discover",
          params: {}
        })
      });
      const discoveryBody = await discovery.json();

      expect(discovery.status).toBe(200);
      expect(discoveryBody).toMatchObject({
        jsonrpc: "2.0",
        id: "discover-1",
        result: {
          ok: true,
          name: "shellx-motion-debug-server",
          transport: "json-rpc",
          methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"],
          contractCount: DEBUG_COMMAND_CONTRACTS.length
        }
      });

      const contracts = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "contracts-1",
          method: "motion.debug.contracts",
          params: {}
        })
      });
      const contractsBody = await contracts.json();

      expect(contracts.status).toBe(200);
      expect(contractsBody).toMatchObject({
        jsonrpc: "2.0",
        id: "contracts-1",
        result: {
          ok: true,
          transport: "json-rpc",
          contracts: DEBUG_COMMAND_CONTRACTS
        }
      });
    } finally {
      await server.close();
    }
  });

  it("serves JSON-RPC discovery over loopback WebSocket", async () => {
    const server = await startTestServer({ port: 0 });
    const socket = authenticatedSocket(server);
    try {
      await waitForSocketOpen(socket);
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: "ws-discover",
        method: "rpc.discover",
        params: {}
      }));
      const body = await readSocketJson(socket);

      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: "ws-discover",
        result: {
          ok: true,
          name: "shellx-motion-debug-server",
          transport: "websocket-json-rpc",
          methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"],
          contractCount: DEBUG_COMMAND_CONTRACTS.length
        }
      });
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("stamps the HTTP transport actor (http + session + tier) onto host receipts", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-http-actor-"));
    const receiptsRoot = join(outDir, "host-receipts");
    // The host nominates the receipt root. A caller naming its own is refused by the Debug API
    // receipts fence, which is the trust model the shipped server runs.
    const server = await startTestServer({ port: 0, grantedTier: "edit_motion", context: { receiptsRoot, authoringInputRoots: [EDITABLE_LOWER_THIRD], authoringOutputRoots: [outDir] } });
    try {
      const response = await fetch(new URL("/debug", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "motion.template.apply",
          requestedTier: "edit_motion",
          args: { packageRoot: EDITABLE_LOWER_THIRD, outDir, receiptsRoot, values: { title: "Launch Day" } }
        })
      });
      const body = await response.json() as { ok: boolean; receiptId?: string };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);

      const hostReceipt = JSON.parse(await readFile(join(receiptsRoot, `${body.receiptId}.receipt.json`), "utf8"));
      // POST /debug is the bare HTTP transport: an unknown caller class, but the observed wire, the
      // authenticated server session, and the granted tier are recorded so History answers "BY WHO".
      expect(hostReceipt.actor.kind).toBe("unknown");
      expect(hostReceipt.actor.label).toBe("http client");
      expect(hostReceipt.actor.transport).toBe("http");
      expect(hostReceipt.actor.grantedTier).toBe("edit_motion");
      expect(hostReceipt.actor.sessionId).toMatch(/^srv-[0-9a-f]{16}$/);
    } finally {
      await server.close();
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("stamps the MCP transport actor (mcp + clientInfo) from the initialize handshake onto host receipts", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-mcp-actor-"));
    const receiptsRoot = join(outDir, "host-receipts");
    // Host-nominated receipt root; see the HTTP actor test above for why a caller cannot name one.
    const server = await startTestServer({ port: 0, grantedTier: "edit_motion", context: { receiptsRoot, authoringInputRoots: [EDITABLE_LOWER_THIRD], authoringOutputRoots: [outDir] } });
    const socket = authenticatedSocket(server);
    try {
      await waitForSocketOpen(socket);
      // The MCP client declares its identity in the initialize handshake, before running any tool.
      socket.send(JSON.stringify({
        jsonrpc: "2.0", id: "init", method: "initialize",
        params: { protocolVersion: "2025-06-18", clientInfo: { name: "test-mcp", version: "9.9" } }
      }));
      await readSocketJson(socket);

      // A later tools/call on the SAME connection inherits the declared client identity + session.
      socket.send(JSON.stringify({
        jsonrpc: "2.0", id: "apply", method: "tools/call",
        params: {
          name: "motion_template_apply",
          arguments: {
            requestedTier: "edit_motion",
            args: { packageRoot: EDITABLE_LOWER_THIRD, outDir, receiptsRoot, values: { title: "Launch Day" } }
          }
        }
      }));
      const toolResponse = await readSocketJson(socket) as { result?: { structuredContent?: { ok?: boolean; receiptId?: string } } };
      const structured = toolResponse.result?.structuredContent;
      expect(structured?.ok).toBe(true);

      const hostReceipt = JSON.parse(await readFile(join(receiptsRoot, `${structured?.receiptId}.receipt.json`), "utf8"));
      // An MCP tools/call is an agent; the handshake-declared client rides with the observed session.
      expect(hostReceipt.actor.kind).toBe("agent");
      expect(hostReceipt.actor.label).toBe("test-mcp/9.9");
      expect(hostReceipt.actor.transport).toBe("mcp");
      expect(hostReceipt.actor.clientInfo).toBe("test-mcp/9.9");
      expect(hostReceipt.actor.grantedTier).toBe("edit_motion");
      expect(hostReceipt.actor.sessionId).toMatch(/^srv-[0-9a-f]{16}:ws-[0-9a-f]{8}$/);
    } finally {
      socket.close();
      await server.close();
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("dispatches debug commands over JSON-RPC with the same permission gates", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const response = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "motion.debug.dispatch",
          params: {
            command: "motion.actions.find",
            requestedTier: "read_motion",
            args: { request: "show render queue" }
          }
        })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: 7,
        result: {
          ok: true,
          command: "motion.actions.find",
          result: {
            id: "motion.render.queue",
            permission: "read_motion"
          },
          warnings: []
        }
      });
    } finally {
      await server.close();
    }
  });

  it("serves MCP-style initialize and tool discovery from debug contracts", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const initialize = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "mcp-init",
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "motion-test-agent", version: "0.0.0" }
          }
        })
      });
      const initializeBody = await initialize.json();

      expect(initialize.status).toBe(200);
      expect(initializeBody).toMatchObject({
        jsonrpc: "2.0",
        id: "mcp-init",
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "shellx-motion-debug-server" },
          capabilities: { tools: {} }
        }
      });

      const tools = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "mcp-tools",
          method: "tools/list",
          params: {}
        })
      });
      const toolsBody = await tools.json();

      expect(tools.status).toBe(200);
      expect(toolsBody.result.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "motion_actions_find",
          title: "motion.actions.find",
          description: expect.stringContaining("permission=read_motion"),
          annotations: expect.objectContaining({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true
          }),
          inputSchema: expect.objectContaining({
            type: "object",
            properties: expect.objectContaining({
              args: expect.any(Object),
              requestedTier: expect.any(Object)
            })
          })
        }),
        expect.objectContaining({
          name: "motion_render_final",
          title: "motion.render.final",
          description: expect.stringContaining("mutates=true"),
          annotations: expect.objectContaining({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false
          })
        })
      ]));
    } finally {
      await server.close();
    }
  });

  it("calls debug commands through MCP-style tools with permission gates", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const response = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "mcp-call",
          method: "tools/call",
          params: {
            name: "motion_actions_find",
            arguments: {
              requestedTier: "read_motion",
              args: { request: "show render queue" }
            }
          }
        })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: "mcp-call",
        result: {
          isError: false,
          content: [
            {
              type: "text",
              text: expect.stringContaining("\"command\":\"motion.actions.find\"")
            }
          ],
          structuredContent: {
            ok: true,
            command: "motion.actions.find",
            result: {
              id: "motion.render.queue",
              permission: "read_motion"
            }
          }
        }
      });

      const denied = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "mcp-denied",
          method: "tools/call",
          params: {
            name: "motion_package_patch",
            arguments: {
              requestedTier: "read_motion",
              args: { packageRoot: "/tmp/not-used" }
            }
          }
        })
      });
      const deniedBody = await denied.json();

      expect(deniedBody).toMatchObject({
        jsonrpc: "2.0",
        id: "mcp-denied",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            command: "motion.package.patch",
            error: {
              code: "permission_denied",
              message: "motion.package.patch requires edit_motion; this session holds read_motion.",
              suggestedAction: expect.stringContaining("cannot raise its own permission tier")
            }
          }
        }
      });
    } finally {
      await server.close();
    }
  });

  it("returns JSON-RPC method errors without dispatching unknown RPC methods", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const response = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "bad-method",
          method: "motion.unknown",
          params: {}
        })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        jsonrpc: "2.0",
        id: "bad-method",
        error: {
          code: -32601,
          message: "Unknown JSON-RPC method: motion.unknown."
        }
      });
    } finally {
      await server.close();
    }
  });

  it("refuses mutating debug commands below their required tier", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const response = await fetch(new URL("/debug", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "motion.package.patch",
          requestedTier: "read_motion",
          args: { packageRoot: "/tmp/not-used" }
        })
      });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body).toMatchObject({
        ok: false,
        command: "motion.package.patch",
        error: {
          code: "permission_denied",
          message: "motion.package.patch requires edit_motion; this session holds read_motion.",
          suggestedAction: expect.stringContaining("cannot raise its own permission tier")
        },
        warnings: []
      });
    } finally {
      await server.close();
    }
  });

  it("marks MCP tool calls as errors when connector receipts fail", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-mcp-cut-generate-failed-"));
    const server = await startTestServer({ port: 0, grantedTier: "write_local", context: { authoringOutputRoots: [outDir], renderPackageRoots: [outDir], renderInputRoots: [outDir], renderOutputRoots: [outDir] } });
    try {
      const response = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "mcp-cut-generate-failed",
          method: "tools/call",
          params: {
            name: "motion_connector_cut_generate_to_cut",
            arguments: {
              requestedTier: "write_local",
              args: {
                script: previewFailingScriptedVideo(),
                outDir,
                cutImportMode: "rendered_media",
                dryRunRender: true,
                createdAt: "2026-07-03T12:45:00.000Z"
              }
            }
          }
        })
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: "mcp-cut-generate-failed",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            command: "motion.connector.cut_generate_to_cut",
            error: {
              code: "connector_failed",
              message: expect.stringContaining("motion.connector.cut_generate_to_cut")
            },
            result: {
              ok: false,
              preview: { ok: false, lane: "native", failureFatal: true },
              render: { ok: true, required: true, dryRun: true }
            },
            warnings: expect.arrayContaining([expect.stringContaining("Unsupported color format")])
          }
        }
      });
    } finally {
      await server.close();
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("serves the versioned SDK over authenticated loopback HTTP and enforces server-owned tiers", async () => {
    const server = await startTestServer({ port: 0, grantedTier: "read_motion", context: { renderPackageRoots: [resolve("../../fixtures/packages/lower-third")] } });
    try {
      const sdk = createMotionSdk(createMotionSdkHttpTransport({
        baseUrl: server.url,
        capabilityToken: TEST_CAPABILITY_TOKEN
      }));
      const validated = await sdk.validate({ packageRoot: resolve("../../fixtures/packages/lower-third") });
      expect(validated).toMatchObject({
        ok: true,
        output: {
          package: {
            packageId: "pkg_lower_third",
            motionId: "motion_lower_third",
            manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
          }
        }
      });

      const denied = await sdk.compile({ script: {}, outDir: "/tmp/sdk-denied" });
      expect(denied).toMatchObject({
        ok: false,
        error: {
          code: "permission_denied",
          message: "Motion SDK compile requires write_local; this session holds read_motion.",
          retryable: false,
          // The SDK error has no suggestedAction field, so the guidance rides in detail.
          detail: { suggestedAction: expect.stringContaining("cannot raise its own permission tier"), selfElevation: "unavailable", resolvedBy: "host_operator" }
        }
      });
      const deniedEdit = await sdk.timelineEdit({
        packageRoot: resolve("../../fixtures/packages/editable-lower-third"),
        outDir: "/tmp/sdk-edit-denied",
        edit: { kind: "keyframe.delete", layerId: "title", target: "opacity", atMs: 0 }
      });
      expect(deniedEdit).toMatchObject({
        ok: false,
        error: {
          code: "permission_denied",
          message: "Motion SDK timelineEdit requires edit_motion; this session holds read_motion.",
          retryable: false
        }
      });
      const deniedTracking = await sdk.trackingApply({
        packageRoot: resolve("../../fixtures/packages/editable-lower-third"),
        outDir: "/tmp/sdk-tracking-denied",
        analysisId: "track-1",
        layerId: "title"
      });
      expect(deniedTracking).toMatchObject({
        ok: false,
        error: {
          code: "permission_denied",
          message: "Motion SDK trackingApply requires edit_motion; this session holds read_motion.",
          retryable: false
        }
      });
    } finally {
      await server.close();
    }
  });

  it("executes authenticated timeline edits only at edit_motion tier and returns reopened identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-http-edit-"));
    const packageRoot = resolve("../../fixtures/packages/editable-lower-third");
    const server = await startTestServer({ port: 0, grantedTier: "edit_motion", context: { authoringInputRoots: [packageRoot], authoringOutputRoots: [root] } });
    try {
      const sdk = createMotionSdk(createMotionSdkHttpTransport({
        baseUrl: server.url,
        capabilityToken: TEST_CAPABILITY_TOKEN
      }));
      const outDir = join(root, "edited");
      const edited = await sdk.timelineEdit({
        packageRoot,
        outDir,
        edit: { kind: "keyframe.upsert", layerId: "title", target: "opacity", atMs: 200, value: 0.75, easing: "ease-out" }
      });
      expect(edited).toMatchObject({
        ok: true,
        output: {
          packageRoot: outDir,
          package: { packageId: "pkg_editable_lower_third", motionId: "motion_editable_lower_third", motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          receipt: { operation: "timeline.keyframe.upsert", status: "passed", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
        }
      });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects forged SDK cache and request identities before invoking the transport", async () => {
    const execute = vi.fn();
    const server = await startTestServer({ port: 0, sdkTransport: { execute } });
    try {
      const input = { packageRoot: resolve("../../fixtures/packages/lower-third") };
      const cacheKey = await motionSdkCacheKey("validate", input);
      const forged = await fetch(new URL("/sdk", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: MOTION_SDK_SCHEMA,
          operation: "validate",
          requestId: `sdk-validate-${cacheKey.slice(0, 20)}`,
          cacheKey: `${cacheKey[0] === "a" ? "b" : "a"}${cacheKey.slice(1)}`,
          input
        })
      });
      expect(forged.status).toBe(400);
      expect(await forged.json()).toMatchObject({ error: { code: "invalid_sdk_request", message: "Motion SDK cacheKey does not match the canonical request input." } });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

const PRODUCT_PACK_ROOT = fileURLToPath(new URL("../../../templates/shellx-product-pack", import.meta.url));

/**
 * How many template families this tree actually ships.
 *
 * Read from disk rather than hard-coded because the number legitimately differs between the
 * implementation tree and the published export -- see the assertions that use it.
 */
async function productPackFamilyCount(): Promise<number> {
  const entries = await readdir(PRODUCT_PACK_ROOT, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).length;
}
describe("agent template reference APIs", () => {
  it("does not serve the retired human Gallery or its assets", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      for (const path of ["/workbench/gallery", "/workbench/gallery/", "/gallery.js", "/gallery-controls.js", "/gallery.css"]) {
        const response = await fetch(new URL(path, server.url));
        expect(response.status, path).toBe(404);
      }
    } finally {
      await server.close();
    }
  });

  it("reports the authenticated grant tier for agent commands", async () => {
    const server = await startTestServer({ port: 0, grantedTier: "render_motion" });
    try {
      const contracts = await fetch(new URL("/debug/contracts", server.url));
      expect(contracts.status).toBe(200);
      const body = await contracts.json();
      expect(body).toMatchObject({ ok: true, grantedTier: "render_motion" });
      expect(Array.isArray(body.contracts)).toBe(true);
      const renderContract = body.contracts.find((contract: { command: string }) => contract.command === "motion.render.final");
      expect(renderContract).toMatchObject({ permission: "render_motion" });
    } finally {
      await server.close();
    }
  });

  it("returns the full template catalog payload to agents", async () => {
    const server = await startTestServer({ port: 0 });
    try {
      const response = await fetch(new URL("/debug", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "motion.template.catalog", args: { templateRoot: PRODUCT_PACK_ROOT }, requestedTier: "read_motion" })
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      const templates = body.result.templates as Array<Record<string, unknown>>;
      // Counted against the families actually on disk, not a frozen 15. The implementation tree holds
      // the public families plus the ones the export manifest withholds; the published tree holds only
      // the public ones. A hard-coded count was right in neither and was red in the export the moment
      // the withholding actually took effect. The family set itself is enforced by
      // assertProductTemplateContract in the pack gates; what this asserts is that the catalog command
      // returns exactly one reference entry per family present.
      expect(templates).toHaveLength(await productPackFamilyCount());
      for (const card of templates) {
        expect(typeof card.templateName).toBe("string");
        expect(Array.isArray(card.compatibleHosts)).toBe(true);
        expect(Array.isArray(card.designFamilies)).toBe(true);
        const metadata = card.metadata as { suitability?: { bestFor?: unknown[] }; preview?: { poster?: string } };
        expect(Array.isArray(metadata.suitability?.bestFor)).toBe(true);
        expect(typeof metadata.preview?.poster).toBe("string");
      }
    } finally {
      await server.close();
    }
  });

});

function webSocketUpgradeStatus(server: MotionDebugServerHandle, extraHeaders: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL("/ws", server.url), {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        // A deterministic valid 16-byte nonce without shipping a secret-shaped
        // RFC example literal that release scanners correctly flag as generic key material.
        "sec-websocket-key": Buffer.alloc(16, 0x42).toString("base64"),
        "sec-websocket-version": "13",
        ...extraHeaders
      }
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
}

function httpStatus(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
    request.end();
  });
}

function previewFailingScriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "debug-preview-fail",
    name: "Debug Preview Fail",
    sourceApp: "shellx-cut",
    workflow: "generate",
    width: 640,
    height: 360,
    fps: 2,
    frames: [
      {
        id: "bad-preview",
        title: "Bad native preview",
        body: "Dry-run export must surface this failure",
        durationMs: 1000,
        background: "color(display-p3 1 0 0)",
        accent: "#38bdf8"
      }
    ]
  };
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

function readSocketJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message.")), 1000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
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
