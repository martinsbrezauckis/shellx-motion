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
import { JOB_STATUS_CONTRACT, type MotionJobStatus, type MotionJobView } from "@shellx-motion/core";
import { positiveIntegerArg, stringArg } from "./args.js";

export interface RenderJobQueryServices {
  /** Reads the live lease directory and the terminal record store as one. */
  jobView?: MotionJobView;
  /** The owner identity this dispatch is answered as, derived from the transport-observed actor. */
  jobCallerId?: string;
  /**
   * Whether this host granted cross-caller visibility.
   *
   * Defaults to false everywhere. An operator console is started differently from an embedded
   * agent, which is exactly the distinction that makes this safe to expose at all.
   */
  jobCrossCallerScopeGranted?: boolean;
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
  if (command !== "motion.job.get" && command !== "motion.job.list") return null;
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
  const callerId = services.jobCallerId ?? "unattributed";
  const requestScope = scope ?? "own";
  return command === "motion.job.get"
    ? await getResult(args, services.jobView, callerId, requestScope)
    : await listResult(args, services.jobView, callerId, requestScope);
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
