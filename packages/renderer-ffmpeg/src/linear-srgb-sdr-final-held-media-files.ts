import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const CHUNK_BYTES = 64 * 1024;
const MAX_TOOL_BYTES = 512 * 1024 * 1024;

export type HeldFileFacts = Readonly<{
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
}>;

export type HeldTool = Readonly<{
  path: string;
  handle: FileHandle;
  facts: HeldFileFacts;
  sha256: string;
}>;

export type HeldLeaf = Readonly<{
  path: string;
  handle: FileHandle;
  identity: HeldFileFacts;
}>;

export function assertHeldMediaPrivateNames(root: string, output: string, decoded: string): void {
  const resolvedRoot = resolve(root);
  if (basename(output) !== "verified.mp4" || basename(decoded) !== "decoded.rgba" || resolve(output) !== join(resolvedRoot, "verified.mp4") || resolve(decoded) !== join(resolvedRoot, "decoded.rgba")) {
    throw new Error("Strict SDR held-media requires its exact private source and decode leaves.");
  }
}

export async function openHeldTool(path: string, label: string): Promise<HeldTool> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const facts = await regularFileFacts(handle, path, `Strict SDR held-media ${label}`);
    if (((await lstat(path)).mode & 0o111) === 0) throw new Error(`Strict SDR held-media ${label} is not executable.`);
    if (facts.size < 4 || facts.size > MAX_TOOL_BYTES) throw new Error(`Strict SDR held-media ${label} is outside its bounded executable size.`);
    return Object.freeze({ path, handle, facts, sha256: (await hashHandle(handle, facts.size, `Strict SDR held-media ${label}`)).sha256 });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function assertHeldTool(tool: HeldTool, label: string): Promise<void> {
  const facts = await regularFileFacts(tool.handle, tool.path, label);
  if (!sameHeldFacts(facts, tool.facts) || (await hashHandle(tool.handle, facts.size, label)).sha256 !== tool.sha256) {
    throw new Error(`${label} changed after strict held-media admission.`);
  }
}

export function assertCurrentHeldToolResolution(tool: HeldTool, resolveCurrent: () => string, label: string): void {
  if (resolveCurrent() !== tool.path) throw new Error(`${label} no longer resolves to the admitted executable.`);
}

export async function createExclusiveHeldLeaf(root: FileHandle, rootIdentity: HeldFileFacts, path: string, label: string): Promise<HeldLeaf> {
  await assertHeldDirectoryIdentity(root, dirnameOf(path), rootIdentity, `${label} parent`);
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_RDWR, 0o600);
  try {
    const identity = await assertPinnedHeldLeaf(root, rootIdentity, { path, handle }, label);
    return Object.freeze({ path, handle, identity });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function assertPinnedHeldLeaf(root: FileHandle, rootIdentity: HeldFileFacts, leaf: { readonly path: string; readonly handle: FileHandle; readonly identity?: HeldFileFacts }, label: string): Promise<HeldFileFacts> {
  await assertHeldDirectoryIdentity(root, dirnameOf(leaf.path), rootIdentity, `${label} parent`);
  const pathFacts = await regularPathFacts(leaf.path, label);
  const handleFacts = await regularHandleFacts(leaf.handle, label);
  if (pathFacts.dev !== handleFacts.dev || pathFacts.ino !== handleFacts.ino || pathFacts.nlink !== handleFacts.nlink || (leaf.identity && !sameIdentityFacts(leaf.identity, handleFacts))) {
    throw new Error(`${label} no longer resolves to the held exclusive inode.`);
  }
  return handleFacts;
}

export async function hashHeldLeaf(root: FileHandle, rootIdentity: HeldFileFacts, leaf: HeldLeaf, maximum: number, label: string): Promise<{ readonly sha256: string; readonly byteLength: number; readonly identity: HeldFileFacts }> {
  const before = await assertPinnedHeldLeaf(root, rootIdentity, leaf, `${label} before hash`);
  if (before.size < 1 || before.size > maximum) throw new Error(`${label} is outside its bounded byte range.`);
  const hashed = await hashHandle(leaf.handle, before.size, label);
  const after = await assertPinnedHeldLeaf(root, rootIdentity, leaf, `${label} after hash`);
  if (!sameHeldFacts(before, after) || hashed.byteLength !== before.size) throw new Error(`${label} changed while hashing through its held descriptor.`);
  return Object.freeze({ sha256: hashed.sha256, byteLength: hashed.byteLength, identity: after });
}

export async function readExactHeldLeaf(root: FileHandle, rootIdentity: HeldFileFacts, leaf: HeldLeaf, expectedBytes: number, label: string): Promise<Buffer> {
  const before = await assertPinnedHeldLeaf(root, rootIdentity, leaf, `${label} before read`);
  if (before.size !== expectedBytes) throw new Error(`${label} did not have the expected exact byte length.`);
  const bytes = Buffer.alloc(expectedBytes);
  for (let offset = 0; offset < bytes.byteLength;) {
    const { bytesRead } = await leaf.handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead < 1) throw new Error(`${label} ended before its exact byte length.`);
    offset += bytesRead;
  }
  const after = await assertPinnedHeldLeaf(root, rootIdentity, leaf, `${label} after read`);
  if (!sameHeldFacts(before, after)) throw new Error(`${label} changed while reading through its held descriptor.`);
  return bytes;
}

