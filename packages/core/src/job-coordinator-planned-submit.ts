/** Immutable V1 render-plan admission, replay, and identity-claim policy. */
import type { MotionJobCoordinatorResult, MotionJobCoordinatorSubmit, MotionJobCoordinatorSubmitValue } from "./job-coordinator";
import { type MotionJobIdentityClaimHandle, MotionJobIdentityClaimStore } from "./job-identity-claim-store";
import { coordinatorFailure } from "./job-coordinator-support";
import { MotionRenderAdmissionStore } from "./render-admission-store";
import { parseMotionRenderPlan, type MotionRenderPlan } from "./render-plan";
import { MotionRenderPlanStore } from "./render-plan-store";

export type MotionCoordinatorPresence =
  | { kind: "present"; planFingerprint?: string; terminal: boolean }
  | { kind: "missing" }
  | { kind: "unavailable" };

export type MotionCoordinatorSubmittedAcceptance =
  | { kind: "accepted"; schema: string; fingerprint: string }
  | { kind: "missing" }
  | { kind: "unavailable" };

export interface MotionJobCoordinatorPlannedSubmitServices {
  readJobState(jobId: string, callerId: string, identity: string): Promise<MotionCoordinatorPresence>;
  /** Reads only the first durable submitted event; no event means no planned replay proof. */
  readSubmittedAcceptance(jobId: string, callerId: string): Promise<MotionCoordinatorSubmittedAcceptance>;
  /** Process-local live replay requires both a non-settling marker and the exact held claim. */
  isLocallyReplayablePlanned(identity: string, planFingerprint: string): Promise<boolean>;
  /** Invoking this method transfers the held claim to the coordinator before host-lease creation. */
  submitReserved(input: MotionJobCoordinatorSubmit, jobId: string, identity: string, renderPlan: MotionRenderPlan | undefined, claim: MotionJobIdentityClaimHandle): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>>;
  /** Keep a fail-closed pre-execution claim alive when durable state is unresolved. */
  retainUnresolvedClaim(identity: string, claim: MotionJobIdentityClaimHandle): void;
}

const PLAN_ADMISSION_RETRY_COUNT = 25;
const PLAN_ADMISSION_RETRY_MS = 10;

export class MotionJobCoordinatorPlannedSubmit {
  constructor(
    private readonly plans: MotionRenderPlanStore,
    private readonly admissions: MotionRenderAdmissionStore,
    private readonly claims: MotionJobIdentityClaimStore,
    private readonly services: MotionJobCoordinatorPlannedSubmitServices
  ) {}

  async submit(input: MotionJobCoordinatorSubmit, jobId: string, identity: string): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>> {
    const parsed = parseSubmittedPlan(input);
    if (!parsed.ok) return parsed.result;
    const acquired = await this.claims.acquire({ callerId: input.callerId, jobId, admission: { mode: "planned", planFingerprint: parsed.plan.fingerprint } });
    if (!acquired.ok) return await this.claimFailure(acquired, true, input, jobId, identity, parsed.plan);
    return await this.submitPlannedHeld(input, jobId, identity, parsed.plan, acquired.handle);
  }

  async submitPlanless(input: MotionJobCoordinatorSubmit, jobId: string, identity: string): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>> {
    let acquired = await this.claims.acquire({ callerId: input.callerId, jobId, admission: { mode: "legacy-planless" } });
    // Historical planless same-id reuse remains supported.  A just-recorded terminal result can
    // briefly retain the prior holder while it settles its claim; wait only for that same-class
    // terminal holder to release, then acquire a new legacy execution claim.
    if (!acquired.ok && acquired.code === "claim_held") {
      const state = await this.waitForPresentJob(jobId, input.callerId, identity);
      if (state.kind === "present" && state.terminal && !state.planFingerprint) {
        acquired = await this.waitForPlanlessRelease(input, jobId, identity);
      }
    }
    if (!acquired.ok) return await this.claimFailure(acquired, false, input, jobId, identity);
    return await this.submitPlanlessHeld(input, jobId, identity, acquired.handle);
  }

