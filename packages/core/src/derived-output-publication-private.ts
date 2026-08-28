/** Private identity-bound stage mechanics for derived final-output publication. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdtemp, open, readdir, rmdir } from "node:fs/promises";
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
import { hashFile } from "./receipts";

export type PrivateFileAnchor = { path: string; identity: OutputPathIdentity };
export type {
  CompleteDirectoryInventoryEntry,
  CompleteDirectoryInventorySnapshot,
  ExactDirectoryInventoryEntry,
  ExactDirectoryInventorySnapshot
} from "./closed-directory-inventory";
export { isClosedDirectoryInventoryAmbiguity } from "./closed-directory-inventory";

export async function createPrivateFileStage(root: string, fingerprint: string, extension: string): Promise<{ path: string; identity: OutputPathIdentity }> {
  const safeExtension = /^\.[a-z0-9]{1,16}$/i.test(extension) ? extension : ".stage";
  const path = join(root, `.shellx-motion-final-${fingerprint}-${randomUUID()}${safeExtension}`);
  const handle = await open(path, "wx", 0o600);
  await handle.close();
  const facts = await stableRegularFile(path, "Final output staging file");
  return { path, identity: { dev: facts.dev, ino: facts.ino } };
}

export async function createPrivateDirectoryStage(root: string, fingerprint: string): Promise<{ path: string; identity: OutputPathIdentity }> {
  const path = await mkdtemp(join(root, `.shellx-motion-final-${fingerprint}-`));
  return { path, identity: await capturePrivateDirectoryIdentity(path, "Final image-sequence staging") };
}

export async function createPrivateFileAnchor(
  lockPath: string,
  name: string,
  targetPath: string,
  expectedIdentity: OutputPathIdentity
): Promise<PrivateFileAnchor> {
  const path = join(lockPath, name);
  const target = await stableRegularFile(targetPath, "Final output identity source", expectedIdentity);
  await link(targetPath, path);
  const anchor = await stableRegularFile(path, "Final output private identity anchor", expectedIdentity);
  if (anchor.dev !== target.dev || anchor.ino !== target.ino) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", "Final output identity anchor did not bind the expected file.", path);
  }
  return { path, identity: { dev: anchor.dev, ino: anchor.ino } };
}

export async function stableRegularFile(path: string, label: string, expected?: OutputPathIdentity): Promise<OutputPathIdentity & { size: number; nlink: number; sha256: string }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} must be a regular non-symlink file.`, path);
  }
  if (expected && (Number(before.dev) !== expected.dev || Number(before.ino) !== expected.ino)) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} changed after Motion captured its identity.`, path);
  }
  const sha256 = await hashFile(path);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new DerivedOutputPublicationError("derived_output_stage_invalid", `${label} changed while Motion verified its bytes.`, path);
  }
  return { dev: Number(after.dev), ino: Number(after.ino), size: after.size, nlink: after.nlink, sha256 };
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

export async function removeExactPrivateDirectory(topology: OutputPathTopology, path: string, identity: OutputPathIdentity): Promise<void> {
  await topology.assertCurrent();
  await assertOutputDirectoryIdentity(path, identity, "Final output reservation", { private: true });
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