export async function assertHeldMp4FastStart(root: FileHandle, rootIdentity: HeldFileFacts, source: HeldLeaf): Promise<void> {
  const before = await assertPinnedHeldLeaf(root, rootIdentity, source, "Strict SDR held-media MP4 before atom inspection");
  let offset = 0;
  let moov = -1;
  let mdat = -1;
  const header = Buffer.alloc(16);
  while (offset < before.size) {
    const { bytesRead } = await source.handle.read(header, 0, 8, offset);
    if (bytesRead !== 8) throw new Error("Strict SDR held-media MP4 box header was truncated.");
    let size = header.readUInt32BE(0);
    const type = header.toString("ascii", 4, 8);
    let headerBytes = 8;
    if (size === 1) {
      const extended = await source.handle.read(header, 8, 8, offset + 8);
      if (extended.bytesRead !== 8) throw new Error("Strict SDR held-media extended MP4 box header was truncated.");
      size = Number(header.readBigUInt64BE(8));
      headerBytes = 16;
    } else if (size === 0) {
      size = before.size - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerBytes || offset + size > before.size) throw new Error("Strict SDR held-media MP4 box size was invalid.");
    if (type === "moov") moov = offset;
    if (type === "mdat") mdat = offset;
    offset += size;
  }
  const after = await assertPinnedHeldLeaf(root, rootIdentity, source, "Strict SDR held-media MP4 after atom inspection");
  if (!sameHeldFacts(before, after) || moov < 0 || mdat < 0 || moov >= mdat) throw new Error("Strict SDR held-media MP4 did not retain +faststart moov-before-mdat ordering.");
}

export async function removeHeldLeaf(root: FileHandle, rootIdentity: HeldFileFacts, leaf: HeldLeaf, label: string): Promise<void> {
  let identityError: unknown;
  try {
    await assertPinnedHeldLeaf(root, rootIdentity, leaf, `${label} before cleanup`);
  } catch (error) {
    identityError = error;
  }
  let closeError: unknown;
  try {
    await leaf.handle.close();
  } catch (error) {
    closeError = error;
  }
  if (identityError && closeError) {
    throw new AggregateError([identityError, closeError], `${label} identity cleanup refused and its retained descriptor could not be closed.`);
  }
  if (identityError) throw identityError;
  if (closeError) throw closeError;
  const facts = await regularPathFacts(leaf.path, `${label} cleanup path`);
  if (!sameIdentityFacts(leaf.identity, facts)) throw new Error(`${label} changed before identity-cleanup unlink.`);
  await unlink(leaf.path);
}

export async function heldDirectoryFacts(handle: FileHandle, path: string, label: string): Promise<HeldFileFacts> {
  const facts = await handle.stat();
  const pathFacts = await lstat(path);
  if (!facts.isDirectory() || facts.isSymbolicLink() || !pathFacts.isDirectory() || pathFacts.isSymbolicLink() || facts.dev !== pathFacts.dev || facts.ino !== pathFacts.ino) {
    throw new Error(`${label} is not the held private directory.`);
  }
  return factsOf(facts);
}

export async function assertHeldDirectoryIdentity(handle: FileHandle, path: string, expected: HeldFileFacts, label: string): Promise<void> {
  const actual = await heldDirectoryFacts(handle, path, label);
  if (!sameIdentityFacts(actual, expected)) throw new Error(`${label} changed after private-root admission.`);
}

export function sameHeldFacts(left: HeldFileFacts, right: HeldFileFacts): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.nlink === right.nlink;
}

async function regularFileFacts(handle: FileHandle, path: string, label: string): Promise<HeldFileFacts> {
  const facts = await handle.stat();
  const pathFacts = await lstat(path);
  if (!facts.isFile() || facts.isSymbolicLink() || !pathFacts.isFile() || pathFacts.isSymbolicLink() || facts.dev !== pathFacts.dev || facts.ino !== pathFacts.ino || facts.nlink !== pathFacts.nlink) {
    throw new Error(`${label} is not the held regular file.`);
  }
  return factsOf(facts);
}

async function regularPathFacts(path: string, label: string): Promise<HeldFileFacts> {
  const facts = await lstat(path);
  if (!facts.isFile() || facts.isSymbolicLink()) throw new Error(`${label} is not a regular non-symlink file.`);
  return factsOf(facts);
}

async function regularHandleFacts(handle: FileHandle, label: string): Promise<HeldFileFacts> {
  const facts = await handle.stat();
  if (!facts.isFile() || facts.isSymbolicLink()) throw new Error(`${label} held descriptor is not a regular file.`);
  return factsOf(facts);
}

async function hashHandle(handle: FileHandle, expectedSize: number, label: string): Promise<{ readonly sha256: string; readonly byteLength: number }> {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  for (let offset = 0; offset < expectedSize;) {
    const wanted = Math.min(chunk.byteLength, expectedSize - offset);
    const { bytesRead } = await handle.read(chunk, 0, wanted, offset);
    if (bytesRead !== wanted) throw new Error(`${label} shortened while hashing its held descriptor.`);
    hash.update(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return Object.freeze({ sha256: hash.digest("hex"), byteLength: expectedSize });
}

function factsOf(value: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number }): HeldFileFacts {
  return Object.freeze({ dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, nlink: value.nlink });
}
function sameIdentityFacts(left: HeldFileFacts, right: HeldFileFacts): boolean { return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink; }
function dirnameOf(path: string): string { const value = resolve(path); const index = value.lastIndexOf(sep); return index > 0 ? value.slice(0, index) : value; }
