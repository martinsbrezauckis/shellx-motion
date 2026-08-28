/**
 * No-follow, identity-stable readers for host-owned receipt stores.
 *
 * Receipt paths are names supplied by discovery or a caller. A name-based `open` after a recursive
 * `readdir` can otherwise cross a directory-to-symlink replacement even when the final file itself
 * uses O_NOFOLLOW. Keep the root directory open, reopen every discovered ancestor from that held
 * capability, and prove the original name chain before returning or purging a receipt.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { compareCodeUnits, hashBuffer } from "@shellx-motion/core";
import { MAX_DEBUG_JSON_DISCOVERY_DEPTH, MAX_DEBUG_JSON_DISCOVERY_ENTRIES, MAX_DEBUG_JSON_DISCOVERY_FILES, MAX_DEBUG_RECEIPT_BYTES } from "./receipt-store-limits.js";
import { decodeCanonicalReceiptUtf8, readCappedReceiptBytes } from "./receipt-store-byte-reader.js";
import { hasStableReceiptStoreCapability } from "./receipt-store-host-capability.js";

export { hasStableReceiptStoreCapability } from "./receipt-store-host-capability.js";

export interface VerifiedReceiptFile { dev: number; ino: number; }
export interface StableReceiptByteSnapshot {
  sha256: string;
  byteLength: number;
  identity: VerifiedReceiptFile;
}
/** What happened after an admitted read requested an on-disk raw-prompt purge. */
export type StableReceiptPostPurge =
  | { state: "not_needed" }
  | { state: "not_persisted" }
  | { state: "purged"; snapshot: StableReceiptByteSnapshot };
export interface StableReceiptSnapshot extends StableReceiptByteSnapshot {
  postPurge: StableReceiptPostPurge;
}
export interface StableReceiptLocation {
  /** Capability-backed path to the leaf's retained parent directory. */
  capabilityPath: string;
  /** True only while the named root and every opened ancestor retain their original identity. */
  isCurrent: () => Promise<boolean>;
}
export interface StableReceiptEntry<T> { path: string; receipt: T; snapshot: StableReceiptSnapshot; }
export interface StableReceiptEntries<T> { entries: StableReceiptEntry<T>[]; complete: boolean; }
export interface ReceiptStoreReadServices {
  /** Deterministic race seam; production callers leave it empty. */
  afterReaddir?: (input: { receiptsRoot: string }) => Promise<void>;
  /** Deterministic leaf-open seam; production callers leave it empty. */
  afterLeafOpen?: (input: { receiptPath: string }) => Promise<void>;
}

type Normalize<T> = (value: unknown) => T | null;
export interface StableReceiptEnforcement<T> {
  receipt: T | null;
  /** Omit only when the enforcer did not request a purge. */
  postPurge?: StableReceiptPostPurge;
}
type Enforce<T> = (path: string, receipt: T | null, original: unknown, file: VerifiedReceiptFile, location?: StableReceiptLocation) => Promise<StableReceiptEnforcement<T>>;

export function unchangedStableReceipt<T>(receipt: T | null): StableReceiptEnforcement<T> {
  return { receipt };
}

/** @internal Retained root primitive shared with the stable receipt writer. */
export interface DirectoryCapability {
  logicalPath: string;
  capabilityPath: string;
  dev: number;
  ino: number;
  handle?: Awaited<ReturnType<typeof open>>;
  /** Retained no-follow chain used to admit this configured root. */
  rootLineage?: DirectoryCapability[];
}

interface DirectoryIdentity { logicalPath: string; dev: number; ino: number; }
interface Candidate { parts: string[]; directories?: DirectoryIdentity[]; }
interface OpenedAncestor { directory: DirectoryCapability; opened: DirectoryCapability[]; }
interface DiscoveryState { fileCount: number; entryCount: number; complete: boolean; }

