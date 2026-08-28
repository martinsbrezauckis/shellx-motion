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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEBUG_COMMANDS } from "@shellx-motion/debug-api";
import { motionCapabilityCatalog } from "@shellx-motion/core";
import { startMotionDebugServer, type MotionDebugServerOptions } from "./index";

const servers: Array<{ close: () => Promise<void> }> = [];
const scratchRoots: string[] = [];
const LOWER_THIRD = fileURLToPath(new URL("../../../fixtures/packages/lower-third", import.meta.url));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), `shellx-motion-mcp-${prefix}-`));
  scratchRoots.push(root);
  return root;
}

async function mcpServer(
  grantedTier: "read_motion" | "edit_motion" | "render_motion" = "read_motion",
  context?: MotionDebugServerOptions["context"]
) {
  const handle = await startMotionDebugServer({ host: "127.0.0.1", port: 0, grantedTier, context });
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

  it("publishes keepFrames, streams default video, and refuses non-video retention over real MCP calls", async () => {
    const outputRoot = await scratch("streaming");
    const { call } = await mcpServer("render_motion", {
      renderPackageRoots: [LOWER_THIRD],
      renderInputRoots: [LOWER_THIRD],
      renderOutputRoots: [outputRoot]
    });
    const listed = await call("tools/list");
    const renderTool = listed.body.result.tools.find((tool: { name: string }) => tool.name === "motion_render_final");
    expect(renderTool).toMatchObject({
      inputSchema: { properties: { args: { properties: { keepFrames: { type: "boolean" } } } } }
    });

    const { body } = await call("tools/call", {
      name: "motion_render_final",
      arguments: {
        args: {
          packageRoot: LOWER_THIRD,
          outputPath: resolve(outputRoot, "mcp-streamed-final.mp4"),
          dryRun: true
        }
      }
    });
    expect(body.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        command: "motion.render.final",
        result: {
          dryRun: true,
          frameTransport: { delivery: "streamed", reason: "stream_default" },
          ffmpeg: { shell: false, args: expect.arrayContaining(["-f", "image2pipe", "-i", "pipe:0"]) }
        }
      }
    });

    const refused = await call("tools/call", {
      name: "motion_render_final",
      arguments: {
        args: {
          packageRoot: LOWER_THIRD,
          outputPath: resolve(outputRoot, "mcp-keep-frames-refusal.png"),
          preset: "png-frame",
          keepFrames: true,
          dryRun: true
        }
      }
    });
    expect(refused.body.result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "invalid_args", message: "motion.render.final keepFrames requires a final-video FFmpeg preset." }
      }
    });
  }, 45_000);

  it("carries the closed durable segmented dry-run through the elevated MCP wire without rendering", async () => {
    const outputRoot = await scratch("segmented");
    const renderContext = {
      renderPackageRoots: [LOWER_THIRD],
      renderInputRoots: [LOWER_THIRD],
      renderOutputRoots: [outputRoot]
    };
    const { call } = await mcpServer("render_motion", renderContext);
    const listed = await call("tools/list");
    const renderTool = listed.body.result.tools.find((tool: { name: string }) => tool.name === "motion_render_final");
    expect(renderTool).toMatchObject({
      inputSchema: { properties: { args: { properties: { segmented: {
        type: "object", required: ["segmentFrames"], additionalProperties: false,
        properties: { segmentFrames: { type: "number" }, resume: { type: "boolean" } }
      } } } } }
    });

    const elevated = await call("tools/call", {
      name: "motion_render_final",
      arguments: { args: {
        packageRoot: LOWER_THIRD,
        outputPath: resolve(outputRoot, "mcp-segmented-final-dry-run.mp4"),
        segmented: { segmentFrames: 48, resume: true },
        dryRun: true
      } }
    });
    expect(elevated.body.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        command: "motion.render.final",
        result: { dryRun: true, lane: "ffmpeg", segmented: { segmentFrames: 48, resume: true, store: "derived-from-output" } }
      }
    });
    expect(JSON.stringify(elevated.body)).not.toContain("segments.ffconcat");

    const { call: lowerTierCall } = await mcpServer("read_motion", renderContext);
    const lowerTier = await lowerTierCall("tools/call", {
      name: "motion_render_final",
      arguments: { args: { packageRoot: LOWER_THIRD, outputPath: resolve(outputRoot, "mcp-segmented-final-denied.mp4"), segmented: { segmentFrames: 48 }, dryRun: true } }
    });
    expect(lowerTier.body.result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "permission_denied" } }
    });
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

  it("returns the same canonical connector catalog through a read-only MCP tool without coordinator authority", async () => {
    const { call } = await mcpServer("read_motion", { jobView: null });
    const listed = await call("tools/list");
    const catalogTool = listed.body.result.tools.find((tool: { name: string }) => tool.name === "motion_connector_catalog");
    expect(catalogTool).toMatchObject({
      title: "motion.connector.catalog",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { properties: { args: { type: "object", properties: {}, additionalProperties: false } } }
    });

    const { body } = await call("tools/call", { name: "motion_connector_catalog", arguments: { args: {} } });
    const coreCatalog = motionCapabilityCatalog();
    expect(body.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        command: "motion.connector.catalog",
        result: { ok: true, catalog: coreCatalog }
      }
    });
    expect(body.result.structuredContent.result.catalog).toEqual(coreCatalog);
    expect(body.result.structuredContent.result.catalog).toMatchObject({
      schema: coreCatalog.schema,
      fingerprint: coreCatalog.fingerprint
    });
  }, 45_000);

  it("carries bounded analytic particle fields through the existing layer-create MCP tool", async () => {
    const outDir = await mkdtemp(resolve(tmpdir(), "shellx-motion-mcp-particle-field-"));
    const { call } = await mcpServer("edit_motion", {
      authoringInputRoots: [LOWER_THIRD],
      authoringOutputRoots: [outDir]
    });
    try {
      const { body } = await call("tools/call", {
        name: "motion_timeline_layer_create",
        arguments: {
          args: {
            packageRoot: LOWER_THIRD,
            outDir,
            createdBy: "mcp-particle-field-test",
            layer: {
              id: "mcp-orbital-dust", type: "particles", startMs: 0, durationMs: 300,
              transform: { x: 0, y: 0, width: 64, height: 36 },
              emitter: {
                seed: 11, count: 24, lifetimeMs: 300, color: "#ffffff",
                field: { schema: "shellx-motion/particle-field@1", sources: [
                  { kind: "radial", centerX: 0.5, centerY: 0.5, strength: -0.3, softening: 0.2 }
                ] }
              }
            }
          }
        }
      });

      expect(body.result).toMatchObject({
        isError: false,
        structuredContent: {
          ok: true,
          command: "motion.timeline.layer.create",
          result: { action: "created", layerId: "mcp-orbital-dust", validation: { ok: true } }
        }
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
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
    const { body } = await call("tools/call", {
      name: "motion_render_final",
      arguments: { args: { packageRoot: LOWER_THIRD } }
    });

    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "permission_denied" } }
    });
    expect(JSON.stringify(body)).not.toContain("Configured render package roots must not be empty");
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
