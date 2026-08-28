/** Descriptor-anchored traversal shared by leaf-only and complete-tree inventory modes. */
import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnits } from "./canonical-json";
import { ClosedDirectoryInventoryAmbiguityError, isClosedDirectoryInventoryAmbiguity } from "./closed-directory-inventory-error";
import { CLOSED_DIRECTORY_INVENTORY_LIMITS as LIMITS, type ExactDirectoryInventoryEntry } from "./closed-directory-inventory-input";
import { DerivedOutputPublicationError } from "./derived-output-publication-types";
import type { OutputPathIdentity } from "./output-path-topology";

export type ClosedDirectoryEntryIdentity = Readonly<{ path: string; identity: OutputPathIdentity; nlink: number }>;
export type ClosedDirectoryIdentity = Readonly<{ path: string; identity: OutputPathIdentity }>;
export type ClosedDirectoryTree = { directories: Map<string, ClosedDirectoryTree>; files: Map<string, ExactDirectoryInventoryEntry>; exactEmpty: boolean };
export type ClosedDirectoryFoundLeaf = ClosedDirectoryEntryIdentity & { readonly sha256: string; readonly byteLength: number };
export type ClosedDirectoryPinnedSnapshot = Readonly<{ directories: readonly ClosedDirectoryIdentity[]; leaves: readonly ClosedDirectoryEntryIdentity[] }>;

export async function observeClosedDirectoryInventory(path: string, tree: ClosedDirectoryTree, rootIdentity: OutputPathIdentity, label: string, previous?: ClosedDirectoryPinnedSnapshot): Promise<{ directories: ClosedDirectoryIdentity[]; leaves: ClosedDirectoryFoundLeaf[] }> {
  assertClosedDirectoryInventoryAvailable(path, label);
  const budget = new WorkBudget(label, path);
  const directories: ClosedDirectoryIdentity[] = [];
  const leaves: ClosedDirectoryFoundLeaf[] = [];
  const priorDirectories = new Map(previous?.directories.map((entry) => [entry.path, entry]));
  const priorLeaves = new Map(previous?.leaves.map((entry) => [entry.path, entry]));
  const root = await openDirectory(path, label, budget);
  try {
    const facts = await root.stat();
    assertDirectoryFacts(facts, label, path);
    assertIdentity({ dev: Number(facts.dev), ino: Number(facts.ino) }, rootIdentity, `${label} root`, path);
    await walk(root, "", tree, label, budget, directories, leaves, priorDirectories, priorLeaves);
  } finally {
    await root.close();
  }
  return { directories, leaves };
}

async function walk(directory: FileHandle, relativePath: string, tree: ClosedDirectoryTree, label: string, budget: WorkBudget, directories: ClosedDirectoryIdentity[], leaves: ClosedDirectoryFoundLeaf[], priorDirectories: Map<string, ClosedDirectoryIdentity>, priorLeaves: Map<string, ClosedDirectoryEntryIdentity>): Promise<void> {
  const facts = await directory.stat();
  assertDirectoryFacts(facts, label, capabilityPath(directory));
  const identity = { dev: Number(facts.dev), ino: Number(facts.ino) };
  assertPriorDirectory(priorDirectories.get(relativePath), identity, label, relativePath);
  directories.push({ path: relativePath, identity });
  const expectedNames = [...tree.directories.keys(), ...tree.files.keys()].sort(compareCodeUnits);
  const entries = await listExact(directory, expectedNames, label, relativePath, budget);
  for (const entry of entries) {
    const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (tree.directories.has(entry.name)) {
      const child = await openDirectory(join(capabilityPath(directory), entry.name), `${label} directory`, budget);
      try {
        await assertCurrentDirectoryEntry(directory, entry.name, child, label, childPath);
        await walk(child, childPath, tree.directories.get(entry.name)!, label, budget, directories, leaves, priorDirectories, priorLeaves);
        await assertCurrentDirectoryEntry(directory, entry.name, child, label, childPath);
      } finally {
        await child.close();
      }
      continue;
    }
    const expected = tree.files.get(entry.name);
    if (!expected) failClosedDirectoryInventory(`${label} contains an unexpected entry.`, join(capabilityPath(directory), entry.name));
    leaves.push(await readLeaf(directory, entry.name, childPath, expected, label, budget, priorLeaves.get(childPath)));
  }
  await listExact(directory, expectedNames, label, relativePath, budget);
}

