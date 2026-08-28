/** Local SDK to Debug API coordinator cancellation plumbing. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RenderStreamingFinalResult } from "@shellx-motion/renderer-ffmpeg";
import { createLocalMotionSdk } from "./local.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for the coordinator terminal state.");
}

async function withCoordinatorRoots<T>(root: string, run: () => Promise<T>): Promise<T> {
  const prior = {
    coordinator: process.env.SHELLX_MOTION_JOB_COORDINATOR_ROOT,
    lease: process.env.SHELLX_MOTION_LEASE_ROOT,
    record: process.env.SHELLX_MOTION_JOB_RECORD_ROOT,
  };
  process.env.SHELLX_MOTION_JOB_COORDINATOR_ROOT = root;
  process.env.SHELLX_MOTION_LEASE_ROOT = join(root, "leases");
  process.env.SHELLX_MOTION_JOB_RECORD_ROOT = join(root, "records");
  try {
    return await run();
  } finally {
    if (prior.coordinator === undefined) delete process.env.SHELLX_MOTION_JOB_COORDINATOR_ROOT;
    else process.env.SHELLX_MOTION_JOB_COORDINATOR_ROOT = prior.coordinator;
    if (prior.lease === undefined) delete process.env.SHELLX_MOTION_LEASE_ROOT;
    else process.env.SHELLX_MOTION_LEASE_ROOT = prior.lease;
    if (prior.record === undefined) delete process.env.SHELLX_MOTION_JOB_RECORD_ROOT;
    else process.env.SHELLX_MOTION_JOB_RECORD_ROOT = prior.record;
  }
}

describe("LocalMotionSdkRenderJob", () => {
  it("forwards its stable jobId and cancellation signal through Debug streamed-final execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-coordinator-signal-"));
    roots.push(root);
    const priorCoordinatorRoot = process.env.SHELLX_MOTION_JOB_COORDINATOR_ROOT;
    const priorLeaseRoot = process.env.SHELLX_MOTION_LEASE_ROOT;
    const priorRecordRoot = process.env.SHELLX_MOTION_JOB_RECORD_ROOT;
    // The local SDK intentionally uses the process-owned default coordinator. Pin its three
    // durable stores here so this integration proof neither depends on runner XDG setup nor leaves
    // lease, record, or event state in the workspace runtime directory.
    process.env.SHELLX_MOTION_JOB_COORDINATOR_ROOT = root;
    process.env.SHELLX_MOTION_LEASE_ROOT = join(root, "leases");
    process.env.SHELLX_MOTION_JOB_RECORD_ROOT = join(root, "records");
    const jobId = "sdk:signal-plumbing";
    let entered!: () => void;
    const seamEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let observedAbort!: () => void;
    const abortObserved = new Promise<void>((resolve) => { observedAbort = resolve; });

    try {
      const sdk = createLocalMotionSdk({
        callerId: "cut:workspace-7",
        ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version coordinator-test", stderr: "" }),
        streamingFinalRenderer: async (input) => {
          input.signal?.addEventListener("abort", () => observedAbort(), { once: true });
          entered();
          await released;
          if (!input.transport) throw new Error("coordinator submit must reach the streamed transport seam");
          const stopped: RenderStreamingFinalResult = {
            ok: false,
            transport: input.transport,
            error: { code: "job_cancelled", message: "test streamed producer settled after cancellation" }
          };
          return stopped;
        }
      });

      const job = await sdk.submitRender({
        jobId,
        packageRoot: resolve("../../fixtures/packages/lower-third"),
        outputPath: join(root, "final.mp4"),
        preset: "mp4-h264"
      });
      expect(job.id).toBe(jobId);
      await seamEntered;

      const accepted = await job.cancel("operator stopped export");
      await abortObserved;
      expect(accepted).toMatchObject({ jobId, lifecycle: expect.any(String), cancelRequested: { requestedBy: expect.any(String) } });
      const live = await job.status();
      expect(live).toMatchObject({ jobId, lifecycle: expect.any(String), cancelRequested: { requestedBy: expect.any(String) } });
      expect(live.lifecycle).not.toBe("ended");
      expect(live.state).not.toBe("cancelled");

      release();
      const terminal = await eventually(() => job.status(), (status) => status.state === "cancelled");
      expect(terminal).toMatchObject({ jobId, lifecycle: "ended", state: "cancelled", outcome: "cancelled" });
    } finally {
      if (priorCoordinatorRoot === undefined) delete process.env.SHELLX_MOTION_JOB_COORDINATOR_ROOT;
      else process.env.SHELLX_MOTION_JOB_COORDINATOR_ROOT = priorCoordinatorRoot;
      if (priorLeaseRoot === undefined) delete process.env.SHELLX_MOTION_LEASE_ROOT;
      else process.env.SHELLX_MOTION_LEASE_ROOT = priorLeaseRoot;
      if (priorRecordRoot === undefined) delete process.env.SHELLX_MOTION_JOB_RECORD_ROOT;
      else process.env.SHELLX_MOTION_JOB_RECORD_ROOT = priorRecordRoot;
    }
  });

  it("fails closed before rendering when a direct SDK coordinator caller has no owner principal", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-coordinator-no-principal-"));
    roots.push(root);
    let rendererCalls = 0;
    const sdk = createLocalMotionSdk({
      streamingFinalRenderer: async () => {
        rendererCalls += 1;
        throw new Error("a missing coordinator principal must reject before rendering");
      }
    });

    await expect(sdk.submitRender({
      jobId: "sdk:no-principal",
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(root, "final.mp4"),
      preset: "mp4-h264"
    })).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(rendererCalls).toBe(0);
  });

  it("preserves a durable-segmented GPU job lane in SDK status/events without creating a reuse identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-coordinator-gpu-"));
    roots.push(root);
    await withCoordinatorRoots(root, async () => {
      let renders = 0;
      const sdk = createLocalMotionSdk({
      callerId: "cut:gpu-workspace",
      gpuFinalExecutionAvailable: true,
      ffmpegRunner: async () => ({ exitCode: 0, stdout: "ffmpeg version coordinator-gpu-test", stderr: "" }),
      streamingFinalRenderer: async (input) => {
        renders += 1;
        expect(input.frameLane).toBe("gpu");
        if (!input.transport) throw new Error("GPU coordinator requests must retain strict streamed transport.");
        return {
          ok: false,
          transport: input.transport,
          error: { code: "job_queue_timeout", message: `fresh GPU attempt ${renders} could not acquire a slot` }
        };
      }
    });
      const job = await sdk.submitRender({
      jobId: "sdk:gpu-fresh-source",
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(root, "final.mp4"),
      preset: "mp4-h264",
      frameLane: "gpu",
      segmented: { segmentFrames: 120, resume: true }
    });
      const source = await eventually(() => job.status(), (status) => status.state === "failed");
      expect(source).toMatchObject({ jobId: "sdk:gpu-fresh-source", frameLane: "gpu", lane: "ffmpeg" });
      expect(source.receiptId).toBeUndefined();
      const sourceEvents = await job.events();
      expect(sourceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "submitted", data: expect.objectContaining({ frameLane: "gpu" }) }),
      expect.objectContaining({ type: "failed", data: expect.objectContaining({ frameLane: "gpu" }) })
      ]));
      expect(renders).toBe(0); // The managed test filesystem refuses package reads before renderer admission.
    });
  });

  it("refuses a durable-segmented SDK GPU submission before queueing when the embedding host has not declared GPU final execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-coordinator-gpu-refusal-"));
    roots.push(root);
    let rendererCalls = 0;
    const sdk = createLocalMotionSdk({
      callerId: "cut:gpu-unavailable",
      streamingFinalRenderer: async () => {
        rendererCalls += 1;
        throw new Error("unavailable GPU job must not start rendering");
      }
    });
    await expect(sdk.submitRender({
      jobId: "sdk:gpu-unavailable",
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(root, "final.mp4"),
      preset: "mp4-h264",
      frameLane: "gpu",
      segmented: { segmentFrames: 120 }
    })).rejects.toMatchObject({ code: "capability_unavailable", message: expect.stringContaining("no GPU job was queued") });
    expect(rendererCalls).toBe(0);
  });
});
