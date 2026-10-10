import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAIM_FILE, MAX_CLAIM_BYTES, parsePointer, parseState, serializePointer, serializeState, type PointerRead, type StoredState } from "./job-identity-claim-store-model";

export async function readClaimState(directory: string): Promise<StoredState | null> {
  try {
    const before = await assertClaimDirectory(directory);
    const loaded = await readPrivateLeaf(join(directory, CLAIM_FILE), "Motion job identity claim state");
    const after = await assertClaimDirectory(directory);
    if (!sameDirectory(before, after)) return null;
    const state = parseState(JSON.parse(loaded.raw) as unknown);
    return loaded.raw === serializeState(state) ? state : null;
  } catch {
    return null;
  }
}

export async function readClaimPointer(path: string): Promise<PointerRead> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const loaded = await readPrivateLeaf(path, "Motion job identity claim pointer", true);
      if (loaded.metadata.nlink !== 1) {
        await delay(1);
        continue;
      }
      const pointer = parsePointer(JSON.parse(loaded.raw) as unknown);
      return loaded.raw === serializePointer(pointer) ? { kind: "pointer", pointer, metadata: loaded.metadata } : { kind: "invalid" };
    } catch (error) {
      return isMissing(error) ? { kind: "missing" } : { kind: "invalid" };
    }
  }
  return { kind: "invalid" };
}

export async function createClaimDirectory(directory: string, serialized: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  try {
    await writeFile(join(directory, CLAIM_FILE), serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await assertClaimDirectory(directory);
  } catch (error) {
    await removeClaimDirectory(directory).catch(() => {});
    throw error;
  }
}

export async function writeStateAtomic(directory: string, serialized: string): Promise<void> {
  await assertClaimDirectory(directory);
  const statePath = join(directory, CLAIM_FILE);
  const temporary = join(directory, `.${CLAIM_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await assertClaimDirectory(directory);
    await rename(temporary, statePath);
    await assertClaimDirectory(directory);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeNoClobber(path: string, serialized: string): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Remove one immutable pointer only if it still names the exact validated inode. */
export async function removeExactPointer(path: string, expected: Stats): Promise<boolean> {
  assertPrivateLeaf(expected, "Motion job identity claim pointer");
  const temporary = `${path}.remove-${process.pid}-${randomUUID()}.tmp`;
  try {
    await link(path, temporary);
    const [current, held] = await Promise.all([lstat(path), lstat(temporary)]);
    if (!sameLeaf(expected, current) || !sameLeaf(expected, held) || current.nlink !== 2 || held.nlink !== 2) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (isMissing(error) || isAlreadyExists(error)) return false;
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function removeClaimDirectory(directory: string): Promise<void> {
  try {
    await assertClaimDirectory(directory);
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function readPrivateLeaf(path: string, label: string, allowTransientSecondLink = false): Promise<{ raw: string; metadata: Stats }> {
  const before = await lstat(path);
  assertPrivateLeaf(before, label, allowTransientSecondLink ? 2 : 1);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertPrivateLeaf(opened, label, allowTransientSecondLink ? 2 : 1);
    if (!sameLeaf(before, opened)) throw new Error(`${label} changed before it was opened.`);
    const bytes = Buffer.allocUnsafe(opened.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const lexicalAfter = await lstat(path);
    if (offset !== opened.size || !sameLeaf(opened, after) || !sameLeaf(after, lexicalAfter) || lexicalAfter.isSymbolicLink()) {
      throw new Error(`${label} changed while it was read.`);
    }
    assertPrivateLeaf(after, label, allowTransientSecondLink ? 2 : 1);
    assertPrivateLeaf(lexicalAfter, label, allowTransientSecondLink ? 2 : 1);
    return { raw: bytes.subarray(0, offset).toString("utf8"), metadata: after };
  } finally {
    await handle.close();
  }
}

async function assertClaimDirectory(path: string): Promise<Stats> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Motion job identity claim directory must be a private non-symlink directory.");
  }
  return metadata;
}

function assertPrivateLeaf(metadata: Stats, label: string, maximumLinks = 1): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink < 1 || metadata.nlink > maximumLinks || !Number.isSafeInteger(metadata.size)
    || metadata.size < 2 || metadata.size > MAX_CLAIM_BYTES || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a bounded private single-link regular non-symlink file.`);
  }
}

function sameLeaf(left: Stats, right: Stats): boolean {
  return right.isFile() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return right.isDirectory() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
