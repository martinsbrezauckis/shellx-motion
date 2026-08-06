import { MotionJobLeaseDirectory, LEASE_HEARTBEAT_INTERVAL_MS, UNATTRIBUTED_CALLER_ID } from "./job-lease";
import type { MotionJobRegistry } from "./job-registry";
import { currentMotionHostJob } from "./host-job";
import { assertMotionJobId, mintMotionJobId } from "./job-registry";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MAX_RENDER_DIMENSION = 7_680;
const MAX_RENDER_PIXELS = 7_680 * 4_320;
const MAX_RENDER_FRAMES = 216_000;

/**
 * What a WHOLE-DOCUMENT render actually meets, as opposed to what one allocation may not exceed.
 *
 * `MAX_RENDER_FRAMES` above is an allocation guard: it stops a frame list from becoming an
 * input-controlled memory exhaustion path. It is not the budget a delivery render passes. Every
 * non-still render walks a materialised frame sequence, and the CLI refuses that sequence above
 * 36,000 frames or 80e9 pixel-frames (`renderFrameSequenceBudgetError` in
 * `packages/cli/src/main.ts`) — which is reached long before 216,000 frames.
 *
 * Authoring paths therefore bound documents by THIS pair. Bounding by the looser allocation guard
 * would let an authoring command accept a document the very next render refuses, which is the
 * failure this whole policy exists to prevent: a bound that disagrees with the thing enforcing it
 * later is a second lie, not a safety net. `packages/cli/src/main.test.ts` pins the two copies of
 * these numbers to each other, so a change to one fails the other's suite.
 */
const MAX_RENDER_SEQUENCE_FRAMES = 36_000;
const MAX_RENDER_SEQUENCE_PIXEL_FRAMES = 80_000_000_000;

/**
 * Frame-rate window for an authored document.
 *
 * Not invented here: `buildScriptedVideoFromSourceImport` in `source-import.ts` already bounds an
 * authored document to `fps` 1..120 (alongside 16..7680 and 16..4320 sides, which are the same
 * frame guard read a different way), and the published `motion.package.create` contract already
 * declares `minimum: 1`. This makes that window the one every authoring path shares rather than one
 * importer's private opinion.
 */
const MIN_DOCUMENT_FPS = 1;
const MAX_DOCUMENT_FPS = 120;

/** Expensive local execution families governed by one workstation-wide policy. */
export type LocalMotionJobLane = "ffmpeg" | "browser" | "native" | "batch" | "connector" | "agent" | "analysis" | "quality" | "other";

export interface LocalMotionJobPolicy {
  maxConcurrentJobs: number;
  maxQueueDepth: number;
  maxQueueWaitMs: number;
  maxWallClockMs: number;
  minFreeScratchBytes: number;
  scratchReservationBytes: number;
  maxProcessTreeRssBytes: number;
  rssPollIntervalMs: number;
}

export interface LocalMotionJobRequest {
  lane: LocalMotionJobLane;
  operation: string;
  scratchRoot: string;
  signal?: AbortSignal;
  /** Trusted host overrides only; untrusted packages never supply resource policy. */
  policy?: Partial<Omit<LocalMotionJobPolicy, "maxConcurrentJobs" | "maxQueueDepth">>;
  /**
   * Stable owner identity for this work, used for visibility (never for scheduling).
   *
   * Scheduling stays global — this job competes for the machine-wide cap regardless of owner —
   * while who may later see the job is decided by this value.
   */
  callerId?: string;
  /**
   * The id this job will be known by, chosen by the caller.
   *
   * This is Motion's answer to "how does a host learn the job id before the work finishes": it
   * supplies the id itself, so it holds the handle before the process even starts — earlier than
   * any asynchronous handoff could deliver one. Omit it and Motion mints a timestamped id, which
   * the caller receives with the result.
   *
   * The same value addresses the live lease, the resource evidence and the terminal record. They
   * were three different values previously; an id returned after execution could not be used
   * to look anything up.
   */
  jobId?: string;
}

export interface LocalMotionJobEvidence {
  schema: "shellx-motion/local-job-resources@1";
  jobId: string;
  lane: LocalMotionJobLane;
  operation: string;
  state: "passed" | "cancelled" | "queue_timeout" | "deadline_exceeded" | "rss_limit_exceeded" | "scratch_path_unsafe" | "scratch_budget_failed" | "input_budget_exceeded" | "failed";
  queueWaitMs: number;
  durationMs: number;
  policy: LocalMotionJobPolicy;
  scratch: {
    pathSafety: "canonical-no-symlink";
    freeBytesAtStart: number;
    reservedBytes: number;
    minFreeBytes: number;
  };
  peakProcessTreeRssBytes: number;
  watchedProcessCount: number;
  rssScope: "process-tree" | "root-process" | "unavailable";
  processContainment?: LocalMotionProcessContainmentEvidence;
  sandbox?: LocalMotionRuntimeSandboxEvidence;
}

/** Trusted host evidence for how a spawned worker tree is terminated and bounded. */
export interface LocalMotionProcessContainmentEvidence {
  schema: "shellx-motion/process-containment@1";
  mode: "windows-job-object" | "windows-taskkill-fallback" | "unix-process-group" | "cooperative-browser-session" | "direct-child";
  status: "enforced" | "fallback" | "unavailable";
  killTree: boolean;
  memoryLimit: "job-commit" | "rss-monitor" | "none";
  maxJobMemoryBytes?: number;
  maxActiveProcesses?: number;
  launcher?: {
    kind: "powershell-csharp";
    sha256: string;
  };
  reasonCode?: "native_helper_missing" | "native_setup_failed" | "worker_process_unavailable" | "unsupported_platform";
}

