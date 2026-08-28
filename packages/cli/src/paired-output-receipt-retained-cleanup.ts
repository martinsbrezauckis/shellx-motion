/** Best-effort release of retained private reservation state after a completed primary delivery. */
import type { DerivedOutputPublication } from "@shellx-motion/core";

export async function releaseRetainedPairedPrivateReservations(
  receipt: DerivedOutputPublication,
  secondaryArtifacts: readonly { publication: DerivedOutputPublication }[]
): Promise<void> {
  await Promise.allSettled([receipt.abort(), ...secondaryArtifacts.map((secondary) => secondary.publication.abort())]);
}
