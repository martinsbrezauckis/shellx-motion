/** Exact v2 prefix recovery after the trusted host has acquired the root repair gate. */
import { link, lstat } from "node:fs/promises";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import {
  assertCurrentAuthorityDirectory,
  readRegularFile,
  type TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";
import {
  acquirePairWriterLock,
  assertPairWriterLock,
  readQuiescentPairWriterLock,
  releasePairWriterLock,
  type PairWriterLock,
} from "./timeline-layout-authority-pair-files.js";
import {
  assertRecoveredPairMembersAbsent,
  cleanupRecoveredPending,
  inspectInterruptedPairPrefix,
  reclaimInterruptedPairPrefix,
} from "./timeline-layout-authority-pair-recovery-files.js";
import { maintainAdmittedImmutableJsonPairEvidence } from "./timeline-layout-authority-pair-maintenance.js";
import {
  assertPairKey,
  journalValue,
  MAX_PAIR_JOURNAL_BYTES,
  pairPaths,
  parseJournal,
  PENDING_PAIR_SCHEMA,
} from "./timeline-layout-authority-pair-records.js";
import { readImmutableJsonPair } from "./timeline-layout-authority-pair-reader.js";
import { assertHostQuiescentPairRecoveryAdmission } from "./timeline-layout-authority-pair-repair-session.js";
import type {
  HostQuiescentPairRecoveryAdmission,
  ImmutableJsonPairReadDescriptor,
} from "./timeline-layout-authority-pair-types.js";

export async function recoverInterruptedImmutableJsonPair(
  directory: TrustedAuthorityDirectory,
  input: ImmutableJsonPairReadDescriptor,
  admission: HostQuiescentPairRecoveryAdmission,
): Promise<boolean> {
  assertPairKey(input.key);
  await assertHostQuiescentPairRecoveryAdmission(directory, admission);
  const paths = pairPaths(directory, input.key);
  const lock = await acquireOrClaimQuiescentWriterLock(directory, paths, input.key);
  try {
    try {
      await readImmutableJsonPair(directory, input);
      return false;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    const pending = await readPendingPairJournal(directory, input, paths).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!pending) {
      await assertRecoveredPairMembersAbsent(paths);
      await assertCurrentAuthorityDirectory(directory);
      return true;
    }
    const members = await inspectedMembers(directory, input, paths, pending.pending);
    await assertCurrentAuthorityDirectory(directory);
    await assertHostQuiescentPairRecoveryAdmission(directory, admission);
    await assertPairWriterLock(paths, lock);
    await reclaimInterruptedPairPrefix(members);
    await assertRecoveredPairMembersAbsent(paths);
    await cleanupRecoveredPending(paths.pendingPath, pending.bytes, MAX_PAIR_JOURNAL_BYTES);
    await assertCurrentAuthorityDirectory(directory);
    return true;
  } finally {
    await releasePairWriterLock(paths, lock);
  }
}

export async function finalizeRecoveredImmutableJsonPair(
  directory: TrustedAuthorityDirectory,
  input: ImmutableJsonPairReadDescriptor,
  admission: HostQuiescentPairRecoveryAdmission,
): Promise<string> {
  assertPairKey(input.key);
  await assertHostQuiescentPairRecoveryAdmission(directory, admission);
  const paths = pairPaths(directory, input.key);
  const lock = await acquireOrClaimQuiescentWriterLock(directory, paths, input.key);
  let released = false;
  try {
    const pending = await readPendingPairJournal(directory, input, paths);
    const members = await inspectedMembers(directory, input, paths, pending.pending);
    if (!complete(members)) throw new Error("Layout authority recovery cannot admit an incomplete prepared pair.");
    await assertCurrentAuthorityDirectory(directory);
    await assertHostQuiescentPairRecoveryAdmission(directory, admission);
    await assertPairWriterLock(paths, lock);
    await releasePairWriterLock(paths, lock);
    released = true;
    await link(paths.journalStagePath, paths.journalPath);
    await maintainAdmittedImmutableJsonPairEvidence(directory, input).catch(() => {});
    return paths.journalPath;
  } finally {
    if (!released) await releasePairWriterLock(paths, lock).catch(() => {});
  }
}

export async function recoveredImmutableJsonPairIsComplete(
  directory: TrustedAuthorityDirectory,
  input: ImmutableJsonPairReadDescriptor,
  admission: HostQuiescentPairRecoveryAdmission,
): Promise<boolean> {
  assertPairKey(input.key);
  await assertHostQuiescentPairRecoveryAdmission(directory, admission);
  const paths = pairPaths(directory, input.key);
  const lock = await acquireOrClaimQuiescentWriterLock(directory, paths, input.key);
  try {
    const pending = await readPendingPairJournal(directory, input, paths);
    const members = await inspectedMembers(directory, input, paths, pending.pending);
    await assertCurrentAuthorityDirectory(directory);
    await assertHostQuiescentPairRecoveryAdmission(directory, admission);
    return complete(members);
  } finally {
    await releasePairWriterLock(paths, lock).catch(() => {});
  }
}

export async function reclaimRecoveredPairLockOnly(
  directory: TrustedAuthorityDirectory,
  key: string,
  admission: HostQuiescentPairRecoveryAdmission,
): Promise<boolean> {
  assertPairKey(key);
  await assertHostQuiescentPairRecoveryAdmission(directory, admission);
  const paths = pairPaths(directory, key);
  const lock = await acquireOrClaimQuiescentWriterLock(directory, paths, key);
  try {
    await assertRecoveredPairMembersAbsent(paths);
    await assertCurrentAuthorityDirectory(directory);
    await assertHostQuiescentPairRecoveryAdmission(directory, admission);
    return true;
  } finally {
    await releasePairWriterLock(paths, lock);
  }
}

async function inspectedMembers(
  directory: TrustedAuthorityDirectory,
  input: ImmutableJsonPairReadDescriptor,
  paths: ReturnType<typeof pairPaths>,
  pending: ReturnType<typeof parseJournal>,
) {
  const journal = journalValue(directory.root, {
    key: input.key,
    recordKind: pending.recordKind,
    outputLineage: input.outputLineage,
    receiptSha256: pending.receipt.sha256,
    authoritySha256: pending.authority.sha256,
  }, paths);
  return await inspectInterruptedPairPrefix({
    receipt: { finalPath: paths.receiptPath, stagePath: paths.receiptStagePath, sha256: pending.receipt.sha256, maximumBytes: input.receiptMaximumBytes },
    authority: { finalPath: paths.authorityPath, stagePath: paths.authorityStagePath, sha256: pending.authority.sha256, maximumBytes: input.authorityMaximumBytes },
    journal: { finalPath: paths.journalPath, stagePath: paths.journalStagePath, sha256: canonicalJsonSha256(journal), maximumBytes: MAX_PAIR_JOURNAL_BYTES },
  });
}

function complete(members: readonly { state: number }[]): boolean {
  return members.map((member) => member.state).join(",") === "2,2,1";
}

async function readPendingPairJournal(
  directory: TrustedAuthorityDirectory,
  input: ImmutableJsonPairReadDescriptor,
  paths: ReturnType<typeof pairPaths>,
): Promise<{ pending: ReturnType<typeof parseJournal>; bytes: Buffer }> {
  const before = await lstat(paths.pendingPath).catch(missing);
  if (!before) throw Object.assign(new Error("Layout authority pending pair journal is absent."), { code: "ENOENT" });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("Layout authority pending pair journal is not a private regular file.");
  }
  const bytes = await readRegularFile(paths.pendingPath, MAX_PAIR_JOURNAL_BYTES);
  const after = await lstat(paths.pendingPath);
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) {
    throw new Error("Layout authority pending pair journal changed during inspection.");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Layout authority pending pair journal is malformed.");
  }
  return { pending: parseJournal(value, directory.root, input, paths, PENDING_PAIR_SCHEMA), bytes };
}

async function acquireOrClaimQuiescentWriterLock(
  directory: TrustedAuthorityDirectory,
  paths: ReturnType<typeof pairPaths>,
  key: string,
): Promise<PairWriterLock> {
  try {
    return await acquirePairWriterLock(directory, paths, key);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !/active or uninspected host writer lock/i.test(error.message)) throw error;
    return await readQuiescentPairWriterLock(directory, paths, key);
  }
}

function missing(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT") return null;
  throw error;
}
