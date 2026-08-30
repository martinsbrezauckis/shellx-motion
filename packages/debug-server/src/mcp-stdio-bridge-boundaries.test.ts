import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { motionUserAccessPaths, writeMotionMcpBridgeDiscovery } from "./user-access";

const BRIDGE = fileURLToPath(new URL("../bin/shellx-motion-mcp.mjs", import.meta.url));

describe("installed MCP stdio bridge transport boundaries", () => {
  it("bounds newline-free stdio requests and resumes at the next frame", async () => {
    const parent = await testRoot("motion-mcp-bridge-stdio-bound-");
    const child = runBridge(join(parent, "missing-access"));
    const responses = responseReader(child);
    try {
      child.stdin.write(Buffer.alloc(1_000_001, 0x61));
      child.stdin.write("\n");
      expect(await responses.next()).toMatchObject({ id: null, error: { code: -32700, message: expect.stringMatching(/1 MB/) } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "after-bound", method: "tools/list", params: {} })}\n`);
      expect(await responses.next()).toMatchObject({ id: "after-bound", error: { code: -32000 } });
    } finally {
      child.kill();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("streams the listener proof limit and cancels an oversized chunked response", async () => {
    const parent = await testRoot("motion-mcp-bridge-proof-bound-");
    const paths = motionUserAccessPaths(join(parent, "access"));
    const credential = newCredential();
    let chunksSent = 0;
    let sawPrivilegedRequest = false;
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/mcp-bridge/proof")) {
        response.writeHead(200, { "content-type": "application/json" });
        let stopped = false;
        const pump = () => {
          if (stopped) return;
          chunksSent += 1;
          response.write("x".repeat(1024));
          if (chunksSent >= 100) response.end();
          else setImmediate(pump);
        };
        response.once("close", () => { stopped = true; });
        setImmediate(pump);
        return;
      }
      sawPrivilegedRequest = true;
      response.writeHead(500);
      response.end();
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("proof fixture did not bind");
    await writeMotionMcpBridgeDiscovery(paths, { port: address.port, credential });
    const child = runBridge(paths.root);
    const responses = responseReader(child);
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "oversized-proof", method: "tools/list", params: {} })}\n`);
      expect(await responses.next()).toMatchObject({ id: "oversized-proof", error: { code: -32000 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(chunksSent).toBeLessThan(100);
      expect(sawPrivilegedRequest).toBe(false);
    } finally {
      child.kill();
      await close(server);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("sends neither bridge credential nor MCP body when proof cannot retain its exact socket", async () => {
    const parent = await testRoot("motion-mcp-bridge-channel-bound-");
    const paths = motionUserAccessPaths(join(parent, "access"));
    const credential = newCredential();
    let firstSocket = true;
    const laterConnectionBytes: Buffer[] = [];
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/mcp-bridge/proof") {
        const nonce = requestUrl.searchParams.get("nonce") ?? "";
        const proof = createHmac("sha256", credential).update(`shellx-motion-mcp-listener@1:${nonce}`, "utf8").digest("base64url");
        response.writeHead(200, { "content-type": "application/json", connection: "close" });
        response.end(`${JSON.stringify({ ok: true, proof })}\n`);
        return;
      }
      response.writeHead(500);
      response.end();
    });
    server.on("connection", (socket) => {
      if (firstSocket) { firstSocket = false; return; }
      socket.on("data", (chunk) => laterConnectionBytes.push(Buffer.from(chunk)));
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("channel fixture did not bind");
    await writeMotionMcpBridgeDiscovery(paths, { port: address.port, credential });
    const child = runBridge(paths.root);
    const responses = responseReader(child);
    const requestBody = JSON.stringify({ jsonrpc: "2.0", id: "channel-bound", method: "tools/list", params: {} });
    try {
      child.stdin.write(`${requestBody}\n`);
      expect(await responses.next()).toMatchObject({ id: "channel-bound", error: { code: -32000 } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const leaked = Buffer.concat(laterConnectionBytes).toString("utf8");
      expect(leaked).not.toContain(credential);
      expect(leaked).not.toContain(requestBody);
    } finally {
      child.kill();
      await close(server);
      await rm(parent, { recursive: true, force: true });
    }
  });
});

function runBridge(accessRoot: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, SHELLX_MOTION_ACCESS_ROOT: accessRoot },
    stdio: ["pipe", "pipe", "pipe"]
  });
}

async function testRoot(prefix: string): Promise<string> {
  const scratch = join(process.cwd(), ".scratch");
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  return await mkdtemp(join(scratch, prefix));
}

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
  return { next: () => {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for Motion MCP bridge response.")), 5000);
      waiters.push((value) => { clearTimeout(timer); resolve(value); });
    });
  } };
}

function newCredential(): string {
  return randomBytes(32).toString("base64url");
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
