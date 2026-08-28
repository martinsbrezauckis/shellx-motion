/**
 * Live job queries — the surface a host polls while work is in flight.
 *
 * Role: `motion.render.status` and `motion.render.queue` read *receipt files*, so they can only
 * describe work that has already finished writing evidence. A host that has just asked for a render
 * and wants to know whether it is queued, running or done had nothing to call. This module is that
 * missing surface: `motion.job.get` and `motion.job.list` answer from the live lease directory and
 * the terminal record store, merged by `MotionJobView`.
 *
 * The two boundaries this enforces, and why they are here rather than in core:
 *
 *  1. **Owner scope.** Every query is answered as the dispatch's caller. An agent embedded in Cut
 *     asking for "all jobs" must not enumerate Design Studio's work, so `scope: "all"` is refused
 *     unless the *host* granted cross-caller visibility when it started the server. That is a
 *     transport decision by design — core deliberately declines to make it.
 *  2. **Query errors are not job states.** `job_unknown`, `job_expired` and `job_not_visible`
 *     describe the lookup, never the job, and each demands a different response from the caller.
 *     They are reported as typed errors with the contract's guidance attached.
 *
 * Dependencies: `@shellx-motion/core` (MotionJobView). Primary caller: the render domain router.
 */
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { JOB_STATUS_CONTRACT, type MotionJobCoordinator, type MotionJobCoordinatorResult, type MotionJobStatus, type MotionJobView } from "@shellx-motion/core";
import { nonNegativeNumberArg, positiveIntegerArg, stringArg } from "./args.js";

export interface RenderJobQueryServices {
  /** Reads the live lease directory and the terminal record store as one. */
  jobView?: MotionJobView;
  /** Server-generated/authenticated owner principal this dispatch is answered as. */
  jobCallerId?: string;
  /**
   * Whether this host granted cross-caller visibility.
   *
   * Defaults to false everywhere. An operator console is started differently from an embedded
   * agent, which is exactly the distinction that makes this safe to expose at all.
   */
  jobCrossCallerScopeGranted?: boolean;
  /** Process-owned coordinator; controls are unavailable when the host has no worker authority. */
  jobCoordinator?: MotionJobCoordinator;
  /** Host-owned retry router; durable connector bindings use this instead of an in-memory closure. */
  retryCoordinatedJob?: (input: { jobId: string; callerId: string; newJobId?: string }) => Promise<MotionJobCoordinatorResult<{ jobId: string; priorJobId: string }>>;
}

/** Guidance for each query error, taken from the authored contract rather than restated here. */
const QUERY_ERROR_GUIDANCE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(JOB_STATUS_CONTRACT.queryErrors.map((entry) => [entry.code, entry.agentGuidance]))
);

export async function dispatchRenderJobQueryCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderJobQueryServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.job.events") return await eventsResult(args, services);
  if (command === "motion.job.cancel") return await cancelResult(args, services);
  if (command === "motion.job.retry") return await retryResult(args, services);
  if (command !== "motion.job.get" && command !== "motion.job.list") return null;
  const callerId = trustedJobCallerId(services);
  if (!callerId) return ownerPrincipalUnavailable();
  if (!services.jobView) {
    return capabilityUnavailable("Motion job tracking is unavailable on this host.");
  }
  const scope = readScope(args);
  if (scope === false) {
    return invalidArgs(
      "motion.job scope must be \"own\" or \"all\".",
      "Pass scope \"own\" to see this caller's jobs, or \"all\" only on a host that granted cross-caller visibility."
    );
  }
  if (scope === "all" && services.jobCrossCallerScopeGranted !== true) {
    return {
      ok: false,
      error: {
        code: "permission_denied",
        message: "motion.job scope \"all\" requires a host that granted cross-caller job visibility.",
        // Naming the fix rather than only the refusal: an agent cannot grant itself this, and
        // saying so stops it retrying the same call.
        suggestedAction: "Ask the host operator to start the Motion debug server with cross-caller job visibility, or query scope \"own\"."
      },
      warnings: []
    };
  }
  const requestScope = scope ?? "own";
  return command === "motion.job.get"
    ? await getResult(args, services.jobView, callerId, requestScope)
    : await listResult(args, services.jobView, callerId, requestScope);
}

async function eventsResult(args: unknown, services: RenderJobQueryServices): Promise<MotionDebugResult> {
  const jobId = stringArg(args, "jobId");
  const after = nonNegativeNumberArg(args, "after");
  if (!jobId) return invalidArgs("motion.job.events requires jobId.", "Pass the id returned by motion.job.submit.");
  if (after === false || (after !== null && !Number.isSafeInteger(after))) return invalidArgs("motion.job.events after must be a non-negative integer.", "Omit after for the retained event log, or pass the last event sequence you processed.");
  if (!services.jobCoordinator) return capabilityUnavailable("Live job events require the persistent local Motion job coordinator.");
  const callerId = trustedJobCallerId(services);
  if (!callerId) return ownerPrincipalUnavailable();
  const answer = await services.jobCoordinator.events({ jobId, callerId, ...(after === null ? {} : { after }) });
  if (!answer.ok) return coordinatorFailure(answer.code, answer.message);
  return { ok: true, visibleState: { panel: "render", operation: "job.events", jobId, eventCount: answer.value.events.length }, result: { ok: true, jobId, events: answer.value.events }, warnings: [] };
}

