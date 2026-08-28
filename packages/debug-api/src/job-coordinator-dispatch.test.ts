/** Coordinator admission and disable-policy regression coverage. */
import { describe, expect, it, vi } from "vitest";
import { parseCoordinatedRenderSubmit } from "./coordinated-render-submit.js";
import { submitCoordinatedRender } from "./coordinator-submit-handler.js";
import { dispatchDebugCommand } from "./index.js";
import type { MotionJobCoordinator } from "@shellx-motion/core";

const base = { packageRoot: "/motion/package", outputPath: "/renders/output.mp4", preset: "mp4-h264" };

function coordinatorSpy() {
  return {
    submit: vi.fn(),
    jobView: vi.fn(),
    events: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn()
  } as unknown as MotionJobCoordinator;
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
    let executed: Record<string, unknown> | undefined;
    const coordinator = {
      submit: vi.fn(async (input) => {
        await input.execute(new AbortController().signal);
        return { ok: true as const, value: { jobId: "cut:gpu-segmented" } };
      }),
      jobView: vi.fn(() => ({ get: vi.fn(async () => ({ ok: true as const, job: { state: "pending", lifecycle: "pending" } })) }))
    } as unknown as MotionJobCoordinator;
    const result = await submitCoordinatedRender({
      ...base, frameLane: "gpu", segmented: { segmentFrames: 12, resume: true }
    }, {
      jobTrackingDisabled: false,
      injectedBrowserRenderer: true,
      gpuFinalExecutionAvailable: true,
      callerId: "test-host-principal",
      coordinator: () => coordinator,
      executeFinal: async (renderArgs) => {
        executed = renderArgs;
        return { ok: true, visibleState: { panel: "receipts", operation: "render.final" }, result: { receipt: {} }, warnings: [] };
      },
      unhandled: (error) => ({ ok: false, error: { code: "invalid_args", message: String(error) }, warnings: [] })
    });

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
    const result = await submitCoordinatedRender({ ...base, frameLane: "gpu" }, {
      jobTrackingDisabled: false,
      injectedBrowserRenderer: false,
      gpuFinalExecutionAvailable: true,
      callerId: "test-host-principal",
      coordinator: () => coordinator,
      executeFinal: async (renderArgs) => ({
        ok: true,
        receiptId: "gpu-final-receipt",
        visibleState: { panel: "receipts", operation: "render.final" },
        result: {
          ok: true,
          frameLane: renderArgs.frameLane,
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
    });
    expect(result).toMatchObject({
      ok: true,
      result: { jobId: "cut:gpu-final", frameLane: "gpu", state: "pending", lifecycle: "pending" }
    });
    expect(coordinator.submit).toHaveBeenCalledTimes(1);
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
