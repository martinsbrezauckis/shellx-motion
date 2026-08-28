import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startMotionDebugServer } from "./index.js";
import { MOTION_AGENT_SNAPSHOT_RESOURCE_URI } from "./mcp-resources.js";

const LOWER_THIRD = fileURLToPath(new URL("../../../fixtures/packages/lower-third", import.meta.url));
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(source?: { packageRoot?: string; receiptsRoot?: string }) {
  const server = await startMotionDebugServer({
    host: "127.0.0.1",
    port: 0,
    grantedTier: "read_motion",
    ...(source ? { agentSnapshotSource: source } : {})
  });
  servers.push(server);
  const rpc = async (method: string, params: unknown = {}) => {
    const response = await fetch(new URL("/rpc", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${server.capabilityToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { rpc };
}

describe("fixed MCP agent snapshot resource", () => {
  it("is entirely absent without host configuration", async () => {
    const { rpc } = await start();
    const initialized = await rpc("initialize", { protocolVersion: "2025-06-18" });
    const listed = await rpc("resources/list");

    expect(initialized.body.result.capabilities).toEqual({ tools: {} });
    expect(listed.body.error).toMatchObject({ code: -32601 });
  });

  it("lists and reads one fixed host-owned resource with no query or caller-selected path", async () => {
    const { rpc } = await start({ packageRoot: LOWER_THIRD });
    const initialized = await rpc("initialize", { protocolVersion: "2025-06-18" });
    const listed = await rpc("resources/list");
    const read = await rpc("resources/read", { uri: MOTION_AGENT_SNAPSHOT_RESOURCE_URI });
    const rejected = await rpc("resources/read", { uri: `${MOTION_AGENT_SNAPSHOT_RESOURCE_URI}?packageRoot=/tmp/escape` });
    const overLimitToolCall = await rpc("tools/call", {
      name: "motion_agent_snapshot",
      arguments: { args: { request: "😀".repeat(257) } }
    });

    expect(initialized.body.result.capabilities).toMatchObject({ resources: { listChanged: false } });
    expect(listed.body.result.resources).toEqual([expect.objectContaining({ uri: MOTION_AGENT_SNAPSHOT_RESOURCE_URI })]);
    expect(rejected.body.error).toMatchObject({ code: -32602 });
    expect(overLimitToolCall.body.result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "invalid_args", detail: { violations: [expect.objectContaining({ argument: "request", kind: "above_max_length", maxLength: 256 })] } }
    });
    const contents = read.body.result.contents as Array<{ uri: string; text: string }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]?.uri).toBe(MOTION_AGENT_SNAPSHOT_RESOURCE_URI);
    expect(JSON.parse(contents[0]?.text ?? "{}")).toMatchObject({
      schema: "shellx-motion/agent-snapshot@1",
      freshness: { jobs: { scope: "own" } },
      identity: { package: { fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } }
    });
    expect(contents[0]?.text).not.toContain(LOWER_THIRD);
  });
});
