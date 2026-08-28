/** Opt-in complete-tree inventory construction and evidence, including explicit empty directories. */
import { createHash } from "node:crypto";
import { isEmptyDirectoryInventoryEntry, CLOSED_DIRECTORY_INVENTORY_LIMITS as LIMITS, type CompleteDirectoryInventoryEntry, type ExactDirectoryInventoryEntry } from "./closed-directory-inventory-input";
import { DerivedOutputPublicationError } from "./derived-output-publication-types";

export type CompleteDirectoryInventoryTree = { directories: Map<string, CompleteDirectoryInventoryTree>; files: Map<string, ExactDirectoryInventoryEntry>; exactEmpty: boolean };

export function completeExpectedDirectoryInventoryTree(entries: readonly CompleteDirectoryInventoryEntry[], path: string, label: string): CompleteDirectoryInventoryTree {
  const root = emptyCompleteDirectoryInventoryTree();
  let entryCount = 0;
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let current = root;
    for (const part of parts.slice(0, -1)) {
      if (current.exactEmpty || current.files.has(part)) {
        failCompleteDirectoryInventory(`${label} expected complete-tree inventory has an empty-directory marker with descendants.`, path);
      }
      let next = current.directories.get(part);
      if (!next) {
        if (entryCount >= LIMITS.maxEntries) failCompleteDirectoryInventory(`${label} expected complete-tree inventory exceeds its entry limit.`, path);
        entryCount += 1;
        next = emptyCompleteDirectoryInventoryTree();
        current.directories.set(part, next);
      }
      current = next;
    }
    const leaf = parts.at(-1)!;
    if (current.exactEmpty) {
      failCompleteDirectoryInventory(`${label} expected complete-tree inventory has an empty-directory marker with descendants.`, path);
    }
    if (current.files.has(leaf)) {
      failCompleteDirectoryInventory(`${label} expected complete-tree inventory has a duplicate or overlapping entry.`, path);
    }
    if (isEmptyDirectoryInventoryEntry(entry)) {
      const directory = current.directories.get(leaf);
      if (directory) {
        if (directory.exactEmpty || directory.files.size > 0 || directory.directories.size > 0) {
          failCompleteDirectoryInventory(`${label} expected complete-tree inventory has an empty-directory marker with descendants.`, path);
        }
        directory.exactEmpty = true;
        continue;
      }
      if (entryCount >= LIMITS.maxEntries) failCompleteDirectoryInventory(`${label} expected complete-tree inventory exceeds its entry limit.`, path);
      entryCount += 1;
      const empty = emptyCompleteDirectoryInventoryTree();
      empty.exactEmpty = true;
      current.directories.set(leaf, empty);
      continue;
    }
    if (current.directories.has(leaf)) failCompleteDirectoryInventory(`${label} expected complete-tree inventory overlaps a directory and file.`, path);
    if (entryCount >= LIMITS.maxEntries) failCompleteDirectoryInventory(`${label} expected complete-tree inventory exceeds its entry limit.`, path);
    entryCount += 1;
    current.files.set(leaf, entry);
  }
  return root;
}

export function completeDirectoryInventoryEvidence(expected: readonly CompleteDirectoryInventoryEntry[], directories: readonly { path: string }[], leaves: readonly { path: string; sha256: string; byteLength: number }[]): Readonly<{ sha256: string; entryCount: number; leafCount: number; entries: readonly string[]; inventory: readonly CompleteDirectoryInventoryEntry[] }> {
  const foundLeaves = new Map(leaves.map((leaf) => [leaf.path, leaf]));
  const foundDirectories = new Set(directories.map((directory) => directory.path));
  const digest = createHash("sha256");
  let leafCount = 0;
  for (const entry of expected) {
    if (isEmptyDirectoryInventoryEntry(entry)) {
      if (!foundDirectories.has(entry.path)) failCompleteDirectoryInventory("Closed complete-tree inventory changed while it was verified.", entry.path);
      digest.update(`${entry.path}\u0000empty-directory\n`);
      continue;
    }
    const leaf = foundLeaves.get(entry.path);
    if (!leaf || leaf.byteLength !== entry.byteLength || leaf.sha256 !== entry.sha256) failCompleteDirectoryInventory("Closed complete-tree inventory changed while it was verified.", entry.path);
    // Keep legacy file digest rows byte-for-byte identical in the opt-in complete-tree mode.
    digest.update(`${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`);
    leafCount += 1;
  }
  const inventory = Object.freeze(expected.map((entry) => Object.freeze({ ...entry })));
  return Object.freeze({ sha256: digest.digest("hex"), entryCount: expected.length, leafCount, entries: Object.freeze(expected.map((entry) => entry.path)), inventory });
}

function emptyCompleteDirectoryInventoryTree(): CompleteDirectoryInventoryTree { return { directories: new Map(), files: new Map(), exactEmpty: false }; }
function failCompleteDirectoryInventory(message: string, path: string): never { throw new DerivedOutputPublicationError("derived_output_stage_invalid", message, path); }
