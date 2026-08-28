import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentScriptProvenanceAuthority } from "@shellx-motion/core";
import { establishServerObservedMcpSession } from "@shellx-motion/debug-api";
import { startMotionDebugServer, type MotionDebugServerHandle } from "./index";
import { localSdkOptionsFromDebugContext } from "./sdk-local-options";

const CAPABILITY = "approved-agent-entry-transport-test-capability-000000";
const WS_PROTOCOL = "shellx-motion-debug-v1";
const roots: string[] = [];

function authorityProbe(onMint: () => void): AgentScriptProvenanceAuthority {
  return {
    resolverVersion: 1,
    async mint() {
      onMint();
      throw new Error("raw transport must not reach authority minting");
    },
    async resolve() { throw new Error("not used by this transport-boundary test"); },
    async revoke() { throw new Error("not used by this transport-boundary test"); },
    async writeReceipt() { throw new Error("not used by this transport-boundary test"); }
  };
}

function authorizedFetch(server: MotionDebugServerHandle, body: unknown): Promise<Response> {
  return globalThis.fetch(new URL("/debug", server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${CAPABILITY}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function dataOnlyPackage(root: string): Promise<{ packageRoot: string; outputRoot: string }> {
  const packageRoot = join(root, "inputs", "source");
  const outputRoot = join(root, "outputs");
  // These are host-approved authority roots, so retain their private mode under a permissive
  // operator umask. The test's deliberate refusal paths are created separately below.
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "transport-provenance-source",
    name: "Transport provenance source",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  })}\n`);
  await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "transport-provenance-motion",
    name: "Transport provenance source",
    durationMs: 1000,
    fps: 30,
    width: 320,
    height: 180,
    layers: [{ id: "background", type: "shape", shape: "rectangle", startMs: 0, durationMs: 1000, width: 320, height: 180, fill: "#111111" }],
    assets: [],
    provenance: { sourceApp: "shellx-motion-test", createdBy: "test" }
  })}\n`);
  return { packageRoot, outputRoot };
}

function authorArgs(packageRoot: string, outDir: string): Record<string, unknown> {
  return {
    packageRoot,
    outDir,
    html: "<main>entry</main><script>window.ok = true;</script>",
    layer: { id: "entry", type: "html", startMs: 0, durationMs: 1000 }
  };
}

function authorToolCall(id: string, packageRoot: string, outDir: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "motion_package_script_author",
      arguments: { requestedTier: "write_local", args: authorArgs(packageRoot, outDir) }
    }
  };
}

function authoringAuthority(onMint: () => void): AgentScriptProvenanceAuthority {
  return {
    resolverVersion: 1,
    async mint(input) {
      onMint();
      return {
        schema: "shellx-motion/approved-agent-script-provenance@1",
        resolverVersion: 1,
        attestationId: "transport-test-attestation",
        packageId: input.package.manifest.id,
        packageRootIdentity: { dev: "0", ino: "0" },
        packageSnapshotSha256: "0".repeat(64),
        sources: [],
        createdAt: "2026-08-11T00:00:00.000Z"
      };
    },
    async resolve() { throw new Error("not used by this transport-boundary test"); },
    async revoke() { throw new Error("not used by this transport-boundary test"); },
    async writeReceipt() { return "host-private-receipt.json"; }
  };
}

function socket(server: MotionDebugServerHandle): WebSocket {
  return new WebSocket(new URL("/ws", server.url).toString().replace(/^http/, "ws"), [WS_PROTOCOL, `shellx-motion-token.${CAPABILITY}`]);
}

function open(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for WebSocket open.")); }, 1_000);
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener("open", onOpen); socket.removeEventListener("error", onError); };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("WebSocket failed to open.")); };
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

function read(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for WebSocket response.")); }, 1_000);
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener("message", onMessage); socket.removeEventListener("error", onError); };
    const onMessage = (event: MessageEvent) => {
      cleanup();
      try { resolve(JSON.parse(String(event.data)) as Record<string, unknown>); }
      catch (error) { reject(error); }
    };
    const onError = () => { cleanup(); reject(new Error("WebSocket errored while waiting for a response.")); };
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

