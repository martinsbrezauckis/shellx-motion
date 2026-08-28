import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MotionJobCoordinator, MotionJobLeaseDirectory, MotionJobRegistry } from "@shellx-motion/core";
import { startMotionDebugServer, type MotionDebugServerHandle, type MotionDebugServerOptions } from "./index.js";

const CAPABILITY_TOKEN = "test-capability-token-000000000000000000000000";
const WS_PROTOCOL = "shellx-motion-debug-v1";
const RENDER_PACKAGE_ROOT = fileURLToPath(new URL("../../../fixtures/packages/lower-third", import.meta.url));

function startServer({ context, ...options }: MotionDebugServerOptions): Promise<MotionDebugServerHandle> {
  return startMotionDebugServer({
    ...options,
    capabilityToken: CAPABILITY_TOKEN,
    useDefaultTemplateRoots: false,
    context: { scratchRoot: join(process.cwd(), ".scratch", "job-owner-principal-uncreated"), ...context }
  });
}

function socket(server: MotionDebugServerHandle): WebSocket {
  return new WebSocket(new URL("/ws", server.url).toString().replace(/^http/, "ws"), [WS_PROTOCOL, `shellx-motion-token.${CAPABILITY_TOKEN}`]);
}

function read(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for WebSocket message.")); }, 1_000);
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener("message", onMessage); socket.removeEventListener("error", onError); };
    const onMessage = (event: MessageEvent) => { cleanup(); try { resolve(JSON.parse(String(event.data)) as Record<string, unknown>); } catch (error) { reject(error); } };
    const onError = () => { cleanup(); reject(new Error("WebSocket errored while waiting for a message.")); };
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
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

async function tool(socket: WebSocket, id: string, name: string, args: Record<string, unknown>): Promise<Record<string, any> | undefined> {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { requestedTier: "render_motion", args } } }));
  return (await read(socket) as { result?: { structuredContent?: Record<string, any> } }).result?.structuredContent;
}

async function initialize(socket: WebSocket, id: string, clientInfo?: { name: string; version: string }): Promise<void> {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", ...(clientInfo ? { clientInfo } : {}) } }));
  await read(socket);
}

function coordinator(root: string): MotionJobCoordinator {
  return new MotionJobCoordinator({ leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }), records: new MotionJobRegistry({ recordRoot: join(root, "records") }), eventsRoot: join(root, "events") });
}

const renderArgs = (jobId: string, outputRoot: string) => ({
  jobId,
  packageRoot: RENDER_PACKAGE_ROOT,
  outputPath: join(outputRoot, "missing-motion-output.mp4"),
  preset: "mp4-h264"
});

describe("debug server job owner principals", () => {
  it("fails closed for stateless HTTP job access without a host-authenticated principal", async () => {
    const server = await startServer({ port: 0, grantedTier: "render_motion" });
    try {
      const response = await globalThis.fetch(new URL("/debug", server.url), {
        method: "POST",
        headers: { authorization: `Bearer ${CAPABILITY_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ command: "motion.job.list", requestedTier: "render_motion", args: {} })
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(503);
      expect(body).toMatchObject({
        ok: false,
        error: { code: "capability_unavailable", message: expect.stringContaining("owner principal") }
      });
    } finally {
      await server.close();
    }
  });

  it("does not turn a stateless MCP HTTP request into a reusable job owner", async () => {
    const server = await startServer({ port: 0, grantedTier: "render_motion" });
    try {
      const response = await globalThis.fetch(new URL("/rpc", server.url), {
        method: "POST",
        headers: { authorization: `Bearer ${CAPABILITY_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "stateless-list",
          method: "tools/call",
          params: { name: "motion_job_list", arguments: { requestedTier: "render_motion", args: {} } }
        })
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({
        id: "stateless-list",
        result: { isError: true, structuredContent: { ok: false, error: { code: "capability_unavailable", message: expect.stringContaining("owner principal") } } }
      });
    } finally {
      await server.close();
    }
  });

  it("binds live jobs to opaque authenticated connection principals, not MCP labels", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-owner-principal-"));
    const jobs = coordinator(root);
    const server = await startServer({
      port: 0,
      grantedTier: "render_motion",
      context: { renderPackageRoots: [RENDER_PACKAGE_ROOT], renderOutputRoots: [root], jobView: jobs.jobView(), jobCoordinator: jobs }
    });
    const owner = socket(server);
    const other = socket(server);
    try {
      await Promise.all([open(owner), open(other)]);
      await initialize(owner, "owner-init", { name: "victim-mcp", version: "1.0" });
      const jobId = `ownership-${Date.now()}`;
      expect(await tool(owner, "owner-submit", "motion_job_submit", renderArgs(jobId, root))).toMatchObject({ ok: true, result: { jobId } });

      const rejectsEveryJobOperation = async (label: string) => {
        for (const [id, name, args] of [["get", "motion_job_get", { jobId }], ["list", "motion_job_list", {}], ["events", "motion_job_events", { jobId }], ["cancel", "motion_job_cancel", { jobId }], ["retry", "motion_job_retry", { jobId }]] as const) {
          const result = await tool(other, `${label}-${id}`, name, args);
          if (name === "motion_job_list") expect(result).toMatchObject({ ok: true, result: { jobCount: 0, jobs: [] } });
          else expect(result).toMatchObject({ ok: false, error: { code: "job_not_visible" } });
        }
        expect(await tool(other, `${label}-snapshot`, "motion_agent_snapshot", {})).toMatchObject({ ok: true, result: { jobs: { count: 0, recent: [] } } });
      };
      await rejectsEveryJobOperation("default");

      // A copied initialize `clientInfo` remains receipt attribution only, never job ownership.
      await initialize(other, "spoof-init", { name: "victim-mcp", version: "1.0" });
      await rejectsEveryJobOperation("spoof");
      expect(await tool(owner, "owner-list", "motion_job_list", {})).toMatchObject({ ok: true, result: { jobCount: 1, jobs: [expect.objectContaining({ jobId })] } });
    } finally {
      owner.close(); other.close(); await server.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves job access across reconnect only for an explicit host-configured principal", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-owner-reconnect-"));
    const jobs = coordinator(root);
    const server = await startServer({
      port: 0,
      grantedTier: "render_motion",
      context: {
        callerId: "host-authenticated-workspace",
        renderPackageRoots: [RENDER_PACKAGE_ROOT],
        renderOutputRoots: [root],
        jobView: jobs.jobView(),
        jobCoordinator: jobs
      }
    });
    const initial = socket(server);
    let reconnected: WebSocket | undefined;
    try {
      await open(initial);
      const jobId = `reconnect-${Date.now()}`;
      expect(await tool(initial, "submit", "motion_job_submit", renderArgs(jobId, root))).toMatchObject({ ok: true, result: { jobId } });
      initial.close();
      reconnected = socket(server);
      await open(reconnected);
      expect(await tool(reconnected, "reconnect-get", "motion_job_get", { jobId })).toMatchObject({ ok: true, result: { job: { jobId } } });
    } finally {
      initial.close(); reconnected?.close(); await server.close(); await rm(root, { recursive: true, force: true });
    }
  });
});