/** Runtime launch-policy evidence. `requested` deliberately does not claim kernel enforcement. */
export interface LocalMotionRuntimeSandboxEvidence {
  schema: "shellx-motion/runtime-sandbox@1";
  provider: "chromium";
  status: "requested" | "disabled";
  scope: "browser-process";
  reasonCode?: "trusted_host_opt_out";
}

export interface LocalMotionJobContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
  /** Canonical host-admitted scratch root for trusted worker control files. */
  readonly scratchRoot: string;
  /** Register a spawned process. RSS includes descendants where the platform exposes them. */
  watchProcess(pid: number): void;
  /** Record the actual process-tree containment selected by the trusted renderer/worker host. */
  reportProcessContainment(evidence: LocalMotionProcessContainmentEvidence): void;
  /** Record whether a runtime's own sandbox was requested or explicitly disabled. */
  reportSandbox(evidence: LocalMotionRuntimeSandboxEvidence): void;
}

export interface LocalMotionJobExecution<T> {
  value: T;
  evidence: LocalMotionJobEvidence;
}

export type LocalMotionJobErrorCode =
  | "job_queue_full"
  | "job_queue_timeout"
  | "job_cancelled"
  | "job_deadline_exceeded"
  | "job_rss_limit_exceeded"
  | "job_rss_inspection_failed"
  | "job_process_containment_unavailable"
  | "job_scratch_path_unsafe"
  | "job_scratch_budget_failed"
  | "job_input_budget_exceeded";

/** Typed failure used by render/SDK surfaces without exposing local scratch paths. */
export class LocalMotionJobError extends Error {
  constructor(
    readonly code: LocalMotionJobErrorCode,
    message: string,
    readonly evidence?: LocalMotionJobEvidence
  ) {
    super(message);
    this.name = "LocalMotionJobError";
    Object.setPrototypeOf(this, LocalMotionJobError.prototype);
  }
}

export interface LocalMotionJobGovernorServices {
  now?: () => number;
  prepareScratchRoot?: (scratchRoot: string) => Promise<string>;
  freeScratchBytes?: (scratchRoot: string) => Promise<number>;
  processTreeRssBytes?: (pid: number) => Promise<number>;
  /**
   * Cross-process admission. Omit for the default per-user lease directory; pass `null` to
   * deliberately run process-local only (single-process embedders and most tests).
   */
  leases?: MotionJobLeaseDirectory | null;
  /**
   * Accepted and ignored.
   *
   * Terminal records describe what a *host* asked for; the governor admits the resource operations
   * Motion performs to satisfy that, which is a different unit — one render is six of them. See
   * `MotionHostJob` in host-job.ts. Kept in the type so an embedder that passes it does not break.
   *
   * @deprecated Pass nothing; record host jobs through MotionHostJob instead.
   */
  records?: MotionJobRegistry | null;
}

interface QueueWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
  timer?: NodeJS.Timeout;
}

interface MutableEvidence {
  jobId: string;
  lane: LocalMotionJobLane;
  operation: string;
  policy: LocalMotionJobPolicy;
  queuedAtMs: number;
  startedAtMs: number;
  freeBytesAtStart: number;
  peakProcessTreeRssBytes: number;
  watchedProcessCount: number;
  rssScope: LocalMotionJobEvidence["rssScope"];
  processContainment?: LocalMotionProcessContainmentEvidence;
  sandbox?: LocalMotionRuntimeSandboxEvidence;
}

/**
 * One in-process admission controller shared by renderer packages through the Core singleton.
 * Process-local scope is deliberate: independent CLI invocations remain OS-isolatable, while all
 * lanes inside one SDK/debug-server process compete for the same bounded capacity.
 */
export class LocalMotionJobGovernor {
  private activeJobs = 0;
  private readonly queue: QueueWaiter[] = [];
  // Reservations are deliberately process-global rather than path-keyed. Two different scratch
  // directories commonly share one filesystem; conservative global accounting avoids overbooking.
  private reservedScratchBytes = 0;
  /**
   * Cross-process admission, or null when this governor is deliberately process-local.
   *
   * Without it the concurrency cap is per-process, so N callers each get the full cap and the
   * memory ceiling multiplies by N instead of holding.
   */
  private readonly leases: MotionJobLeaseDirectory | null;
  constructor(
    readonly policy: LocalMotionJobPolicy = localMotionJobPolicyFromEnvironment(),
    private readonly services: LocalMotionJobGovernorServices = {}
  ) {
    validateLocalMotionJobPolicy(policy);
    this.leases = services.leases === undefined ? new MotionJobLeaseDirectory() : services.leases;
  }

  snapshot(): { activeJobs: number; queuedJobs: number; policy: LocalMotionJobPolicy; machineWide: boolean } {
    return {
      activeJobs: this.activeJobs,
      queuedJobs: this.queue.length,
      policy: { ...this.policy },
      // False means the cap is only bounded within this process — either coordination is off, or
      // it failed and the governor degraded rather than refusing to run.
      machineWide: this.leases !== null && !this.leases.isDegraded
    };
  }