export async function readStableReceiptEntries<T>(
  receiptsRoot: string,
  normalize: Normalize<T>,
  enforce: Enforce<T>,
  services: ReceiptStoreReadServices = {}
): Promise<StableReceiptEntries<T>> {
  const root = await retainRootDirectory(receiptsRoot);
  if (!root) return { entries: [], complete: false };
  try {
    const state: DiscoveryState = { fileCount: 0, entryCount: 0, complete: true };
    const candidates = await discoverCandidates(root, [], state);
    await services.afterReaddir?.({ receiptsRoot });
    if (!await rootIsCurrent(root, [])) return { entries: [], complete: false };
    const entries: StableReceiptEntry<T>[] = [];
    for (const candidate of candidates) {
      const read = await readCandidate(root, candidate, normalize, enforce, services);
      if (!read.current) return { entries: [], complete: false };
      if (read.entry !== null) entries.push(read.entry);
    }
    return { entries: entries.sort((left, right) => compareCodeUnits(left.path, right.path)), complete: state.complete };
  } finally {
    await closeRoot(root);
  }
}

/** Safe discovery only; callers that consume bytes must use one of the stable read functions. */
export async function discoverStableReceiptFiles(
  receiptsRoot: string,
  services: ReceiptStoreReadServices = {}
): Promise<{ files: string[]; complete: boolean }> {
  const root = await retainRootDirectory(receiptsRoot);
  if (!root) return { files: [], complete: false };
  try {
    const state: DiscoveryState = { fileCount: 0, entryCount: 0, complete: true };
    const candidates = await discoverCandidates(root, [], state);
    await services.afterReaddir?.({ receiptsRoot });
    return await rootIsCurrent(root, [])
      ? { files: candidates.map((candidate) => join(root.logicalPath, ...candidate.parts)), complete: state.complete }
      : { files: [], complete: false };
  } finally {
    await closeRoot(root);
  }
}

export async function readStableReceiptEntry<T>(
  receiptsRoot: string,
  receiptPath: string,
  normalize: Normalize<T>,
  enforce: Enforce<T>,
  services: ReceiptStoreReadServices = {}
): Promise<{ insideRoot: boolean; entry: StableReceiptEntry<T> | null }> {
  const parts = relativeReceiptParts(receiptsRoot, receiptPath);
  if (!parts) return { insideRoot: false, entry: null };
  const root = await retainRootDirectory(receiptsRoot);
  if (!root) return { insideRoot: true, entry: null };
  try {
    const read = await readCandidate(root, { parts }, normalize, enforce, services);
    if (!read.current || read.entry === null) return { insideRoot: true, entry: null };
    return { insideRoot: true, entry: read.entry };
  } finally {
    await closeRoot(root);
  }
}

function relativeReceiptParts(receiptsRoot: string, receiptPath: string): string[] | null {
  const root = resolve(receiptsRoot);
  const candidate = resolve(receiptPath);
  const relation = relative(root, candidate);
  if (!relation || isAbsolute(relation) || relation.startsWith("..") || relation.split(/[\\/]/).some((part) => !safePart(part))) return null;
  return relation.split(/[\\/]/);
}

async function discoverCandidates(root: DirectoryCapability, parts: string[], state: DiscoveryState, depth = 0, directories: DirectoryIdentity[] = []): Promise<Candidate[]> {
  if (depth > MAX_DEBUG_JSON_DISCOVERY_DEPTH || state.fileCount >= MAX_DEBUG_JSON_DISCOVERY_FILES || state.entryCount >= MAX_DEBUG_JSON_DISCOVERY_ENTRIES) {
    state.complete = false;
    return [];
  }
  const opened = await openAncestor(root, parts);
  if (!opened) { state.complete = false; return []; }
  try {
    const classifiedDirectories = parts.length === 0 ? directories : [...directories, identityOf(opened.directory)];
    const dirents = (await readdir(opened.directory.capabilityPath, { withFileTypes: true, encoding: "utf8" }))
      .sort((left, right) => compareCodeUnits(left.name, right.name));
    const candidates: Candidate[] = [];
    for (const dirent of dirents) {
      if (state.fileCount >= MAX_DEBUG_JSON_DISCOVERY_FILES || state.entryCount >= MAX_DEBUG_JSON_DISCOVERY_ENTRIES) {
        state.complete = false;
        break;
      }
      state.entryCount += 1;
      if (!safePart(dirent.name)) { state.complete = false; continue; }
      const child = [...parts, dirent.name];
      if (dirent.isDirectory()) candidates.push(...await discoverCandidates(root, child, state, depth + 1, classifiedDirectories));
      else if (dirent.isFile() && dirent.name.endsWith(".json")) { candidates.push({ parts: child, directories: classifiedDirectories }); state.fileCount += 1; }
    }
    return candidates;
  } catch {
    state.complete = false;
    return [];
  } finally {
    await closeOpened(opened.opened);
  }
}

