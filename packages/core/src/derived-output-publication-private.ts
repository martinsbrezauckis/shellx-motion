/** Private identity-bound stage mechanics for derived final-output publication. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, mkdtemp, open, readdir, rmdir, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  assertExactDirectoryInventoryAt,
  assertCompleteExactDirectoryInventoryWithEmptyDirectoriesAt,
  captureCompleteExactDirectoryInventoryAt,
  captureCompleteExactDirectoryInventoryWithEmptyDirectoriesAt,
  captureExactDirectoryInventoryAt,
  type CompleteDirectoryInventoryEntry,
  type CompleteDirectoryInventorySnapshot,
  type ExactDirectoryInventoryEntry,
  type ExactDirectoryInventorySnapshot
} from "./closed-directory-inventory";
import {
  assertOutputDirectoryIdentity,
  captureOutputDirectoryIdentity,
  type OutputPathIdentity,
  type OutputPathTopology
} from "./output-path-topology";
import { DerivedOutputPublicationError, type DerivedDirectoryPublicationEvidence } from "./derived-output-publication-types";

export type PrivateFileAnchor = { path: string; identity: OutputPathIdentity };
export type {
  CompleteDirectoryInventoryEntry,
  CompleteDirectoryInventorySnapshot,
  ExactDirectoryInventoryEntry,
  ExactDirectoryInventorySnapshot
} from "./closed-directory-inventory";
export { isClosedDirectoryInventoryAmbiguity } from "./closed-directory-inventory";

export async function createPrivateFileStage(root: string, fingerprint: string, extension: string, maximumBytes?: number): Promise<{ path: string; identity: OutputPathIdentity }> {
  const safeExtension = /^\.[a-z0-9]{1,16}$/i.test(extension) ? extension : ".stage";
  const path = join(root, `.shellx-motion-final-${fingerprint}-${randomUUID()}${safeExtension}`);
  let identity: OutputPathIdentity | undefined;
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      const facts = await handle.stat();
      if (!facts.isFile() || facts.isSymbolicLink()) throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output staging file is not regular.", path);
      identity = { dev: Number(facts.dev), ino: Number(facts.ino) };
    } finally { await handle.close(); }
    const facts = await stableRegularFile(path, "Final output staging file", identity, maximumBytes);
    return { path, identity: { dev: facts.dev, ino: facts.ino } };
  } catch (error) {
    if (identity) await removeExactPrivateFile(path, "Final output staging rollback", identity).catch(() => undefined);
    throw error;
  }
}

export async function createPrivateDirectoryStage(root: string, fingerprint: string): Promise<{ path: string; identity: OutputPathIdentity }> {
  const path = await mkdtemp(join(root, `.shellx-motion-final-${fingerprint}-`));
  return { path, identity: await capturePrivateDirectoryIdentity(path, "Final image-sequence staging") };
}

export async function createPrivateFileAnchor(
  lockPath: string,
  name: string,
  targetPath: string,
  expectedIdentity: OutputPathIdentity,
  maximumBytes?: number
): Promise<PrivateFileAnchor> {
  const path = join(lockPath, name);
  let linked = false;
  try {
    const target = await stableRegularFile(targetPath, "Final output identity source", expectedIdentity, maximumBytes);
    await link(targetPath, path);
    linked = true;
    const anchor = await stableRegularFile(path, "Final output private identity anchor", expectedIdentity, maximumBytes);
    if (anchor.dev !== target.dev || anchor.ino !== target.ino) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output identity anchor did not bind the expected file.", path);
    }
    return { path, identity: { dev: anchor.dev, ino: anchor.ino } };
  } catch (error) {
    if (linked) await removeExactPrivateFile(path, "Final output anchor rollback", expectedIdentity).catch(() => undefined);
    throw error;
  }
}

export async function stableRegularFile(path: string, label: string, expected?: OutputPathIdentity, maximumBytes = Number.MAX_SAFE_INTEGER): Promise<OutputPathIdentity & { size: number; mtimeMs: number; ctimeMs: number; nlink: number; sha256: string }> {
  const before = await lstat(path);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || !before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size > maximumBytes) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} must be a regular non-symlink file.`, path);
  }
  if (expected && (Number(before.dev) !== expected.dev || Number(before.ino) !== expected.ino)) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} changed after Motion captured its identity.`, path);
  }
  // Do not stream to EOF: a hostile writer can grow a pathname after admission.  This reads
  // exactly the descriptor-admitted length and rejects any identity or timestamp movement.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let sha256: string;
  try {
    const opened = await handle.stat();
    if (!sameRegularFacts(before, opened)) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} changed before Motion opened its bounded descriptor.`, path);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, before.size)));
    let offset = 0;
    while (offset < before.size) {
      const wanted = Math.min(buffer.length, before.size - offset);
      const read = await handle.read(buffer, 0, wanted, offset);
      if (read.bytesRead !== wanted) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} shortened while Motion verified its bounded bytes.`, path);
      digest.update(buffer.subarray(0, wanted));
      offset += wanted;
    }
    const afterDescriptor = await handle.stat();
    if (!sameRegularFacts(before, afterDescriptor)) throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} changed while Motion verified its bounded bytes.`, path);
    sha256 = digest.digest("hex");
  } finally { await handle.close(); }
  const after = await lstat(path);
  if (!sameRegularFacts(before, after)) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} changed while Motion verified its bytes.`, path);
  }
  return { dev: Number(after.dev), ino: Number(after.ino), size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, nlink: after.nlink, sha256 };
}

function sameRegularFacts(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return right.isFile() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.nlink === right.nlink;
}

async function removeExactPrivateFile(path: string, label: string, identity: OutputPathIdentity): Promise<void> {
  await assertRegularFileIdentity(path, label, identity);
  await unlink(path);
}

/** Identity-only cleanup guard: never hash an attacker-expanded private stage before preserving/removing it. */
export async function assertRegularFileIdentity(path: string, label: string, expected: OutputPathIdentity): Promise<void> {
  const facts = await lstat(path);
  if (!facts.isFile() || facts.isSymbolicLink() || Number(facts.dev) !== expected.dev || Number(facts.ino) !== expected.ino) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} changed after Motion captured its identity.`, path);
  }
}

export async function verifyDirectoryAt(
  path: string,
  expectedEntries: readonly string[],
  expectedIdentity: OutputPathIdentity,
  label: string
): Promise<DerivedDirectoryPublicationEvidence> {
  const names = [...new Set(expectedEntries)].sort();
  if (names.length !== expectedEntries.length || names.some((name) => !safeRelativeFilePath(name))) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} inventory is not a closed set of relative file paths.`, path);
  }
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: path.includes(".shellx-motion-") });
  const actual = await regularFilesBelow(path, path);
  if (actual.length !== names.length || actual.some((name) => !names.includes(name))) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} contains an unknown, missing, or non-regular entry.`, path);
  }
  const digest = createHash("sha256");
  for (const name of names) {
    const file = await stableRegularFile(join(path, name), `${label} entry`);
    digest.update(`${name}\u0000${file.size}\u0000${file.sha256}\n`);
  }
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: path.includes(".shellx-motion-") });
  return { sha256: digest.digest("hex"), entryCount: names.length };
}

/** Capture the complete regular-file inventory of one identity-bound private directory. */
export async function captureDirectoryInventoryAt(
  path: string,
  expectedIdentity: OutputPathIdentity,
  label: string
): Promise<DerivedDirectoryPublicationEvidence & { entries: string[] }> {
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: path.includes(".shellx-motion-") });
  const entries = (await regularFilesBelow(path, path)).sort();
  const evidence = await verifyDirectoryAt(path, entries, expectedIdentity, label);
  return { ...evidence, entries };
}

/** Capture a recursively bounded descriptor-relative content-addressed closed tree before rename. */
export async function captureExactDirectoryInventorySnapshotAt(
  path: string,
  expectedEntries: readonly ExactDirectoryInventoryEntry[],
  expectedIdentity: OutputPathIdentity,
  label: string
): Promise<ExactDirectoryInventorySnapshot> {
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: true });
  const snapshot = await captureExactDirectoryInventoryAt(path, expectedEntries, expectedIdentity, label);
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: true });
  return snapshot;
}

/** Capture a complete private staged tree without accepting caller-selected leaf data. */
export async function captureCompleteExactDirectoryInventorySnapshotAt(
  path: string,
  expectedIdentity: OutputPathIdentity,
  label: string
): Promise<ExactDirectoryInventorySnapshot> {
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: true });
  const snapshot = await captureCompleteExactDirectoryInventoryAt(path, expectedIdentity, label);
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: true });
  return snapshot;
}

/** Explicit opt-in complete-tree capture for internal COW flows that retain empty directories. */
export async function captureCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(
  path: string,
  expectedIdentity: OutputPathIdentity,
  label: string
): Promise<CompleteDirectoryInventorySnapshot> {
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: true });
  const snapshot = await captureCompleteExactDirectoryInventoryWithEmptyDirectoriesAt(path, expectedIdentity, label);
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: true });
  return snapshot;
}

/** Recheck the retained exact tree after rename; both content and nested identities must survive. */
export async function assertExactDirectoryInventorySnapshotAt(
  path: string,
  expectedEntries: readonly ExactDirectoryInventoryEntry[],
  expectedIdentity: OutputPathIdentity,
  snapshot: ExactDirectoryInventorySnapshot,
  label: string
): Promise<DerivedDirectoryPublicationEvidence & { entries: string[]; inventory: readonly ExactDirectoryInventoryEntry[] }> {
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: true });
  const evidence = await assertExactDirectoryInventoryAt(path, expectedEntries, expectedIdentity, snapshot, label);
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: true });
  return { sha256: evidence.sha256, entryCount: evidence.entryCount, entries: [...evidence.entries], inventory: evidence.inventory };
}

/** Recheck an opt-in complete tree after rename, including pinned empty-directory identities. */
export async function assertCompleteExactDirectoryInventoryWithEmptyDirectoriesSnapshotAt(
  path: string,
  expectedEntries: readonly CompleteDirectoryInventoryEntry[],
  expectedIdentity: OutputPathIdentity,
  snapshot: CompleteDirectoryInventorySnapshot,
  label: string
): Promise<CompleteDirectoryInventorySnapshot["evidence"]> {
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: true });
  const evidence = await assertCompleteExactDirectoryInventoryWithEmptyDirectoriesAt(path, expectedEntries, expectedIdentity, snapshot, label);
  await assertOutputDirectoryIdentity(path, expectedIdentity, label, { private: true });
  return evidence;
}

export async function removeExactPrivateDirectory(topology: OutputPathTopology, path: string, identity: OutputPathIdentity, heldDirectoryAuthority?: unknown): Promise<void> {
  await topology.assertCurrent();
  await assertOutputDirectoryIdentity(path, identity, "Final output reservation", { private: true, heldDirectoryAuthority });
  await rmdir(path);
}

async function capturePrivateDirectoryIdentity(path: string, label: string): Promise<OutputPathIdentity> {
  const facts = await lstat(path);
  if (!facts.isDirectory() || facts.isSymbolicLink()) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} must be a private non-symlink directory.`, path);
  }
  return await captureOutputDirectoryIdentity(path, label, { private: true });
}

async function regularFilesBelow(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const facts = await lstat(path);
    if (facts.isSymbolicLink()) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final directory staging contains a symbolic link.", path);
    }
    if (facts.isDirectory()) {
      files.push(...await regularFilesBelow(root, path));
      continue;
    }
    if (!facts.isFile()) {
      throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final directory staging contains a non-regular entry.", path);
    }
    files.push(relative(root, path).split(sep).join("/"));
  }
  return files;
}

function safeRelativeFilePath(name: string): boolean {
  if (!name || name.includes("\\") || name.startsWith("/") || name.endsWith("/")) return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
