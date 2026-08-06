/**
 * The MCP tool surface must expose every debug command, exactly once, callably.
 *
 * Existing MCP coverage checks the handshake and spot-checks two tools. Nothing asserted the list
 * was COMPLETE, which is the invariant that breaks silently: commands were removed and added on
 *  (motion.screenshot out, the two Lottie imports in) and a drifted MCP mapping would
 * have shipped unnoticed — an MCP client would simply not see a command that exists, with no error
 * anywhere.
 *
 * This is the surface an external agent actually binds to, so "the command registry says 166" and
 * "an MCP client can call 166" are different claims and both need proving.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEBUG_COMMANDS } from "@shellx-motion/debug-api";
import { startMotionDebugServer } from "./index";

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function mcpServer() {
  const handle = await startMotionDebugServer({ host: "127.0.0.1", port: 0, grantedTier: "read_motion" });
  servers.push(handle);
  const call = async (method: string, params: unknown = {}) => {
    const response = await fetch(new URL("/rpc", handle.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${handle.capabilityToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
    });
    return { status: response.status, body: await response.json() };
  };
  return { handle, call };
}

/** The documented mapping: dots become underscores, prefixed with motion_. */
const toolNameFor = (command: string) => command.replace(/\./g, "_");

describe("MCP tool surface", () => {
  it("exposes every registered command, exactly once", async () => {
    const { call } = await mcpServer();

    const { body } = await call("tools/list");
    const names = body.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).toHaveLength(DEBUG_COMMANDS.length);
    // No duplicates: two commands collapsing to one tool name would silently hide one of them.
    expect(new Set(names).size).toBe(names.length);
    for (const command of DEBUG_COMMANDS) {
      expect(names).toContain(toolNameFor(command));
    }
  }, 45_000);

  it("gives every tool a usable input schema and a title naming the real command", async () => {
    const { call } = await mcpServer();

    const { body } = await call("tools/list");

    for (const tool of body.result.tools as Array<Record<string, unknown>>) {
      // A tool without a schema is one a client cannot construct a call for.
      expect(tool.inputSchema, `${tool.name} has no inputSchema`).toMatchObject({ type: "object" });
      // The title carries the dotted command so an operator can map a tool back to the docs.
      expect(DEBUG_COMMANDS).toContain(tool.title as never);
      expect(toolNameFor(tool.title as string)).toBe(tool.name);
    }
  }, 45_000);

  it("annotates every tool from the canonical mutation contract", async () => {
    const { call } = await mcpServer();
    const { body } = await call("tools/list");

    for (const tool of body.result.tools as Array<Record<string, any>>) {
      expect(tool.annotations, `${tool.name} has no MCP annotations`).toMatchObject({
        title: tool.title,
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean)
      });
      const isReadOnly = tool.description.includes("mutates=false");
      expect(tool.annotations.readOnlyHint, `${tool.name} readOnlyHint drifted`).toBe(isReadOnly);
      expect(tool.annotations.destructiveHint, `${tool.name} destructiveHint drifted`).toBe(!isReadOnly);
      expect(tool.annotations.idempotentHint, `${tool.name} idempotentHint drifted`).toBe(isReadOnly);
    }
  }, 45_000);

  it("completes the handshake with a protocol version and a named server", async () => {
    const { call } = await mcpServer();

    const { body } = await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "surface-test", version: "1" }
    });

    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.capabilities).toMatchObject({ tools: {} });
    expect(body.result.serverInfo).toMatchObject({ name: "shellx-motion-debug-server" });
  }, 45_000);

  it("dispatches a tools/call and returns both text and structured content", async () => {
    const { call } = await mcpServer();

    const { body } = await call("tools/call", { name: "motion_state", arguments: {} });

    expect(body.result.isError).toBe(false);
    // Clients that understand structured output and clients that only read text must both work.
    expect(body.result.structuredContent).toMatchObject({ ok: true, command: "motion.state" });
    expect(body.result.content?.[0]).toMatchObject({ type: "text" });
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ ok: true });
  }, 45_000);

  it("reports an unknown tool as an error instead of pretending it ran", async () => {
    const { call } = await mcpServer();

    const { body } = await call("tools/call", { name: "motion_not_a_command", arguments: {} });

    // A client asking for something that does not exist must be told so.
    expect(body.result?.isError ?? body.error !== undefined).toBe(true);
  }, 45_000);

  it("refuses a tool the granted tier does not cover, rather than running it", async () => {
    const { call } = await mcpServer();

    // The server was started at read_motion; rendering needs render_motion.
    const { body } = await call("tools/call", { name: "motion_render_final", arguments: { args: {} } });

    const payload = body.result?.structuredContent ?? body.result ?? body.error;
    expect(JSON.stringify(payload)).toMatch(/permission_denied|capability_unavailable|invalid_args/);
  }, 45_000);

  it("rejects an unauthenticated request", async () => {
    const { handle } = await mcpServer();

    const response = await fetch(new URL("/rpc", handle.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });

    // The token is the whole access control story for the loopback server.
    expect(response.status).toBe(401);
  }, 45_000);
});
