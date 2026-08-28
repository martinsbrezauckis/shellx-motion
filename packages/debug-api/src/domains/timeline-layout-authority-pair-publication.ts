/** Pre-install immutable pair preparation and post-install final-journal admission. */
import { link } from "node:fs/promises";
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import {
  assertCurrentAuthorityDirectory,
  readRegularFile,
  type TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";
import {
  assertNoPairRepairGate,
  assertPairArtifactsAbsent,
  assertPairWriterLock,
  acquirePairWriterLock,
  cleanupPairStaging,
  releasePairWriterLock,
  rollbackLinkedPairMembers,
  writeNewImmutableFile,
  type LinkedPairMember,
  type PairMember,
  type PairWriterLock,
} from "./timeline-layout-authority-pair-files.js";
import { cleanupAdmittedPairEvidence } from "./timeline-layout-authority-pair-recovery-files.js";
import {
  assertPairDescriptor,
  MAX_PAIR_JOURNAL_BYTES,
  pairPaths,
  PENDING_PAIR_SCHEMA,
  journalValue,
  recordPayload,
} from "./timeline-layout-authority-pair-records.js";
import { readImmutableJsonPair } from "./timeline-layout-authority-pair-reader.js";
import type {
  ImmutableJsonPair,
  ImmutableJsonPairDescriptor,
  PreparedImmutableJsonPair,
} from "./timeline-layout-authority-pair-types.js";

interface PreparedPairState {
  directory: TrustedAuthorityDirectory;
  input: ImmutableJsonPairDescriptor;
  paths: ReturnType<typeof pairPaths>;
  pendingBytes: Buffer;
  members: readonly PairMember[];
  linked: readonly PairMember[];
  journalPath: string;
  lock: PairWriterLock | undefined;
  final: boolean;
}

const preparedStates = new WeakMap<PreparedImmutableJsonPair, PreparedPairState>();

export async function writeImmutableJsonPair(
  directory: TrustedAuthorityDirectory,
  input: ImmutableJsonPairDescriptor,
): Promise<string> {
  const prepared = await prepareImmutableJsonPair(directory, input);
  try {
    return await finalizePreparedImmutableJsonPair(prepared);
  } catch (error) {
    await abortPreparedImmutableJsonPair(prepared).catch(() => {});
    throw error;
  }
}

/** Prepare all durable v2 evidence before COW install; only the journal remains unlinked. */
export async function prepareImmutableJsonPair(
  directory: TrustedAuthorityDirectory,
  input: ImmutableJsonPairDescriptor,
): Promise<PreparedImmutableJsonPair> {
  assertPairDescriptor(input);
  const paths = pairPaths(directory, input.key);
  const existingBeforeLock = await existingExactPair(directory, input);
  if (existingBeforeLock) return rememberedFinal(directory, input, paths, existingBeforeLock.journalPath);

  await assertNoPairRepairGate(directory);
  let lock: PairWriterLock | undefined;
  try {
    lock = await acquirePairWriterLock(directory, paths, input.key);
  } catch (error: unknown) {
    const existing = await existingExactPair(directory, input);
    if (existing) return rememberedFinal(directory, input, paths, existing.journalPath);
    throw error;
  }
  let members: readonly PairMember[];
  let pendingBytes: Buffer;
  try {
    members = pairMembers(directory, input, paths);
    pendingBytes = pendingPayload(directory, input, paths);
  } catch (error) {
    if (lock) await releasePairWriterLock(paths, lock).catch(() => {});
    throw error;
  }
  const linked: PairMember[] = [];
  let prepared = false;
  try {
    const existing = await existingExactPair(directory, input);
    if (existing) {
      await releasePairWriterLock(paths, lock);
      lock = undefined;
      prepared = true;
      return remember({ directory, input, paths, pendingBytes, members, linked: [], journalPath: existing.journalPath, lock, final: true });
    }
    await assertCurrentAuthorityDirectory(directory);
    await assertNoPairRepairGate(directory);
    await assertPairArtifactsAbsent(paths);
    await writeNewImmutableFile(directory, paths.pendingPath, pendingBytes);
    for (const member of members) {
      await assertNoPairRepairGate(directory);
      await writeNewImmutableFile(directory, member.stagePath, member.bytes);
    }
    for (const member of members) {
      if (member.step === "journal") continue;
      await assertCurrentAuthorityDirectory(directory);
      await assertNoPairRepairGate(directory);
      await input.hooks?.beforeCommitStep?.(member.step);
      await link(member.stagePath, member.finalPath);
      linked.push(member);
      if (!(await readRegularFile(member.finalPath, member.maximumBytes)).equals(member.bytes)) {
        throw new Error("Layout authority pair member did not survive link readback.");
      }
      await input.hooks?.afterMemberLink?.(member.step);
    }
    prepared = true;
    return remember({ directory, input, paths, pendingBytes, members, linked, journalPath: paths.journalPath, lock, final: false });
  } catch (error) {
    const rollbackProblem = await rollbackLinkedPairMembers(linked as LinkedPairMember[], input.hooks).catch((problem: unknown) => problem);
    if (lock) await releasePairWriterLock(paths, lock).catch(() => {});
    if (rollbackProblem instanceof Error) throw rollbackProblem;
    throw error;
  } finally {
    if (!prepared) await cleanupPairStaging(paths, pendingBytes, members).catch(() => {});
  }
}

/** Link the final journal only after caller re-proves installed COW lineage. */
export async function finalizePreparedImmutableJsonPair(prepared: PreparedImmutableJsonPair): Promise<string> {
  const state = stateFor(prepared);
  if (state.final) return state.journalPath;
  if (!state.lock) throw new Error("Layout authority prepared pair lock was already released.");
  await assertCurrentAuthorityDirectory(state.directory);
  await assertPairWriterLock(state.paths, state.lock);
  await assertNoPairRepairGate(state.directory);
  await state.input.hooks?.beforeCommitStep?.("journal");
  await state.input.hooks?.beforeJournalAdmissionLink?.();
  await assertCurrentAuthorityDirectory(state.directory);
  await assertPairWriterLock(state.paths, state.lock);
  await assertNoPairRepairGate(state.directory);
  await link(state.paths.journalStagePath, state.paths.journalPath);
  state.final = true;
  await cleanupAdmittedPairEvidence({
    pendingPath: state.paths.pendingPath,
    pending: state.pendingBytes,
    receipt: state.members[0]!,
    authority: state.members[1]!,
    journal: state.members[2]!,
  }).catch(() => {});
  const lock = state.lock;
  state.lock = undefined;
  await releasePairWriterLock(state.paths, lock).catch(() => {});
  return state.journalPath;
}

export async function abortPreparedImmutableJsonPair(prepared: PreparedImmutableJsonPair): Promise<void> {
  const state = stateFor(prepared);
  if (state.final) return;
  if (state.lock) await assertPairWriterLock(state.paths, state.lock);
  await rollbackLinkedPairMembers(state.linked as LinkedPairMember[], state.input.hooks);
  await cleanupPairStaging(state.paths, state.pendingBytes, state.members);
  if (state.lock) {
    await releasePairWriterLock(state.paths, state.lock);
    state.lock = undefined;
  }
}

function pairMembers(
  directory: TrustedAuthorityDirectory,
  input: ImmutableJsonPairDescriptor,
  paths: ReturnType<typeof pairPaths>,
): readonly PairMember[] {
  const receiptBytes = recordPayload(input.receipt, input.receiptMaximumBytes);
  const authorityBytes = recordPayload(input.authority, input.authorityMaximumBytes);
  const journal = journalValue(directory.root, {
    key: input.key,
    recordKind: input.recordKind,
    outputLineage: input.outputLineage,
    receiptSha256: canonicalJsonSha256(input.receipt),
    authoritySha256: canonicalJsonSha256(input.authority),
  }, paths);
  return [
    { step: "receipt", finalPath: paths.receiptPath, stagePath: paths.receiptStagePath, bytes: receiptBytes, maximumBytes: input.receiptMaximumBytes },
    { step: "authority", finalPath: paths.authorityPath, stagePath: paths.authorityStagePath, bytes: authorityBytes, maximumBytes: input.authorityMaximumBytes },
    { step: "journal", finalPath: paths.journalPath, stagePath: paths.journalStagePath, bytes: recordPayload(journal, MAX_PAIR_JOURNAL_BYTES), maximumBytes: MAX_PAIR_JOURNAL_BYTES },
  ];
}

function pendingPayload(directory: TrustedAuthorityDirectory, input: ImmutableJsonPairDescriptor, paths: ReturnType<typeof pairPaths>): Buffer {
  const journal = journalValue(directory.root, {
    key: input.key, recordKind: input.recordKind, outputLineage: input.outputLineage,
    receiptSha256: canonicalJsonSha256(input.receipt), authoritySha256: canonicalJsonSha256(input.authority),
  }, paths);
  return recordPayload({ ...journal, schema: PENDING_PAIR_SCHEMA }, MAX_PAIR_JOURNAL_BYTES);
}

function rememberedFinal(directory: TrustedAuthorityDirectory, input: ImmutableJsonPairDescriptor, paths: ReturnType<typeof pairPaths>, journalPath: string): PreparedImmutableJsonPair {
  return remember({ directory, input, paths, pendingBytes: Buffer.alloc(0), members: [], linked: [], journalPath, lock: undefined, final: true });
}

function remember(state: PreparedPairState): PreparedImmutableJsonPair {
  const prepared = Object.freeze({ __layoutAuthorityPreparedPair: Symbol("layout-authority-prepared-pair") }) as unknown as PreparedImmutableJsonPair;
  preparedStates.set(prepared, state);
  return prepared;
}

function stateFor(prepared: PreparedImmutableJsonPair): PreparedPairState {
  const state = preparedStates.get(prepared);
  if (!state) throw new Error("Layout authority prepared pair is not host-owned.");
  return state;
}

async function existingExactPair(directory: TrustedAuthorityDirectory, input: ImmutableJsonPairDescriptor): Promise<ImmutableJsonPair | null> {
  try {
    const existing = await readImmutableJsonPair(directory, {
      key: input.key, recordKinds: [input.recordKind], outputLineage: input.outputLineage,
      receiptMaximumBytes: input.receiptMaximumBytes, authorityMaximumBytes: input.authorityMaximumBytes,
    });
    if (canonicalJson(existing.receipt) !== canonicalJson(input.receipt)
      || canonicalJson(existing.authority) !== canonicalJson(input.authority)) {
      throw new Error("Layout authority pair already exists with different immutable bytes.");
    }
    return existing;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}
