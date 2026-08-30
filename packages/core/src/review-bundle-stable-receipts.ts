import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { canonicalJsonSha256 } from "./canonical-json";
import { ExistingDirectoryAuthority, type RetainedDirectoryAuthority } from "./output-path-topology";
import { readReceiptActor } from "./receipts";
import { readBoundedStableFile, type StableFileIdentity } from "./stable-file-read";
import type { OperationReceipt, ReceiptArtifact } from "./types";
import type {
  BoundReviewBundleReceiptEntry,
  ReviewBundleReceiptEntry,
  StableReviewBundleReceiptInput
} from "./review-bundle-types";

/** Receipts are control-plane inputs, not an unbounded log-ingestion channel. */
export const MAX_REVIEW_BUNDLE_RECEIPT_BYTES = 16 * 1024 * 1024;

export interface BoundFilesystemReceipt {
  root: string;
  path: string;
  relativePath: string;
  sha256: string;
  byteLength: number;
  identity: StableFileIdentity;
  receipt: OperationReceipt;
  receiptSha256: string;
}

// A caller may construct or mutate a ReviewBundleReceiptEntry, so every fact that authorizes a
// parsed snapshot remains private and identity-bound rather than live on the public object.
const boundFilesystemReceipts = new WeakMap<ReviewBundleReceiptEntry, BoundFilesystemReceipt>();

/**
 * Re-admit host stable-reader results as Core-owned review-bundle entries. The public handoff
 * cannot forge authority: Core reopens the exact approved-root leaf, verifies the Debug snapshot,
 * reparses those bytes itself, and keeps the resulting root-relative identity private.
 */
export async function bindStableReviewBundleReceiptEntries(
  receiptsRoot: string,
  supplied: readonly StableReviewBundleReceiptInput[],
  retainedRootAuthority?: RetainedDirectoryAuthority
): Promise<BoundReviewBundleReceiptEntry[]> {
  const lexicalRoot = resolve(receiptsRoot);
  const rootAuthority = retainedRootAuthority
    ?? await ExistingDirectoryAuthority.acquire(await realpath(lexicalRoot));
  await assertReceiptRootCurrent(lexicalRoot, rootAuthority);
  const canonicalRoot = rootAuthority.path;
  const entries: BoundReviewBundleReceiptEntry[] = [];
  for (const candidate of supplied) {
    await assertReceiptRootCurrent(lexicalRoot, rootAuthority);
    const source = await readBoundedStableFile(candidate.path, {
      label: "Stable review bundle receipt",
      maxBytes: MAX_REVIEW_BUNDLE_RECEIPT_BYTES,
      withinRoot: canonicalRoot,
      captureIdentity: true
    });
    const identity = requiredStableFileIdentity(source, "Stable review bundle receipt");
    if (!matchesStableReaderSnapshot(source, identity, candidate.snapshot)) {
      throw new Error("Stable review bundle receipt changed after the Debug reader parsed its snapshot.");
    }
    const receipt = readReviewBundleReceipt(JSON.parse(source.bytes.toString("utf8")));
    if (!receipt) throw new Error("Stable review bundle receipt no longer contains a valid Motion receipt.");
    const entry = {
      path: source.canonicalPath,
      relativePath: reviewReceiptRelativePath(canonicalRoot, source.canonicalPath),
      receipt
    } as BoundReviewBundleReceiptEntry;
    rememberBoundFilesystemReceipt(entry, {
      root: canonicalRoot,
      path: source.canonicalPath,
      relativePath: entry.relativePath!,
      sha256: source.sha256,
      byteLength: source.byteLength,
      identity,
      receipt: cloneReceiptSnapshot(receipt),
      receiptSha256: canonicalJsonSha256(receipt)
    });
    entries.push(entry);
  }
  await assertReceiptRootCurrent(lexicalRoot, rootAuthority);
  return entries;
}

async function assertReceiptRootCurrent(
  lexicalRoot: string,
  authority: RetainedDirectoryAuthority
): Promise<void> {
  await authority.assertCurrent();
  if (resolve(await realpath(lexicalRoot)) !== resolve(authority.path)) {
    throw new Error("Review bundle receiptsRoot changed after admission.");
  }
  await authority.assertCurrent();
}

/**
 * Replace a caller-visible bound entry with the exact Core-held receipt snapshot before review
 * content is rendered or artifact paths are considered. Any public-object mutation is a refusal,
 * not an opportunity to substitute different receipt semantics for the approved byte digest.
 */
export function exactReviewBundleReceiptEntries(entries: readonly ReviewBundleReceiptEntry[]): ReviewBundleReceiptEntry[] {
  return entries.map((entry) => {
    const binding = boundFilesystemReceipt(entry);
    if (!binding) return entry;
    assertBoundFilesystemReceiptEntry(entry, binding);
    const exact = {
      path: binding.path,
      relativePath: binding.relativePath,
      receipt: binding.receipt
    } satisfies ReviewBundleReceiptEntry;
    rememberBoundFilesystemReceipt(exact, binding);
    return exact;
  });
}

export function rememberBoundFilesystemReceipt(entry: ReviewBundleReceiptEntry, binding: BoundFilesystemReceipt): void {
  boundFilesystemReceipts.set(entry, binding);
}

