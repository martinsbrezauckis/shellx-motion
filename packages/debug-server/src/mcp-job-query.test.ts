/**
 * The live job surface, exercised the way a host actually reaches it: over MCP.
 *
 * This is the surface ShellX Cut binds to. Cut reported that Motion had the internal foundation —
 * per-owner lease lookup, stable caller ids, a shared status vocabulary — but no registered action,
 * no dispatch and no MCP tool, so none of it was reachable. These tests fail if that regresses:
 * a command can exist in the registry and still be uncallable, and the two are different claims.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MotionJobLeaseDirectory, MotionJobRegistry, MotionJobView } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { startMotionDebugServer } from "./index";

const servers: Array<{ close: () => Promise<void> }> = [];
const tempRoots: string[] = [];
const RENDER_PACKAGE_ROOT = fileURLToPath(new URL("../../../fixtures/packages/lower-third", import.meta.url));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function jobServer(options: { callerId: string; crossCallerJobScope?: boolean; grantedTier?: "read_motion" | "write_local"; jobTrackingDisabled?: boolean }) {
  const root = await testRoot("shellx-motion-mcp-job-");
  const workspaceScratch = join(process.cwd(), ".scratch");
  tempRoots.push(root);
  const leases = new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") });
  const records = new MotionJobRegistry({ recordRoot: join(root, "records") });
  const workspaceAuthority = await createTrustedWorkspaceAnchor(workspaceScratch);
  const handle = await withTrustedWorkspaceAnchor(workspaceAuthority, async () => await startMotionDebugServer({
    host: "127.0.0.1",
    port: 0,
    grantedTier: options.grantedTier ?? "read_motion",
    context: {
      scratchRoot: join(root, "scratch"),
      authoringInputRoots: [workspaceScratch],
      authoringOutputRoots: [workspaceScratch],
      renderPackageRoots: [workspaceScratch, RENDER_PACKAGE_ROOT],
      renderInputRoots: [workspaceScratch],
      renderOutputRoots: [workspaceScratch],
      jobView: options.jobTrackingDisabled ? null : new MotionJobView({ leases, records }),
      callerId: options.callerId,
      ...(options.crossCallerJobScope === undefined ? {} : { crossCallerJobScope: options.crossCallerJobScope })
    },
    // Server startup only needs this isolated test workspace; template discovery is unrelated.
    useDefaultTemplateRoots: false
  }));
  servers.push(handle);
  const call = async (method: string, params: unknown = {}) => {
    const response = await fetch(new URL("/rpc", handle.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${handle.capabilityToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
    });
    return await response.json();
  };
  const tool = async (name: string, args: unknown = {}) => {
    const body = await call("tools/call", { name, arguments: { args } });
    return body.result.structuredContent as { ok: boolean; result?: any; error?: { code: string; message: string; suggestedAction?: string } };
  };
  const debug = async (command: string, args: unknown = {}) => {
    const response = await fetch(new URL("/debug", handle.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${handle.capabilityToken}` },
      body: JSON.stringify({ command, requestedTier: "read_motion", args })
    });
    return { status: response.status, body: await response.json() as { ok: boolean; result?: any; error?: { code: string; message: string } } };
  };
  return { leases, records, call, tool, debug, workspaceScratch };
}

describe("the job surface an MCP host binds to", () => {
  it("publishes the coordinator job commands as callable tools", async () => {
    const { call } = await jobServer({ callerId: "cut:workspace-7" });

    const { result } = await call("tools/list");
    const names = result.tools.map((entry: { name: string }) => entry.name);

    // Registered but unreachable is the exact failure Cut reported; the tool listing is the proof.
    expect(names).toContain("motion_job_get");
    expect(names).toContain("motion_job_list");
    expect(names).toContain("motion_job_events");
    expect(names).toContain("motion_job_submit");
    expect(names).toContain("motion_job_cancel");
    expect(names).toContain("motion_job_retry");
  }, 45_000);

  it("describes what each tool is FOR, not only its permission bits", async () => {
    const { call } = await jobServer({ callerId: "cut:workspace-7" });

    const { result } = await call("tools/list");
    const description = result.tools.find((entry: { name: string }) => entry.name === "motion_job_get")?.description as string;

    // The description is the only text most MCP clients ever show. It used to read
    // "ShellX Motion debug command motion.job.get. permission=... mutates=..." and nothing else.
    expect(description).toMatch(/pending, running, or ended/);
    expect(description).toContain("permission=read_motion");
  }, 45_000);

  it("does not advertise coordinator tools when the host disabled job tracking", async () => {
    const { call, tool, workspaceScratch } = await jobServer({ callerId: "cut:workspace-7", grantedTier: "write_local", jobTrackingDisabled: true });

    const { result } = await call("tools/list");
    const names = result.tools.map((entry: { name: string }) => entry.name);
    for (const name of ["motion_job_submit", "motion_job_get", "motion_job_list", "motion_job_events", "motion_job_cancel", "motion_job_retry"]) {
      expect(names).not.toContain(name);
    }

    // A cached MCP client may still call an old tool name. It receives the same typed lack of
    // authority as the direct Debug API and cannot create a default coordinator through that call.
    const refused = await tool("motion_job_submit", {
      packageRoot: RENDER_PACKAGE_ROOT,
      outputPath: join(workspaceScratch, "disabled-render.mp4"),
      preset: "mp4-h264"
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
  }, 45_000);

  it("publishes only stream-safe arguments for coordinator submission", async () => {
    const { call } = await jobServer({ callerId: "cut:workspace-7", grantedTier: "write_local" });

    const { result } = await call("tools/list");
    const submit = result.tools.find((entry: { name: string }) => entry.name === "motion_job_submit");
    const properties = submit.inputSchema.properties.args.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("packageRoot");
    expect(properties).not.toHaveProperty("keepFrames");
    expect(properties).not.toHaveProperty("workflowPath");
    expect(properties).not.toHaveProperty("qualityManifestPath");
    expect(properties).not.toHaveProperty("dryRun");
  }, 45_000);

  it("reports a live job as running, with a poll interval a client can obey", async () => {
    const { leases, tool } = await jobServer({ callerId: "cut:workspace-7" });
    await leases.announce({ jobId: "cut:render-1", lane: "ffmpeg", operation: "render.final", callerId: "cut:workspace-7", visibility: "host", admitted: true });

    const live = await tool("motion_job_get", { jobId: "cut:render-1" });

    // outcome stays null until the job ends, and pollAfterMs is how a client learns it should ask
    // again — its absence is the signal to stop.
    expect(live).toMatchObject({ ok: true, result: { job: { state: "running", lifecycle: "running", outcome: null, pollAfterMs: 2000 } } });
  }, 45_000);

  it("preserves a future connector failure and retry metadata through raw HTTP and MCP", async () => {
    const { records, tool, debug } = await jobServer({ callerId: "cut:workspace-7" });
    const endedAtMs = Date.now();
    await records.record({
      schema: "shellx-motion/job-record@1",
      jobId: "cut:future-typed-error",
      callerId: "cut:workspace-7",
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

    const expected = { job: { error: {
      code: "connector_future_backpressure",
      message: "future renderer is saturated",
      retryable: true,
      remedy: "wait",
      retryAfterMs: 2_500,
      suggestedAction: "Wait, then retry the same immutable binding."
    } } };
    const http = await debug("motion.job.get", { jobId: "cut:future-typed-error" });
    expect(http).toMatchObject({ status: 200, body: { ok: true, result: expected } });
    const ended = await tool("motion_job_get", { jobId: "cut:future-typed-error" });
    expect(ended).toMatchObject({ ok: true, result: expected });
  }, 45_000);

  it("separates a job that never existed from one whose evidence expired", async () => {
    const { tool } = await jobServer({ callerId: "cut:workspace-7" });

    const unknown = await tool("motion_job_get", { jobId: "cut:never-existed" });

    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("job_unknown");
    // The guidance comes from the authored contract, so the API and the docs cannot disagree.
    expect(unknown.error?.suggestedAction).toMatch(/re-read the submission response/i);
  }, 45_000);

  it("refuses cross-caller scope unless the host granted it", async () => {
    const { tool } = await jobServer({ callerId: "cut:workspace-7" });

    const denied = await tool("motion_job_list", { scope: "all" });

    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("permission_denied");
    // An agent cannot grant itself this, so the message must say who can.
    expect(denied.error?.suggestedAction).toMatch(/host operator/i);
  }, 45_000);

  it("honours cross-caller scope on a host that granted it", async () => {
    const { leases, tool } = await jobServer({ callerId: "operator:console", crossCallerJobScope: true });
    await leases.announce({ jobId: "ds:render-1", lane: "browser", operation: "render.final", callerId: "design-studio:main", visibility: "host", admitted: true });

    const listed = await tool("motion_job_list", { scope: "all" });

    expect(listed).toMatchObject({ ok: true, result: { jobCount: 1, jobs: [{ jobId: "ds:render-1", callerId: "design-studio:main" }] } });
  }, 45_000);

  it("never shows one host another host's work by default", async () => {
    // Cut and Design Studio share one machine and one capacity pool. They must not share evidence.
    const { leases, tool } = await jobServer({ callerId: "cut:workspace-7" });
    await leases.announce({ jobId: "ds:render-1", lane: "browser", operation: "render.final", callerId: "design-studio:main", visibility: "host", admitted: true });

    expect(await tool("motion_job_list", {})).toMatchObject({ ok: true, result: { jobCount: 0 } });
    expect((await tool("motion_job_get", { jobId: "ds:render-1" })).error?.code).toBe("job_not_visible");
  }, 45_000);

  it("rejects a bad scope by naming the two values it accepts", async () => {
    const { tool } = await jobServer({ callerId: "cut:workspace-7" });

    const invalid = await tool("motion_job_list", { scope: "everything" });

    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe("invalid_args");
    expect(invalid.error?.message).toMatch(/"own" or "all"/);
  }, 45_000);

  it("routes a natural-language status question to the live view, not the receipt view", async () => {
    // The receipt-file views cannot see work that is still running, so an agent asking
    // "is my render done" must not land on them.
    const { tool } = await jobServer({ callerId: "cut:workspace-7" });

    const found = await tool("motion_actions_find", { request: "is my render done" });

    expect(found).toMatchObject({ ok: true, result: { id: "motion.job.get", calls: ["motion.job.get"] } });
  }, 45_000);
});

describe("telling a host what this machine is missing", () => {
  it("reports FFmpeg as a named requirement with install commands, not a spawn error", async () => {
    // The failure this replaces: a user with no FFmpeg saw `spawn ffmpeg ENOENT` and concluded the
    // product was broken. ShellX Cut hit exactly that with new users.
    const { tool } = await jobServer({ callerId: "cut:workspace-7" });

    const answer = await tool("motion_platform_requirements", {});

    expect(answer.ok).toBe(true);
    const ffmpeg = answer.result.requirements.find((entry: { tool: string }) => entry.tool === "ffmpeg");
    expect(ffmpeg).toBeDefined();
    expect(ffmpeg.requiredFor).toMatch(/encoding final video/i);
    // Whether or not this machine has it, the install path must be answerable — that is the point.
    expect(ffmpeg.installOptions.length).toBeGreaterThan(0);
    expect(ffmpeg.overrideEnvVar).toBe("SHELLX_MOTION_FFMPEG");
    expect(typeof answer.result.satisfied).toBe("boolean");
  }, 45_000);

  it("routes 'why does rendering fail' to the requirements check", async () => {
    const { tool } = await jobServer({ callerId: "cut:workspace-7" });

    const found = await tool("motion_actions_find", { request: "why does rendering fail" });

    expect(found).toMatchObject({ ok: true, result: { id: "motion.platform.requirements" } });
  }, 45_000);
});

describe("the cold start an agent needs to begin at all", () => {
  it("creates a package from nothing, and the created package validates", async () => {
    // An outside agent given only the docs and these tools could not start: every authoring command
    // edits an existing package, and every route that made one was an importer. It recovered only
    // because an unrelated fixture happened to be in the machine's temp directory.
    // write_local: creating a package writes files, and the tier gate correctly refuses it below that.
    const { tool } = await jobServer({ callerId: "cut:workspace-7", grantedTier: "write_local" });
    const root = await testRoot("shellx-motion-cold-start-");
    tempRoots.push(root);
    const packageRoot = join(root, "piece");

    const created = await tool("motion_package_create", { packageRoot, name: "Cold Start", durationMs: 2000 });

    expect(created).toMatchObject({ ok: true, result: { layerCount: 1 } });
    // Readable stem from the name, unique suffix from the package: two packages called "Cold Start"
    // used to share one id, which made them one package to receipts, caches and host lineage.
    expect(created.result.packageId).toMatch(/^pkg_cold_start_[0-9a-f]{16}$/);
    // The second call must be knowable from the first: a cold-start agent has just learned this
    // command exists and needs to be told where to go next.
    expect(created.result.nextSteps.length).toBeGreaterThan(0);

    const validated = await tool("motion_package_validate", { packageRoot });
    expect(validated).toMatchObject({ ok: true, result: { valid: true, layers: 1, durationMs: 2000 } });
  }, 45_000);

  it("refuses to create over an existing package instead of half-overwriting it", async () => {
    // write_local: creating a package writes files, and the tier gate correctly refuses it below that.
    const { tool } = await jobServer({ callerId: "cut:workspace-7", grantedTier: "write_local" });
    const root = await testRoot("shellx-motion-cold-start-");
    tempRoots.push(root);
    const packageRoot = join(root, "piece");
    await tool("motion_package_create", { packageRoot });

    const again = await tool("motion_package_create", { packageRoot });

    expect(again.ok).toBe(false);
    expect(again.error?.message).toMatch(/not empty/i);
  }, 45_000);

  it("reports an invalid package by naming the field, without rendering", async () => {
    // write_local: creating a package writes files, and the tier gate correctly refuses it below that.
    const { tool } = await jobServer({ callerId: "cut:workspace-7", grantedTier: "write_local" });
    const root = await testRoot("shellx-motion-cold-start-");
    tempRoots.push(root);
    const invalidPackageRoot = join(root, "nothing-here");
    await mkdir(invalidPackageRoot, { mode: 0o700 });

    const answer = await tool("motion_package_validate", { packageRoot: invalidPackageRoot });

    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe("invalid_args");
  }, 45_000);

  it("routes a cold-start question to create, not to the glTF importer", async () => {
    // The exact query that failed: it ranked motion.scene3d.gltf.import first, sending an agent
    // with a blank page to import a 3D model it did not have.
    const { tool } = await jobServer({ callerId: "cut:workspace-7" });

    expect(await tool("motion_actions_find", { request: "create new empty motion package" }))
      .toMatchObject({ ok: true, result: { id: "motion.package.create" } });
    expect(await tool("motion_actions_find", { request: "validate package" }))
      .toMatchObject({ ok: true, result: { id: "motion.package.validate" } });
    // And the importer must still win its own queries.
    expect(await tool("motion_actions_find", { request: "import this glb model and render it in canvas" }))
      .toMatchObject({ ok: true, result: { id: "motion.scene3d.gltf.import" } });
  }, 45_000);
});

async function testRoot(prefix: string): Promise<string> {
  const scratch = join(process.cwd(), ".scratch");
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  return await mkdtemp(join(scratch, prefix));
}