  async run<T>(request: LocalMotionJobRequest, operation: (context: LocalMotionJobContext) => Promise<T>): Promise<LocalMotionJobExecution<T>> {
    const queuedAtMs = this.now();
    const operationId = boundedOperation(request.operation);
    const policy = effectivePolicy(this.policy, request.policy);
    // ONE id for the lease, the evidence and the terminal record. These were three separate random
    // values previously, so an id a caller received could not address the job it named.
    const jobId = request.jobId === undefined ? mintMotionJobId(queuedAtMs) : assertMotionJobId(request.jobId);
    const callerId = request.callerId ?? UNATTRIBUTED_CALLER_ID;

    // Announced before the in-process queue, not after it, so a job waiting for a slot is visible
    // as `pending` rather than answering `job_unknown` while it waits.
    // "internal": this is a resource admission, not the thing a host asked for. It counts against
    // capacity and is deliberately absent from motion.job.list. See host-job.ts.
    await this.leases?.announce({ jobId, lane: request.lane, operation: operationId, callerId, visibility: "internal" });
    const leases = this.leases;
    // Deliberately unref'd: refreshing a lease must not be the reason a process stays alive.
    const leaseHeartbeat: NodeJS.Timeout | undefined = leases
      ? setInterval(() => { void leases.heartbeat(jobId); }, LEASE_HEARTBEAT_INTERVAL_MS)
      : undefined;
    leaseHeartbeat?.unref?.();

    try {
      return await this.runAnnounced(request, operation, { jobId, callerId, operationId, policy, queuedAtMs });
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      await this.leases?.release(jobId);
    }
  }

  /** The governed body, after this job has an id and is publicly visible as pending. */
  private async runAnnounced<T>(
    request: LocalMotionJobRequest,
    operation: (context: LocalMotionJobContext) => Promise<T>,
    identity: { jobId: string; callerId: string; operationId: string; policy: LocalMotionJobPolicy; queuedAtMs: number }
  ): Promise<LocalMotionJobExecution<T>> {
    const { jobId, operationId, policy, queuedAtMs } = identity;
    await this.acquireSlot(request.signal, policy.maxQueueWaitMs);
    const startedAtMs = this.now();
    // Machine-wide admission happens after the in-process slot so the local queue still bounds
    // how many claims one process can have outstanding.
    let leaseHeld = false;
    try {
      leaseHeld = await this.acquireLease({
        jobId,
        lane: request.lane,
        operation: operationId,
        limit: policy.maxConcurrentJobs,
        callerId: request.callerId,
        signal: request.signal,
        deadlineAtMs: queuedAtMs + policy.maxQueueWaitMs
      });
    } catch (error) {
      this.releaseSlot();
      throw error;
    }
    void leaseHeld;
    // The moment real capacity is held, the host job that asked for this work stops waiting and
    // starts working. Without this the wrapper reports "running" from the outset, so a caller shows
    // "rendering..." over a queue — the exact confusion the pending/running split exists to prevent.
    await currentMotionHostJob()?.markRunning();
    const requestedScratchRoot = resolve(request.scratchRoot);
    let admittedScratchRoot = requestedScratchRoot;
    let reserved = false;
    let monitor: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let pendingRssSample: Promise<void> | null = null;
    const controller = new AbortController();
    const watchedPids = new Set<number>();
    const mutable: MutableEvidence = {
      jobId,
      lane: request.lane,
      operation: operationId,
      policy,
      queuedAtMs,
      startedAtMs,
      freeBytesAtStart: 0,
      peakProcessTreeRssBytes: 0,
      watchedProcessCount: 0,
      rssScope: processTreeRssScope(),
    };
    const relayAbort = () => abortOnce(controller, request.signal?.reason instanceof Error
      ? request.signal.reason
      : new LocalMotionJobError("job_cancelled", "Motion job was cancelled by its caller."));
    request.signal?.addEventListener("abort", relayAbort, { once: true });
    if (request.signal?.aborted) relayAbort();

    try {
      let freeBytes: number;
      try {
        admittedScratchRoot = await (this.services.prepareScratchRoot ?? prepareLocalMotionScratchRoot)(requestedScratchRoot);
        freeBytes = await (this.services.freeScratchBytes ?? freeScratchBytes)(admittedScratchRoot);
      } catch (error) {
        if (error instanceof LocalMotionJobError) throw error;
        throw new LocalMotionJobError("job_scratch_budget_failed", "Motion job scratch capacity could not be established.");
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      mutable.freeBytesAtStart = freeBytes;
      const required = policy.minFreeScratchBytes + this.reservedScratchBytes + policy.scratchReservationBytes;
      if (freeBytes < required) {
        throw new LocalMotionJobError(
          "job_scratch_budget_failed",
          `Motion job requires ${required} free scratch bytes but only ${freeBytes} are available.`
        );
      }
      this.reservedScratchBytes += policy.scratchReservationBytes;
      reserved = true;

      deadline = setTimeout(() => {
        abortOnce(controller, new LocalMotionJobError("job_deadline_exceeded", `Motion job exceeded its ${policy.maxWallClockMs}ms wall-clock budget.`));
      }, policy.maxWallClockMs);
      deadline.unref?.();

      const sampleRss = async () => {
        if (controller.signal.aborted || watchedPids.size === 0) return;
        let total = 0;
        for (const pid of watchedPids) {
          total += Math.max(0, await (this.services.processTreeRssBytes ?? processTreeRssBytes)(pid));
        }
        mutable.peakProcessTreeRssBytes = Math.max(mutable.peakProcessTreeRssBytes, total);
        mutable.watchedProcessCount = watchedPids.size;
        if (total > policy.maxProcessTreeRssBytes) {
          abortOnce(controller, new LocalMotionJobError(
            "job_rss_limit_exceeded",
            `Motion job process tree exceeded its ${policy.maxProcessTreeRssBytes}-byte RSS budget.`
          ));
        }
      };
      const triggerRssSample = (): Promise<void> => {
        if (!pendingRssSample) {
          pendingRssSample = sampleRss().finally(() => { pendingRssSample = null; });
        }
        return pendingRssSample;
      };
      monitor = setInterval(() => void triggerRssSample().catch(() => {
        abortOnce(controller, new LocalMotionJobError("job_rss_inspection_failed", "Motion job RSS inspection failed."));
      }), policy.rssPollIntervalMs);
      monitor.unref?.();

      const value = await operation({
        jobId: mutable.jobId,
        signal: controller.signal,
        scratchRoot: admittedScratchRoot,
        watchProcess(pid) {
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Motion job process id must be a positive safe integer.");
          watchedPids.add(pid);
          mutable.watchedProcessCount = watchedPids.size;
          void triggerRssSample().catch(() => {
            abortOnce(controller, new LocalMotionJobError("job_rss_inspection_failed", "Motion job RSS inspection failed."));
          });
        },
        reportProcessContainment(evidence) {
          if (mutable.processContainment) throw new Error("Motion job process containment was already reported.");
          mutable.processContainment = validateProcessContainmentEvidence(evidence);
        },
        reportSandbox(evidence) {
          if (mutable.sandbox) throw new Error("Motion job runtime sandbox was already reported.");
          mutable.sandbox = validateRuntimeSandboxEvidence(evidence);
        },
      });
      await triggerRssSample();
      if (controller.signal.aborted) throw controller.signal.reason;
      return { value, evidence: finalizeEvidence(mutable, "passed", this.now()) };
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      const state = request.signal?.aborted ? "cancelled" : evidenceState(reason);
      const evidence = finalizeEvidence(mutable, state, this.now());
      if (reason instanceof LocalMotionJobError) {
        throw new LocalMotionJobError(reason.code, reason.message, evidence);
      }
      throw error;
    } finally {
      if (monitor) clearInterval(monitor);
      if (deadline) clearTimeout(deadline);
      request.signal?.removeEventListener("abort", relayAbort);
      if (reserved) {
        this.reservedScratchBytes = Math.max(0, this.reservedScratchBytes - policy.scratchReservationBytes);
      }
      this.releaseSlot();
    }
  }

  private now(): number {
    return this.services.now?.() ?? Date.now();
  }

  private async acquireSlot(signal: AbortSignal | undefined, maxQueueWaitMs: number): Promise<void> {
    if (signal?.aborted) throw new LocalMotionJobError("job_cancelled", "Motion job was cancelled before admission.");
    if (this.activeJobs < this.policy.maxConcurrentJobs) {
      this.activeJobs += 1;
      return;
    }
    if (this.queue.length >= this.policy.maxQueueDepth) {
      throw new LocalMotionJobError("job_queue_full", `Motion job queue is full (${this.policy.maxQueueDepth}).`);
    }
    await new Promise<void>((resolveWait, rejectWait) => {
      const waiter: QueueWaiter = {
        resolve: resolveWait,
        reject: rejectWait,
        signal,
      };
      const remove = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", waiter.abort!);
      };
      waiter.abort = () => {
        remove();
        rejectWait(new LocalMotionJobError("job_cancelled", "Motion job was cancelled while queued."));
      };
      waiter.timer = setTimeout(() => {
        remove();
        rejectWait(new LocalMotionJobError("job_queue_timeout", `Motion job waited more than ${maxQueueWaitMs}ms for local capacity.`));
      }, maxQueueWaitMs);
      waiter.timer.unref?.();
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
      if (signal?.aborted) waiter.abort();
    });
  }

