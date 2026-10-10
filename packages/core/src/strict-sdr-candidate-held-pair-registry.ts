/** Core-local final-receipt observer for the private strict-SDR candidate pair. */
import type { DerivedFilePublicationEvidence, DerivedOutputPublication } from "./derived-output-publication";

export type StrictSdrCandidateHeldPairStageEvidence = Readonly<{
  output: DerivedFilePublicationEvidence;
  receipt: DerivedFilePublicationEvidence;
}>;

type CandidateRegistration = Readonly<{
  heldDirectoryAuthority: unknown;
  outputPublication: DerivedOutputPublication;
  recordStage(evidence: StrictSdrCandidateHeldPairStageEvidence): void;
}>;

const registrations = new WeakMap<object, CandidateRegistration>();

/** The candidate factory is the only registration route. Duplicate state is never adopted. */
export function registerStrictSdrCandidateHeldPair(
  publication: object,
  registration: CandidateRegistration
): void {
  if (registrations.has(publication)) {
    throw new Error("Strict-SDR candidate final receipt publication is already registered.");
  }
  registrations.set(publication, registration);
}

export function unregisterStrictSdrCandidateHeldPair(publication: object): void {
  registrations.delete(publication);
}

/** Candidate wrappers fail closed if their exact Core registration was lost or substituted. */
export function assertStrictSdrCandidateHeldPairRegistration(
  publication: object,
  heldDirectoryAuthority: unknown,
  outputPublication: DerivedOutputPublication
): void {
  const registration = registrations.get(publication);
  if (
    !registration
    || registration.heldDirectoryAuthority !== heldDirectoryAuthority
    || registration.outputPublication !== outputPublication
  ) {
    throw new Error("Strict-SDR candidate pair is missing its matching Core final-receipt registration.");
  }
}

/**
 * Runs only after PairedOutputReceiptPublication has written, verified, and passed its existing
 * post-stage fault seam. Ordinary paired publications are deliberately not registered and remain
 * unchanged no-ops here.
 */
export function recordStrictSdrCandidateFinalReceiptIfRegistered(
  publication: object,
  heldDirectoryAuthority: unknown,
  outputPublication: DerivedOutputPublication,
  output: DerivedFilePublicationEvidence,
  receipt: DerivedFilePublicationEvidence
): void {
  const registration = registrations.get(publication);
  if (!registration) return;
  assertStrictSdrCandidateHeldPairRegistration(publication, heldDirectoryAuthority, outputPublication);
  registration.recordStage(Object.freeze({
    output: Object.freeze({ ...output }),
    receipt: Object.freeze({ ...receipt })
  }));
}