  private async submitPlannedHeld(input: MotionJobCoordinatorSubmit, jobId: string, identity: string, plan: MotionRenderPlan, claim: MotionJobIdentityClaimHandle): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>> {
    try {
      const existing = await this.readHeldState(claim, jobId, input.callerId, identity);
      if (!existing.ok) return this.retain(claim, identity, existing.result);
      if (existing.state.kind === "present") return await this.replayHeld(claim, identity, jobId, input.callerId, plan, existing.state);
      const admitted = await this.bindAdmission(claim, jobId, input.callerId, { mode: "planned", planFingerprint: plan.fingerprint });
      if (!admitted.ok) return admitted.release ? this.releaseUnaccepted(claim, identity, admitted.result) : this.retain(claim, identity, admitted.result);
      const bound = await this.bindPlan(claim, jobId, input.callerId, plan);
      if (!bound.ok) return this.retain(claim, identity, bound.result);
      const afterBind = await this.readHeldState(claim, jobId, input.callerId, identity);
      if (!afterBind.ok) return this.retain(claim, identity, afterBind.result);
      if (bound.replayed && afterBind.state.kind === "missing") return this.retain(claim, identity, unresolvedPlan(jobId));
      if (afterBind.state.kind === "present") return await this.replayHeld(claim, identity, jobId, input.callerId, plan, afterBind.state);
      // Explicit transfer: coordinator records this handle before the first host-lease await.
      return await this.services.submitReserved(input, jobId, identity, plan, claim);
    } catch {
      return this.retain(claim, identity, coordinatorFailure("capability_unavailable", "Motion render-plan binding storage is unavailable; no render was started."));
    }
  }

  private async submitPlanlessHeld(input: MotionJobCoordinatorSubmit, jobId: string, identity: string, claim: MotionJobIdentityClaimHandle): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>> {
    try {
      const existing = await this.readHeldState(claim, jobId, input.callerId, identity);
      if (!existing.ok) return this.releaseUnaccepted(claim, identity, existing.result);
      if (existing.state.kind === "present" && existing.state.planFingerprint) return this.releaseUnaccepted(claim, identity, admissionConflict(jobId));
      if (existing.state.kind === "present" && !existing.state.terminal) {
        return this.releaseUnaccepted(claim, identity, coordinatorFailure("job_not_terminal", `Motion job ${jobId} is already active.`));
      }
      if (!await held(claim)) return this.retain(claim, identity, authorityUnavailable());
      const stored = await this.plans.read({ callerId: input.callerId, jobId });
      if (stored.ok) return this.releaseUnaccepted(claim, identity, admissionConflict(jobId));
      if (stored.code !== "plan_unknown") return this.releaseUnaccepted(claim, identity, coordinatorFailure("job_plan_invalid", `Motion job ${jobId} has an unreadable immutable render-plan binding.`));
      const admitted = await this.bindAdmission(claim, jobId, input.callerId, { mode: "legacy-planless" });
      if (!admitted.ok) return admitted.release ? this.releaseUnaccepted(claim, identity, admitted.result) : this.retain(claim, identity, admitted.result);
      // Transfer is also required for a terminal planless id: it is a new compatible execution.
      return await this.services.submitReserved(input, jobId, identity, undefined, claim);
    } catch {
      return this.releaseUnaccepted(claim, identity, coordinatorFailure("capability_unavailable", "Motion render admission storage is unavailable; no render was started."));
    }
  }

  private async claimFailure(acquired: Exclude<Awaited<ReturnType<MotionJobIdentityClaimStore["acquire"]>>, { ok: true }>, planned: boolean, input: MotionJobCoordinatorSubmit, jobId: string, identity: string, plan?: MotionRenderPlan): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>> {
    if (acquired.code === "claim_conflict") return admissionConflict(jobId);
    if (acquired.code === "claim_held") {
      if (planned && plan) return await this.waitHeldPlanned(input.callerId, jobId, identity, plan);
      const state = await this.waitForPresentJob(jobId, input.callerId, identity);
      return state.kind === "present" && state.planFingerprint ? admissionConflict(jobId)
        : coordinatorFailure("job_not_terminal", `Motion job ${jobId} is already active.`);
    }
    if (acquired.code === "claim_recovery_required" || acquired.code === "claim_recovery_refused") {
      return planned ? unresolvedPlan(jobId) : coordinatorFailure("job_not_terminal", `Motion job ${jobId} has an unresolved prior submission.`);
    }
    return authorityUnavailable();
  }