async function readLeaf(parent: FileHandle, name: string, relativePath: string, expected: ExactDirectoryInventoryEntry, label: string, budget: WorkBudget, prior: ClosedDirectoryEntryIdentity | undefined): Promise<ClosedDirectoryFoundLeaf> {
  const path = join(capabilityPath(parent), name);
  let namedAdmission: Awaited<ReturnType<typeof lstat>>;
  try {
    namedAdmission = await lstat(path);
  } catch (error) {
    failClosedDirectoryInventory(`${label} expected entry is missing (${reasonOf(error)}).`, path);
  }
  if (namedAdmission.isSymbolicLink()) {
    ambiguous(`${label} entry topology changed to a symbolic link.`, path);
  }
  let handle: FileHandle;
  try {
    // O_NONBLOCK makes FIFOs and devices safe to admit and immediately refuse by fstat below.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if (isTopologyOpenFailure(error)) ambiguous(`${label} entry topology changed while it was opened (${reasonOf(error)}).`, path);
    failClosedDirectoryInventory(`${label} expected entry could not be opened (${reasonOf(error)}).`, path);
  }
  try {
    budget.charge(1);
    const before = await handle.stat();
    assertSameFacts(before, namedAdmission, `${label} entry`, path);
    assertFileFacts(before, expected, label, path);
    const namedBefore = await namedFacts(path, label);
    assertSameFacts(before, namedBefore, `${label} entry`, path);
    const bytes = await readExactly(handle, before.size, budget, label, path);
    const after = await handle.stat();
    const namedAfter = await lstat(path);
    assertSameFacts(before, after, `${label} entry`, path);
    assertSameFacts(after, namedAfter, `${label} entry`, path);
    assertFileFacts(after, expected, label, path);
    const identity = { dev: Number(after.dev), ino: Number(after.ino) };
    if (prior && (prior.nlink !== after.nlink || prior.identity.dev !== identity.dev || prior.identity.ino !== identity.ino)) ambiguous(`${label} entry changed after its identity was pinned.`, path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expected.sha256) failClosedDirectoryInventory(`${label} entry bytes did not match the admitted inventory.`, path);
    return { path: relativePath, identity, nlink: after.nlink, sha256, byteLength: bytes.byteLength };
  } finally {
    await handle.close();
  }
}

async function listExact(directory: FileHandle, expectedNames: readonly string[], label: string, relativePath: string, budget: WorkBudget): Promise<Dirent[]> {
  let cursor: Awaited<ReturnType<typeof opendir>>;
  try {
    cursor = await opendir(capabilityPath(directory), { bufferSize: 1 });
  } catch (error) {
    ambiguous(`${label} directory could not be enumerated through its retained descriptor (${reasonOf(error)}).`, capabilityPath(directory));
  }
  const entries: Dirent[] = [];
  try {
    for (;;) {
      const entry = await cursor.read();
      if (!entry) break;
      budget.charge(1);
      // Refuse the 2,049th entry before retaining or sorting it.
      if (entries.length >= LIMITS.maxEntries) {
        failClosedDirectoryInventory(`${label} directory exceeds its entry limit.`, relativePath ? `${label}/${relativePath}` : label);
      }
      entries.push(entry);
    }
  } finally {
    await cursor.close();
  }
  const names = entries.map((entry) => entry.name).sort(compareCodeUnits);
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) failClosedDirectoryInventory(`${label} contains an unknown or missing entry.`, relativePath ? `${label}/${relativePath}` : label);
  return entries.sort((left, right) => compareCodeUnits(left.name, right.name));
}

