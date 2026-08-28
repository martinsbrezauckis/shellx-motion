/**
 * Closed-tree verification for private derived-output stages.
 *
 * Node cannot expose openat(2) directly. On Linux, `/proc/self/fd/<directory-fd>` gives the
 * equivalent descriptor-relative route, so every nested open remains anchored to a retained
 * directory identity. Other platforms deliberately refuse this exact-tree contract until they
 * have an equivalent descriptor/DACL primitive; they must not fall back to pathname traversal.
 */
import { createHash } from "node:crypto";
import { compareCodeUnits } from "./canonical-json";
import { completeDirectoryInventoryEvidence, completeExpectedDirectoryInventoryTree } from "./closed-directory-inventory-complete";
import {
  discoverCompleteDirectoryInventory,
  discoverCompleteDirectoryInventoryWithEmptyDirectories
} from "./closed-directory-inventory-discovery";
import {
  CLOSED_DIRECTORY_INVENTORY_LIMITS as LIMITS,
  normalizeCompleteDirectoryInventory,
  normalizeExpectedDirectoryInventory,
  type CompleteDirectoryInventoryEntry,
  type ExactDirectoryInventoryEntry
} from "./closed-directory-inventory-input";
import {
  failClosedDirectoryInventory as fail,
  observeClosedDirectoryInventory,
  type ClosedDirectoryEntryIdentity as EntryIdentity,
  type ClosedDirectoryFoundLeaf as FoundLeaf,
  type ClosedDirectoryIdentity as DirectoryIdentity,
  type ClosedDirectoryTree as Tree
} from "./closed-directory-inventory-observe";
import type { OutputPathIdentity } from "./output-path-topology";

export type {
  CompleteDirectoryInventoryEntry,
  EmptyDirectoryInventoryEntry,
  ExactDirectoryInventoryEntry
} from "./closed-directory-inventory-input";
export type ExactDirectoryInventoryEvidence = Readonly<{ sha256: string; entryCount: number; entries: readonly string[]; inventory: readonly ExactDirectoryInventoryEntry[] }>;
export type CompleteDirectoryInventoryEvidence = Readonly<{ sha256: string; entryCount: number; leafCount: number; entries: readonly string[]; inventory: readonly CompleteDirectoryInventoryEntry[] }>;

/** Private identity snapshot retained across the stage-to-public rename. */
export interface ExactDirectoryInventorySnapshot {
  readonly evidence: ExactDirectoryInventoryEvidence;
  readonly directories: readonly DirectoryIdentity[];
  readonly leaves: readonly EntryIdentity[];
}

/** Private identity snapshot for the opt-in complete-tree mode with explicit empty directories. */
export interface CompleteDirectoryInventorySnapshot {
  readonly evidence: CompleteDirectoryInventoryEvidence;
  readonly directories: readonly DirectoryIdentity[];
  readonly leaves: readonly EntryIdentity[];
}

export { ClosedDirectoryInventoryAmbiguityError, isClosedDirectoryInventoryAmbiguity } from "./closed-directory-inventory-error";

/** Open, hash, and identity-pin a complete expected tree through retained directory descriptors. */
export async function captureExactDirectoryInventoryAt(path: string, expectedEntries: unknown, rootIdentity: OutputPathIdentity, label: string): Promise<ExactDirectoryInventorySnapshot> {
  const expected = normalizeExpectedDirectoryInventory(expectedEntries, path, label);
  const tree = expectedTree(expected, path, label);
  const observed = await observeClosedDirectoryInventory(path, tree, rootIdentity, label);
  const evidence = evidenceFor(expected, observed.leaves);
  return Object.freeze({
    evidence,
    directories: Object.freeze(observed.directories.map((entry) => Object.freeze(entry))),
    leaves: Object.freeze(observed.leaves.map(({ path: leafPath, identity, nlink }) => Object.freeze({ path: leafPath, identity: Object.freeze({ ...identity }), nlink })))
  });
}

/**
 * Discover and pin the complete staged tree through retained directory descriptors.
 *
 * This intentionally does not accept a caller-owned inventory.  It is for internal COW flows
 * whose final artifact set is the complete tree already present in a private stage.  Discovery
 * is immediately followed by the normal exact-inventory capture, so it retains the same
 * no-follow, sorted, bounded leaf identity as a caller-supplied inventory.
 */
export async function captureCompleteExactDirectoryInventoryAt(path: string, rootIdentity: OutputPathIdentity, label: string): Promise<ExactDirectoryInventorySnapshot> {
  return await captureExactDirectoryInventoryAt(path, await discoverCompleteDirectoryInventory(path, rootIdentity, label), rootIdentity, label);
}

/**
 * Opt-in complete-tree capture retaining explicit empty-directory markers.  It does not change
 * the legacy leaf-only API, its no-empty refusal, or its file digest format.
 */