async function readCandidate<T>(
  root: DirectoryCapability,
  candidate: Candidate,
  normalize: Normalize<T>,
  enforce: Enforce<T>,
  services: ReceiptStoreReadServices
): Promise<{ current: boolean; entry: StableReceiptEntry<T> | null }> {
  const { parts } = candidate;
  const name = parts.at(-1);
  if (!name || !safePart(name)) return { current: await rootIsCurrent(root, []), entry: null };
  const parentParts = parts.slice(0, -1);
  const openedParent = await openAncestor(root, parentParts);
  if (!openedParent) return { current: false, entry: null };
  const parent = openedParent.directory;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const logicalPath = join(root.logicalPath, ...parts);
  const capabilityPath = join(parent.capabilityPath, name);
  try {
    if (!await classifiedDirectoriesAreCurrent(root, openedParent.opened, candidate.directories)) return { current: false, entry: null };
    const before = await lstat(capabilityPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_DEBUG_RECEIPT_BYTES) return { current: await classifiedDirectoriesAreCurrent(root, openedParent.opened, candidate.directories), entry: null };
    handle = await open(capabilityPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_DEBUG_RECEIPT_BYTES) return { current: await classifiedDirectoriesAreCurrent(root, openedParent.opened, candidate.directories), entry: null };
    await services.afterLeafOpen?.({ receiptPath: logicalPath });
    const after = await lstat(capabilityPath);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) return { current: await classifiedDirectoriesAreCurrent(root, openedParent.opened, candidate.directories), entry: null };
    const bytes = await readCappedReceiptBytes(handle, opened.size);
    const final = await handle.stat();
    const current = await classifiedDirectoriesAreCurrent(root, openedParent.opened, candidate.directories);
    if (!current || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) return { current, entry: null };
    if (bytes === null) return { current: true, entry: null };
    const content = decodeCanonicalReceiptUtf8(bytes);
    if (content === null) return { current: true, entry: null };
    const parsed: unknown = JSON.parse(content);
    const location: StableReceiptLocation = {
      capabilityPath,
      isCurrent: async () => await openedChainIsCurrent(root, openedParent.opened)
    };
    // The semantic receipt name remains the logical path: paired-delivery markers bind that public
    // name. Filesystem mutation, when an enforcer needs it, stays confined to location.capabilityPath.
    const enforcement = await enforce(logicalPath, normalize(parsed), parsed, { dev: opened.dev, ino: opened.ino }, location);
    if (enforcement.receipt === null) return { current: true, entry: null };
    return {
      current: true,
      entry: {
        path: logicalPath,
        receipt: enforcement.receipt,
        snapshot: {
          sha256: hashBuffer(bytes),
          byteLength: bytes.byteLength,
          identity: { dev: opened.dev, ino: opened.ino },
          postPurge: enforcement.postPurge ?? { state: "not_needed" }
        }
      }
    };
  } catch {
    return { current: await classifiedDirectoriesAreCurrent(root, openedParent.opened, candidate.directories), entry: null };
  } finally {
    if (handle) await handle.close().catch(() => {});
    await closeOpened(openedParent.opened);
  }
}

