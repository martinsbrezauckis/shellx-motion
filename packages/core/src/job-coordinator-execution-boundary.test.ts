import { afterEach, describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MotionJobCoordinator } from "./job-coordinator";
import type { ActiveJob as CoordinatorActiveJob, ReplayableJob as CoordinatorReplayableJob } from "./job-coordinator";
import type { MotionJobCoordinatorEvent } from "./job-event-store";
import { motionJobOwnerKey } from "./job-id-file";
import { MotionJobIdentityClaimStore } from "./job-identity-claim-store";
import { MotionJobLeaseDirectory } from "./job-lease";
import { MotionJobRegistry } from "./job-registry";
import type { MotionJobQueryResult } from "./job-view";
import type { ActiveJob as CoreActiveJob, ReplayableJob as CoreReplayableJob } from "./index";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { createMotionRenderPlan } from "./render-plan";
import { MotionRenderPlanStore } from "./render-plan-store";

declare module "./job-coordinator" {
  interface ActiveJob {
    readonly phaseBConsumerActiveMarker?: true;
  }

  interface ReplayableJob {
    readonly phaseBConsumerReplayMarker?: true;
  }
}

const roots: string[] = [];
const CALLER_ID = "cut:phase-b-characterization";

afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

interface Fixture {
  readonly root: string;
  readonly eventsRoot: string;
  readonly jobs: MotionJobCoordinator;
  readonly anchor: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-phase-b-kernel-"));
  roots.push(root);
  const eventsRoot = join(root, "events");
  const value: Fixture = {
    root,
    eventsRoot,
    jobs: new MotionJobCoordinator({
      leases: new MotionJobLeaseDirectory({ leaseRoot: join(root, "leases") }),
      records: new MotionJobRegistry({ recordRoot: join(root, "records") }),
      eventsRoot,
      identityClaims: new MotionJobIdentityClaimStore({ claimRoot: join(root, "claims") }),
      renderPlans: new MotionRenderPlanStore({ planRoot: join(root, "plans") })
    }),
    anchor: await createTrustedWorkspaceAnchor(root)
  };
  await inFixture(value, async () => {
    const initialized = await value.jobs.submit({
      jobId: "cut:phase-b-initialization", callerId: "cut:phase-b-initialization", lane: "test", operation: "test.initialization",
      execute: async () => ({ ok: true })
    });
    if (!initialized.ok) throw new Error("Could not initialize retained coordinator authority.");
    await eventually(
      async () => await value.jobs.jobView().get({ jobId: "cut:phase-b-initialization", callerId: "cut:phase-b-initialization" }),
      (answer) => answer.ok && answer.job.state === "succeeded"
    );
    await settleSuccessfulJob(value, "cut:phase-b-initialization", "cut:phase-b-initialization");
  });
  return value;
}

async function inFixture<T>(value: Fixture, operation: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(value.anchor, operation);
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for the coordinator terminal state.");
}

async function observed(value: Fixture, jobId: string, state: "succeeded" | "failed" | "cancelled") {
  let last: MotionJobQueryResult | undefined;
  const terminal = await eventually<MotionJobQueryResult>(async () => {
    last = await value.jobs.jobView().get({ jobId, callerId: CALLER_ID });
    return last;
  }, (answer) => answer.ok && answer.job.state === state)
    .catch((error) => { throw new Error(`${error instanceof Error ? error.message : String(error)} Last state: ${JSON.stringify(last)}`); });
  if (!terminal.ok) throw new Error(`Job ${jobId} was not readable.`);
  const events = await value.jobs.events({ jobId, callerId: CALLER_ID });
  if (!events.ok) throw new Error(`Events for ${jobId} were not readable.`);
  if (state === "succeeded") await settleSuccessfulJob(value, jobId, CALLER_ID);
  return { outcome: terminal.job.outcome, events: events.value.events };
}

async function settleSuccessfulJob(value: Fixture, jobId: string, callerId: string): Promise<void> {
  // A known-success retry waits for settlement and starts no new work.
  await expect(value.jobs.retry({ jobId, callerId })).resolves.toMatchObject({ ok: false, code: "job_not_retryable" });
  await expect(value.jobs.jobView().get({ jobId, callerId })).resolves.toMatchObject({ ok: true, job: { state: "succeeded" } });
}

function observableBytes(value: { outcome: string | null; events: MotionJobCoordinatorEvent[] }): Buffer {
  return Buffer.from(JSON.stringify({
    outcome: value.outcome,
    events: value.events.map((event) => ({
      seq: event.seq,
      type: event.type,
      ...(event.data ? { data: event.data } : {})
    }))
  }), "utf8");
}