export async function captureCompleteExactDirectoryInventoryWithEmptyDirectoriesAt(path: string, rootIdentity: OutputPathIdentity, label: string): Promise<CompleteDirectoryInventorySnapshot> {
  const expected = normalizeCompleteDirectoryInventory(await discoverCompleteDirectoryInventoryWithEmptyDirectories(path, rootIdentity, label), path, label);
  const tree = completeExpectedDirectoryInventoryTree(expected, path, label);
  const observed = await observeClosedDirectoryInventory(path, tree, rootIdentity, label);
  const evidence = completeDirectoryInventoryEvidence(expected, observed.directories, observed.leaves);
  return Object.freeze({
    evidence,
    directories: Object.freeze(observed.directories.map((entry) => Object.freeze({ path: entry.path, identity: Object.freeze({ ...entry.identity }) }))),
    leaves: Object.freeze(observed.leaves.map(({ path: leafPath, identity, nlink }) => Object.freeze({ path: leafPath, identity: Object.freeze({ ...identity }), nlink })))
  });
}

/** Re-open the final tree and prove every directory and leaf is the one pinned before rename. */
export async function assertExactDirectoryInventoryAt(path: string, expectedEntries: unknown, rootIdentity: OutputPathIdentity, snapshot: ExactDirectoryInventorySnapshot, label: string): Promise<ExactDirectoryInventoryEvidence> {
  const expected = normalizeExpectedDirectoryInventory(expectedEntries, path, label);
  const tree = expectedTree(expected, path, label);
  const observed = await observeClosedDirectoryInventory(path, tree, rootIdentity, label, snapshot);
  const evidence = evidenceFor(expected, observed.leaves);
  if (evidence.sha256 !== snapshot.evidence.sha256 || evidence.entryCount !== snapshot.evidence.entryCount) {
    fail(`${label} changed after its closed inventory was pinned.`, path);
  }
  return evidence;
}

/** Re-open the opt-in complete tree, retaining every pinned directory identity and emptiness. */
export async function assertCompleteExactDirectoryInventoryWithEmptyDirectoriesAt(path: string, expectedEntries: unknown, rootIdentity: OutputPathIdentity, snapshot: CompleteDirectoryInventorySnapshot, label: string): Promise<CompleteDirectoryInventoryEvidence> {
  const expected = normalizeCompleteDirectoryInventory(expectedEntries, path, label);
  const tree = completeExpectedDirectoryInventoryTree(expected, path, label);
  const observed = await observeClosedDirectoryInventory(path, tree, rootIdentity, label, snapshot);
  const evidence = completeDirectoryInventoryEvidence(expected, observed.directories, observed.leaves);
  if (evidence.sha256 !== snapshot.evidence.sha256 || evidence.entryCount !== snapshot.evidence.entryCount || evidence.leafCount !== snapshot.evidence.leafCount) {
    fail(`${label} changed after its closed complete-tree inventory was pinned.`, path);
  }
  return evidence;
}

function expectedTree(entries: readonly ExactDirectoryInventoryEntry[], path: string, label: string): Tree {
  const root = emptyTree();
  let entryCount = 0;
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      if (current.files.has(part)) fail(`${label} expected inventory overlaps a file and directory.`, path);
      let next = current.directories.get(part);
      if (!next) {
        if (entryCount >= LIMITS.maxEntries) fail(`${label} expected inventory exceeds its entry limit.`, path);
        entryCount += 1;
        next = emptyTree();
        current.directories.set(part, next);
      }
      current = next;
    }
    const leaf = parts.at(-1)!;
    if (current.directories.has(leaf) || current.files.has(leaf)) fail(`${label} expected inventory has a duplicate or overlapping leaf.`, path);
    if (entryCount >= LIMITS.maxEntries) fail(`${label} expected inventory exceeds its entry limit.`, path);
    entryCount += 1;
    current.files.set(leaf, entry);
  }
  return root;
}

function evidenceFor(expected: readonly ExactDirectoryInventoryEntry[], leaves: readonly FoundLeaf[]): ExactDirectoryInventoryEvidence {
  const found = new Map(leaves.map((leaf) => [leaf.path, leaf]));
  const digest = createHash("sha256");
  for (const entry of expected) {
    const leaf = found.get(entry.path);
    if (!leaf || leaf.byteLength !== entry.byteLength || leaf.sha256 !== entry.sha256) fail("Closed directory inventory changed while it was verified.", entry.path);
    digest.update(`${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`);
  }
  const inventory = Object.freeze(expected.map((entry) => Object.freeze({ ...entry })));
  return Object.freeze({ sha256: digest.digest("hex"), entryCount: expected.length, entries: Object.freeze(expected.map((entry) => entry.path)), inventory });
}

function emptyTree(): Tree { return { directories: new Map(), files: new Map(), exactEmpty: false }; }
