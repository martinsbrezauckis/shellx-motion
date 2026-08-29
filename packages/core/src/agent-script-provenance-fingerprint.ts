/** Descriptor-bound package fingerprinting for approved-agent-entry resolution. */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { AgentScriptProvenanceRefusal, canonicalPackageRoot } from "./agent-script-provenance-root";

type DirectoryEntry = { name: string; isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean };
export const AGENT_SCRIPT_PROVENANCE_MAX_FILES = 4_096;
export const AGENT_SCRIPT_PROVENANCE_MAX_BYTES = 536_870_912;
const PROVENANCE_HASH_CHUNK_BYTES = 64 * 1024;

/** A single, bounded tree fingerprint for an execution snapshot. Package receipts are included. */
export async function fingerprintAgentScriptPackage(root: string): Promise<string> {
  const canonicalRoot = await canonicalPackageRoot(root);
  const fingerprint = createHash("sha256");
  updateFingerprintFrame(fingerprint, ["shellx-motion/approved-agent-entry-package-fingerprint@1"]);
  let fileCount = 0;
  let totalBytes = 0;
  const walk = async (directory: string): Promise<void> => {
    const beforeDirectory = await assertCanonicalPackageDirectory(canonicalRoot, directory);
    const entries = await readStableDirectoryEntries(canonicalRoot, directory, beforeDirectory);
    updateFingerprintFrame(fingerprint, ["directory", portableRelative(canonicalRoot, directory)]);
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const rel = portableRelative(canonicalRoot, path);
      if (entry.isSymbolicLink()) throw new AgentScriptProvenanceRefusal(`Active script package contains a symbolic link: ${rel}.`, { path: rel });
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) throw new AgentScriptProvenanceRefusal(`Active script package contains an unsupported special entry: ${rel}.`, { path: rel });
      fileCount += 1;
      if (fileCount > AGENT_SCRIPT_PROVENANCE_MAX_FILES) {
        throw new AgentScriptProvenanceRefusal("Active script package exceeds the provenance snapshot budget.", { fileCount, totalBytes });
      }
      const file = await readVerifiedPackageRegularFile(
        canonicalRoot,
        path,
        rel,
        AGENT_SCRIPT_PROVENANCE_MAX_BYTES - totalBytes
      );
      totalBytes += file.byteLength;
      updateFingerprintFrame(fingerprint, ["file", rel, String(file.byteLength), file.sha256]);
    }
    const afterEntries = await readStableDirectoryEntries(canonicalRoot, directory, beforeDirectory);
    if (!sameDirectoryEntries(entries, afterEntries)) {
      throw new AgentScriptProvenanceRefusal("Active script package directory entries changed while fingerprinting.", { path: portableRelative(canonicalRoot, directory) });
    }
    if (!sameDirectory(beforeDirectory, await assertCanonicalPackageDirectory(canonicalRoot, directory))) {
      throw new AgentScriptProvenanceRefusal("Active script package directory changed while fingerprinting.", { path: portableRelative(canonicalRoot, directory) });
    }
  };
  await walk(canonicalRoot);
  return fingerprint.digest("hex");
}

export async function readVerifiedPackageRegularFile(
  canonicalRoot: string,
  path: string,
  rel: string,
  maxBytes: number
): Promise<{ sha256: string; byteLength: number }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new AgentScriptProvenanceRefusal("Active script package has an invalid provenance snapshot budget.");
  }
  await assertCanonicalPackageParent(canonicalRoot, path);
  const initial = await lstat(path);
  if (initial.isSymbolicLink() || !initial.isFile()) throw new AgentScriptProvenanceRefusal(`Active script package entry must be a regular file: ${rel}.`, { path: rel });
  if (!Number.isSafeInteger(initial.size) || initial.size > maxBytes) {
    throw new AgentScriptProvenanceRefusal("Active script package exceeds the provenance snapshot budget.", { path: rel, byteLength: initial.size, maxBytes });
  }
  const handle = await open(path, fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0));
  try {
    const before = await handle.stat();
    if (!sameFile(initial, before)) throw new AgentScriptProvenanceRefusal(`Active script package file changed before it could be read: ${rel}.`, { path: rel });
    if (!Number.isSafeInteger(before.size) || before.size > maxBytes) {
      throw new AgentScriptProvenanceRefusal("Active script package exceeds the provenance snapshot budget.", { path: rel, byteLength: before.size, maxBytes });
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(PROVENANCE_HASH_CHUNK_BYTES, before.size)));
    let byteLength = 0;
    while (byteLength < before.size) {
      const requested = Math.min(chunk.byteLength, before.size - byteLength);
      const read = await handle.read(chunk, 0, requested, byteLength);
      if (read.bytesRead === 0) break;
      hash.update(chunk.subarray(0, read.bytesRead));
      byteLength += read.bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    await assertCanonicalPackageParent(canonicalRoot, path);
    if (byteLength !== before.size || !sameFile(before, after) || !sameFile(before, pathAfter)) {
      throw new AgentScriptProvenanceRefusal(`Active script package file changed while it was being read: ${rel}.`, { path: rel });
    }
    return { sha256: hash.digest("hex"), byteLength };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function assertCanonicalPackageParent(root: string, path: string): Promise<void> {
  const relation = relative(root, path);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) throw new AgentScriptProvenanceRefusal("Active script package entry escaped the canonical package root.", { path });
  const parent = resolve(path, "..");
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent || !isInside(root, canonicalParent)) throw new AgentScriptProvenanceRefusal("Active script package entry traverses a symbolic link.", { path });
}

async function assertCanonicalPackageDirectory(root: string, directory: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const relation = relative(root, directory);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new AgentScriptProvenanceRefusal("Active script package directory escaped the canonical package root.", { path: directory });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new AgentScriptProvenanceRefusal("Active script package contains a non-directory tree component.", { path: directory });
  if (await realpath(directory) !== directory) throw new AgentScriptProvenanceRefusal("Active script package directory traverses a symbolic link.", { path: directory });
  return info;
}

async function readStableDirectoryEntries(root: string, directory: string, identity: Awaited<ReturnType<typeof lstat>>): Promise<DirectoryEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (!sameDirectory(identity, await assertCanonicalPackageDirectory(root, directory))) {
    throw new AgentScriptProvenanceRefusal("Active script package directory changed while it was being read.", { path: directory });
  }
  return entries.map((entry) => ({ name: entry.name, isSymbolicLink: () => entry.isSymbolicLink(), isDirectory: () => entry.isDirectory(), isFile: () => entry.isFile() }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function sameDirectoryEntries(left: DirectoryEntry[], right: DirectoryEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return Boolean(other) && entry.name === other.name && entry.isSymbolicLink() === other.isSymbolicLink()
      && entry.isDirectory() === other.isDirectory() && entry.isFile() === other.isFile();
  });
}

function updateFingerprintFrame(hash: ReturnType<typeof createHash>, parts: string[]): void {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(parts.length, 0);
  hash.update(header);
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength), 0);
    hash.update(length);
    hash.update(bytes);
  }
}

function sameFile(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): boolean {
  return !after.isSymbolicLink() && after.isFile() && after.dev === before.dev && after.ino === before.ino
    && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs;
}

function sameDirectory(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): boolean {
  return !after.isSymbolicLink() && after.isDirectory() && after.dev === before.dev && after.ino === before.ino;
}

function portableRelative(root: string, candidate: string): string {
  return relative(root, candidate).replaceAll("\\", "/");
}

function isInside(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}