async function retainDirectory(path: string): Promise<DirectoryCapability | null> {
  if (!hasStableReceiptStoreCapability()) return null;
  try {
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) return null;
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    const after = await lstat(path);
    if (!opened.isDirectory() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) { await handle.close(); return null; }
    const capabilityPath = `/proc/self/fd/${handle.fd}`;
    if (!(await lstat(capabilityPath)).isSymbolicLink()) { await handle.close(); return null; }
    return { logicalPath: resolve(path), capabilityPath, dev: opened.dev, ino: opened.ino, handle };
  } catch { return null; }
}

/** Admit an absolute root from a retained no-follow walk, not a single pathname resolution. */
/** @internal Acquire one no-follow root lineage for a bounded read or write lifecycle. */
export async function retainRootDirectory(path: string): Promise<DirectoryCapability | null> {
  const logicalPath = resolve(path);
  if (!hasStableReceiptStoreCapability()) return null;
  let current: DirectoryCapability | undefined;
  const held: DirectoryCapability[] = [];
  let admitted = false;
  try {
    const initial = await retainDirectory("/");
    if (!initial) return null;
    current = initial;
    held.push(current);
    for (const part of logicalPath.split("/").filter(Boolean)) {
      const next = await retainDirectory(join(current.capabilityPath, part));
      if (!next) return null;
      next.logicalPath = join(current.logicalPath, part);
      held.push(next);
      current = next;
    }
    const after = await lstat(logicalPath);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== current.dev || after.ino !== current.ino) return null;
    admitted = true;
    return { ...current, logicalPath, rootLineage: held };
  } catch {
    return null;
  } finally {
    if (!admitted) await closeOpened(held);
  }
}

async function openAncestor(root: DirectoryCapability, parts: string[]): Promise<OpenedAncestor | null> {
  let current = root;
  const opened: DirectoryCapability[] = [];
  for (const part of parts) {
    if (!safePart(part)) { await closeOpened(opened); return null; }
    const next = await retainDirectory(join(current.capabilityPath, part));
    if (!next) { await closeOpened(opened); return null; }
    next.logicalPath = join(current.logicalPath, part);
    opened.push(next); current = next;
  }
  return { directory: current, opened };
}

async function closeOpened(opened: DirectoryCapability[]): Promise<void> {
  await Promise.all(opened.map(async (directory) => await directory.handle?.close().catch(() => {})));
}

/** @internal Release a retained receipt-root lineage. */
export async function closeRoot(root: DirectoryCapability): Promise<void> {
  await closeOpened(root.rootLineage ?? [root]);
}

/** @internal Re-prove that the retained receipt root still has its configured logical name. */
export async function rootIsCurrent(root: DirectoryCapability, _parentParts: string[]): Promise<boolean> {
  for (const directory of root.rootLineage ?? [root]) if (!await sameDirectory(directory.logicalPath, directory)) return false;
  return true;
}

async function openedChainIsCurrent(root: DirectoryCapability, opened: DirectoryCapability[]): Promise<boolean> {
  if (!await rootIsCurrent(root, [])) return false;
  for (const directory of opened) if (!await sameDirectory(directory.logicalPath, directory)) return false;
  return true;
}

async function classifiedDirectoriesAreCurrent(root: DirectoryCapability, opened: DirectoryCapability[], expected: DirectoryIdentity[] | undefined): Promise<boolean> {
  if (!await openedChainIsCurrent(root, opened)) return false;
  if (!expected) return true;
  return opened.length === expected.length && opened.every((directory, index) => directory.dev === expected[index].dev && directory.ino === expected[index].ino && directory.logicalPath === expected[index].logicalPath);
}

function identityOf(directory: DirectoryCapability): DirectoryIdentity {
  return { logicalPath: directory.logicalPath, dev: directory.dev, ino: directory.ino };
}

async function sameDirectory(path: string, expected: DirectoryCapability): Promise<boolean> {
  try {
    const facts = await lstat(path);
    return facts.isDirectory() && !facts.isSymbolicLink() && facts.dev === expected.dev && facts.ino === expected.ino;
  } catch { return false; }
}

function safePart(value: string): boolean { return value.length > 0 && value !== "." && value !== ".." && value === basename(value); }