  /** Same-class peers never bind admission/plan data; foreign holders wait for release and terminal proof. */
  private async waitHeldPlanned(callerId: string, jobId: string, identity: string, plan: MotionRenderPlan): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>> {
    for (let attempt = 0; attempt <= PLAN_ADMISSION_RETRY_COUNT; attempt += 1) {
      if (await this.services.isLocallyReplayablePlanned(identity, plan.fingerprint)) {
        const state = await this.services.readJobState(jobId, callerId, identity);
        if (state.kind === "unavailable") return authorityUnavailable();
        if (state.kind === "present") {
          if (state.planFingerprint !== plan.fingerprint) return planConflict(jobId);
          if (!state.terminal) {
            const facts = await this.acceptedFacts(callerId, jobId, plan);
            if (facts.ok && await this.services.isLocallyReplayablePlanned(identity, plan.fingerprint)) {
              return { ok: true, value: { jobId, replayed: true } };
            }
            if (!facts.ok) {
              const result = facts.result as MotionCoordinatorFailure;
              if (result.code !== "job_plan_unresolved") return result;
            }
          }
        }
      }
      // A durable held claim belongs to another coordinator (or is a local transition with no
      // synchronous live marker). Its lease/event state is not replay authority. Wait only for a
      // fresh claim, which then requires durable terminal proof before answering replayed.
      const acquired = await this.claims.acquire({ callerId, jobId, admission: { mode: "planned", planFingerprint: plan.fingerprint } });
      if (acquired.ok) return await this.replayAfterSettlementRelease(acquired.handle, identity, jobId, callerId, plan);
      if (acquired.code === "claim_conflict") return admissionConflict(jobId);
      if (acquired.code !== "claim_held" || attempt === PLAN_ADMISSION_RETRY_COUNT) return unresolvedPlan(jobId);
      await delay(PLAN_ADMISSION_RETRY_MS);
    }
    return unresolvedPlan(jobId);
  }

  private async replayAfterSettlementRelease(claim: MotionJobIdentityClaimHandle, identity: string, jobId: string, callerId: string, plan: MotionRenderPlan): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>> {
    const state = await this.services.readJobState(jobId, callerId, identity);
    if (state.kind === "unavailable") return this.retain(claim, identity, authorityUnavailable());
    // A released claim without a durable terminal record is not replay proof, even if a stale host
    // lease lingers briefly. Retain the fresh handle instead of turning it into a second execution.
    if (state.kind !== "present" || !state.terminal) return this.retain(claim, identity, unresolvedPlan(jobId));
    return await this.replayHeld(claim, identity, jobId, callerId, plan, state);
  }

  private async replayHeld(claim: MotionJobIdentityClaimHandle, identity: string, jobId: string, callerId: string, plan: MotionRenderPlan, present: Extract<MotionCoordinatorPresence, { kind: "present" }>): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>> {
    if (!present.planFingerprint) return this.releaseUnaccepted(claim, identity, acceptedWithoutPlan(jobId));
    if (present.planFingerprint !== plan.fingerprint) return this.releaseUnaccepted(claim, identity, planConflict(jobId));
    try {
      const facts = await this.acceptedFacts(callerId, jobId, plan);
      if (!facts.ok) {
        const result = facts.result as MotionCoordinatorFailure;
        return result.code === "job_id_conflict"
          ? this.releaseUnaccepted(claim, identity, result)
          : this.retain(claim, identity, result);
      }
      // This is a fresh, replay-only claim. It did not publish lease/event/record facts and must
      // not counterfeit their lifecycle phases; it only serializes the read-only verification.
      const released = await claim.release();
      return released.ok ? { ok: true, value: { jobId, replayed: true } } : this.retain(claim, identity, authorityUnavailable());
    } catch {
      return this.retain(claim, identity, authorityUnavailable());
    }
  }