function expectedBytes(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function phaseBRenderPlan() {
  return createMotionRenderPlan({
    package: { id: "pkg_phase_b", manifestSha256: "a".repeat(64) }, motion: { id: "motion_phase_b", documentSha256: "b".repeat(64) },
    lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256: "a".repeat(64), motionSha256: "b".repeat(64) },
    output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256: "c".repeat(64) }, quality: { mode: "none" },
    requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "streamed", segmented: null, fallback: "none" },
    runtime: { engine: "ffmpeg@7.1", routeFingerprint: "d".repeat(64), presetFingerprint: "e".repeat(64), capabilityFingerprint: "f".repeat(64) },
    compatibility: { version: 1, state: "current" }
  });
}

describe("MotionJobCoordinator execution-kernel boundary", () => {
  it("keeps execution imports and context V2-blind while the public coordinator remains the export route", async () => {
    const executionPath = fileURLToPath(new URL("./job-coordinator-execution.ts", import.meta.url));
    const coordinatorPath = fileURLToPath(new URL("./job-coordinator.ts", import.meta.url));
    const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url));
    const [execution, coordinator, index] = await Promise.all([
      readFile(executionPath, "utf8"),
      readFile(coordinatorPath, "utf8"),
      readFile(indexPath, "utf8")
    ]);
    const imports = Array.from(execution.matchAll(/^import(?:\s+type)?[\s\S]*?from\s+"([^"]+)";$/gm), (match) => match[1]);
    const context = execution.slice(execution.indexOf("export interface MotionCoordinatorExecutionContext"), execution.indexOf("export async function runCoordinatorExecution"));

    expect(coordinator).toContain("export interface ActiveJob extends ExecutionActiveJob {");
    expect(coordinator).toContain("export interface ReplayableJob extends ExecutionReplayableJob {");
    expect(execution).toContain('export type MotionJobCoordinatorExecute = MotionJobCoordinatorExecuteSignature["execute"];');
    expect(index).toContain('export * from "./job-coordinator";');
    expect(index).not.toContain('export * from "./job-coordinator-execution";');
    expect(imports).not.toContain("./job-coordinator");
    expect(imports).not.toContain("./index");
    expect(imports.join("\n")).not.toMatch(/(?:render-plan|render-admission|renderer|request|receipt|capability|permit|token|authority)/u);
    expect(context).not.toMatch(/(?:submissionData|renderPlan|fingerprint|permit|token|authority|renderer|request|capability)/u);
    expect(execution).not.toMatch(/(?:submissionData|renderPlan)/u);
  });

  it("preserves public interface facades and method callback variance without widening execution state", () => {
    const renderPlan = phaseBRenderPlan();
    const submissionData = { binding: "phase-b-compatibility" };
    const narrowedExecute = async (_signal: AbortSignal & { readonly reason: Error }) => ({ ok: true });
    const coordinatorActive: Pick<CoordinatorActiveJob, "submissionData" | "renderPlan" | "phaseBConsumerActiveMarker"> = { submissionData, renderPlan, phaseBConsumerActiveMarker: true };
    const coordinatorReplay: Pick<CoordinatorReplayableJob, "submissionData" | "renderPlan" | "phaseBConsumerReplayMarker"> = { submissionData, renderPlan, phaseBConsumerReplayMarker: true };
    const coreActive: Pick<CoreActiveJob, "submissionData" | "renderPlan" | "phaseBConsumerActiveMarker"> = { submissionData, renderPlan, phaseBConsumerActiveMarker: true };
    const coreReplay: Pick<CoreReplayableJob, "submissionData" | "renderPlan" | "phaseBConsumerReplayMarker"> = { submissionData, renderPlan, phaseBConsumerReplayMarker: true };
    const coordinatorActiveExecute: CoordinatorActiveJob["execute"] = narrowedExecute;
    const coordinatorReplayExecute: CoordinatorReplayableJob["execute"] = narrowedExecute;
    const coreActiveExecute: CoreActiveJob["execute"] = narrowedExecute;
    const coreReplayExecute: CoreReplayableJob["execute"] = narrowedExecute;

    expect([coordinatorActive, coordinatorReplay, coreActive, coreReplay]).toEqual([
      { submissionData, renderPlan, phaseBConsumerActiveMarker: true }, { submissionData, renderPlan, phaseBConsumerReplayMarker: true },
      { submissionData, renderPlan, phaseBConsumerActiveMarker: true }, { submissionData, renderPlan, phaseBConsumerReplayMarker: true }
    ]);
    expect([coordinatorActiveExecute, coordinatorReplayExecute, coreActiveExecute, coreReplayExecute]).toEqual([
      narrowedExecute, narrowedExecute, narrowedExecute, narrowedExecute
    ]);
  });

  it("preserves byte-exact observable event order and outcomes across success, failure, cancellation, retry, and replay", async () => {
    const value = await fixture();

    await inFixture(value, async () => {
    await expect(value.jobs.submit({
      jobId: "cut:phase-b-success", callerId: CALLER_ID, lane: "test", operation: "test.success",
      execute: async () => ({ ok: true })
    })).resolves.toEqual({ ok: true, value: { jobId: "cut:phase-b-success" } });
    expect(observableBytes(await observed(value, "cut:phase-b-success", "succeeded"))).toEqual(expectedBytes(
      '{"outcome":"succeeded","events":[{"seq":1,"type":"submitted","data":{"operation":"test.success"}},{"seq":2,"type":"succeeded"}]}'
    ));

    await value.jobs.submit({
      jobId: "cut:phase-b-failure", callerId: CALLER_ID, lane: "test", operation: "test.failure",
      execute: async () => ({ ok: false, error: { code: "job_queue_timeout", message: "busy", retryable: true } })
    });
    expect(observableBytes(await observed(value, "cut:phase-b-failure", "failed"))).toEqual(expectedBytes(
      '{"outcome":"failed","events":[{"seq":1,"type":"submitted","data":{"operation":"test.failure"}},{"seq":2,"type":"failed","data":{"code":"job_queue_timeout","retryable":true,"remedy":"wait"}}]}'
    ));

    let entered!: () => void;
    const executionEntered = new Promise<void>((resolve) => { entered = resolve; });
    await value.jobs.submit({
      jobId: "cut:phase-b-cancel", callerId: CALLER_ID, lane: "test", operation: "test.cancel",
      execute: async (signal) => await new Promise((resolve) => {
        entered();
        signal.addEventListener("abort", () => resolve({ ok: false, error: { code: "job_cancelled", message: "stopped" } }), { once: true });
      })
    });
    await executionEntered;
    await value.jobs.cancel({ jobId: "cut:phase-b-cancel", callerId: CALLER_ID, reason: "operator stopped" });
    expect(observableBytes(await observed(value, "cut:phase-b-cancel", "cancelled"))).toEqual(expectedBytes(
      '{"outcome":"cancelled","events":[{"seq":1,"type":"submitted","data":{"operation":"test.cancel"}},{"seq":2,"type":"cancel_requested","data":{"requestedBy":"cut:phase-b-characterization","reason":"operator stopped"}},{"seq":3,"type":"cancelled","data":{"requestedBy":"cut:phase-b-characterization","reason":"operator stopped"}}]}'
    ));

    let retryCalls = 0;
    await value.jobs.submit({
      jobId: "cut:phase-b-retry-source", callerId: CALLER_ID, lane: "test", operation: "test.retry",
      execute: async () => ++retryCalls === 1
        ? { ok: false, receiptId: "receipt-source", error: { code: "job_queue_timeout", message: "busy", retryable: true } }
        : { ok: true, receiptId: "receipt-retry" }
    });
    expect(observableBytes(await observed(value, "cut:phase-b-retry-source", "failed"))).toEqual(expectedBytes(
      '{"outcome":"failed","events":[{"seq":1,"type":"submitted","data":{"operation":"test.retry"}},{"seq":2,"type":"failed","data":{"code":"job_queue_timeout","retryable":true,"remedy":"wait"}}]}'
    ));
    await value.jobs.retry({
      jobId: "cut:phase-b-retry-source", callerId: CALLER_ID, newJobId: "cut:phase-b-retry-next"
    });
    expect(observableBytes(await observed(value, "cut:phase-b-retry-next", "succeeded"))).toEqual(expectedBytes(
      '{"outcome":"succeeded","events":[{"seq":1,"type":"submitted","data":{"operation":"test.retry","lineage":{"priorJobId":"cut:phase-b-retry-source","priorReceiptId":"receipt-source","retryAttempt":1}}},{"seq":2,"type":"retry_submitted","data":{"priorJobId":"cut:phase-b-retry-source","retryAttempt":1}},{"seq":3,"type":"succeeded","data":{"receiptId":"receipt-retry"}}]}'
    ));

    const plan = phaseBRenderPlan();
    const replayJobId = "cut:phase-b-replay";
    await value.jobs.submit({
      jobId: replayJobId, callerId: CALLER_ID, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
      execute: async () => ({ ok: true })
    });
    await observed(value, replayJobId, "succeeded");
    const eventPath = join(value.eventsRoot, `${motionJobOwnerKey(CALLER_ID, replayJobId)}.events.json`);
    const beforeReplay = await readFile(eventPath);
    let replayExecutions = 0;
    await expect(value.jobs.submit({
      jobId: replayJobId, callerId: CALLER_ID, lane: "ffmpeg", frameLane: "gpu", operation: "render.final", renderPlan: plan,
      execute: async () => { replayExecutions += 1; return { ok: true }; }
    })).resolves.toEqual({ ok: true, value: { jobId: replayJobId, replayed: true } });
    expect(replayExecutions).toBe(0);
    expect(await readFile(eventPath)).toEqual(beforeReplay);
    });
  });
});