  /**
   * Wait for a machine-wide slot, retrying the optimistic claim until the queue deadline.
   *
   * Returns false when coordination is off or has degraded — the caller proceeds bounded only by
   * the in-process cap, which is the documented fallback rather than a failure.
   *
   * Backoff is deliberately jittered: several processes that lost the same rank comparison would
   * otherwise retry in lockstep forever.
   */
  private async acquireLease(input: {
    jobId: string;
    lane: LocalMotionJobLane;
    operation: string;
    limit: number;
    callerId: string | undefined;
    signal: AbortSignal | undefined;
    deadlineAtMs: number;
  }): Promise<boolean> {
    if (!this.leases) return false;
    let attempt = 0;
    for (;;) {
      const claim = await this.leases.claim({
        jobId: input.jobId,
        lane: input.lane,
        operation: input.operation,
        limit: input.limit,
        // Forwarding this is what makes per-owner visibility real. Omitting it type-checked
        // silently, because claim treats callerId as optional and defaults to "unattributed".
        ...(input.callerId ? { callerId: input.callerId } : {}),
        // A losing claim keeps its announced lease, so the job stays observable as `pending` for
        // the whole time it waits instead of blinking out of existence between retries.
        retainPending: true
      });
      if (!claim.machineWide) return false;
      if (claim.admitted) return true;
      // The signal is only consulted once this actually has to wait. Checking it before the first
      // claim would pre-empt the cancellation paths further down and change which error a
      // cancelled job reports.
      if (input.signal?.aborted) {
        throw new LocalMotionJobError("job_cancelled", "Motion job was cancelled while waiting for machine-wide capacity.");
      }
      if (this.now() >= input.deadlineAtMs) {
        throw new LocalMotionJobError(
          "job_queue_timeout",
          `Motion job waited for machine-wide capacity past its queue deadline (${claim.observed} job(s) already running on this machine).`
        );
      }
      attempt += 1;
      await this.waitBeforeRetry(attempt, input.signal);
    }
  }

