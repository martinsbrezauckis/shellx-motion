/** Caller-scoped projections of live host-job leases. */
import type { MotionJobLeaseRecord } from "./job-lease-types";

export function visibleMotionJobLeases(
  live: MotionJobLeaseRecord[],
  input: { callerId: string; scope?: "own" | "all" }
): MotionJobLeaseRecord[] {
  const host = live.filter((entry) => entry.visibility === "host");
  return input.scope === "all" ? host : host.filter((entry) => entry.callerId === input.callerId);
}

export function visibleMotionJobLease(
  live: MotionJobLeaseRecord[],
  input: { jobId: string; callerId: string; scope?: "own" | "all" }
): { ok: true; lease: MotionJobLeaseRecord } | { ok: false; code: "job_unknown" | "job_not_visible" } {
  const matching = live.filter((entry) => entry.jobId === input.jobId && entry.visibility === "host");
  if (matching.length === 0) return { ok: false, code: "job_unknown" };
  if (input.scope === "all") return { ok: true, lease: matching[0] };
  const mine = matching.find((entry) => entry.callerId === input.callerId);
  return mine ? { ok: true, lease: mine } : { ok: false, code: "job_not_visible" };
}
