import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MotionJobCoordinator,
  MotionJobLeaseDirectory,
  MotionJobRegistry,
  MotionRenderPlanStore
} from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { submitCoordinatedRender } from "./coordinator-submit-handler.js";
import type { FinalRenderRequest } from "./domains/render-final.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

function preparedFinal(renderArgs: Record<string, unknown>): FinalRenderRequest {
  return {
    packageRoot: renderArgs.packageRoot as string,
    outputPath: renderArgs.outputPath as string,
    frameLane: (renderArgs.frameLane ?? "browser") as FinalRenderRequest["frameLane"],
    preset: (renderArgs.preset ?? "mp4-h264") as FinalRenderRequest["preset"],
    dryRun: false,
    reuseAttested: false
  };
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for committed streamed terminal state.");
}

describe.runIf(process.platform !== "win32")("coordinated render committed-failure production handoff", () => {
  it("carries authenticated streamed publication uncertainty through a cancellation race as a failed committed lifecycle", async () => {
    const parent = resolve(".scratch/host-tests");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(parent, "coordinated-committed-streamed-"));
    roots.push(root);
    const callerId = "test:committed-streamed";
    const jobId = "test:committed-streamed-job";
    const outputPath = join(root, "possibly-published.mp4");
    const coordinator = new MotionJobCoordinator({
      leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }),
      records: new MotionJobRegistry({ recordRoot: join(root, "records") }),
      eventsRoot: join(root, "events"),
      renderPlans: new MotionRenderPlanStore({ planRoot: join(root, "render-plans") })
    });
    let started!: () => void;
    const startedExecution = new Promise<void>((resolveStarted) => { started = resolveStarted; });
    let complete!: (result: { ok: false; error: { code: string; message: string; retryable: true; detail: unknown }; result: unknown; warnings: string[] }) => void;
    const completion = new Promise<{ ok: false; error: { code: string; message: string; retryable: true; detail: unknown }; result: unknown; warnings: string[] }>((resolveCompletion) => { complete = resolveCompletion; });
    const anchor = await createTrustedWorkspaceAnchor(resolve("../.."));
    const submitted = await withTrustedWorkspaceAnchor(anchor, async () => await submitCoordinatedRender({
      jobId, packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "mp4-h264", frameLane: "browser"
    }, {
      jobTrackingDisabled: false,
      injectedBrowserRenderer: false,
      gpuFinalExecutionAvailable: true,
      callerId,
      coordinator: () => coordinator,
      prepareFinalRender: async (renderArgs) => preparedFinal(renderArgs),
      executePreparedFinal: async () => {
        started();
        return await completion;
      },
      unhandled: (error) => ({ ok: false, error: { code: "invalid_args", message: String(error) }, warnings: [] })
    }));
    expect(submitted).toMatchObject({ ok: true, result: { jobId } });
    await startedExecution;
    await expect(withTrustedWorkspaceAnchor(anchor, async () => await coordinator.cancel({ jobId, callerId, reason: "operator requested stop" })))
      .resolves.toMatchObject({ ok: true });
    complete({
      ok: false,
      error: {
        code: "publication_commit_uncertain",
        message: "final publication may have completed",
        retryable: true,
        detail: {
          possiblyCommitted: true,
          publicPaths: [outputPath],
          expectedPublications: [{
            publicPath: outputPath,
            kind: "file",
            expectedIdentity: { dev: 1, ino: 2 },
            expected: { sha256: "a".repeat(64), byteLength: 1 }
          }]
        }
      },
      // This response-facing duplicate must not be the source of Core authority; the failure
      // detail above is the authenticated streamed producer envelope.
      result: { possiblyCommitted: true, publicPaths: [outputPath] },
      warnings: []
    });
    const terminal = await eventually(
      async () => await withTrustedWorkspaceAnchor(anchor, async () => await coordinator.jobView().get({ jobId, callerId })),
      (answer) => answer.ok && answer.job.state === "failed"
    );
    expect(terminal).toMatchObject({
      ok: true,
      job: { lifecycle: "ended", outcome: "failed", state: "failed", committed: true, error: { retryable: true } }
    });
    if (!terminal.ok) throw new Error("committed streamed terminal unavailable");
    if (!terminal.job.evidence) throw new Error("committed streamed terminal omitted its V1 evidence envelope");
    expect(terminal.job.evidence.artifacts).toEqual([]);
    const events = await withTrustedWorkspaceAnchor(anchor, async () => await coordinator.events({ jobId, callerId }));
    expect(events).toMatchObject({ ok: true, value: { events: expect.arrayContaining([
      expect.objectContaining({ type: "cancel_requested" }),
      expect.objectContaining({ type: "failed", data: expect.objectContaining({ committed: true, retryable: true }) })
    ]) } });
  });
});