  /** Bounded, jittered backoff so processes that lost the same comparison do not retry in step. */
  private async waitBeforeRetry(attempt: number, signal: AbortSignal | undefined): Promise<void> {
    const base = Math.min(50 * 2 ** Math.min(attempt, 5), 1_000);
    const delay = base / 2 + Math.random() * (base / 2);
    await new Promise<void>((resolveWait, rejectWait) => {
      // Deliberately NOT unref'd. A process waiting for machine-wide capacity may have nothing
      // else on its event loop, and an unref'd timer lets it exit instead of waiting for the
      // slot it asked for. Observed directly: a second process exited with "unsettled top-level
      // await" rather than running once the first released.
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolveWait();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        rejectWait(new LocalMotionJobError("job_cancelled", "Motion job was cancelled while waiting for machine-wide capacity."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private releaseSlot(): void {
    this.activeJobs = Math.max(0, this.activeJobs - 1);
    const waiter = this.queue.shift();
    if (!waiter) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.abort!);
    this.activeJobs += 1;
    waiter.resolve();
  }
}

export const defaultLocalMotionJobGovernor = new LocalMotionJobGovernor();

/** Rejects hostile dimensions before native allocation or Chromium context creation. */
export function assertLocalMotionFrameBudget(input: {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}): void {
  const scale = input.deviceScaleFactor ?? 1;
  if (
    !Number.isSafeInteger(input.width)
    || !Number.isSafeInteger(input.height)
    || input.width <= 0
    || input.height <= 0
    || input.width > MAX_RENDER_DIMENSION
    || input.height > MAX_RENDER_DIMENSION
    || !Number.isFinite(scale)
    || scale <= 0
    || scale > 4
    || input.width * input.height * scale * scale > MAX_RENDER_PIXELS
  ) {
    throw new LocalMotionJobError(
      "job_input_budget_exceeded",
      `Motion frame exceeds the local ${MAX_RENDER_DIMENSION}-pixel side or ${MAX_RENDER_PIXELS}-pixel output budget.`
    );
  }
}

/** Prevents frame-list allocation from becoming an input-controlled memory exhaustion path. */
export function assertLocalMotionFrameCountBudget(frameCount: number): void {
  if (!Number.isSafeInteger(frameCount) || frameCount < 0 || frameCount > MAX_RENDER_FRAMES) {
    throw new LocalMotionJobError(
      "job_input_budget_exceeded",
      `Motion job exceeds the local ${MAX_RENDER_FRAMES}-frame budget.`
    );
  }
}

/**
 * The document shape this installation can actually render, in numbers an authoring surface can
 * quote back to its caller.
 *
 * Every value here is one of the guards above or the CLI render budget, never a fresh opinion, so a
 * refusal at authoring time and a refusal at render time name the same limit.
 */
export const MOTION_DOCUMENT_LIMITS = Object.freeze({
  /** Longest side of one frame, from `assertLocalMotionFrameBudget`. */
  maxDimension: MAX_RENDER_DIMENSION,
  /** Pixels in one frame, from `assertLocalMotionFrameBudget` (7680 x 4320). */
  maxFramePixels: MAX_RENDER_PIXELS,
  minFps: MIN_DOCUMENT_FPS,
  maxFps: MAX_DOCUMENT_FPS,
  /** Frames a delivery render materialises, from the CLI frame-sequence budget. */
  maxFrames: MAX_RENDER_SEQUENCE_FRAMES,
  /** frames x width x height, from the CLI frame-sequence budget. */
  maxPixelFrames: MAX_RENDER_SEQUENCE_PIXEL_FRAMES,
  /**
   * Longest document the frame budget allows, which is the budget spent at the slowest legal frame
   * rate. Derived rather than chosen: at 1 fps, 36,000 frames is 36,000,000 ms (10 hours), and any
   * higher frame rate reaches the frame budget sooner.
   */
  maxDurationMs: (MAX_RENDER_SEQUENCE_FRAMES * 1_000) / MIN_DOCUMENT_FPS,
});

/**
 * How many frames a delivery render materialises for a document.
 *
 * The renderers' own formula (`frameCountFor` in the CLI, and the ffmpeg encoder's frame count):
 * duplicated here only so an authoring surface can ask the question before a render exists.
 *
 * @param durationMs document duration
 * @param fps document frame rate
 * @returns at least one frame, even for a sub-frame duration
 */
export function motionDocumentFrameCount(durationMs: number, fps: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(fps) || fps <= 0) return 1;
  return Math.max(1, Math.ceil((durationMs / 1_000) * fps));
}

/**
 * Why this machine could not render a document of this shape, or undefined when it can.
 *
 * Returns a message rather than throwing because the callers are authoring surfaces that report a
 * refusal to an agent, and every message names the accepted range: an agent that is told "width is
 * too large" learns nothing it can act on, while "an integer from 1 to 7680" is a retry.
 *
 * @param document the authored width/height/fps/durationMs
 * @returns a sentence naming the field, the received value and the accepted range, or undefined
 */
export function motionDocumentBudgetError(document: {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}): string | undefined {
  const { width, height, fps, durationMs } = document;
  const limits = MOTION_DOCUMENT_LIMITS;
  for (const [field, value] of [["width", width], ["height", height]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > limits.maxDimension) {
      return `${field} must be an integer from 1 to ${limits.maxDimension}; received ${value}.`;
    }
  }
  if (width * height > limits.maxFramePixels) {
    return `frame is ${width}x${height} = ${width * height} pixels; this machine renders at most `
      + `${limits.maxFramePixels} pixels per frame (7680x4320). Lower the width or the height.`;
  }
  if (!Number.isFinite(fps) || fps < limits.minFps || fps > limits.maxFps) {
    return `fps must be a number from ${limits.minFps} to ${limits.maxFps}; received ${fps}.`;
  }
  // Only finiteness and sign here. The ceiling is deliberately left to the frame rule below, which
  // knows the frame rate: `maxDurationMs` is the budget spent at 1 fps, so quoting it to someone
  // authoring at 60 fps would name a limit twice as generous as the one about to refuse them.
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return `durationMs must be a number greater than 0, and short enough to stay inside the `
      + `${limits.maxFrames}-frame render budget (at most ${limits.maxDurationMs} at 1 fps, less at `
      + `higher frame rates); received ${durationMs}.`;
  }
  const frames = motionDocumentFrameCount(durationMs, fps);
  if (frames > limits.maxFrames) {
    const longestMs = Math.floor((limits.maxFrames * 1_000) / fps);
    return `${durationMs}ms at ${fps} fps needs ${frames} frames; this machine renders at most `
      + `${limits.maxFrames} frames, so at ${fps} fps the longest document is ${longestMs}ms. `
      + "Lower durationMs or fps.";
  }
  const pixelFrames = frames * width * height;
  if (!Number.isSafeInteger(pixelFrames) || pixelFrames > limits.maxPixelFrames) {
    const longestMs = Math.floor((limits.maxPixelFrames / (width * height)) * 1_000 / fps);
    return `${frames} frames at ${width}x${height} is ${pixelFrames} pixel-frames; this machine `
      + `renders at most ${limits.maxPixelFrames}, so at this size and ${fps} fps the longest `
      + `document is ${longestMs}ms. Lower the resolution, durationMs or fps.`;
  }
  return undefined;
}

export function localMotionJobPolicyFromEnvironment(env: NodeJS.ProcessEnv = process.env): LocalMotionJobPolicy {
  return {
    maxConcurrentJobs: boundedEnvInteger(env.SHELLX_MOTION_MAX_CONCURRENT_JOBS, 2, 1, 16),
    maxQueueDepth: boundedEnvInteger(env.SHELLX_MOTION_MAX_QUEUE_DEPTH, 64, 0, 1_024),
    maxQueueWaitMs: boundedEnvInteger(env.SHELLX_MOTION_MAX_QUEUE_WAIT_MS, 5 * 60_000, 100, 60 * 60_000),
    maxWallClockMs: boundedEnvInteger(env.SHELLX_MOTION_MAX_JOB_MS, 30 * 60_000, 100, 24 * 60 * 60_000),
    minFreeScratchBytes: boundedEnvInteger(env.SHELLX_MOTION_MIN_FREE_SCRATCH_BYTES, 256 * MIB, 0, 16 * 1024 * GIB),
    scratchReservationBytes: boundedEnvInteger(env.SHELLX_MOTION_SCRATCH_RESERVATION_BYTES, 64 * MIB, 0, 16 * 1024 * GIB),
    maxProcessTreeRssBytes: boundedEnvInteger(env.SHELLX_MOTION_MAX_JOB_RSS_BYTES, 6 * GIB, 64 * MIB, 1024 * GIB),
    rssPollIntervalMs: boundedEnvInteger(env.SHELLX_MOTION_RSS_POLL_MS, 1_000, 25, 60_000),
  };
}

export async function freeScratchBytes(scratchRoot: string): Promise<number> {
  const facts = await statfs(scratchRoot, { bigint: true });
  return safeBigIntToNumber(facts.bavail * facts.bsize);
}

/**
 * Create a scratch directory without traversing an existing symlink/junction component.
 * `mkdir({recursive:true})` is intentionally avoided: it can follow a package-controlled reparse
 * point before a later realpath check notices the escape.
 */
export async function prepareLocalMotionScratchRoot(scratchRoot: string): Promise<string> {
  const requested = await canonicalScratchRequest(resolve(scratchRoot));
  if (dirname(requested) === requested) throw scratchPathError();
  const chain: string[] = [];
  let cursor = requested;
  while (dirname(cursor) !== cursor) {
    chain.unshift(cursor);
    cursor = dirname(cursor);
  }

  for (const component of chain) {
    let facts: Awaited<ReturnType<typeof lstat>>;
    try {
      facts = await lstat(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw scratchPathError();
      }
      try {
        await mkdir(component, { mode: 0o700 });
        facts = await lstat(component);
      } catch {
        throw scratchPathError();
      }
    }
    if (!facts.isDirectory() || facts.isSymbolicLink()) throw scratchPathError();
    let canonical: string;
    try {
      canonical = await realpath(component);
    } catch {
      throw scratchPathError();
    }
    if (!sameCanonicalPath(canonical, component)) throw scratchPathError();
  }
  return requested;
}

async function canonicalScratchRequest(requested: string): Promise<string> {
  // macOS commonly exposes TMPDIR through the root-owned /var -> /private/var alias. The current
  // workspace and OS temp directory are host-selected trust anchors, so canonicalize only those
  // prefixes before rejecting every later symlink/reparse component.
  for (const base of [resolve(process.cwd()), resolve(tmpdir())]) {
    if (requested !== base && !requested.startsWith(`${base}${process.platform === "win32" ? "\\" : "/"}`)) continue;
    let canonicalBase: string;
    try {
      canonicalBase = await realpath(base);
    } catch {
      continue;
    }
    return resolve(canonicalBase, requested.slice(base.length).replace(/^[/\\]+/, ""));
  }
  return requested;
}

/** Cross-platform best-effort RSS for a process and descendants, bounded by local OS facts. */
export async function processTreeRssBytes(pid: number): Promise<number> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 0;
  if (process.platform === "linux") return linuxProcessTreeRssBytes(pid);
  if (process.platform === "darwin") return psProcessTreeRssBytes(pid);
  if (process.platform === "win32") return windowsProcessTreeRssBytes(pid);
  return 0;
}

function processTreeRssScope(): LocalMotionJobEvidence["rssScope"] {
  if (process.platform === "linux" || process.platform === "darwin" || process.platform === "win32") return "process-tree";
  return "unavailable";
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function scratchPathError(): LocalMotionJobError {
  return new LocalMotionJobError(
    "job_scratch_path_unsafe",
    "Motion job scratch root must be a canonical directory without symlink or reparse-point components."
  );
}

async function linuxProcessTreeRssBytes(rootPid: number): Promise<number> {
  const pending = [rootPid];
  const seen = new Set<number>();
  let total = 0;
  while (pending.length > 0 && seen.size < 4_096) {
    const pid = pending.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const [status, children] = await Promise.all([
      readFile(`/proc/${pid}/status`, "utf8").catch(() => ""),
      readFile(`/proc/${pid}/task/${pid}/children`, "utf8").catch(() => ""),
    ]);
    const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    if (rss) total += Number(rss[1]) * 1024;
    for (const child of children.trim().split(/\s+/)) {
      const childPid = Number(child);
      if (Number.isSafeInteger(childPid) && childPid > 0 && !seen.has(childPid)) pending.push(childPid);
    }
  }
  if (pending.length > 0) throw new Error("Motion process tree exceeds the 4096-process inspection budget.");
  return total;
}

async function psProcessTreeRssBytes(rootPid: number): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * MIB });
  const rows = stdout.trim().split("\n").map((line) => {
    const [pid, parentPid, rssKb] = line.trim().split(/\s+/).map(Number);
    return { pid, parentPid, rssBytes: rssKb * 1024 };
  }).filter((row) => Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.parentPid) && Number.isFinite(row.rssBytes));
  return sumBoundedProcessTreeRss(rows, rootPid);
}