async function cancelResult(args: unknown, services: RenderJobQueryServices): Promise<MotionDebugResult> {
  const jobId = stringArg(args, "jobId");
  const reason = stringArg(args, "reason") ?? undefined;
  if (!jobId) return invalidArgs("motion.job.cancel requires jobId.", "Pass the id returned by motion.job.submit.");
  if (!services.jobCoordinator) return capabilityUnavailable("Live cancellation requires the persistent local Motion job coordinator.");
  const callerId = trustedJobCallerId(services);
  if (!callerId) return ownerPrincipalUnavailable();
  const answer = await services.jobCoordinator.cancel({ jobId, callerId, ...(reason ? { reason } : {}) });
  if (!answer.ok) return coordinatorFailure(answer.code, answer.message);
  return {
    ok: true,
    visibleState: { panel: "render", operation: "job.cancel", jobId, state: answer.value.job.state, cancelRequested: true },
    result: { ok: true, job: answer.value.job, cancelRequested: true }, warnings: []
  };
}

async function retryResult(args: unknown, services: RenderJobQueryServices): Promise<MotionDebugResult> {
  const jobId = stringArg(args, "jobId");
  const newJobId = stringArg(args, "newJobId") ?? undefined;
  if (!jobId) return invalidArgs("motion.job.retry requires jobId.", "Pass a retryable failed job id.");
  if (!services.jobCoordinator) return capabilityUnavailable("Live retry requires the persistent local Motion job coordinator.");
  const callerId = trustedJobCallerId(services);
  if (!callerId) return ownerPrincipalUnavailable();
  const retry = services.retryCoordinatedJob ?? (async (input) => await services.jobCoordinator!.retry(input));
  const answer = await retry({ jobId, callerId, ...(newJobId ? { newJobId } : {}) });
  if (!answer.ok) return coordinatorFailure(answer.code, answer.message);
  return {
    ok: true,
    visibleState: { panel: "render", operation: "job.retry", jobId: answer.value.jobId, priorJobId: answer.value.priorJobId },
    result: { ok: true, ...answer.value }, warnings: []
  };
}

function coordinatorFailure(code: string, message: string): MotionDebugResult {
  return { ok: false, error: { code, message, suggestedAction: code === "job_not_retryable" ? "Retry only a failed job whose error is marked retryable; never restart a cancelled job automatically." : "Re-read the job id and caller identity from the submission response." }, warnings: [] };
}

async function getResult(args: unknown, view: MotionJobView, callerId: string, scope: "own" | "all"): Promise<MotionDebugResult> {
  const jobId = stringArg(args, "jobId");
  if (!jobId) {
    return invalidArgs("motion.job.get requires jobId.", "Pass the jobId returned by the render that created it, or the id you supplied when starting it.");
  }
  const answer = await view.get({ jobId, callerId, scope });
  if (!answer.ok) {
    return {
      ok: false,
      error: {
        code: answer.code,
        message: `Motion job ${jobId} could not be read: ${answer.code}.`,
        suggestedAction: QUERY_ERROR_GUIDANCE[answer.code] ?? "Re-read the jobId from the submission response."
      },
      warnings: []
    };
  }
  return {
    ok: true,
    visibleState: { panel: "render", operation: "job.get", jobId, state: answer.job.state, lifecycle: answer.job.lifecycle },
    result: { ok: true, job: answer.job },
    warnings: answer.job.warnings
  };
}

async function listResult(args: unknown, view: MotionJobView, callerId: string, scope: "own" | "all"): Promise<MotionDebugResult> {
  const limit = positiveIntegerArg(args, "limit");
  if (limit === false) {
    return invalidArgs("motion.job.list limit must be a positive integer.", "Omit limit for the default page, or pass a positive whole number.");
  }
  const jobs = await view.list({ callerId, scope, ...(limit === null ? {} : { limit }) });
  return {
    ok: true,
    visibleState: {
      panel: "render", operation: "job.list", jobCount: jobs.length,
      inFlightCount: jobs.filter((job) => job.lifecycle !== "ended").length,
      stateCounts: stateCounts(jobs)
    },
    result: { ok: true, scope, callerId, jobCount: jobs.length, stateCounts: stateCounts(jobs), jobs },
    warnings: []
  };
}

/** Every contract state, always present, so a caller can read a zero without a key check. */
function stateCounts(jobs: MotionJobStatus[]): Record<string, number> {
  const counts: Record<string, number> = { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const job of jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;
  return counts;
}

/** `false` distinguishes a rejected value from an omitted one, so the error can say which. */
function readScope(args: unknown): "own" | "all" | null | false {
  const scope = stringArg(args, "scope");
  if (scope === null) return null;
  return scope === "own" || scope === "all" ? scope : false;
}

function invalidArgs(message: string, suggestedAction: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message, suggestedAction }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}

function trustedJobCallerId(services: RenderJobQueryServices): string | undefined {
  return services.jobCallerId?.trim() || undefined;
}

function ownerPrincipalUnavailable(): MotionDebugResult {
  return {
    ok: false,
    error: {
      code: "capability_unavailable",
      message: "Motion job access requires a server-authenticated owner principal.",
      suggestedAction: "Ask the host operator to use an authenticated Motion transport or configure a trusted in-process caller identity."
    },
    warnings: []
  };
}
