/** Live HTTP regressions for the shared external render-root boundary. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOTION_SDK_SCHEMA, motionSdkCacheKey, type MotionSdkOperation } from "@shellx-motion/sdk";
import { startMotionDebugServer } from "./index.js";

const TOKEN = "render-root-transport-fence-token-000000000000";
let hostRoot: string;
let foreignRoot: string;
const servers: Array<{ close: () => Promise<void> }> = [];

beforeEach(async () => {
  hostRoot = await mkdtemp(join(tmpdir(), "motion-render-root-host-"));
  foreignRoot = await mkdtemp(join(tmpdir(), "motion-render-root-foreign-"));
  await mkdir(join(hostRoot, "package"), { mode: 0o700 });
  await mkdir(join(foreignRoot, "package"), { mode: 0o700 });
  await writeFile(join(foreignRoot, "workflow.json"), "{}", { mode: 0o600 });
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await rm(hostRoot, { recursive: true, force: true });
  await rm(foreignRoot, { recursive: true, force: true });
});

describe("external render roots across authenticated transports", () => {
  it("refuses foreign SDK package, preview output/workflow, cache-output, and cache-input paths before execution", async () => {
    const execute = vi.fn();
    const server = await startMotionDebugServer({
      port: 0,
      grantedTier: "render_motion",
      capabilityToken: TOKEN,
      context: {
        scratchRoot: hostRoot,
        renderPackageRoots: [hostRoot],
        renderInputRoots: [hostRoot],
        renderOutputRoots: [hostRoot]
      },
      sdkTransport: { execute }
    });
    servers.push(server);

    const packageAnswer = await postSdk(server.url, "validate", { packageRoot: join(foreignRoot, "package") });
    expect(packageAnswer).toMatchObject({ status: 403, body: { error: { code: "render_path_not_approved" } } });

    const previewAnswer = await postSdk(server.url, "preview", {
      packageRoot: join(hostRoot, "package"), outDir: join(foreignRoot, "preview")
    });
    expect(previewAnswer).toMatchObject({ status: 403, body: { error: { code: "render_path_not_approved" } } });

    const previewWorkflowAnswer = await postSdk(server.url, "preview", {
      packageRoot: join(hostRoot, "package"), outDir: join(hostRoot, "preview"),
      workflowPath: join(foreignRoot, "workflow.json")
    });
    expect(previewWorkflowAnswer).toMatchObject({ status: 403, body: { error: { code: "render_path_not_approved" } } });

    const cacheOutputAnswer = await postSdk(server.url, "renderCachePlan", {
      packageRoot: join(hostRoot, "package"), outputPath: join(foreignRoot, "cache.mp4"), preset: "mp4-h264"
    });
    expect(cacheOutputAnswer).toMatchObject({ status: 403, body: { error: { code: "render_path_not_approved" } } });

    const cacheInputAnswer = await postSdk(server.url, "renderCachePlan", {
      packageRoot: join(hostRoot, "package"), outputPath: join(hostRoot, "cache.mp4"),
      preset: "mp4-h264", workflowPath: join(foreignRoot, "workflow.json")
    });
    expect(cacheInputAnswer).toMatchObject({ status: 403, body: { error: { code: "render_path_not_approved" } } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a foreign package read on authenticated POST /debug before dispatch", async () => {
    const server = await startMotionDebugServer({
      port: 0,
      grantedTier: "read_motion",
      capabilityToken: TOKEN,
      context: { scratchRoot: hostRoot, renderPackageRoots: [hostRoot] }
    });
    servers.push(server);
    const response = await fetch(new URL("/debug", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ command: "motion.timeline.inspect", args: { packageRoot: join(foreignRoot, "package") } })
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "render_path_not_approved" } });
  });
});

async function postSdk(url: URL, operation: MotionSdkOperation, input: Record<string, unknown>) {
  const cacheKey = await motionSdkCacheKey(operation, input);
  const response = await fetch(new URL("/sdk", url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      schema: MOTION_SDK_SCHEMA, operation, requestId: `sdk-${operation}-${cacheKey.slice(0, 20)}`, cacheKey, input
    })
  });
  return { status: response.status, body: await response.json() };
}
