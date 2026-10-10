/** Non-barrel capability bridge for internal companion provenance only. */
import type { MotionJobIdentityClaimHandle } from "./job-identity-claim-store";
import type { MotionJobIdentityClaimMutationResult, MotionJobIdentityClaimSnapshot } from "./job-identity-claim-store-model";

export type MotionJobIdentityClaimExactHeldProof =
  | Readonly<{ ok: true; claim: MotionJobIdentityClaimSnapshot; ownerKey: string; runNonce: string }>
  | Extract<MotionJobIdentityClaimMutationResult, { ok: false }>;

type ExactProof = (input: Readonly<{ callerId: string; jobId: string; planFingerprint: string }>) => Promise<MotionJobIdentityClaimExactHeldProof>;
const proofs = new WeakMap<MotionJobIdentityClaimHandle, ExactProof>();

/** Called only by the store that issued the handle; no property is added to the public handle. */
export function bindMotionJobIdentityClaimExactProof(handle: MotionJobIdentityClaimHandle, proof: ExactProof): void {
  proofs.set(handle, proof);
}

/** @internal Exact identity/fingerprint proof for a live opaque handle. */
export async function assertMotionJobIdentityClaimHandlePlannedExact(
  handle: MotionJobIdentityClaimHandle,
  input: Readonly<{ callerId: string; jobId: string; planFingerprint: string }>
): Promise<MotionJobIdentityClaimExactHeldProof> {
  const proof = proofs.get(handle);
  if (!proof) return { ok: false, code: "claim_lost" };
  try { return await proof(input); } catch { return { ok: false, code: "claim_unavailable" }; }
}
