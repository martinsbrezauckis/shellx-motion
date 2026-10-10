/** Coordinator admission and disable-policy regression coverage. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseCoordinatedRenderSubmit } from "./coordinated-render-submit.js";
import { submitCoordinatedRender } from "./coordinator-submit-handler.js";
import { dispatchDebugCommand } from "./index.js";
import { MotionJobCoordinator, MotionJobLeaseDirectory, MotionJobRegistry, MotionRenderPlanStore } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import type { FinalRenderRequest } from "./domains/render-final.js";

const base = { packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath: "/renders/output.mp4", preset: "mp4-h264" };
const lifecycleRoots: string[] = [];

afterEach(async () => {
  await Promise.all(lifecycleRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function preparedFinal(renderArgs: Record<string, unknown>): FinalRenderRequest {
  return {
    packageRoot: renderArgs.packageRoot as string,
    outputPath: renderArgs.outputPath as string,
    frameLane: (renderArgs.frameLane ?? "browser") as FinalRenderRequest["frameLane"],
    preset: (renderArgs.preset ?? "mp4-h264") as FinalRenderRequest["preset"],
    dryRun: false,
    reuseAttested: false,
    ...(typeof renderArgs.segmented === "object" && renderArgs.segmented !== null ? { segmented: renderArgs.segmented as { segmentFrames: number; resume?: boolean } } : {})
  };
}

function coordinatorSpy() {
  return {
    submit: vi.fn(),
    jobView: vi.fn(),
    events: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn()
  } as unknown as MotionJobCoordinator;
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for coordinator state.");
}

describe("coordinator render admission", () => {
  it("builds a fresh stream-safe render request and never leaks submit jobId into render.final", () => {
    const parsed = parseCoordinatedRenderSubmit({ ...base, jobId: "cut:coordinator-id", frameLane: "native" });

    expect(parsed).toEqual({
      ok: true,
      value: {
        jobId: "cut:coordinator-id",
        renderArgs: { ...base, frameLane: "native" }
      }
    });
    if (parsed.ok) expect(parsed.value.renderArgs).not.toHaveProperty("jobId");
  });

  it("admits only the closed durable segmented selector for coordinator cancellation", () => {
    expect(parseCoordinatedRenderSubmit({ ...base, segmented: { segmentFrames: 120, resume: true } })).toEqual({
      ok: true,
      value: { renderArgs: { ...base, segmented: { segmentFrames: 120, resume: true } } }
    });
    expect(parseCoordinatedRenderSubmit({ ...base, segmented: { segmentFrames: 120, storeRoot: "/caller-controlled" } })).toMatchObject({
      ok: false, message: expect.stringContaining("segmented")
    });
  });

  it("keeps browser, provider, and hybrid-capture authority out of durable GPU job arguments", () => {
    for (const [field, value] of [
      ["browserLocation", "/caller/browser"],
      ["browserSessionFactory", "caller-factory"],
      ["openVideoProvider", "caller-provider"],
      ["providerFactory", "caller-provider-factory"],
      ["openHybridCapture", "caller-capture"],
      ["hybridCapture", { source: "caller-controlled" }],
      ["capturePlan", { range: 0 }]
    ] as const) {
      expect(parseCoordinatedRenderSubmit({
        ...base,
        frameLane: "gpu",
        segmented: { segmentFrames: 120, resume: true },
        [field]: value
      })).toMatchObject({ ok: false, message: expect.stringContaining(field) });
    }
  });

  it("admits GPU only for a strict final video, preserving the selected frame lane without queueing unsupported presets", async () => {
    expect(parseCoordinatedRenderSubmit({ ...base, frameLane: "gpu" })).toEqual({
      ok: true,
      value: { renderArgs: { ...base, frameLane: "gpu" } }
    });
    const coordinator = coordinatorSpy();
    for (const args of [{ ...base, frameLane: "gpu", preset: "gif" }]) {
      const result = await dispatchDebugCommand("motion.job.submit", args, {
        tier: "render_motion", callerId: "test-host-principal", jobCoordinator: coordinator, gpuFinalExecutionAvailable: true
      });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
      expect(coordinator.submit).not.toHaveBeenCalled();
    }

    const unavailable = await dispatchDebugCommand("motion.job.submit", { ...base, frameLane: "gpu" }, {
      tier: "render_motion", callerId: "test-host-principal", jobCoordinator: coordinator,
      gpuFinalExecutionAvailable: false
    });
    expect(unavailable).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: expect.stringContaining("no GPU job was queued") } });
    expect(coordinator.submit).not.toHaveBeenCalled();
  });

  it("routes GPU segmented resume through the coordinator's exact final path without injected-browser fallback", async () => {
    let executed: FinalRenderRequest | undefined;
    const coordinator = {
      submit: vi.fn(async (input) => {
        await input.execute(new AbortController().signal);
        return { ok: true as const, value: { jobId: "cut:gpu-segmented" } };
      }),
      jobView: vi.fn(() => ({ get: vi.fn(async () => ({ ok: true as const, job: { state: "pending", lifecycle: "pending" } })) }))
    } as unknown as MotionJobCoordinator;
    const result = await withTrustedWorkspaceAnchor(
      await createTrustedWorkspaceAnchor(resolve("../..")),
      async () => await submitCoordinatedRender({
        ...base, frameLane: "gpu", segmented: { segmentFrames: 12, resume: true }
      }, {
        jobTrackingDisabled: false,
        injectedBrowserRenderer: true,
        gpuFinalExecutionAvailable: true,
        callerId: "test-host-principal",
        coordinator: () => coordinator,
        prepareFinalRender: async (renderArgs) => preparedFinal(renderArgs),
        executePreparedFinal: async (request) => {
          executed = request;
          return { ok: true, visibleState: { panel: "receipts", operation: "render.final" }, result: { receipt: {} }, warnings: [] };
        },
        unhandled: (error) => ({ ok: false, error: { code: "invalid_args", message: String(error) }, warnings: [] })
      })
    );

    expect(result).toMatchObject({ ok: true, result: { jobId: "cut:gpu-segmented", frameLane: "gpu" } });
    expect(executed).toMatchObject({ frameLane: "gpu", segmented: { segmentFrames: 12, resume: true } });
    expect(executed).not.toHaveProperty("storeRoot");
  });

  it("passes GPU execution through the direct final path and records only the receipt-owned producer link", async () => {
    const coordinator = {
      submit: vi.fn(async (input) => {
        expect(input).toMatchObject({ callerId: "test-host-principal", lane: "ffmpeg", frameLane: "gpu", operation: "render.final" });
        const execution = await input.execute(new AbortController().signal);
        expect(execution).toMatchObject({
          ok: true,
          receiptId: "gpu-final-receipt",
          receiptPath: "/receipts/gpu-final-receipt.json",
          producerEvidence: { frameLane: "gpu", schema: "shellx-motion/gpu-streaming-producer@1" }
        });
        return { ok: true as const, value: { jobId: "cut:gpu-final" } };
      }),
      jobView: vi.fn(() => ({ get: vi.fn(async () => ({ ok: true as const, job: { state: "pending", lifecycle: "pending" } })) }))
    } as unknown as MotionJobCoordinator;
    const result = await withTrustedWorkspaceAnchor(
      await createTrustedWorkspaceAnchor(resolve("../..")),
      async () => await submitCoordinatedRender({ ...base, frameLane: "gpu" }, {
        jobTrackingDisabled: false,
        injectedBrowserRenderer: false,
        gpuFinalExecutionAvailable: true,
        callerId: "test-host-principal",
        coordinator: () => coordinator,
        prepareFinalRender: async (renderArgs) => preparedFinal(renderArgs),
        executePreparedFinal: async (request) => ({
          ok: true,
          receiptId: "gpu-final-receipt",
          visibleState: { panel: "receipts", operation: "render.final" },
          result: {
            ok: true,
            frameLane: request.frameLane,
            receiptPath: "/receipts/gpu-final-receipt.json",
            receipt: {
              schema: "shellx-motion/receipt@1",
              id: "gpu-final-receipt",
              output: {
                frameTransport: {
                  producer: {
                    frameLane: "gpu",
                    evidence: { schema: "shellx-motion/gpu-streaming-producer@1", adapterFingerprint: "a".repeat(64) }
                  }
                }
              }
            }
          },
          warnings: []
        }),
        unhandled: (error) => ({ ok: false, error: { code: "invalid_args", message: String(error) }, warnings: [] })
      })
    );
    expect(result).toMatchObject({
      ok: true,
      result: { jobId: "cut:gpu-final", frameLane: "gpu", state: "pending", lifecycle: "pending" }
    });
    expect(coordinator.submit).toHaveBeenCalledTimes(1);
  });

  it("does not convert response claims or unproven paths into Core committed failure authority", async () => {
    const executions: Array<Record<string, unknown>> = [];
    const coordinator = {
      submit: vi.fn(async (input) => {
        executions.push(await input.execute(new AbortController().signal));
        return { ok: true as const, value: { jobId: input.jobId ?? "test:unproven" } };
      }),
      jobView: vi.fn(() => ({ get: vi.fn(async () => ({ ok: true as const, job: { state: "pending", lifecycle: "pending" } })) }))
    } as unknown as MotionJobCoordinator;
    const outputPath = resolve(".scratch/host-tests/unproven-commit.mp4");
    const anchor = await createTrustedWorkspaceAnchor(resolve("../.."));
    const unprovenFailure = await withTrustedWorkspaceAnchor(anchor, async () => await submitCoordinatedRender({
      ...base, jobId: "test:unproven-failure", outputPath
    }, {
      jobTrackingDisabled: false, injectedBrowserRenderer: false, gpuFinalExecutionAvailable: true, callerId: "test-host-principal",
      coordinator: () => coordinator, prepareFinalRender: async (renderArgs) => preparedFinal(renderArgs),
      executePreparedFinal: async () => ({
        ok: false,
        error: { code: "publication_commit_uncertain", message: "unproven marker", detail: { possiblyCommitted: true, publicPaths: [outputPath], expectedPublications: [] } },
        result: { possiblyCommitted: true, publicPaths: [outputPath] }, warnings: []
      }),
      unhandled: (error) => ({ ok: false, error: { code: "invalid_args", message: String(error) }, warnings: [] })
    }));
    expect(unprovenFailure).toMatchObject({ ok: true });
    expect(executions[0]).toMatchObject({ ok: false });
    expect(executions[0]).not.toHaveProperty("committed");

    const successWithResponseClaim = await withTrustedWorkspaceAnchor(anchor, async () => await submitCoordinatedRender({
      ...base, jobId: "test:unproven-success", outputPath: resolve(".scratch/host-tests/unproven-success.mp4")
    }, {
      jobTrackingDisabled: false, injectedBrowserRenderer: false, gpuFinalExecutionAvailable: true, callerId: "test-host-principal",
      coordinator: () => coordinator, prepareFinalRender: async (renderArgs) => preparedFinal(renderArgs),
      executePreparedFinal: async () => ({
        ok: true,
        result: { possiblyCommitted: true, publicPaths: [outputPath] }, warnings: []
      }),
      unhandled: (error) => ({ ok: false, error: { code: "invalid_args", message: String(error) }, warnings: [] })
    }));
    expect(successWithResponseClaim).toMatchObject({ ok: true });
    expect(executions[1]).toMatchObject({ ok: true });
    expect(executions[1]).not.toHaveProperty("committed");
  });

  it.each(["keepFrames", "workflow", "workflowPath", "qualityManifestPath", "manifestPath", "dryRun", "framesDir", "minUniqueFrameHashes", "reuseAttested"])(
    "refuses the materialization selector %s before a coordinator worker is created",
    async (field) => {
      const coordinator = coordinatorSpy();
      const result = await dispatchDebugCommand("motion.job.submit", { ...base, [field]: field === "keepFrames" || field === "dryRun" || field === "reuseAttested" ? true : "selected" }, {
        tier: "render_motion",
        callerId: "test-host-principal",
        jobCoordinator: coordinator
      });

      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining(field) } });
      expect(coordinator.submit).not.toHaveBeenCalled();
    }
  );

  it("refuses non-video presets and injected browser renderers before worker creation", async () => {
    const coordinator = coordinatorSpy();
    const still = await dispatchDebugCommand("motion.job.submit", { ...base, preset: "png-frame" }, { tier: "render_motion", callerId: "test-host-principal", jobCoordinator: coordinator });
    expect(still).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("final-video FFmpeg") } });

    const materializedHost = await dispatchDebugCommand("motion.job.submit", base, {
      tier: "render_motion",
      callerId: "test-host-principal",
      jobCoordinator: coordinator,
      browserFrameRenderer: (async () => Buffer.from("frame")) as never
    });
    expect(materializedHost).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("injected browser renderer") } });
    expect(coordinator.submit).not.toHaveBeenCalled();
  });

  it("fails closed when no host principal was supplied instead of deriving one from an actor label", async () => {
    const coordinator = coordinatorSpy();
    const result = await dispatchDebugCommand("motion.job.submit", base, {
      tier: "render_motion",
      actor: { kind: "agent", transport: "mcp", label: "caller-controlled-label", sessionId: "caller-controlled-session" },
      jobCoordinator: coordinator
    });

    expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: expect.stringContaining("owner principal") } });
    expect(coordinator.submit).not.toHaveBeenCalled();
  });
});

describe.runIf(process.platform !== "win32")("public coordinated final-render lifecycle", () => {
  it("binds the admitted path-free plan before status, fingerprints material changes, and refuses a changed replay", async () => {
    const projectRoot = resolve("../..");
    const parent = resolve(".scratch/host-tests");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(parent, "coordinated-final-lifecycle-"));
    lifecycleRoots.push(root);
    const renderPlans = new MotionRenderPlanStore({ planRoot: join(root, "render-plans") });
    const coordinator = new MotionJobCoordinator({
      leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }),
      records: new MotionJobRegistry({ recordRoot: join(root, "records") }),
      eventsRoot: join(root, "events"),
      renderPlans,
    });
    const plans: Array<{ jobId: string; fingerprint: string }> = [];
    const submit = coordinator.submit.bind(coordinator);
    vi.spyOn(coordinator, "submit").mockImplementation(async (input) => {
      if (input.renderPlan && input.jobId) plans.push({ jobId: input.jobId, fingerprint: input.renderPlan.fingerprint });
      // This public-dispatch test proves coordinator admission/status. Dedicated handler tests
      // below prove the real worker receives the already-prepared typed request.
      return await submit({ ...input, execute: async () => ({ ok: true }) });
    });
    const anchor = await createTrustedWorkspaceAnchor(projectRoot);
    const callerId = "test:lifecycle-owner";
    const baseArgs = {
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(root, "baseline.mp4"),
      preset: "mp4-h264",
      frameLane: "browser" as const,
    };
    const context = {
      tier: "render_motion" as const,
      callerId,
      jobCoordinator: coordinator,
      receiptsRoot: join(root, "receipts"),
      gpuFinalExecutionAvailable: true,
    };
    const submitAndRead = async (jobId: string, args: Record<string, unknown>) => {
      const result = await withTrustedWorkspaceAnchor(anchor, async () => await dispatchDebugCommand(
        "motion.job.submit", { ...args, jobId }, context,
      ));
      expect(result).toMatchObject({ ok: true, result: { jobId } });
      const status = await eventually(
        async () => await withTrustedWorkspaceAnchor(anchor, async () => await coordinator.jobView().get({ jobId, callerId })),
        (value) => value.ok && value.job.state === "succeeded",
      );
      if (!status.ok) throw new Error("coordinator status unavailable");
      const stored = await withTrustedWorkspaceAnchor(anchor, async () => await renderPlans.read({ jobId, callerId }));
      if (!stored.ok) throw new Error("render plan binding unavailable");
      expect(status.job.planFingerprint).toBe(stored.plan.fingerprint);
      expect(status.job).not.toHaveProperty("pid");
      return { status, fingerprint: stored.plan.fingerprint, plan: stored.plan };
    };

    const baseline = await submitAndRead("test:lifecycle-baseline", baseArgs);
    const segmented = await submitAndRead("test:lifecycle-segmented", {
      ...baseArgs,
      segmented: { segmentFrames: 120, resume: true },
    });
    const output = await submitAndRead("test:lifecycle-output", { ...baseArgs, outputPath: join(root, "other.mp4") });
    const preset = await submitAndRead("test:lifecycle-preset", { ...baseArgs, preset: "mp4-hevc" });
    const route = await submitAndRead("test:lifecycle-route", { ...baseArgs, frameLane: "gpu" });
    const changedPackage = await submitAndRead("test:lifecycle-package", {
      ...baseArgs,
      packageRoot: resolve("../../fixtures/packages/batch-card"),
    });

    expect(baseline.plan).toMatchObject({
      schema: "shellx-motion/render-plan@1",
      requested: { delivery: "streamed", segmented: null },
      compatibility: { version: 1, state: "current" },
    });
    expect(segmented.plan).toMatchObject({
      schema: "shellx-motion/render-plan@1",
      requested: { delivery: "segmented", segmented: { segmentFrames: 120, resume: true } },
      compatibility: { version: 1, state: "current" },
    });
    expect([...new Set([baseline.fingerprint, segmented.fingerprint, output.fingerprint, preset.fingerprint, route.fingerprint, changedPackage.fingerprint])]).toHaveLength(6);
    expect(plans).toEqual(expect.arrayContaining([
      { jobId: "test:lifecycle-baseline", fingerprint: baseline.fingerprint },
      { jobId: "test:lifecycle-segmented", fingerprint: segmented.fingerprint },
      { jobId: "test:lifecycle-output", fingerprint: output.fingerprint },
      { jobId: "test:lifecycle-preset", fingerprint: preset.fingerprint },
      { jobId: "test:lifecycle-route", fingerprint: route.fingerprint },
      { jobId: "test:lifecycle-package", fingerprint: changedPackage.fingerprint },
    ]));
    for (const [jobId, fingerprint] of [
      ["test:lifecycle-baseline", baseline.fingerprint],
      ["test:lifecycle-segmented", segmented.fingerprint],
    ] as const) {
      const events = await withTrustedWorkspaceAnchor(anchor, async () => await coordinator.events({ jobId, callerId }));
      expect(events.ok).toBe(true);
      if (!events.ok) throw new Error("coordinator events unavailable");
      expect(events.value.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "submitted", data: expect.objectContaining({ renderPlan: {
          schema: "shellx-motion/render-plan@1", fingerprint,
        } }) }),
      ]));
      expect(JSON.stringify(events.value.events)).not.toContain("render-plan@2");
    }

    const conflict = await withTrustedWorkspaceAnchor(anchor, async () => await dispatchDebugCommand("motion.job.submit", {
      ...baseArgs, jobId: "test:lifecycle-baseline", outputPath: join(root, "conflicting-output.mp4"),
    }, context));
    expect(conflict).toMatchObject({ ok: false, error: { code: "job_id_conflict" } });
    const conflictPlan = plans.at(-1);
    expect(conflictPlan).toMatchObject({ jobId: "test:lifecycle-baseline" });
    expect(conflictPlan?.fingerprint).not.toBe(baseline.fingerprint);
  });

  it("fails closed before stream allocation when the admitted stable package lineage drifts", async () => {
    const parent = resolve(".scratch/host-tests");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(parent, "coordinated-final-lineage-"));
    lifecycleRoots.push(root);
    const packageRoot = join(root, "package");
    await cp(resolve("../../fixtures/packages/lower-third"), packageRoot, { recursive: true });
    const outputPath = join(root, "out.mp4");
    let execution: { ok: boolean; error?: { message: string } } | undefined;
    let streamedCalls = 0;
    const coordinator = {
      submit: vi.fn(async (input) => {
        // This occurs after the production handler loaded its StableRenderPackage and built the
        // immutable plan, but before it begins the typed final executor.
        await appendFile(join(packageRoot, "motion.json"), "\n", "utf8");
        execution = await input.execute(new AbortController().signal);
        return { ok: true as const, value: { jobId: "test:lifecycle-lineage" } };
      }),
      jobView: vi.fn(() => ({ get: vi.fn(async () => ({ ok: true as const, job: { state: "pending", lifecycle: "pending" } })) })),
    } as unknown as MotionJobCoordinator;
    const result = await withTrustedWorkspaceAnchor(
      await createTrustedWorkspaceAnchor(root),
      async () => await dispatchDebugCommand("motion.job.submit", {
        jobId: "test:lifecycle-lineage", packageRoot, outputPath, preset: "mp4-h264", frameLane: "browser",
      }, {
        tier: "render_motion",
        callerId: "test:lifecycle-owner",
        jobCoordinator: coordinator,
        streamingFinalRenderer: async () => {
          streamedCalls += 1;
          throw new Error("lineage drift must refuse before stream allocation");
        },
      }),
    );

    expect(result).toMatchObject({ ok: true, result: { jobId: "test:lifecycle-lineage" } });
    expect(execution).toMatchObject({ ok: false, error: { message: expect.stringContaining("lineage changed") } });
    expect(streamedCalls).toBe(0);
  });

});

describe("jobView null disable policy", () => {
  it("disables coordinator submission and controls without granting coordinator authority", async () => {
    const coordinator = coordinatorSpy();
    const requests = [
      { command: "motion.job.submit" as const, args: base, tier: "render_motion" as const },
      { command: "motion.job.events" as const, args: { jobId: "cut:disabled" }, tier: "read_motion" as const },
      { command: "motion.job.cancel" as const, args: { jobId: "cut:disabled" }, tier: "render_motion" as const },
      { command: "motion.job.retry" as const, args: { jobId: "cut:disabled" }, tier: "render_motion" as const }
    ];

    for (const request of requests) {
      const result = await dispatchDebugCommand(request.command, request.args, {
        tier: request.tier,
        jobView: null,
        jobCoordinator: coordinator
      });
      expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    }
    expect(coordinator.submit).not.toHaveBeenCalled();
    expect(coordinator.jobView).not.toHaveBeenCalled();
    expect(coordinator.events).not.toHaveBeenCalled();
    expect(coordinator.cancel).not.toHaveBeenCalled();
    expect(coordinator.retry).not.toHaveBeenCalled();
  });
});

describe("coordinator cancellation detail boundary", () => {
  it.each([
    ["newline", "line one\nline two"],
    ["carriage return", "line one\rline two"],
    ["tab", "line one\tline two"],
    ["delete", "line one\u007fline two"],
    ["empty text", ""],
    ["513 Unicode scalars", "🙂".repeat(513)]
  ])("rejects %s public cancellation reasons before mutating the coordinator", async (_label, reason) => {
    const coordinator = coordinatorSpy();
    const result = await dispatchDebugCommand("motion.job.cancel", {
      jobId: "cut:control-reason", reason
    }, {
      tier: "render_motion", callerId: "cut:workspace", jobCoordinator: coordinator
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("non-control") } });
    expect(coordinator.cancel).not.toHaveBeenCalled();
  });

  it("accepts and forwards exactly 512 Unicode scalar reasons", async () => {
    const coordinator = coordinatorSpy();
    const reason = "🙂".repeat(512);
    vi.mocked(coordinator.cancel).mockResolvedValue({
      ok: true,
      value: {
        job: {
          schema: "shellx-motion/job-status@1", jobId: "cut:unicode-reason", callerId: "cut:workspace", lane: "ffmpeg", operation: "render.final",
          lifecycle: "pending", outcome: null, state: "pending", createdAtMs: 1, durationMs: 0, queueWaitMs: 0,
          cancelRequested: { requestedBy: "cut:workspace", reason, requestedAtMs: 2 }, warnings: []
        }
      }
    } as never);

    await expect(dispatchDebugCommand("motion.job.cancel", { jobId: "cut:unicode-reason", reason }, {
      tier: "render_motion", callerId: "cut:workspace", jobCoordinator: coordinator
    })).resolves.toMatchObject({ ok: true, result: { cancelRequested: true } });
    expect(coordinator.cancel).toHaveBeenCalledWith({ jobId: "cut:unicode-reason", callerId: "cut:workspace", reason });
  });

  it("projects cancellation from the returned terminal status instead of asserting it", async () => {
    const coordinator = coordinatorSpy();
    vi.mocked(coordinator.cancel).mockResolvedValue({
      ok: true,
      value: {
        job: {
          schema: "shellx-motion/job-status@1", jobId: "cut:committed-success", callerId: "cut:workspace", lane: "connector", operation: "connector.template-to-cut@1",
          lifecycle: "ended", outcome: "succeeded", state: "succeeded", createdAtMs: 1, endedAtMs: 2, durationMs: 1, queueWaitMs: 1,
          cancelRequested: null, warnings: []
        }
      }
    } as never);

    const result = await dispatchDebugCommand("motion.job.cancel", { jobId: "cut:committed-success" }, {
      tier: "render_motion", callerId: "cut:workspace", jobCoordinator: coordinator
    });
    expect(result).toMatchObject({ ok: true, visibleState: { cancelRequested: false }, result: { cancelRequested: false } });
  });
});

describe("coordinator retry refusal guidance", () => {
  it("keeps committed failure uncertainty above a producer retryable hint", async () => {
    const coordinator = coordinatorSpy();
    vi.mocked(coordinator.retry).mockResolvedValue({
      ok: false, code: "job_not_retryable",
      message: "Motion job cut:committed-source may have published irreversible output; reconcile the failed run before any new submission."
    });
    const result = await dispatchDebugCommand("motion.job.retry", { jobId: "cut:committed-source" }, {
      tier: "render_motion", callerId: "cut:workspace", jobCoordinator: coordinator
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "job_not_retryable",
        suggestedAction: expect.stringContaining("committed true, stop and reconcile")
      }
    });
    expect(coordinator.retry).toHaveBeenCalledWith({ jobId: "cut:committed-source", callerId: "cut:workspace" });
  });
});

describe("typed connector failure projection", () => {
  it("returns an unknown future code and retry metadata unchanged through motion.job.get", async () => {
    const error = {
      code: "connector_future_backpressure",
      message: "future renderer is saturated",
      retryable: true,
      remedy: "wait" as const,
      retryAfterMs: 2_500,
      suggestedAction: "Wait, then retry the same immutable binding."
    };
    const result = await dispatchDebugCommand("motion.job.get", { jobId: "cut:future-typed-error" }, {
      tier: "read_motion",
      callerId: "cut:workspace",
      jobView: {
        get: vi.fn(async () => ({ ok: true as const, job: {
          schema: "shellx-motion/job-status@1" as const,
          jobId: "cut:future-typed-error",
          callerId: "cut:workspace",
          lane: "connector",
          operation: "connector.future-scene@1",
          lifecycle: "ended" as const,
          outcome: "failed" as const,
          state: "failed" as const,
          createdAtMs: 1,
          endedAtMs: 2,
          durationMs: 1,
          queueWaitMs: 1,
          cancelRequested: null,
          error,
          warnings: []
        } })),
        list: vi.fn()
      } as never
    });
    expect(result).toMatchObject({ ok: true, result: { job: { error } } });
  });
});
