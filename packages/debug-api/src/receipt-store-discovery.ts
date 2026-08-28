/**
 * Bounded discovery of receipt-shaped JSON inside a receipt store.
 *
 * Role: walk a receipts root and hand back the `.json` files under it, then the subset of those that
 * are platform-verification documents. Every read path in the debug API — receipts read/list, agent
 * transcript, the prompt queue, the platform panel — starts here.
 *
 * The four caps are the whole point of the module having a name. A receipts root is a directory a
 * host declared, not a directory Motion created, so it may be enormous, deeply nested, or pointed at
 * a filesystem the operator did not think about. Unbounded recursion over one turns a read command
 * into an accidental filesystem crawl that never returns, and the caps are shared state threaded
 * through the recursion so a wide tree and a deep tree are both bounded by ONE budget rather than
 * one budget per directory. Sorting is `compareCodeUnits` and not the default comparator: the order
 * these files come back in reaches receipt listings, so it must not depend on the machine's locale.
 *
 * Extracted from `index.ts` rather than left inline: that file carries a declared non-growth
 * baseline in `scripts/module-size-gate.mjs`, and "how a receipt store is enumerated, and how much
 * of it we are willing to look at" is a coherent unit.
 *
 * Primary caller: `index.ts`.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { loadSchemaSync, validateDocumentSync } from "@shellx-motion/core";
import { MAX_DEBUG_JSON_DISCOVERY_DEPTH, MAX_DEBUG_JSON_DISCOVERY_ENTRIES, MAX_DEBUG_JSON_DISCOVERY_FILES, MAX_DEBUG_RECEIPT_BYTES } from "./receipt-store-limits.js";
import { decodeCanonicalReceiptUtf8, readCappedReceiptBytes } from "./receipt-store-byte-reader.js";
import { discoverStableReceiptFiles, readStableReceiptEntries, readStableReceiptEntry, unchangedStableReceipt, type ReceiptStoreReadServices, type StableReceiptEnforcement } from "./receipt-store-stable-reader.js";

export { MAX_DEBUG_JSON_DISCOVERY_DEPTH, MAX_DEBUG_JSON_DISCOVERY_ENTRIES, MAX_DEBUG_JSON_DISCOVERY_FILES, MAX_DEBUG_RECEIPT_BYTES } from "./receipt-store-limits.js";

export interface PlatformReceiptEntry {
  path: string;
  receipt: Record<string, unknown>;
}

export interface JsonDiscoveryResult {
  files: string[];
  /** False means a traversal budget stopped the walk or a directory could not be read. */
  complete: boolean;
}

/** Private deterministic retarget seam; production callers leave it empty. */
export interface VerifiedJsonReceiptReadServices {
  afterOpen?: (input: { path: string }) => Promise<void>;
}

/** Private deterministic root-retarget seam; production callers leave it empty. */
export type PlatformReceiptDiscoveryServices = ReceiptStoreReadServices;

/**
 * List the `.json` files under a root, depth- and count-bounded.
 *
 * @param root directory to walk. A missing or unreadable directory yields an empty list rather than
 *   throwing: a read command over a store that does not exist yet is an empty read, not an error.
 * @param state shared budget across the whole walk; callers pass nothing.
 * @param depth current recursion depth; callers pass nothing.
 */
export async function discoverJsonFiles(
  root: string,
  state: { fileCount: number; entryCount: number; complete: boolean } = { fileCount: 0, entryCount: 0, complete: true },
  depth = 0
): Promise<string[]> {
  if (depth > MAX_DEBUG_JSON_DISCOVERY_DEPTH || state.fileCount >= MAX_DEBUG_JSON_DISCOVERY_FILES || state.entryCount >= MAX_DEBUG_JSON_DISCOVERY_ENTRIES) {
    state.complete = false;
    return [];
  }
  const discovered = await discoverStableReceiptFiles(root);
  state.fileCount += discovered.files.length;
  state.entryCount += discovered.files.length;
  state.complete &&= discovered.complete;
  return discovered.files;
}

/**
 * Bounded discovery with its completeness bit retained for compact callers.
 *
 * Existing panel/read callers intentionally keep the array-only API above; changing their empty
 * store semantics would be a compatibility break. Snapshot callers need to distinguish "empty"
 * from "budgeted or unreadable" without exposing filesystem error detail.
 */
export async function discoverJsonFilesWithStatus(root: string): Promise<JsonDiscoveryResult> {
  const state = { fileCount: 0, entryCount: 0, complete: true };
  const files = await discoverJsonFiles(root, state);
  return { files, complete: state.complete };
}

/**
 * Read one receipt-shaped JSON file through the same no-follow and inode-stability checks every
 * Debug receipt reader needs. Normalization and optional post-read retention enforcement remain
 * caller-owned because their policies differ, while the filesystem safety boundary stays shared.
 */
export async function readVerifiedJsonReceipt<T>(
  path: string,
  normalize: (value: unknown) => T | null,
  enforce: (path: string, receipt: T | null, original: unknown, verifiedFile: { dev: number; ino: number }) => Promise<StableReceiptEnforcement<T>>,
  services: VerifiedJsonReceiptReadServices = {}
): Promise<T | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_DEBUG_RECEIPT_BYTES) return null;
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_DEBUG_RECEIPT_BYTES) return null;
    await services.afterOpen?.({ path });
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) return null;
    const bytes = await readCappedReceiptBytes(handle, opened.size);
    const final = await handle.stat();
    if (final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) return null;
    if (bytes === null) return null;
    const content = decodeCanonicalReceiptUtf8(bytes);
    if (content === null) return null;
    const parsed: unknown = JSON.parse(content);
    return (await enforce(path, normalize(parsed), parsed, { dev: opened.dev, ino: opened.ino })).receipt;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** Parse a file only if it declares one of the two platform-verification schemas. */
export async function readPlatformReceiptFile(
  receiptsRoot: string,
  path: string,
  services: PlatformReceiptDiscoveryServices = {}
): Promise<Record<string, unknown> | null> {
  return (await readStableReceiptEntry(receiptsRoot, path, parsePlatformReceipt, async (_path, receipt) => unchangedStableReceipt(receipt), services)).entry?.receipt ?? null;
}

/** Every platform-verification document under a root, in stable path order. */
export async function readPlatformReceiptEntries(
  receiptsRoot: string,
  services: PlatformReceiptDiscoveryServices = {}
): Promise<PlatformReceiptEntry[]> {
  const result = await readStableReceiptEntries(receiptsRoot, parsePlatformReceipt, async (_path, receipt) => unchangedStableReceipt(receipt), services);
  return result.entries;
}

function parsePlatformReceipt(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = Object.fromEntries(Object.entries(value as Record<string, unknown>));
  const schemaName = record.schema === "shellx-motion/platform-verification@1"
    ? "platformVerification"
    : record.schema === "shellx-motion/platform-verification-aggregate@1"
      ? "platformVerificationAggregate"
      : undefined;
  if (!schemaName) return null;
  return validateDocumentSync(loadSchemaSync(schemaName), record).ok ? record : null;
}