function close(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
    socket.close();
  });
}

function expectMcpAuthoringRefusal(body: Record<string, unknown>): void {
  expect(body).toMatchObject({
    result: {
      structuredContent: {
        ok: false,
        error: { code: "approved_agent_entry_refused" },
        command: "motion.package.script.author"
      }
    }
  });
}

describe("approved-agent-entry transport boundary", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it("does not let raw Debug body claims become an observed MCP agent or reach minting", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-agent-script-server-"));
    roots.push(root);
    let mintCalls = 0;
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: CAPABILITY,
      grantedTier: "write_local",
      context: {
        agentScriptAuthority: authorityProbe(() => { mintCalls += 1; }),
        authoringInputRoots: [root],
        authoringOutputRoots: [root]
      }
    });
    try {
      const response = await authorizedFetch(server, {
        command: "motion.package.script.author",
        requestedTier: "write_local",
        // These deliberately look like authority/actor assertions but /debug never maps either
        // request field into MotionDebugContext. The server stamps its own raw-HTTP actor instead.
        actor: { kind: "agent", transport: "mcp", sessionId: "forged", grantedTier: "write_local" },
        agentScriptAuthority: "forged",
        args: {
          packageRoot: join(root, "source"),
          outDir: join(root, "output"),
          html: "<main>entry</main><script>window.ok = true;</script>",
          layer: { id: "entry", type: "html", startMs: 0, durationMs: 1000 }
        }
      });
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "approved_agent_entry_refused" },
        command: "motion.package.script.author"
      });
      expect(mintCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("does not forward a debug-host authority through the SDK local-options bridge", () => {
    const authority = authorityProbe(() => undefined);
    const options = localSdkOptionsFromDebugContext({
      agentScriptAuthority: authority,
      observedMcpAgentSession: establishServerObservedMcpSession()
    });
    expect(options).not.toHaveProperty("agentScriptAuthority");
    expect(options).not.toHaveProperty("observedMcpAgentSession");
  });

  it("requires a server-established initialized WebSocket MCP session, not a selected MCP method or metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-agent-script-mcp-session-"));
    roots.push(root);
    const { packageRoot, outputRoot } = await dataOnlyPackage(root);
    let mintCalls = 0;
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: CAPABILITY,
      grantedTier: "write_local",
      context: {
        agentScriptAuthority: authoringAuthority(() => { mintCalls += 1; }),
        authoringInputRoots: [join(root, "inputs")],
        authoringOutputRoots: [outputRoot],
        // A trusted in-process object at startup is intentionally ignored. Only the server's
        // live WebSocket handshake may attach one to an individual tool dispatch.
        observedMcpAgentSession: establishServerObservedMcpSession()
      }
    });
    const ws = socket(server);
    const otherWs = socket(server);
    let reconnectWs: WebSocket | undefined;
    try {
      // HTTP initialize stays a normal compatibility response, but has no persistent connection
      // state in which the server could establish the authoring capability.
      const statelessInitialize = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { authorization: `Bearer ${CAPABILITY}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "stateless-initialize",
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stateless-agent", version: "1" } }
        })
      });
      expect(statelessInitialize.status).toBe(200);
      expect(await statelessInitialize.json()).toMatchObject({ result: { protocolVersion: "2025-06-18" } });

      const legacyOutput = join(outputRoot, "legacy-http");
      const legacy = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { authorization: `Bearer ${CAPABILITY}`, "content-type": "application/json" },
        body: JSON.stringify(authorToolCall("legacy-http", packageRoot, legacyOutput))
      });
      expect(legacy.status).toBe(200);
      expectMcpAuthoringRefusal(await legacy.json() as Record<string, unknown>);
      expect(existsSync(legacyOutput)).toBe(false);
      expect(mintCalls).toBe(0);

      const modernOutput = join(outputRoot, "forged-modern-http");
      const modernPayload = authorToolCall("forged-modern-http", packageRoot, modernOutput) as { params: Record<string, unknown> };
      modernPayload.params._meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "forged-modern-agent", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {}
      };
      const modern = await fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${CAPABILITY}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "motion_package_script_author"
        },
        body: JSON.stringify(modernPayload)
      });
      expect(modern.status).toBe(200);
      expectMcpAuthoringRefusal(await modern.json() as Record<string, unknown>);
      expect(existsSync(modernOutput)).toBe(false);
      expect(mintCalls).toBe(0);

      await Promise.all([open(ws), open(otherWs)]);
      const firstFrameOutput = join(outputRoot, "first-ws-frame");
      ws.send(JSON.stringify(authorToolCall("first-ws-frame", packageRoot, firstFrameOutput)));
      expectMcpAuthoringRefusal(await read(ws));
      expect(existsSync(firstFrameOutput)).toBe(false);
      expect(mintCalls).toBe(0);

      // A malformed legacy initialize remains a compatibility response, but it does not establish
      // the sensitive authoring session. A later valid-looking duplicate cannot upgrade it.
      otherWs.send(JSON.stringify({
        jsonrpc: "2.0",
        id: "malformed-initialize",
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: [], clientInfo: { name: "malformed-agent", version: "1" } }
      }));
      expect(await read(otherWs)).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
      const malformedOutput = join(outputRoot, "malformed-ws");
      otherWs.send(JSON.stringify(authorToolCall("malformed-ws", packageRoot, malformedOutput)));
      expectMcpAuthoringRefusal(await read(otherWs));
      expect(existsSync(malformedOutput)).toBe(false);
      expect(mintCalls).toBe(0);
      otherWs.send(JSON.stringify({
        jsonrpc: "2.0",
        id: "duplicate-valid-initialize",
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "duplicate-agent", version: "1" } }
      }));
      expect(await read(otherWs)).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
      const duplicateOutput = join(outputRoot, "duplicate-ws");
      otherWs.send(JSON.stringify(authorToolCall("duplicate-ws", packageRoot, duplicateOutput)));
      expectMcpAuthoringRefusal(await read(otherWs));
      expect(existsSync(duplicateOutput)).toBe(false);
      expect(mintCalls).toBe(0);

      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "approved-agent", version: "1" } }
      }));
      expect(await read(ws)).toMatchObject({ result: { protocolVersion: "2025-06-18" } });

      const approvedOutput = join(outputRoot, "initialized-ws");
      ws.send(JSON.stringify(authorToolCall("initialized-ws", packageRoot, approvedOutput)));
      const approved = await read(ws);
      expect(approved).toMatchObject({
        result: { structuredContent: { ok: true, command: "motion.package.script.author" } }
      });
      expect(JSON.stringify(approved)).not.toContain("observedMcpAgentSession");
      expect(existsSync(approvedOutput)).toBe(true);
      expect(mintCalls).toBe(1);

      // The server capability is object-identity bound to the initialized connection. Matching
      // client metadata on another socket is receipt attribution only; it cannot replay ws's fact.
      const otherSocketOutput = join(outputRoot, "other-socket");
      otherWs.send(JSON.stringify(authorToolCall("other-socket", packageRoot, otherSocketOutput)));
      expectMcpAuthoringRefusal(await read(otherWs));
      expect(existsSync(otherSocketOutput)).toBe(false);
      expect(mintCalls).toBe(1);

      // A new connection after the approved socket closes must initialize again; no session state
      // is serialized or carried to reconnects.
      await close(ws);
      reconnectWs = socket(server);
      await open(reconnectWs);
      const reconnectOutput = join(outputRoot, "reconnect");
      reconnectWs.send(JSON.stringify(authorToolCall("reconnect", packageRoot, reconnectOutput)));
      expectMcpAuthoringRefusal(await read(reconnectWs));
      expect(existsSync(reconnectOutput)).toBe(false);
      expect(mintCalls).toBe(1);
    } finally {
      await Promise.all([close(ws), close(otherWs), ...(reconnectWs ? [close(reconnectWs)] : [])]);
      await server.close();
    }
  });
});
