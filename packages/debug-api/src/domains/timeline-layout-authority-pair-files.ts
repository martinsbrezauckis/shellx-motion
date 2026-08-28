/** No-follow staging, rollback, and explicit recovery operations for immutable authority pairs. */
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import type {
  ImmutableJsonPairCommitHooks,
  ImmutableJsonPairStep,
} from "./timeline-layout-authority-pair-types.js";
import {
  assertCurrentAuthorityDirectory,
  noFollowFlag,
  readRegularFile,
  type TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";
import type { PairPaths } from "./timeline-layout-authority-pair-records.js";
import {
  unlinkExact,
  unlinkLinkedExact,
} from "./timeline-layout-authority-pair-recovery-files.js";

export interface PairMember {
  step: ImmutableJsonPairStep;
  finalPath: string;
  stagePath: string;
  bytes: Buffer;
  maximumBytes: number;
}

export interface PairWriterLock {
  bytes: Buffer;
}

/** Root-wide exclusive gate held only by the trusted host's explicit repair lifecycle. */
export interface PairRepairGate {
  bytes: Buffer;
}

const PAIR_LOCK_SCHEMA = "shellx-motion/timeline-layout-authority-pair-lock@1";
const PAIR_REPAIR_GATE_SCHEMA = "shellx-motion/timeline-layout-authority-pair-repair-gate@1";
const MAX_PAIR_LOCK_BYTES = 2 * 1024;
const PAIR_REPAIR_GATE_NAME = ".pair.repair.lock";

export type LinkedPairMember = PairMember & {
  step: Exclude<ImmutableJsonPairStep, "journal">;
};

export interface InterruptedPairMember {
  finalPath: string;
  stagePath: string;
  sha256: string;
  maximumBytes: number;
  state: 0 | 1 | 2;
}

export async function assertPairArtifactsAbsent(paths: PairPaths): Promise<void> {
  for (const path of [
    paths.receiptPath,
    paths.authorityPath,
    paths.journalPath,
    paths.pendingPath,
    paths.receiptStagePath,
    paths.authorityStagePath,
    paths.journalStagePath,
  ]) {
    try {
      await lstat(path);
      throw new Error("Layout authority pair has incomplete, active, or competing immutable members.");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Acquire a short-lived, no-follow host lock before any pair members exist. A writer never
 * interprets an existing lock as stale: only the explicit quiescent repair path may do so.
 */
export async function acquirePairWriterLock(
  directory: TrustedAuthorityDirectory,
  paths: PairPaths,
  key: string,
): Promise<PairWriterLock> {
  const bytes = Buffer.from(canonicalJson({
    schema: PAIR_LOCK_SCHEMA,
    key,
    receiptsRoot: directory.root,
    nonce: randomBytes(16).toString("hex"),
  }), "utf8");
  try {
    await writeNewImmutableFile(directory, paths.lockPath, bytes);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error("Layout authority pair has an active or uninspected host writer lock.");
    }
    throw error;
  }
  return { bytes };
}

/**
 * Pair writers cooperatively honor this root gate before every irreversible pre-journal step.
 * It gives a trusted repair lifecycle cross-process exclusion without exposing a caller-minted
 * repair capability through Debug, CLI, MCP, or package data.
 */
export async function assertNoPairRepairGate(directory: TrustedAuthorityDirectory): Promise<void> {
  const path = join(directory.path, PAIR_REPAIR_GATE_NAME);
  const before = await lstat(path).catch(missing);
  if (!before) return;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("Layout authority repair gate is not a private regular file.");
  }
  const bytes = await readRegularFile(path, MAX_PAIR_LOCK_BYTES);
  const after = await lstat(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1
    || !isPairRepairGate(bytes, directory)) {
    throw new Error("Layout authority repair gate changed during inspection.");
  }
  throw new Error("Layout authority host repair is active.");
}

/** Acquire the root-wide gate before a trusted, operationally-quiescent repair pass. */
export async function acquirePairRepairGate(
  directory: TrustedAuthorityDirectory,
): Promise<PairRepairGate> {
  const bytes = Buffer.from(canonicalJson({
    schema: PAIR_REPAIR_GATE_SCHEMA,
    receiptsRoot: directory.root,
    nonce: randomBytes(16).toString("hex"),
  }), "utf8");
  const path = join(directory.path, PAIR_REPAIR_GATE_NAME);
  try {
    await writeNewImmutableFile(directory, path, bytes);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error("Layout authority host repair is already active.");
    }
    throw error;
  }
  return { bytes };
}

/**
 * Only an explicit, externally-quiescent host repair may take over a crash-retained root gate.
 * Ordinary pair writers never call this path; they fail closed while a repair gate is present.
 */
export async function readQuiescentPairRepairGate(
  directory: TrustedAuthorityDirectory,
): Promise<PairRepairGate> {
  const path = join(directory.path, PAIR_REPAIR_GATE_NAME);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("Layout authority host repair cannot prove private gate ownership.");
  }
  const bytes = await readRegularFile(path, MAX_PAIR_LOCK_BYTES);
  const after = await lstat(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1
    || !isPairRepairGate(bytes, directory)) {
    throw new Error("Layout authority host repair gate changed during takeover inspection.");
  }
  return { bytes };
}