async function openDirectory(path: string, label: string, budget: WorkBudget): Promise<FileHandle> {
  budget.charge(1);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const facts = await handle.stat();
    assertDirectoryFacts(facts, label, path);
    return handle;
  } catch (error) {
    if (isTopologyOpenFailure(error)) ambiguous(`${label} topology changed while a directory was opened (${reasonOf(error)}).`, path);
    failClosedDirectoryInventory(`${label} must be a retained non-symlink directory (${reasonOf(error)}).`, path);
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
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) failClosedDirectoryInventory(`${label} entry changed while it was read.`, path);
  return bytes.subarray(0, offset);
}

/** Refuse before staging when a caller declares that its final commit needs exact closed-tree proof. */
export function assertClosedDirectoryInventoryAvailable(path: string, label: string): void {
  if (process.platform !== "linux" || !Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)) {
    failClosedDirectoryInventory(`${label} closed-tree publication requires a Linux descriptor-relative primitive; non-Linux hosts need a separately implemented native descriptor/ACL proof and are refused.`, path);
  }
}

function capabilityPath(handle: FileHandle): string { return `/proc/self/fd/${handle.fd}`; }
function assertDirectoryFacts(facts: Awaited<ReturnType<FileHandle["stat"]>>, label: string, path: string): void { if (!facts.isDirectory() || facts.isSymbolicLink()) failClosedDirectoryInventory(`${label} contains a symbolic link or non-directory.`, path); }
function assertFileFacts(facts: Awaited<ReturnType<FileHandle["stat"]>>, expected: ExactDirectoryInventoryEntry, label: string, path: string): void { if (facts.size !== expected.byteLength) failClosedDirectoryInventory(`${label} entry is not the expected single-link regular file.`, path); assertRegularSingleLinkFacts(facts, label, path); }
function assertRegularSingleLinkFacts(facts: Awaited<ReturnType<FileHandle["stat"]>>, label: string, path: string): void { if (!facts.isFile() || facts.isSymbolicLink() || facts.nlink !== 1 || facts.size > LIMITS.maxFileBytes) failClosedDirectoryInventory(`${label} entry is not the expected single-link regular file.`, path); }
function assertSameFacts(left: Awaited<ReturnType<FileHandle["stat"]>>, right: Awaited<ReturnType<FileHandle["stat"]>>, label: string, path: string): void { if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size || left.nlink !== right.nlink || left.mtimeMs !== right.mtimeMs || left.ctimeMs !== right.ctimeMs || right.isSymbolicLink()) ambiguous(`${label} changed while it was verified.`, path); }
function assertIdentity(actual: OutputPathIdentity, expected: OutputPathIdentity, label: string, path: string): void { if (actual.dev !== expected.dev || actual.ino !== expected.ino) ambiguous(`${label} changed after Motion captured its identity.`, path); }
function assertPriorDirectory(prior: ClosedDirectoryIdentity | undefined, actual: OutputPathIdentity, label: string, path: string): void { if (prior) assertIdentity(actual, prior.identity, `${label} directory`, path); }
export function failClosedDirectoryInventory(message: string, path: string): never { throw new DerivedOutputPublicationError("derived_output_stage_invalid", message, path); }
function ambiguous(message: string, path: string): never { throw new ClosedDirectoryInventoryAmbiguityError(message, path); }
function reasonOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isTopologyOpenFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && ["ELOOP", "ESTALE", "ENOTDIR"].includes(String((error as { code?: unknown }).code));
}

async function namedFacts(path: string, label: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    const facts = await lstat(path);
    if (facts.isSymbolicLink()) ambiguous(`${label} entry topology changed to a symbolic link.`, path);
    return facts;
  } catch (error) {
    if (isClosedDirectoryInventoryAmbiguity(error)) throw error;
    ambiguous(`${label} entry topology changed while it was verified (${reasonOf(error)}).`, path);
  }
}

class WorkBudget {
  #used = 0;
  constructor(private readonly label: string, private readonly path: string) {}
  charge(units: number): void { this.#used += units; if (!Number.isSafeInteger(this.#used) || this.#used > LIMITS.maxWorkUnits) failClosedDirectoryInventory(`${this.label} closed-tree verification exceeds its work limit.`, this.path); }
}