async function windowsProcessTreeRssBytes(pid: number): Promise<number> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$rows=Get-CimInstance Win32_Process | Select-Object @{n='pid';e={[int64]$_.ProcessId}},@{n='parentPid';e={[int64]$_.ParentProcessId}},@{n='rssBytes';e={[int64]$_.WorkingSetSize}}",
    "@($rows) | ConvertTo-Json -Compress"
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * MIB
  });
  const parsed = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  return sumBoundedProcessTreeRss(Array.isArray(parsed) ? parsed : [parsed], pid);
}

/** Sum one root and all descendants without accepting an unbounded host process inventory. */
export function sumBoundedProcessTreeRss(rows: unknown[], rootPid: number, maxProcesses = 4_096): number {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || !Number.isSafeInteger(maxProcesses) || maxProcesses < 1 || maxProcesses > 65_536) {
    throw new Error("Motion process tree RSS input is invalid.");
  }
  const normalized = rows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const pid = Number(record.pid);
    const parentPid = Number(record.parentPid);
    const rssBytes = Number(record.rssBytes);
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(parentPid) && parentPid >= 0 && Number.isFinite(rssBytes) && rssBytes >= 0
      ? [{ pid, parentPid, rssBytes: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(rssBytes)) }]
      : [];
  });
  const children = new Map<number, number[]>();
  for (const row of normalized) {
    const group = children.get(row.parentPid) ?? [];
    group.push(row.pid);
    children.set(row.parentPid, group);
  }
  const family = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.shift()!;
    if (family.has(pid)) continue;
    if (family.size >= maxProcesses) throw new Error(`Motion process tree exceeds the ${maxProcesses}-process inspection budget.`);
    family.add(pid);
    for (const childPid of children.get(pid) ?? []) if (!family.has(childPid)) pending.push(childPid);
  }
  return normalized.filter((row) => family.has(row.pid)).reduce((sum, row) => Math.min(Number.MAX_SAFE_INTEGER, sum + row.rssBytes), 0);
}

