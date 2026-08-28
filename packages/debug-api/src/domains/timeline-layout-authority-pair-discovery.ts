/** Bounded host-only discovery of v2 pre-install layout authority pair intent. */
import { lstat, opendir } from "node:fs/promises";
import {
  assertCurrentAuthorityDirectory,
  readRegularFile,
  type TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";
import {
  expectedOutputState,
  inspectExpectedOutput,
  quarantineExactInstalledOutput,
} from "./timeline-layout-authority-pair-output-recovery.js";
import {
  finalizeRecoveredImmutableJsonPair,
  readImmutableJsonPair,
  reclaimRecoveredPairLockOnly,
  recoveredImmutableJsonPairIsComplete,
  recoverInterruptedImmutableJsonPair,
} from "./timeline-layout-authority-pair-store.js";
import { maintainAdmittedImmutableJsonPairEvidence } from "./timeline-layout-authority-pair-maintenance.js";
import {
  assertPairKey,
  pairPaths,
  parseJournal,
  PENDING_PAIR_SCHEMA,
} from "./timeline-layout-authority-pair-records.js";
import { MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES } from "./timeline-layout-authority-record-caps.js";
import type {
  HostQuiescentPairRecoveryAdmission,
  ImmutableJsonPairReadDescriptor,
} from "./timeline-layout-authority-pair-types.js";

const MAX_RECOVERY_CANDIDATES = 32;
const MAX_DISCOVERY_DIRECTORY_ENTRIES_PER_PAGE = 128;
const STATIC_RECEIPT_BYTES = 256 * 1024;
const STATIC_AUTHORITY_BYTES = 64 * 1024;
const GAP_RECEIPT_BYTES = 256 * 1024;

export interface DiscoveredLayoutAuthorityPair {
  key: string;
  locked: boolean;
  state: "lock_only" | "prepared_no_output" | "prepared_exact_output" | "prepared_output_mismatch";
  descriptor?: ImmutableJsonPairReadDescriptor;
}

export interface RepairedLayoutAuthorityPair {
  key: string;
  action: "reclaimed_preinstall_prefix" | "finalized_installed_output" | "reclaimed_lock_only" | "quarantined_output";
}

export interface LayoutAuthorityPairDiscoveryPage {
  pairs: readonly DiscoveredLayoutAuthorityPair[];
  /** Private accepted entries with crashed cleanup; never exposed through Debug transports. */
  accepted: readonly ImmutableJsonPairReadDescriptor[];
  complete: boolean;
}

/**
 * Private host cursor over a fixed-size directory page. It never exposes filenames or a cursor
 * token to Debug/CLI/MCP callers, and it keeps accepted historical records out of candidate caps.
 */
export interface LayoutAuthorityPairDiscoveryPager {
  next(): Promise<LayoutAuthorityPairDiscoveryPage>;
  close(): Promise<void>;
}

/**
 * This is discovery only. It never infers stale-lock liveness, edits a package, or reclaims a
 * member; a trusted host must establish cross-process quiescence before a later repair action.
 */
export async function discoverInterruptedLayoutAuthorityPairs(
  directory: TrustedAuthorityDirectory,
): Promise<readonly DiscoveredLayoutAuthorityPair[]> {
  const pager = await openLayoutAuthorityPairDiscovery(directory);
  try {
    return (await pager.next()).pairs;
  } finally {
    await pager.close();
  }
}

export async function openLayoutAuthorityPairDiscovery(
  directory: TrustedAuthorityDirectory,
): Promise<LayoutAuthorityPairDiscoveryPager> {
  await assertCurrentAuthorityDirectory(directory);
  const entries = await opendir(directory.path, { encoding: "utf8" });
  let complete = false;
  let closed = false;
  return Object.freeze({
    async next(): Promise<LayoutAuthorityPairDiscoveryPage> {
      if (closed) throw new Error("Layout authority recovery pager is closed.");
      if (complete) return { pairs: [], accepted: [], complete: true };
      await assertCurrentAuthorityDirectory(directory);
      const pairs: DiscoveredLayoutAuthorityPair[] = [];
      const accepted: ImmutableJsonPairReadDescriptor[] = [];
      let entriesSeen = 0;
      while (entriesSeen < MAX_DISCOVERY_DIRECTORY_ENTRIES_PER_PAGE) {
        const entry = await entries.read();
        if (!entry) {
          complete = true;
          break;
        }
        entriesSeen += 1;
        await discoverDirectoryEntry(directory, entry.name, pairs, accepted);
      }
      await assertCurrentAuthorityDirectory(directory);
      return { pairs, accepted, complete };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await entries.close().catch(() => {});
    },
  });
}

/**
 * Mutating half of the installed host repair service. Its descriptor inventory is self-discovered
 * from v2 pending records; callers cannot supply a key, output lineage, kind, or byte caps.
 */
export async function repairDiscoveredLayoutAuthorityPairs(
  directory: TrustedAuthorityDirectory,
  admission: HostQuiescentPairRecoveryAdmission,
): Promise<readonly RepairedLayoutAuthorityPair[]> {
  return await repairLayoutAuthorityPairDiscoveryPage(
    directory,
    { pairs: await discoverInterruptedLayoutAuthorityPairs(directory), accepted: [], complete: true },
    admission,
  );
}

/** Consumes one opaque host-owned discovery page; no transport caller can construct its entries. */
export async function repairLayoutAuthorityPairDiscoveryPage(
  directory: TrustedAuthorityDirectory,
  discovered: LayoutAuthorityPairDiscoveryPage,
  admission: HostQuiescentPairRecoveryAdmission,
): Promise<readonly RepairedLayoutAuthorityPair[]> {
  for (const accepted of discovered.accepted) {
    await maintainAdmittedImmutableJsonPairEvidence(directory, accepted).catch(() => {});
  }
  const repaired: RepairedLayoutAuthorityPair[] = [];
  for (const item of discovered.pairs) {
    if (item.state === "lock_only") {
      await reclaimRecoveredPairLockOnly(directory, item.key, admission);
      repaired.push({ key: item.key, action: "reclaimed_lock_only" });
      continue;
    }
    if (!item.descriptor) throw new Error("Layout authority repair discovery lost its immutable pair descriptor.");
    if (item.state === "prepared_no_output") {
      await recoverInterruptedImmutableJsonPair(directory, item.descriptor, admission);
      repaired.push({ key: item.key, action: "reclaimed_preinstall_prefix" });
      continue;
    }
    if (item.state === "prepared_exact_output") {
      if (await recoveredImmutableJsonPairIsComplete(directory, item.descriptor, admission)) {
        await finalizeRecoveredImmutableJsonPair(directory, item.descriptor, admission);
        repaired.push({ key: item.key, action: "finalized_installed_output" });
        continue;
      }
      await quarantineExactInstalledOutput(item.descriptor.outputLineage);
      await recoverInterruptedImmutableJsonPair(directory, item.descriptor, admission);
      repaired.push({ key: item.key, action: "quarantined_output" });
      continue;
    }
    const output = await inspectExpectedOutput(item.descriptor.outputLineage);
    if (!output.identityMatches) {
      throw new Error("Layout authority recovery found a foreign output lineage mismatch; refusing repair.");
    }
    await quarantineExactInstalledOutput(item.descriptor.outputLineage);
    await recoverInterruptedImmutableJsonPair(directory, item.descriptor, admission);
    repaired.push({ key: item.key, action: "quarantined_output" });
  }
  return repaired;
}

/**
 * Accepted pairs converge to receipt, authority, and journal finals. A crash during best-effort
 * post-journal cleanup may temporarily retain pre-journal evidence; stream it rather than
 * accumulating historical inventory, and apply the cap only after a candidate is proven
 * incomplete. The final journal is read before candidate accounting.
 */
async function discoverDirectoryEntry(
  directory: TrustedAuthorityDirectory,
  name: string,
  discovered: DiscoveredLayoutAuthorityPair[],
  accepted: ImmutableJsonPairReadDescriptor[],
): Promise<void> {
  const pendingMatch = /^\.([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.pair\.pending$/u.exec(name);
  if (pendingMatch) {
    const key = pendingMatch[1]!;
    assertPairKey(key);
    const paths = pairPaths(directory, key);
    const pending = await readPendingDescriptor(directory, paths.pendingPath, key);
    if (!pending) return;
    try {
      await readImmutableJsonPair(directory, pending);
      accepted.push(pending);
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    reserveInterruptedCandidate(discovered);
    const output = await expectedOutputState(pending.outputLineage);
    discovered.push({
      key,
      locked: await existsRegularPrivateFile(paths.lockPath),
      descriptor: pending,
      state: output === "absent"
        ? "prepared_no_output"
        : output === "exact"
          ? "prepared_exact_output"
          : "prepared_output_mismatch",
    });
    return;
  }
  const lockMatch = /^\.([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.pair\.lock$/u.exec(name);
  if (!lockMatch) return;
  const key = lockMatch[1]!;
  assertPairKey(key);
  const paths = pairPaths(directory, key);
  // When this lock and its pending name share a page, the lock may be enumerated first. The
  // filesystem check prevents a duplicate; the pending entry then owns the descriptor later.
  if (await readPendingDescriptor(directory, paths.pendingPath, key)) return;
  // A previous page may have repaired this key while the open directory stream still retains its
  // deleted lock name. Never turn that stale enumeration entry into a second no-op repair action.
  if (!(await existsRegularPrivateFile(paths.lockPath))) return;
  reserveInterruptedCandidate(discovered);
  discovered.push({ key, locked: true, state: "lock_only" });
}

function reserveInterruptedCandidate(discovered: readonly DiscoveredLayoutAuthorityPair[]): void {
  if (discovered.length >= MAX_RECOVERY_CANDIDATES) {
    throw new Error("Layout authority recovery inventory exceeds its bounded interrupted-pair cap.");
  }
}

async function readPendingDescriptor(
  directory: TrustedAuthorityDirectory,
  path: string,
  key: string,
): Promise<ImmutableJsonPairReadDescriptor | null> {
  const stat = await lstat(path).catch(missing);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("Layout authority recovery pending intent is not a private regular file.");
  }
  const bytes = await readRegularFile(path, 24 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Layout authority recovery pending intent is malformed.");
  }
  const record = recordValue(value, "Layout authority recovery pending intent");
  if (record.schema !== PENDING_PAIR_SCHEMA || record.key !== key || typeof record.recordKind !== "string") {
    throw new Error("Layout authority recovery pending intent is not a v2 pair record.");
  }
  const caps = capsForRecordKind(record.recordKind);
  const descriptor: ImmutableJsonPairReadDescriptor = {
    key,
    recordKinds: [record.recordKind],
    outputLineage: record.outputLineage,
    receiptMaximumBytes: caps.receipt,
    authorityMaximumBytes: caps.authority,
  };
  parseJournal(value, directory.root, descriptor, pairPaths(directory, key), PENDING_PAIR_SCHEMA);
  return descriptor;
}

function capsForRecordKind(kind: string): { receipt: number; authority: number } {
  switch (kind) {
    case "layout-application":
      return { receipt: STATIC_RECEIPT_BYTES, authority: STATIC_AUTHORITY_BYTES };
    case "layout-gap-restored":
    case "layout-gap-continuation":
      return { receipt: GAP_RECEIPT_BYTES, authority: MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES };
    default:
      throw new Error("Layout authority recovery pending intent has an unsupported record kind.");
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed.`);
  return value as Record<string, unknown>;
}

async function existsRegularPrivateFile(path: string): Promise<boolean> {
  const entry = await lstat(path).catch(missing);
  if (!entry) return false;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new Error("Layout authority recovery writer lock is not a private regular file.");
  }
  return true;
}

function missing(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT") return null;
  throw error;
}
