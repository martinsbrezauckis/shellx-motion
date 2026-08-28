/** Descriptor-relative discovery for internal complete-stage inventory pinning. */
import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnits } from "./canonical-json";
import { ClosedDirectoryInventoryAmbiguityError } from "./closed-directory-inventory-error";
import {
  CLOSED_DIRECTORY_INVENTORY_LIMITS as LIMITS,
  type CompleteDirectoryInventoryEntry,
  type EmptyDirectoryInventoryEntry,
  type ExactDirectoryInventoryEntry
} from "./closed-directory-inventory-input";
import { DerivedOutputPublicationError } from "./derived-output-publication-types";
import type { OutputPathIdentity } from "./output-path-topology";

type FoundLeaf = { path: string; sha256: string; byteLength: number };
type FoundEmptyDirectory = EmptyDirectoryInventoryEntry;

/** Discover every admitted leaf through retained directory descriptors, with no caller inventory. */
export async function discoverCompleteDirectoryInventory(path: string, rootIdentity: OutputPathIdentity, label: string): Promise<ExactDirectoryInventoryEntry[]> {
  assertDescriptorTraversalAvailable(path, label);
  const budget = new WorkBudget(label, path);
  const entryBudget = new EntryBudget(label, path);
  const leaves: FoundLeaf[] = [];
  const root = await openDirectory(path, label, budget);
  try {
    const facts = await root.stat();
    assertDirectoryFacts(facts, label, path);
    assertIdentity({ dev: Number(facts.dev), ino: Number(facts.ino) }, rootIdentity, `${label} root`, path);
    await walkComplete(root, "", label, budget, entryBudget, leaves);
  } finally {
    await root.close();
  }
  return leaves
    .map((leaf) => Object.freeze({ path: leaf.path, sha256: leaf.sha256, byteLength: leaf.byteLength }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
}

/**
 * Discover a complete tree through retained descriptors, preserving empty nested directories as
 * explicit markers.  This is intentionally separate from the legacy leaf-only discovery route.
 */
export async function discoverCompleteDirectoryInventoryWithEmptyDirectories(path: string, rootIdentity: OutputPathIdentity, label: string): Promise<CompleteDirectoryInventoryEntry[]> {
  assertDescriptorTraversalAvailable(path, label);
  const budget = new WorkBudget(label, path);
  const entryBudget = new EntryBudget(label, path);
  const leaves: FoundLeaf[] = [];
  const emptyDirectories: FoundEmptyDirectory[] = [];
  const root = await openDirectory(path, label, budget);
  try {
    const facts = await root.stat();
    assertDirectoryFacts(facts, label, path);
    assertIdentity({ dev: Number(facts.dev), ino: Number(facts.ino) }, rootIdentity, `${label} root`, path);
    await walkCompleteWithEmptyDirectories(root, "", label, budget, entryBudget, leaves, emptyDirectories);
  } finally {
    await root.close();
  }
  return [...leaves, ...emptyDirectories]
    .map((entry) => Object.freeze({ ...entry }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
}

async function walkComplete(directory: FileHandle, relativePath: string, label: string, budget: WorkBudget, entryBudget: EntryBudget, leaves: FoundLeaf[]): Promise<void> {
  const facts = await directory.stat();
  assertDirectoryFacts(facts, label, capabilityPath(directory));
  const entries = await listAll(directory, label, relativePath, budget);
  if (relativePath && entries.length === 0) {
    fail(`${label} contains an empty directory, which the closed leaf inventory does not admit.`, relativePath);
  }
  for (const entry of entries) {
    const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (childPath.split("/").length > LIMITS.maxDepth || childPath.length > 4_096) {
      fail(`${label} closed-tree verification exceeds its bounded path limit.`, childPath);
    }
    entryBudget.charge();
    const child = join(capabilityPath(directory), entry.name);
    const named = await namedFacts(child, label);
    if (named.isDirectory()) {
      const childDirectory = await openDirectory(child, `${label} directory`, budget);
      try {
        await assertCurrentDirectoryEntry(directory, entry.name, childDirectory, label, childPath);
        await walkComplete(childDirectory, childPath, label, budget, entryBudget, leaves);
        await assertCurrentDirectoryEntry(directory, entry.name, childDirectory, label, childPath);
      } finally {
        await childDirectory.close();
      }
      continue;
    }
    if (leaves.length >= LIMITS.maxFiles) fail(`${label} closed-tree verification exceeds its file limit.`, child);
    leaves.push(await readCompleteLeaf(directory, entry.name, childPath, label, budget, entryBudget));
  }
  await assertExactNames(directory, entries.map((entry) => entry.name), label, relativePath, budget);
}

async function walkCompleteWithEmptyDirectories(directory: FileHandle, relativePath: string, label: string, budget: WorkBudget, entryBudget: EntryBudget, leaves: FoundLeaf[], emptyDirectories: FoundEmptyDirectory[]): Promise<void> {
  const facts = await directory.stat();
  assertDirectoryFacts(facts, label, capabilityPath(directory));
  const entries = await listAll(directory, label, relativePath, budget);
  if (relativePath && entries.length === 0) {
    await assertExactNames(directory, [], label, relativePath, budget);
    emptyDirectories.push({ path: relativePath, kind: "empty-directory" });
    return;
  }
  for (const entry of entries) {
    const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (childPath.split("/").length > LIMITS.maxDepth || childPath.length > 4_096) {
      fail(`${label} closed-tree verification exceeds its bounded path limit.`, childPath);
    }
    entryBudget.charge();
    const child = join(capabilityPath(directory), entry.name);
    const named = await namedFacts(child, label);
    if (named.isDirectory()) {
      const childDirectory = await openDirectory(child, `${label} directory`, budget);
      try {
        await assertCurrentDirectoryEntry(directory, entry.name, childDirectory, label, childPath);
        await walkCompleteWithEmptyDirectories(childDirectory, childPath, label, budget, entryBudget, leaves, emptyDirectories);
        await assertCurrentDirectoryEntry(directory, entry.name, childDirectory, label, childPath);
      } finally {
        await childDirectory.close();
      }
      continue;
    }
    if (leaves.length >= LIMITS.maxFiles) fail(`${label} closed-tree verification exceeds its file limit.`, child);
    leaves.push(await readCompleteLeaf(directory, entry.name, childPath, label, budget, entryBudget));
  }
  await assertExactNames(directory, entries.map((entry) => entry.name), label, relativePath, budget);
}

async function readCompleteLeaf(parent: FileHandle, name: string, relativePath: string, label: string, budget: WorkBudget, entryBudget: EntryBudget): Promise<FoundLeaf> {
  const path = join(capabilityPath(parent), name);
  const namedAdmission = await namedFacts(path, label);
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) {
    if (isTopologyOpenFailure(error)) ambiguous(`${label} entry topology changed while it was opened (${reasonOf(error)}).`, path);
    fail(`${label} entry could not be opened (${reasonOf(error)}).`, path);
  }
  try {
    budget.charge(1);
    const before = await handle.stat();
    assertSameFacts(before, namedAdmission, `${label} entry`, path);
    assertRegularSingleLinkFacts(before, label, path);
    entryBudget.chargeBytes(before.size);
    assertSameFacts(before, await namedFacts(path, label), `${label} entry`, path);
    const bytes = await readExactly(handle, before.size, budget, label, path);
    const after = await handle.stat();
    assertSameFacts(before, after, `${label} entry`, path);
    assertSameFacts(after, await namedFacts(path, label), `${label} entry`, path);
    assertRegularSingleLinkFacts(after, label, path);
    return { path: relativePath, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength };
  } finally { await handle.close(); }
}

async function listAll(directory: FileHandle, label: string, relativePath: string, budget: WorkBudget): Promise<Dirent[]> {
  let cursor: Awaited<ReturnType<typeof opendir>>;
  try { cursor = await opendir(capabilityPath(directory), { bufferSize: 1 }); }
  catch (error) { ambiguous(`${label} directory could not be enumerated through its retained descriptor (${reasonOf(error)}).`, capabilityPath(directory)); }
  const entries: Dirent[] = [];
  try {
    for (;;) {
      const entry = await cursor.read();
      if (!entry) break;
      budget.charge(1);
      if (entries.length >= LIMITS.maxEntries) fail(`${label} directory exceeds its entry limit.`, relativePath ? `${label}/${relativePath}` : label);
      entries.push(entry);
    }
  } finally { await cursor.close(); }
  return entries.sort((left, right) => compareCodeUnits(left.name, right.name));
}

async function assertExactNames(directory: FileHandle, expectedNames: readonly string[], label: string, relativePath: string, budget: WorkBudget): Promise<void> {
  const actual = await listAll(directory, label, relativePath, budget);
  const names = actual.map((entry) => entry.name);
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) fail(`${label} contains an unknown or missing entry.`, relativePath || label);
}

async function openDirectory(path: string, label: string, budget: WorkBudget): Promise<FileHandle> {
  budget.charge(1);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    assertDirectoryFacts(await handle.stat(), label, path);
    return handle;
  } catch (error) {
    if (isTopologyOpenFailure(error)) ambiguous(`${label} topology changed while a directory was opened (${reasonOf(error)}).`, path);
    fail(`${label} must be a retained non-symlink directory (${reasonOf(error)}).`, path);
  }
}

async function assertCurrentDirectoryEntry(parent: FileHandle, name: string, child: FileHandle, label: string, relativePath: string): Promise<void> {
  const named = await namedFacts(join(capabilityPath(parent), name), label);
  const opened = await child.stat();
  assertDirectoryFacts(named, label, relativePath);
  assertSameFacts(opened, named, `${label} directory`, relativePath);
}

async function readExactly(handle: FileHandle, size: number, budget: WorkBudget, label: string, path: string): Promise<Buffer> {
  budget.charge(Math.max(1, Math.ceil(size / 65_536)));
  const bytes = Buffer.allocUnsafe(size + 1);
  let offset = 0;
  while (offset < bytes.byteLength) { const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset); if (bytesRead === 0) break; offset += bytesRead; }
  if (offset !== size) fail(`${label} entry changed while it was read.`, path);
  return bytes.subarray(0, offset);
}

