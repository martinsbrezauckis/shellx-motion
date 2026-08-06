import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { startMotionDebugServer } from "./index";
import { motionUserAccessPaths, readOrCreatePersistentCapabilityFile, writeMotionServerPort } from "./user-access";

const BRIDGE = fileURLToPath(new URL("../bin/shellx-motion-mcp.mjs", import.meta.url));

describe("installed MCP stdio bridge", () => {
  it("reads the private live connection, forwards MCP, and gives a clear stopped-engine result", async () => {
    const parent = await mkdtemp(join(tmpdir(), "motion-mcp-bridge-"));
    const paths = motionUserAccessPaths(join(parent, "access"));
    const access = await readOrCreatePersistentCapabilityFile(paths);
    const server = await startMotionDebugServer({ port: 0, capabilityToken: access.token, grantedTier: "read_motion" });
    await writeMotionServerPort(paths, Number(server.url.port));
    const child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, SHELLX_MOTION_ACCESS_ROOT: paths.root },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const responses = responseReader(child);
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge-test", version: "1" } }
      })}\n`);
      expect(await responses.next()).toMatchObject({
        jsonrpc: "2.0",
        id: "initialize",
        result: { serverInfo: { name: "shellx-motion-debug-server" } }
      });

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} })}\n`);
      const listed = await responses.next();
      expect(listed).toMatchObject({ jsonrpc: "2.0", id: "tools" });
      expect(Array.isArray((listed.result as { tools?: unknown[] }).tools)).toBe(true);

      await server.close();
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "stopped", method: "tools/list", params: {} })}\n`);
      expect(await responses.next()).toEqual({
        jsonrpc: "2.0",
        id: "stopped",
        error: { code: -32000, message: "ShellX Motion is not running. Start Motion, then retry this tool call." }
      });
    } finally {
      if (server.server.listening) await server.close();
      child.kill();
      await rm(parent, { recursive: true, force: true });
    }
  });
});

function responseReader(child: ChildProcessWithoutNullStreams): { next: () => Promise<Record<string, unknown>> } {
  const queue: Array<Record<string, unknown>> = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  return {
    next: () => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for Motion MCP bridge response.")), 5000);
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    }
  };
}