export async function assertPairRepairGate(
  directory: TrustedAuthorityDirectory,
  gate: PairRepairGate,
): Promise<void> {
  const path = join(directory.path, PAIR_REPAIR_GATE_NAME);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || !(await readRegularFile(path, MAX_PAIR_LOCK_BYTES)).equals(gate.bytes)) {
    throw new Error("Layout authority host repair gate is no longer exclusively owned.");
  }
  const after = await lstat(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) {
    throw new Error("Layout authority host repair gate changed during recovery.");
  }
}

export async function releasePairRepairGate(
  directory: TrustedAuthorityDirectory,
  gate: PairRepairGate,
): Promise<void> {
  await unlinkExact(join(directory.path, PAIR_REPAIR_GATE_NAME), gate.bytes, MAX_PAIR_LOCK_BYTES, 1);
}

/** Read an exact private lock only after a host operator has made the writer domain quiescent. */
export async function readQuiescentPairWriterLock(
  directory: TrustedAuthorityDirectory,
  paths: PairPaths,
  key: string,
): Promise<PairWriterLock> {
  const before = await lstat(paths.lockPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("Layout authority pair repair cannot prove private lock ownership.");
  }
  const bytes = await readRegularFile(paths.lockPath, MAX_PAIR_LOCK_BYTES);
  const after = await lstat(paths.lockPath);
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) {
    throw new Error("Layout authority pair repair lock changed during inspection.");
  }
  if (!isPairWriterLock(bytes, directory, key)) {
    throw new Error("Layout authority pair repair lock does not bind this host root and key.");
  }
  return { bytes };
}

export async function releasePairWriterLock(
  paths: PairPaths,
  lock: PairWriterLock,
): Promise<void> {
  await unlinkExact(paths.lockPath, lock.bytes, MAX_PAIR_LOCK_BYTES, 1);
}

/** Recheck the admitted host lock before repair deletes any separately validated pair member. */
export async function assertPairWriterLock(
  paths: PairPaths,
  lock: PairWriterLock,
): Promise<void> {
  const before = await lstat(paths.lockPath);
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1
    || !(await readRegularFile(paths.lockPath, MAX_PAIR_LOCK_BYTES)).equals(lock.bytes)) {
    throw new Error("Layout authority pair repair lock is no longer exclusively owned.");
  }
  const after = await lstat(paths.lockPath);
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) {
    throw new Error("Layout authority pair repair lock changed before reclamation.");
  }
}

export async function writeNewImmutableFile(
  directory: TrustedAuthorityDirectory,
  path: string,
  bytes: Buffer,
): Promise<void> {
  await assertCurrentAuthorityDirectory(directory);
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
  if (!(await readRegularFile(path, bytes.byteLength)).equals(bytes)) {
    throw new Error("Layout authority pair staging write did not survive readback.");
  }
}

export async function rollbackLinkedPairMembers(
  linked: readonly LinkedPairMember[],
  hooks: ImmutableJsonPairCommitHooks | undefined,
): Promise<void> {
  let problem: unknown;
  for (const member of [...linked].reverse()) {
    try {
      await hooks?.beforeRollbackUnlink?.(member.step);
      await unlinkLinkedExact(member);
      await hooks?.afterRollbackUnlink?.(member.step);
    } catch (error) {
      problem ??= error;
    }
  }
  if (problem) throw problem;
}

export async function cleanupPairStaging(
  paths: PairPaths,
  pending: Buffer,
  members: readonly PairMember[],
): Promise<void> {
  for (const member of members) {
    await unlinkExact(member.stagePath, member.bytes, member.maximumBytes, 1).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      },
    );
  }
  await unlinkExact(paths.pendingPath, pending, 24 * 1024, 1);
}

function isPairWriterLock(
  bytes: Buffer,
  directory: TrustedAuthorityDirectory,
  key: string,
): boolean {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 4
      || record.schema !== PAIR_LOCK_SCHEMA
      || record.key !== key
      || typeof record.nonce !== "string"
      || !/^[a-f0-9]{32}$/.test(record.nonce)
      || canonicalJson(record) !== bytes.toString("utf8")) return false;
    const root = record.receiptsRoot;
    return Boolean(root && typeof root === "object" && !Array.isArray(root)
      && Object.keys(root).length === 3
      && (root as Record<string, unknown>).path === directory.root.path
      && (root as Record<string, unknown>).dev === directory.root.dev
      && (root as Record<string, unknown>).ino === directory.root.ino);
  } catch {
    return false;
  }
}

function isPairRepairGate(bytes: Buffer, directory: TrustedAuthorityDirectory): boolean {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 3
      || record.schema !== PAIR_REPAIR_GATE_SCHEMA
      || typeof record.nonce !== "string"
      || !/^[a-f0-9]{32}$/.test(record.nonce)
      || canonicalJson(record) !== bytes.toString("utf8")) return false;
    const root = record.receiptsRoot;
    return Boolean(root && typeof root === "object" && !Array.isArray(root)
      && Object.keys(root).length === 3
      && (root as Record<string, unknown>).path === directory.root.path
      && (root as Record<string, unknown>).dev === directory.root.dev
      && (root as Record<string, unknown>).ino === directory.root.ino);
  } catch {
    return false;
  }
}

function missing(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT") return null;
  throw error;
}
