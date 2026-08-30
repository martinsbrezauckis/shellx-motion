import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { MotionJobCoordinator, MotionJobLeaseDirectory, MotionJobRegistry, MotionJobView } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { startMotionDebugServer } from "./index";
import { motionUserAccessPaths, readOrCreatePersistentCapabilityFile, writeMotionMcpBridgeDiscovery } from "./user-access";

const BRIDGE = fileURLToPath(new URL("../bin/shellx-motion-mcp.mjs", import.meta.url));
const RENDER_PACKAGE_ROOT = fileURLToPath(new URL("../../../fixtures/packages/lower-third", import.meta.url));

describe("installed MCP stdio bridge", () => {
  it("withholds the durable bearer from a stale rebound discovery port and resumes with a restarted listener", async () => {
    const parent = await testRoot("motion-mcp-bridge-stale-discovery-");
    const paths = motionUserAccessPaths(join(parent, "access"));
    const access = await readOrCreatePersistentCapabilityFile(paths);
    const firstCredential = newBridgeCredential();
    let server = await startMotionDebugServer({
      port: 0,
      capabilityToken: access.token,
      mcpBridgeCredential: firstCredential,
      grantedTier: "read_motion",
      context: { scratchRoot: join(parent, "scratch") },
      useDefaultTemplateRoots: false
    });
    const port = Number(server.url.port);
    await writeMotionMcpBridgeDiscovery(paths, { port, credential: firstCredential });
    const bridgeCredentialOutsideMcp = await globalThis.fetch(new URL("/debug/contracts", server.url), {
      headers: { "x-shellx-motion-mcp-bridge-credential": firstCredential }
    });
    expect(bridgeCredentialOutsideMcp.status).toBe(401);
    const child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, SHELLX_MOTION_ACCESS_ROOT: paths.root },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const responses = responseReader(child);
    let rebound: Server | undefined;
    let sawDurableBearer = false;
    let sawPerStartBridgeCredential = false;
    let sawMcpRequestBody = false;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "before-crash", method: "tools/list", params: {} })}\n`);
      expect(await responses.next()).toMatchObject({ id: "before-crash", result: { tools: expect.any(Array) } });

      // Simulate a process death: the listener stops but its private discovery record is retained.
      await server.close();
      rebound = createServer((request, response) => {
        sawDurableBearer ||= typeof request.headers.authorization === "string";
        sawPerStartBridgeCredential ||= typeof request.headers["x-shellx-motion-mcp-bridge-credential"] === "string";
        sawMcpRequestBody ||= request.method === "POST";
        response.writeHead(503, { "content-type": "application/json" });
        response.end(`${JSON.stringify({ jsonrpc: "2.0", id: "stale", error: { code: -32000, message: "unavailable" } })}\n`);
      });
      await listen(rebound, port);

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "stale", method: "tools/list", params: {} })}\n`);
      expect(await responses.next()).toMatchObject({ id: "stale", error: { code: -32000 } });
      expect(sawDurableBearer).toBe(false);
      expect(sawPerStartBridgeCredential).toBe(false);
      expect(sawMcpRequestBody).toBe(false);

      await close(rebound);
      rebound = undefined;
      const restartedCredential = newBridgeCredential();
      server = await startMotionDebugServer({
        port,
        capabilityToken: access.token,
        mcpBridgeCredential: restartedCredential,
        grantedTier: "read_motion",
        context: { scratchRoot: join(parent, "scratch-restarted") },
        useDefaultTemplateRoots: false
      });
      await writeMotionMcpBridgeDiscovery(paths, { port, credential: restartedCredential });

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "after-restart", method: "tools/list", params: {} })}\n`);
      expect(await responses.next()).toMatchObject({ id: "after-restart", result: { tools: expect.any(Array) } });
    } finally {
      if (rebound?.listening) await close(rebound);
      if (server.server.listening) await server.close();
      child.kill();
      await rm(parent, { recursive: true, force: true });
    }
  }, 45_000);

  it("reads the private live connection, forwards MCP, and gives a clear stopped-engine result", async () => {
    const parent = await testRoot("motion-mcp-bridge-");
    const paths = motionUserAccessPaths(join(parent, "access"));
    const access = await readOrCreatePersistentCapabilityFile(paths);
    const bridgeCredential = newBridgeCredential();
    const leases = new MotionJobLeaseDirectory({ leaseRoot: join(parent, "leases") });
    const records = new MotionJobRegistry({ recordRoot: join(parent, "records") });
    const endedAtMs = Date.now();
    await records.record({
      schema: "shellx-motion/job-record@1",
      jobId: "cut:bridge-future-error",
      callerId: "cut:bridge-test",
      lane: "connector",
      operation: "connector.future-scene@1",
      lifecycle: "ended",
      outcome: "failed",
      createdAtMs: endedAtMs - 1,
      endedAtMs,
      durationMs: 1,
      queueWaitMs: 1,
      error: {
        code: "connector_future_backpressure",
        message: "future renderer is saturated",
        retryable: true,
        remedy: "wait",
        retryAfterMs: 2_500,
        suggestedAction: "Wait, then retry the same immutable binding."
      },
      warnings: []
    });
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: access.token,
      mcpBridgeCredential: bridgeCredential,
      grantedTier: "read_motion",
      context: {
        scratchRoot: join(parent, "scratch"),
        callerId: "cut:bridge-test",
        jobView: new MotionJobView({ leases, records })
      },
      useDefaultTemplateRoots: false
    });
    await writeMotionMcpBridgeDiscovery(paths, { port: Number(server.url.port), credential: bridgeCredential });
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

      // Coordinator ownership uses a persistent socket without regressing normal modern MCP HTTP
      // metadata/header compatibility.
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "modern-tools",
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "bridge-modern-test", version: "1" }
          }
        }
      })}\n`);
      expect(await responses.next()).toMatchObject({
        jsonrpc: "2.0",
        id: "modern-tools",
        result: { resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": { name: "shellx-motion-debug-server" } } }
      });

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "future-error",
        method: "tools/call",
        params: { name: "motion_job_get", arguments: { args: { jobId: "cut:bridge-future-error" } } }
      })}\n`);
      expect(await responses.next()).toMatchObject({
        jsonrpc: "2.0",
        id: "future-error",
        result: { isError: false, structuredContent: { ok: true, result: { job: { error: {
          code: "connector_future_backpressure",
          message: "future renderer is saturated",
          retryable: true,
          remedy: "wait",
          retryAfterMs: 2_500,
          suggestedAction: "Wait, then retry the same immutable binding."
        } } } } }
      });

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

  it("keeps coordinator ownership for one stdio bridge process and isolates another", async () => {
    const parent = await testRoot("motion-mcp-bridge-owner-");
    const paths = motionUserAccessPaths(join(parent, "access"));
    const access = await readOrCreatePersistentCapabilityFile(paths);
    const bridgeCredential = newBridgeCredential();
    const jobs = new MotionJobCoordinator({
      leases: new MotionJobLeaseDirectory({ leaseRoot: join(parent, "leases") }),
      records: new MotionJobRegistry({ recordRoot: join(parent, "records") }),
      eventsRoot: join(parent, "events")
    });
    const server = await startMotionDebugServer({
      port: 0,
      capabilityToken: access.token,
      mcpBridgeCredential: bridgeCredential,
      grantedTier: "render_motion",
      context: {
        scratchRoot: join(parent, "scratch"),
        renderPackageRoots: [RENDER_PACKAGE_ROOT],
        renderOutputRoots: [parent],
        jobView: jobs.jobView(),
        jobCoordinator: jobs
      },
      useDefaultTemplateRoots: false
    });
    await writeMotionMcpBridgeDiscovery(paths, { port: Number(server.url.port), credential: bridgeCredential });
    const owner = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, SHELLX_MOTION_ACCESS_ROOT: paths.root },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const other = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, SHELLX_MOTION_ACCESS_ROOT: paths.root },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const ownerResponses = responseReader(owner);
    const otherResponses = responseReader(other);
    const jobId = `stdio-owner-${Date.now()}`;
    try {
      await initializeBridge(owner, ownerResponses, "owner-initialize");
      await initializeBridge(other, otherResponses, "other-initialize");

      owner.stdin.write(`${JSON.stringify(toolCall("submit", "motion_job_submit", {
        jobId,
        packageRoot: RENDER_PACKAGE_ROOT,
        outputPath: join(parent, "missing-motion-output.mp4"),
        preset: "mp4-h264"
      }))}\n`);
      expect(await ownerResponses.next()).toMatchObject({
        id: "submit",
        result: { isError: false, structuredContent: { ok: true, command: "motion.job.submit", result: { jobId } } }
      });

      owner.stdin.write(`${JSON.stringify(toolCall("owner-get", "motion_job_get", { jobId }))}\n`);
      expect(await ownerResponses.next()).toMatchObject({
        id: "owner-get",
        result: { isError: false, structuredContent: { ok: true, result: { job: { jobId } } } }
      });
      owner.stdin.write(`${JSON.stringify(toolCall("owner-list", "motion_job_list", {}))}\n`);
      expect(await ownerResponses.next()).toMatchObject({
        id: "owner-list",
        result: { isError: false, structuredContent: { ok: true, result: { jobCount: 1, jobs: [expect.objectContaining({ jobId })] } } }
      });

      // A separately spawned bridge receives a separate server-minted connection principal even
      // though both processes can read the same local access token.
      other.stdin.write(`${JSON.stringify(toolCall("other-get", "motion_job_get", { jobId }))}\n`);
      expect(await otherResponses.next()).toMatchObject({
        id: "other-get",
        result: { isError: true, structuredContent: { ok: false, error: { code: "job_not_visible" } } }
      });
      other.stdin.write(`${JSON.stringify(toolCall("other-list", "motion_job_list", {}))}\n`);
      expect(await otherResponses.next()).toMatchObject({
        id: "other-list",
        result: { isError: false, structuredContent: { ok: true, result: { jobCount: 0, jobs: [] } } }
      });
    } finally {
      // The bridge keeps coordinator ownership on upgraded sockets; server shutdown must end those
      // sockets itself rather than waiting for each stdio process to exit first.
      if (server.server.listening) await server.close();
      owner.kill();
      other.kill();
      await rm(parent, { recursive: true, force: true });
    }
  }, 45_000);

  it("uses only server-configured authoring roots for raw HTTP create and persistent stdio MCP edit", async () => {
    const parent = await testRoot("motion-mcp-authoring-roots-");
    const paths = motionUserAccessPaths(join(parent, "access"));
    const access = await readOrCreatePersistentCapabilityFile(paths);
    const inputRoot = join(parent, "inputs");
    const outputRoot = join(parent, "outputs");
    const outsideRoot = join(parent, "outside");
    const unapprovedPackage = join(outputRoot, "unapproved");
    const createdPackage = join(outputRoot, "created");
    const inputPackage = join(inputRoot, "created");
    const editedPackage = join(outputRoot, "edited");
    let server: Awaited<ReturnType<typeof startMotionDebugServer>> | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      await Promise.all([
        mkdir(inputRoot, { mode: 0o700 }),
        mkdir(outputRoot, { mode: 0o700 }),
        mkdir(outsideRoot, { mode: 0o700 })
      ]);

      const workspaceAuthority = await createTrustedWorkspaceAnchor(parent);
      await withTrustedWorkspaceAnchor(workspaceAuthority, async () => {
      const bridgeCredential = newBridgeCredential();
      server = await startMotionDebugServer({
        port: 0,
        capabilityToken: access.token,
        mcpBridgeCredential: bridgeCredential,
        grantedTier: "write_local",
        context: { scratchRoot: join(parent, "scratch") },
        useDefaultTemplateRoots: false
      });
      const absent = await postDebug(server, access.token, {
        command: "motion.package.create",
        requestedTier: "write_local",
        args: { packageRoot: unapprovedPackage, name: "Unapproved" }
      });
      expect(absent.status).toBe(403);
      expect(absent.body).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved", message: expect.stringMatching(/host-approved authoring input and output roots/) } });
      await expect(readFile(join(unapprovedPackage, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const callerMint = await postDebug(server, access.token, {
        command: "motion.package.create",
        requestedTier: "write_local",
        args: {
          packageRoot: join(outsideRoot, "caller-minted"),
          authoringInputRoots: [inputRoot],
          authoringOutputRoots: [outsideRoot]
        }
      });
      expect(callerMint.status).toBe(400);
      expect(callerMint.body).toMatchObject({ ok: false, error: { code: "invalid_args" } });
      await server.close();

      server = await startMotionDebugServer({
        port: 0,
        capabilityToken: access.token,
        mcpBridgeCredential: bridgeCredential,
        grantedTier: "write_local",
        context: {
          scratchRoot: join(parent, "scratch"),
          authoringInputRoots: [inputRoot],
          authoringOutputRoots: [outputRoot]
        },
        useDefaultTemplateRoots: false
      });
      await writeMotionMcpBridgeDiscovery(paths, { port: Number(server.url.port), credential: bridgeCredential });

      const created = await postDebug(server, access.token, {
        command: "motion.package.create",
        requestedTier: "write_local",
        args: { packageRoot: createdPackage, name: "Transport roots", durationMs: 1000 }
      });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ ok: true, command: "motion.package.create", result: { layerCount: 1 } });
      await expect(readFile(join(createdPackage, "manifest.json"), "utf8")).resolves.toContain('"name": "Transport roots"');
      await cp(createdPackage, inputPackage, { recursive: true });

      child = spawn(process.execPath, [BRIDGE], {
        env: { ...process.env, SHELLX_MOTION_ACCESS_ROOT: paths.root },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const responses = responseReader(child);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "authoring-roots-test", version: "1" } }
      })}\n`);
      expect(await responses.next()).toMatchObject({ jsonrpc: "2.0", id: "initialize", result: { capabilities: { tools: {} } } });

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "edit",
        method: "tools/call",
        params: {
          name: "motion_timeline_layer_create",
          arguments: {
            requestedTier: "edit_motion",
            args: {
              packageRoot: inputPackage,
              outDir: editedPackage,
              createdBy: "stdio-authoring-roots-test",
              layer: {
                id: "accent",
                type: "shape",
                shape: "ellipse",
                fill: "#ffffff",
                startMs: 0,
                durationMs: 1000,
                transform: { x: 10, y: 10, width: 24, height: 24 }
              }
            }
          }
        }
      })}\n`);
      expect(await responses.next()).toMatchObject({
        jsonrpc: "2.0",
        id: "edit",
        result: { isError: false, structuredContent: { ok: true, command: "motion.timeline.layer.create", result: { layerId: "accent" } } }
      });
      await expect(readFile(join(editedPackage, "receipts", "timeline-layer-create.receipt.json"), "utf8")).resolves.toContain('"status": "passed"');

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "outside",
        method: "tools/call",
        params: {
          name: "motion_timeline_layer_create",
          arguments: {
            requestedTier: "edit_motion",
            args: {
              packageRoot: inputPackage,
              outDir: join(outsideRoot, "edited"),
              layer: {
                id: "outside",
                type: "shape",
                shape: "ellipse",
                fill: "#ffffff",
                startMs: 0,
                durationMs: 1000,
                transform: { x: 10, y: 10, width: 24, height: 24 }
              }
            }
          }
        }
      })}\n`);
      expect(await responses.next()).toMatchObject({
        jsonrpc: "2.0",
        id: "outside",
        result: { isError: true, structuredContent: { ok: false, error: { code: "authoring_path_not_approved" } } }
      });
      await expect(readFile(join(outsideRoot, "edited", "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      child?.kill();
      if (server?.server.listening) await server.close();
      await rm(parent, { recursive: true, force: true });
    }
  }, 45_000);
});

async function postDebug(
  server: Awaited<ReturnType<typeof startMotionDebugServer>>,
  token: string,
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await globalThis.fetch(new URL("/debug", server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
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

async function initializeBridge(
  child: ChildProcessWithoutNullStreams,
  responses: { next: () => Promise<Record<string, unknown>> },
  id: string
): Promise<void> {
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge-owner-test", version: "1" } }
  })}\n`);
  expect(await responses.next()).toMatchObject({ id, result: { serverInfo: { name: "shellx-motion-debug-server" } } });
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: { requestedTier: "render_motion", args } }
  };
}

function newBridgeCredential(): string {
  return randomBytes(32).toString("base64url");
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
