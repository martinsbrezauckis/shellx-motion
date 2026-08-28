/** Canonical paths and bounded immutable journal record parsing for layout authority pairs. */
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import { join } from "node:path";
import type {
  ImmutableJsonPairDescriptor,
  ImmutableJsonPairReadDescriptor,
} from "./timeline-layout-authority-pair-types.js";
import type {
  StablePathIdentity,
  TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";

/** v2 is self-discoverable recovery intent for pre-install authority preparation. */
export const PAIR_SCHEMA = "shellx-motion/timeline-layout-authority-pair@2" as const;
export const PENDING_PAIR_SCHEMA = "shellx-motion/timeline-layout-authority-pair-pending@2" as const;
/** Existing v1 completed journals remain readable; v1 pending state is never auto-recovered. */
export const LEGACY_PAIR_SCHEMA = "shellx-motion/timeline-layout-authority-pair@1" as const;
export const MAX_PAIR_JOURNAL_BYTES = 24 * 1024;

export interface PairPaths {
  receiptName: string;
  authorityName: string;
  journalName: string;
  receiptPath: string;
  authorityPath: string;
  journalPath: string;
  lockPath: string;
  pendingPath: string;
  receiptStagePath: string;
  authorityStagePath: string;
  journalStagePath: string;
}

interface JournalInput {
  key: string;
  recordKind: string;
  outputLineage: unknown;
  receiptSha256: string;
  authoritySha256: string;
}

export interface ParsedPairJournal {
  recordKind: string;
  receipt: { sha256: string };
  authority: { sha256: string };
}

export function pairPaths(
  directory: TrustedAuthorityDirectory,
  key: string,
): PairPaths {
  const receiptName = `${key}.receipt.json`;
  const authorityName = `${key}.authority.json`;
  const journalName = `${key}.pair.json`;
  return {
    receiptName,
    authorityName,
    journalName,
    receiptPath: join(directory.path, receiptName),
    authorityPath: join(directory.path, authorityName),
    journalPath: join(directory.path, journalName),
    lockPath: join(directory.path, `.${key}.pair.lock`),
    pendingPath: join(directory.path, `.${key}.pair.pending`),
    receiptStagePath: join(directory.path, `.${key}.receipt.stage`),
    authorityStagePath: join(directory.path, `.${key}.authority.stage`),
    journalStagePath: join(directory.path, `.${key}.journal.stage`),
  };
}

export function recordPayload(value: unknown, maximumBytes: number): Buffer {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.byteLength > maximumBytes) {
    throw new Error("Layout authority record exceeds its byte cap.");
  }
  return bytes;
}

export function assertPairDescriptor(input: ImmutableJsonPairDescriptor): void {
  assertPairKey(input.key);
  if (typeof input.recordKind !== "string"
    || !/^[a-z][a-z0-9-]{0,63}$/.test(input.recordKind)) {
    throw new Error("Layout authority pair record kind is invalid.");
  }
  recordPayload(input.outputLineage, MAX_PAIR_JOURNAL_BYTES);
}

export function assertPairKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Layout authority pair key is invalid.");
  }
}

export function journalValue(
  root: StablePathIdentity,
  input: JournalInput,
  paths: PairPaths,
) {
  return {
    schema: PAIR_SCHEMA,
    key: input.key,
    recordKind: input.recordKind,
    receiptsRoot: root,
    outputLineage: input.outputLineage,
    outputLineageSha256: canonicalJsonSha256(input.outputLineage),
    receipt: { basename: paths.receiptName, sha256: input.receiptSha256 },
    authority: { basename: paths.authorityName, sha256: input.authoritySha256 },
  } as const;
}

export function parseJournal(
  value: unknown,
  root: StablePathIdentity,
  input: ImmutableJsonPairReadDescriptor,
  paths: PairPaths,
  schema: typeof PAIR_SCHEMA | typeof PENDING_PAIR_SCHEMA | typeof LEGACY_PAIR_SCHEMA,
): ParsedPairJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Layout authority pair journal is malformed.");
  }
  const record = value as Record<string, unknown>;
  const required = [
    "schema",
    "key",
    "recordKind",
    "receiptsRoot",
    "outputLineage",
    "outputLineageSha256",
    "receipt",
    "authority",
  ];
  if (Object.keys(record).length !== required.length
    || required.some((key) => !Object.hasOwn(record, key))
    || record.schema !== schema
    || record.key !== input.key
    || typeof record.recordKind !== "string"
    || !input.recordKinds.includes(record.recordKind)) {
    throw new Error("Layout authority pair journal is malformed.");
  }

  const receiptsRoot = parseIdentity(record.receiptsRoot, "Layout authority pair receiptsRoot");
  if (!sameIdentity(receiptsRoot, root)
    || canonicalJson(record.outputLineage) !== canonicalJson(input.outputLineage)
    || record.outputLineageSha256 !== canonicalJsonSha256(input.outputLineage)) {
    throw new Error("Layout authority pair journal does not bind the current host root and output lineage.");
  }
  return {
    recordKind: record.recordKind,
    receipt: parseJournalMember(record.receipt, paths.receiptName),
    authority: parseJournalMember(record.authority, paths.authorityName),
  };
}

function parseIdentity(value: unknown, label: string): StablePathIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3
    || typeof record.path !== "string"
    || !record.path
    || record.path.length > 4_096
    || record.path.includes("\0")
    || !Number.isSafeInteger(record.dev)
    || !Number.isSafeInteger(record.ino)) {
    throw new Error(`${label} is malformed.`);
  }
  return {
    path: record.path,
    dev: record.dev as number,
    ino: record.ino as number,
  };
}

function parseJournalMember(value: unknown, basename: string): { sha256: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Layout authority pair member journal is malformed.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2
    || record.basename !== basename
    || typeof record.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error("Layout authority pair member journal is malformed.");
  }
  return { sha256: record.sha256 };
}

function sameIdentity(left: StablePathIdentity, right: StablePathIdentity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino;
}
