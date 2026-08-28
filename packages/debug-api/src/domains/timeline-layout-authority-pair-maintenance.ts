/** Best-effort cleanup of redundant v2 preparation evidence after final-journal admission. */
import { canonicalJsonSha256 } from "@shellx-motion/core";
import { type TrustedAuthorityDirectory } from "./timeline-layout-application-authority-store.js";
import { cleanupAdmittedPairEvidence } from "./timeline-layout-authority-pair-recovery-files.js";
import {
  journalValue,
  MAX_PAIR_JOURNAL_BYTES,
  pairPaths,
  PENDING_PAIR_SCHEMA,
  recordPayload,
} from "./timeline-layout-authority-pair-records.js";
import { readImmutableJsonPair } from "./timeline-layout-authority-pair-reader.js";
import type { ImmutableJsonPairReadDescriptor } from "./timeline-layout-authority-pair-types.js";

/**
 * A valid final journal remains the sole admission record. This only removes matching private
 * pending/stage links, and never propagates a cleanup failure into an accepted package edit.
 */
export async function maintainAdmittedImmutableJsonPairEvidence(
  directory: TrustedAuthorityDirectory,
  input: ImmutableJsonPairReadDescriptor,
): Promise<void> {
  const pair = await readImmutableJsonPair(directory, input);
  const paths = pairPaths(directory, input.key);
  const receiptBytes = recordPayload(pair.receipt, input.receiptMaximumBytes);
  const authorityBytes = recordPayload(pair.authority, input.authorityMaximumBytes);
  const journal = journalValue(directory.root, {
    key: input.key,
    recordKind: pair.recordKind,
    outputLineage: input.outputLineage,
    receiptSha256: canonicalJsonSha256(pair.receipt),
    authoritySha256: canonicalJsonSha256(pair.authority),
  }, paths);
  const journalBytes = recordPayload(journal, MAX_PAIR_JOURNAL_BYTES);
  const pending = recordPayload({ ...journal, schema: PENDING_PAIR_SCHEMA }, MAX_PAIR_JOURNAL_BYTES);
  await cleanupAdmittedPairEvidence({
    pendingPath: paths.pendingPath,
    pending,
    receipt: {
      finalPath: paths.receiptPath,
      stagePath: paths.receiptStagePath,
      bytes: receiptBytes,
      maximumBytes: input.receiptMaximumBytes,
    },
    authority: {
      finalPath: paths.authorityPath,
      stagePath: paths.authorityStagePath,
      bytes: authorityBytes,
      maximumBytes: input.authorityMaximumBytes,
    },
    journal: {
      finalPath: paths.journalPath,
      stagePath: paths.journalStagePath,
      bytes: journalBytes,
      maximumBytes: MAX_PAIR_JOURNAL_BYTES,
    },
  });
}