  private async bindAdmission(claim: MotionJobIdentityClaimHandle, jobId: string, callerId: string, admission: { mode: "legacy-planless" } | { mode: "planned"; planFingerprint: string }): Promise<{ ok: true } | { ok: false; result: MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>; release?: true }> {
    if (!await held(claim)) return { ok: false, result: authorityUnavailable() };
    const bound = await this.admissions.bind({ callerId, jobId, admission });
    if (!bound.ok) return bound.code === "admission_conflict"
      ? { ok: false, result: admissionConflict(jobId), release: true }
      : { ok: false, result: coordinatorFailure("job_plan_invalid", `Motion job ${jobId} has an invalid immutable admission binding.`) };
    return (await claim.advance("admission_bound")).ok ? { ok: true } : { ok: false, result: authorityUnavailable() };
  }

  private async bindPlan(claim: MotionJobIdentityClaimHandle, jobId: string, callerId: string, plan: MotionRenderPlan): Promise<{ ok: true; plan: MotionRenderPlan; replayed: boolean } | { ok: false; result: MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue> }> {
    if (!await held(claim)) return { ok: false, result: authorityUnavailable() };
    const bound = await this.plans.bind({ callerId, jobId, plan });
    if (!bound.ok) return { ok: false, result: bound.code === "plan_conflict" ? planConflict(jobId) : coordinatorFailure("job_plan_invalid", `Motion job ${jobId} has an invalid immutable render-plan binding.`) };
    return (await claim.advance("plan_bound")).ok ? bound : { ok: false, result: authorityUnavailable() };
  }

  private async readHeldState(claim: MotionJobIdentityClaimHandle, jobId: string, callerId: string, identity: string): Promise<{ ok: true; state: MotionCoordinatorPresence } | { ok: false; result: MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue> }> {
    if (!await held(claim)) return { ok: false, result: authorityUnavailable() };
    const state = await this.services.readJobState(jobId, callerId, identity);
    return state.kind === "unavailable" ? { ok: false, result: authorityUnavailable() } : { ok: true, state };
  }

  private async acceptedFacts(callerId: string, jobId: string, plan: MotionRenderPlan): Promise<{ ok: true } | { ok: false; result: MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue> }> {
    const admission = await this.admissions.read({ callerId, jobId });
    if (!admission.ok) return { ok: false, result: admission.code === "admission_unknown"
      ? unresolvedPlan(jobId)
      : coordinatorFailure("job_plan_invalid", `Motion job ${jobId} has an invalid immutable admission binding.`) };
    if (admission.admission.mode !== "planned" || admission.admission.planFingerprint !== plan.fingerprint) {
      return { ok: false, result: admissionConflict(jobId) };
    }
    const stored = await this.plans.read({ callerId, jobId });
    if (!stored.ok) return { ok: false, result: stored.code === "plan_unknown"
      ? unresolvedPlan(jobId)
      : coordinatorFailure("job_plan_invalid", `Motion job ${jobId} has an invalid immutable render-plan binding.`) };
    if (stored.plan.fingerprint !== plan.fingerprint) return { ok: false, result: planConflict(jobId) };
    const submitted = await this.services.readSubmittedAcceptance(jobId, callerId);
    if (submitted.kind === "unavailable") return { ok: false, result: authorityUnavailable() };
    if (submitted.kind !== "accepted" || submitted.schema !== plan.schema || submitted.fingerprint !== plan.fingerprint) {
      return { ok: false, result: unresolvedPlan(jobId) };
    }
    return { ok: true };
  }

  private async releaseUnaccepted(claim: MotionJobIdentityClaimHandle, identity: string, result: MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>): Promise<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>> {
    const released = await claim.release().catch(() => undefined);
    if (!released?.ok) this.services.retainUnresolvedClaim(identity, claim);
    return result;
  }

  private retain(claim: MotionJobIdentityClaimHandle, identity: string, result: MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>): MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue> {
    this.services.retainUnresolvedClaim(identity, claim);
    return result;
  }