function effectivePolicy(base: LocalMotionJobPolicy, overrides: LocalMotionJobRequest["policy"]): LocalMotionJobPolicy {
  const policy = { ...base, ...(overrides ?? {}) };
  validateLocalMotionJobPolicy(policy);
  return policy;
}

function validateLocalMotionJobPolicy(policy: LocalMotionJobPolicy): void {
  const bounds: Array<[keyof LocalMotionJobPolicy, number, number]> = [
    ["maxConcurrentJobs", 1, 16], ["maxQueueDepth", 0, 1_024], ["maxQueueWaitMs", 100, 60 * 60_000],
    ["maxWallClockMs", 100, 24 * 60 * 60_000], ["minFreeScratchBytes", 0, 16 * 1024 * GIB],
    ["scratchReservationBytes", 0, 16 * 1024 * GIB], ["maxProcessTreeRssBytes", 64 * MIB, 1024 * GIB],
    ["rssPollIntervalMs", 25, 60_000],
  ];
  for (const [key, min, max] of bounds) {
    const value = policy[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Motion local job policy ${key} must be an integer from ${min} to ${max}.`);
  }
}

function boundedEnvInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

function boundedOperation(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[a-z0-9._:-]+$/i.test(value)) {
    throw new Error("Motion local job operation must be 1..128 safe identifier characters.");
  }
  return value;
}

function validateProcessContainmentEvidence(evidence: LocalMotionProcessContainmentEvidence): LocalMotionProcessContainmentEvidence {
  if (evidence.schema !== "shellx-motion/process-containment@1") {
    throw new Error("Motion process containment evidence schema is invalid.");
  }
  const modes = new Set<LocalMotionProcessContainmentEvidence["mode"]>([
    "windows-job-object", "windows-taskkill-fallback", "unix-process-group", "cooperative-browser-session", "direct-child"
  ]);
  const statuses = new Set<LocalMotionProcessContainmentEvidence["status"]>(["enforced", "fallback", "unavailable"]);
  const memoryLimits = new Set<LocalMotionProcessContainmentEvidence["memoryLimit"]>(["job-commit", "rss-monitor", "none"]);
  if (!modes.has(evidence.mode) || !statuses.has(evidence.status) || !memoryLimits.has(evidence.memoryLimit)) {
    throw new Error("Motion process containment evidence contains an unsupported mode or status.");
  }
  if (evidence.mode === "windows-job-object" && (
    evidence.status !== "enforced"
    || evidence.killTree !== true
    || evidence.memoryLimit !== "job-commit"
    || evidence.maxJobMemoryBytes === undefined
    || evidence.maxActiveProcesses === undefined
    || evidence.launcher === undefined
    || evidence.reasonCode !== undefined
  )) {
    throw new Error("Windows Job Object evidence must report enforced tree kill, native limits, and launcher identity.");
  }
  if (evidence.mode === "windows-taskkill-fallback" && (
    evidence.status !== "fallback"
    || evidence.killTree !== true
    || evidence.memoryLimit !== "rss-monitor"
    || !["native_helper_missing", "native_setup_failed"].includes(evidence.reasonCode ?? "")
  )) {
    throw new Error("Windows taskkill evidence must report a reasoned tree-kill fallback with RSS monitoring.");
  }
  if (evidence.mode === "unix-process-group" && (
    evidence.status !== "enforced"
    || evidence.killTree !== true
    || evidence.memoryLimit !== "rss-monitor"
    || evidence.reasonCode !== undefined
    || evidence.launcher !== undefined
  )) {
    throw new Error("Unix process-group evidence must report enforced tree kill with RSS monitoring.");
  }
  if (evidence.mode === "cooperative-browser-session" && (
    evidence.status !== "fallback"
    || evidence.killTree !== false
    || evidence.memoryLimit !== "rss-monitor"
    || evidence.reasonCode !== "worker_process_unavailable"
    || evidence.launcher !== undefined
  )) {
    throw new Error("Cooperative browser evidence must report PID-unavailable fallback close with RSS monitoring.");
  }
  if (evidence.mode === "direct-child" && (
    evidence.status !== "unavailable"
    || evidence.killTree !== false
    || evidence.memoryLimit !== "none"
    || evidence.reasonCode === undefined
  )) {
    throw new Error("Direct-child evidence must report unavailable tree containment with a reason.");
  }
  if (evidence.maxJobMemoryBytes !== undefined && (!Number.isSafeInteger(evidence.maxJobMemoryBytes) || evidence.maxJobMemoryBytes < 64 * MIB)) {
    throw new Error("Motion process containment memory limit is invalid.");
  }
  if (evidence.maxActiveProcesses !== undefined && (!Number.isSafeInteger(evidence.maxActiveProcesses) || evidence.maxActiveProcesses < 1 || evidence.maxActiveProcesses > 65_536)) {
    throw new Error("Motion process containment active-process limit is invalid.");
  }
  if (evidence.launcher && (evidence.launcher.kind !== "powershell-csharp" || !/^[a-f0-9]{64}$/.test(evidence.launcher.sha256))) {
    throw new Error("Motion process containment launcher identity is invalid.");
  }
  if (evidence.mode !== "windows-job-object" && (evidence.maxJobMemoryBytes !== undefined || evidence.maxActiveProcesses !== undefined)) {
    throw new Error("Only Windows Job Object evidence may report native Job Object limits.");
  }
  return {
    ...evidence,
    ...(evidence.launcher ? { launcher: { ...evidence.launcher } } : {}),
  };
}

function validateRuntimeSandboxEvidence(evidence: LocalMotionRuntimeSandboxEvidence): LocalMotionRuntimeSandboxEvidence {
  if (
    evidence.schema !== "shellx-motion/runtime-sandbox@1"
    || evidence.provider !== "chromium"
    || evidence.scope !== "browser-process"
    || !["requested", "disabled"].includes(evidence.status)
  ) {
    throw new Error("Motion runtime sandbox evidence is invalid.");
  }
  if (evidence.status === "requested" && evidence.reasonCode !== undefined) {
    throw new Error("Requested runtime sandbox evidence must not include an opt-out reason.");
  }
  if (evidence.status === "disabled" && evidence.reasonCode !== "trusted_host_opt_out") {
    throw new Error("Disabled runtime sandbox evidence requires the trusted host opt-out reason.");
  }
  return { ...evidence };
}

function safeBigIntToNumber(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function abortOnce(controller: AbortController, reason: Error): void {
  if (!controller.signal.aborted) controller.abort(reason);
}

function evidenceState(error: unknown): LocalMotionJobEvidence["state"] {
  if (!(error instanceof LocalMotionJobError)) return "failed";
  if (error.code === "job_cancelled") return "cancelled";
  if (error.code === "job_queue_timeout") return "queue_timeout";
  if (error.code === "job_deadline_exceeded") return "deadline_exceeded";
  if (error.code === "job_rss_limit_exceeded") return "rss_limit_exceeded";
  if (error.code === "job_rss_inspection_failed") return "failed";
  if (error.code === "job_scratch_path_unsafe") return "scratch_path_unsafe";
  if (error.code === "job_scratch_budget_failed") return "scratch_budget_failed";
  if (error.code === "job_input_budget_exceeded") return "input_budget_exceeded";
  return "failed";
}

function finalizeEvidence(mutable: MutableEvidence, state: LocalMotionJobEvidence["state"], finishedAtMs: number): LocalMotionJobEvidence {
  return {
    schema: "shellx-motion/local-job-resources@1",
    jobId: mutable.jobId,
    lane: mutable.lane,
    operation: mutable.operation,
    state,
    queueWaitMs: Math.max(0, mutable.startedAtMs - mutable.queuedAtMs),
    durationMs: Math.max(0, finishedAtMs - mutable.startedAtMs),
    policy: { ...mutable.policy },
    scratch: {
      pathSafety: "canonical-no-symlink",
      freeBytesAtStart: mutable.freeBytesAtStart,
      reservedBytes: mutable.policy.scratchReservationBytes,
      minFreeBytes: mutable.policy.minFreeScratchBytes,
    },
    peakProcessTreeRssBytes: mutable.peakProcessTreeRssBytes,
    watchedProcessCount: mutable.watchedProcessCount,
    rssScope: mutable.rssScope,
    ...(mutable.processContainment ? { processContainment: { ...mutable.processContainment } } : {}),
    ...(mutable.sandbox ? { sandbox: { ...mutable.sandbox } } : {}),
  };
}