function assertDescriptorTraversalAvailable(path: string, label: string): void { if (process.platform !== "linux" || !Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)) fail(`${label} closed-tree publication requires a Linux descriptor-relative primitive; non-Linux hosts need a separately implemented native descriptor/ACL proof and are refused.`, path); }
function capabilityPath(handle: FileHandle): string { return `/proc/self/fd/${handle.fd}`; }
function assertDirectoryFacts(facts: Awaited<ReturnType<FileHandle["stat"]>>, label: string, path: string): void { if (!facts.isDirectory() || facts.isSymbolicLink()) fail(`${label} contains a symbolic link or non-directory.`, path); }
function assertRegularSingleLinkFacts(facts: Awaited<ReturnType<FileHandle["stat"]>>, label: string, path: string): void { if (!facts.isFile() || facts.isSymbolicLink() || facts.nlink !== 1 || facts.size > LIMITS.maxFileBytes) fail(`${label} entry is not the expected single-link regular file.`, path); }
function assertSameFacts(left: Awaited<ReturnType<FileHandle["stat"]>>, right: Awaited<ReturnType<FileHandle["stat"]>>, label: string, path: string): void { if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size || left.nlink !== right.nlink || left.mtimeMs !== right.mtimeMs || left.ctimeMs !== right.ctimeMs || right.isSymbolicLink()) ambiguous(`${label} changed while it was verified.`, path); }
function assertIdentity(actual: OutputPathIdentity, expected: OutputPathIdentity, label: string, path: string): void { if (actual.dev !== expected.dev || actual.ino !== expected.ino) ambiguous(`${label} changed after Motion captured its identity.`, path); }
function fail(message: string, path: string): never { throw new DerivedOutputPublicationError("derived_output_stage_invalid", message, path); }
function ambiguous(message: string, path: string): never { throw new ClosedDirectoryInventoryAmbiguityError(message, path); }
function reasonOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isTopologyOpenFailure(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && ["ELOOP", "ESTALE", "ENOTDIR"].includes(String((error as { code?: unknown }).code)); }
async function namedFacts(path: string, label: string): Promise<Awaited<ReturnType<typeof lstat>>> { try { const facts = await lstat(path); if (facts.isSymbolicLink()) ambiguous(`${label} entry topology changed to a symbolic link.`, path); return facts; } catch (error) { if (error instanceof DerivedOutputPublicationError) throw error; ambiguous(`${label} entry topology changed while it was verified (${reasonOf(error)}).`, path); } }
class WorkBudget { #used = 0; constructor(private readonly label: string, private readonly path: string) {} charge(units: number): void { this.#used += units; if (!Number.isSafeInteger(this.#used) || this.#used > LIMITS.maxWorkUnits) fail(`${this.label} closed-tree verification exceeds its work limit.`, this.path); } }
class EntryBudget {
  #used = 0;
  #bytes = 0;
  constructor(private readonly label: string, private readonly path: string) {}
  charge(): void {
    this.#used += 1;
    if (this.#used > LIMITS.maxEntries) fail(`${this.label} closed-tree verification exceeds its entry limit.`, this.path);
  }
  chargeBytes(bytes: number): void {
    this.#bytes += bytes;
    if (!Number.isSafeInteger(this.#bytes) || this.#bytes > LIMITS.maxAggregateBytes) {
      fail(`${this.label} closed-tree verification exceeds its aggregate-byte limit.`, this.path);
    }
  }
}