  private async waitForPresentJob(jobId: string, callerId: string, identity: string): Promise<MotionCoordinatorPresence> {
    for (let attempt = 0; attempt <= PLAN_ADMISSION_RETRY_COUNT; attempt += 1) {
      const state = await this.services.readJobState(jobId, callerId, identity);
      if (state.kind !== "missing" || attempt === PLAN_ADMISSION_RETRY_COUNT) return state;
      await delay(PLAN_ADMISSION_RETRY_MS);
    }
    return { kind: "missing" };
  }

  private async waitForPlanlessRelease(input: MotionJobCoordinatorSubmit, jobId: string, identity: string): Promise<Awaited<ReturnType<MotionJobIdentityClaimStore["acquire"]>>> {
    for (let attempt = 0; attempt <= PLAN_ADMISSION_RETRY_COUNT; attempt += 1) {
      const acquired = await this.claims.acquire({ callerId: input.callerId, jobId, admission: { mode: "legacy-planless" } });
      if (acquired.ok || acquired.code !== "claim_held" || attempt === PLAN_ADMISSION_RETRY_COUNT) return acquired;
      const state = await this.services.readJobState(jobId, input.callerId, identity);
      if (state.kind !== "present" || !state.terminal || state.planFingerprint) return acquired;
      await delay(PLAN_ADMISSION_RETRY_MS);
    }
    return { ok: false, code: "claim_unavailable" };
  }
}

/** Submitted events retain only the two public plan identifiers, never plan content or a path. */
export function submittedEventData(input: MotionJobCoordinatorSubmit, renderPlan?: MotionRenderPlan): Record<string, unknown> {
  const { renderPlan: _untrustedPlan, ...submissionData } = input.submissionData ?? {};
  return { operation: input.operation, ...submissionData, ...(input.lineage ? { lineage: input.lineage } : {}), ...(renderPlan ? { renderPlan: { schema: renderPlan.schema, fingerprint: renderPlan.fingerprint } } : {}) };
}

type MotionCoordinatorFailure = Extract<MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue>, { ok: false }>;

function parseSubmittedPlan(input: MotionJobCoordinatorSubmit): { ok: true; plan: MotionRenderPlan } | { ok: false; result: MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue> } {
  try {
    const plan = parseMotionRenderPlan(input.renderPlan);
    // V2 is a read-only historical format until the Debug-private nonserializable execution
    // authority can be carried to every route checkpoint. Parsing it must not grant execution.
    if (plan.schema !== "shellx-motion/render-plan@1") throw new Error("Active render-plan@2 submission is not available.");
    if (input.operation !== plan.operation || input.lane !== plan.requested.lane || input.frameLane !== plan.requested.frameLane) throw new Error("Submitted render route does not match its immutable plan.");
    return { ok: true, plan };
  } catch {
    return { ok: false, result: coordinatorFailure("job_plan_invalid", "Motion render plan is invalid; no render was started.") };
  }
}

function authorityUnavailable(): MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue> { return coordinatorFailure("capability_unavailable", "Motion job identity claim authority is unavailable; no render was started."); }
function unresolvedPlan(jobId: string): MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue> { return coordinatorFailure("job_plan_unresolved", `Motion job ${jobId} has an immutable render-plan binding but no accepted live or terminal job; refusing to execute.`); }
function planConflict(jobId: string): MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue> { return coordinatorFailure("job_id_conflict", `Motion job ${jobId} is accepted under a different immutable render-plan identity.`); }
function admissionConflict(jobId: string): MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue> { return coordinatorFailure("job_id_conflict", `Motion job ${jobId} already has a different immutable admission class.`); }
function acceptedWithoutPlan(jobId: string): MotionJobCoordinatorResult<MotionJobCoordinatorSubmitValue> { return coordinatorFailure("job_id_conflict", `Motion job ${jobId} was already accepted without an immutable render plan.`); }
async function held(claim: MotionJobIdentityClaimHandle): Promise<boolean> { return (await claim.assertHeld()).ok; }
async function delay(milliseconds: number): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }
