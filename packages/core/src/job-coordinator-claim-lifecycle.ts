/** Private claim ownership retained by one coordinator through terminal settlement. */
import { LEASE_HEARTBEAT_INTERVAL_MS } from "./job-lease";
import {
  type MotionJobIdentityClaimHandle,
  type MotionJobIdentityClaimPhase
} from "./job-identity-claim-store";
import type { ActiveJob } from "./job-coordinator-execution";

interface ClaimOwner {
  readonly claim: MotionJobIdentityClaimHandle;
  heartbeat?: NodeJS.Timeout;
  failed?: boolean;
}

/** Not exported: durable identity handles are coordinator implementation authority only. */
export class MotionCoordinatorClaimLifecycle {
  private readonly owners = new Map<string, ClaimOwner>();

  constructor(private readonly active: ReadonlyMap<string, ActiveJob>) {}

  retain(identity: string, claim: MotionJobIdentityClaimHandle): void {
    this.owners.set(identity, { claim });
  }

  async held(identity: string, active?: ActiveJob): Promise<boolean> {
    const owner = this.owners.get(identity);
    if (!owner || owner.failed) return false;
    const result = await owner.claim.assertHeld();
    if (result.ok) return true;
    this.handleFailure(identity, active, result.code);
    return false;
  }

  async advance(identity: string, phase: MotionJobIdentityClaimPhase, active?: ActiveJob): Promise<boolean> {
    const owner = this.owners.get(identity);
    if (!owner || owner.failed) return false;
    const result = await owner.claim.advance(phase);
    if (result.ok) return true;
    this.handleFailure(identity, active, result.code);
    return false;
  }

  startHeartbeat(identity: string): void {
    const owner = this.owners.get(identity);
    if (!owner || owner.heartbeat) return;
    owner.heartbeat = setInterval(() => { void this.heartbeat(identity); }, LEASE_HEARTBEAT_INTERVAL_MS);
    owner.heartbeat.unref?.();
  }

  stopHeartbeat(identity: string): void {
    const owner = this.owners.get(identity);
    if (owner?.heartbeat) clearInterval(owner.heartbeat);
    if (owner) owner.heartbeat = undefined;
  }

  async releaseTerminal(identity: string, active: ActiveJob): Promise<boolean> {
    if (!await this.advance(identity, "terminal_recorded", active)) return false;
    const owner = this.owners.get(identity);
    if (!owner) return false;
    const released = await owner.claim.release();
    if (!released.ok) {
      this.handleFailure(identity, active, released.code);
      return false;
    }
    this.stopHeartbeat(identity);
    this.owners.delete(identity);
    return true;
  }

  private async heartbeat(identity: string): Promise<void> {
    const owner = this.owners.get(identity);
    if (!owner || owner.failed) return;
    const result = await owner.claim.heartbeat();
    if (!result.ok) this.handleFailure(identity, undefined, result.code);
  }

  /**
   * An unavailable store makes further work unsafe, but is not proof that another holder owns the
   * claim. Keep heartbeating that retained authority so a transient outage cannot silently turn
   * into a permanent orphan. Only loss/invalidity stops the timer and removes local authority.
   */
  private handleFailure(identity: string, active: ActiveJob | undefined, code: "claim_lost" | "claim_invalid" | "claim_unavailable" | "claim_phase_invalid"): void {
    if (code === "claim_lost" || code === "claim_invalid") {
      this.fail(identity, active);
      return;
    }
    (active ?? this.active.get(identity))?.controller.abort(new Error("Motion job identity claim authority is unavailable."));
  }

  private fail(identity: string, active?: ActiveJob): void {
    const owner = this.owners.get(identity);
    if (owner) owner.failed = true;
    this.stopHeartbeat(identity);
    (active ?? this.active.get(identity))?.controller.abort(new Error("Motion job identity claim authority was lost."));
  }
}