export function bindLoadedReviewBundleReceipt(
  entry: ReviewBundleReceiptEntry,
  root: string,
  source: { canonicalPath: string; sha256: string; byteLength: number; identity?: StableFileIdentity }
): void {
  rememberBoundFilesystemReceipt(entry, {
    root,
    path: source.canonicalPath,
    relativePath: entry.relativePath!,
    sha256: source.sha256,
    byteLength: source.byteLength,
    identity: requiredStableFileIdentity(source, "Review bundle receipt"),
    receipt: cloneReceiptSnapshot(entry.receipt),
    receiptSha256: canonicalJsonSha256(entry.receipt)
  });
}

export function boundFilesystemReceipt(entry: ReviewBundleReceiptEntry): BoundFilesystemReceipt | undefined {
  return boundFilesystemReceipts.get(entry);
}

export function assertBoundFilesystemReceiptEntry(entry: ReviewBundleReceiptEntry, binding: BoundFilesystemReceipt): void {
  const path = entry.path;
  if (!path) throw new Error("Review bundle receipt input changed before publication.");
  const relativePath = reviewReceiptRelativePath(binding.root, path);
  if (!sameReviewLocalPath(path, binding.path) || entry.relativePath !== binding.relativePath || relativePath !== binding.relativePath
    || canonicalJsonSha256(entry.receipt) !== binding.receiptSha256) {
    throw new Error("Review bundle receipt input changed before publication.");
  }
}

export async function recheckBoundFilesystemReceipt(binding: BoundFilesystemReceipt): Promise<string> {
  try {
    const source = await readBoundedStableFile(binding.path, {
      label: "Stable review bundle receipt",
      maxBytes: MAX_REVIEW_BUNDLE_RECEIPT_BYTES,
      withinRoot: binding.root,
      captureIdentity: true,
      expectedIdentity: binding.identity
    });
    if (source.sha256 !== binding.sha256 || source.byteLength !== binding.byteLength) {
      throw new Error("digest mismatch");
    }
    return source.sha256;
  } catch {
    throw new Error(`Stable review bundle receipt changed before publication: ${binding.relativePath}`);
  }
}

export function readReviewBundleReceipt(value: unknown): OperationReceipt | null {
  const record = recordOf(value);
  if (!record) return null;
  if (record.schema !== "shellx-motion/receipt@1") return null;
  if (typeof record.id !== "string" || typeof record.operation !== "string" || typeof record.packageId !== "string") return null;
  const status = readReceiptStatus(record.status);
  if (!status || typeof record.lane !== "string" || typeof record.createdAt !== "string") return null;
  return {
    schema: "shellx-motion/receipt@1",
    id: record.id,
    operation: record.operation,
    status,
    packageId: record.packageId,
    inputHashes: readStringRecord(record.inputHashes),
    createdAt: record.createdAt,
    lane: record.lane,
    output: record.output,
    ...(Array.isArray(record.artifacts) ? { artifacts: record.artifacts.map(readArtifact).filter((artifact): artifact is NonNullable<OperationReceipt["artifacts"]>[number] => artifact !== null) } : {}),
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((warning): warning is string => typeof warning === "string") : [],
    ...(readReceiptActor(record.actor) ? { actor: readReceiptActor(record.actor) } : {})
  };
}

export function reviewReceiptRelativePath(root: string, path: string): string {
  const candidate = relative(resolve(root), resolve(path));
  if (!candidate || candidate === ".." || candidate.startsWith("../") || candidate.startsWith("..\\") || isAbsolute(candidate)
    || candidate.split(/[/\\]+/).some((part) => !part || part === "." || part === "..")) {
    throw new Error("Review bundle receipt escapes its approved root.");
  }
  return candidate.split(/[/\\]+/).join("/");
}

function requiredStableFileIdentity(source: { identity?: StableFileIdentity }, label: string): StableFileIdentity {
  if (!source.identity) throw new Error(`${label} did not retain its opened-file identity.`);
  return source.identity;
}

function matchesStableReaderSnapshot(
  source: { sha256: string; byteLength: number },
  identity: StableFileIdentity,
  snapshot: StableReviewBundleReceiptInput["snapshot"]
): boolean {
  return source.sha256 === snapshot.sha256
    && source.byteLength === snapshot.byteLength
    && identity.dev === String(snapshot.identity.dev)
    && identity.ino === String(snapshot.identity.ino);
}

function cloneReceiptSnapshot(receipt: OperationReceipt): OperationReceipt {
  // Receipt data came from JSON; a JSON round trip makes the Core-held snapshot independent of
  // the caller-visible object without introducing an ambient prototype or reference.
  return JSON.parse(JSON.stringify(receipt)) as OperationReceipt;
}

function sameReviewLocalPath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function readArtifact(value: unknown): ReceiptArtifact | null {
  const record = recordOf(value);
  if (!record || typeof record.role !== "string" || typeof record.path !== "string") return null;
  if (record.status !== "available" && record.status !== "planned" && record.status !== "not_required" && record.status !== "failed") return null;
  return {
    role: record.role,
    path: record.path,
    status: record.status,
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
    ...(typeof record.primary === "boolean" ? { primary: record.primary } : {})
  };
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = recordOf(value);
  if (!record) return {};
  const strings: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") strings[key] = item;
  }
  return strings;
}

function readReceiptStatus(value: unknown): OperationReceipt["status"] | null {
  return value === "passed" || value === "failed" || value === "warning" || value === "not_run" ? value : null;
}
