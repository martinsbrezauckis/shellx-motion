import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";

const MAX_RECEIPT_BYTES = 64 * 1024;
type Identity = { readonly dev: number; readonly ino: number; readonly byteLength: number; readonly mtimeMs: number; readonly mode: number; };
export interface Hdr10PqPinnedStagedFile { readonly path: string; readonly byteLength: number; readonly handle: FileHandle; readonly identity: Identity; }
export function assertHdr10PqNoFollowStagedFileSupport(): void { noFollowFlags(); }

/** A held no-follow regular file inside the private C2 staging directory. */
export async function openHdr10PqPinnedStagedFile(path: string, maximumBytes: number): Promise<Hdr10PqPinnedStagedFile> {
  const before = await lstatRegular(path, maximumBytes), flags = noFollowFlags(); let handle: FileHandle | undefined;
  try {
    handle = await open(path, flags); const identity = checkedIdentity(await handle.stat(), maximumBytes);
    if (!same(identity, before)) throw new Error("HDR10 staged file changed before its no-follow descriptor was pinned.");
    return Object.freeze({ path, byteLength: identity.byteLength, handle, identity });
  } catch (error) { await handle?.close().catch(() => undefined); throw error; }
}

/** Hashes only bytes from the held descriptor and rejects a concurrent file mutation. */
export async function hashHdr10PqPinnedStagedFile(file: Hdr10PqPinnedStagedFile): Promise<string> {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(Math.min(64 * 1024, file.byteLength)); let offset = 0;
  while (offset < file.byteLength) { const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, file.byteLength - offset), offset); if (bytesRead < 1) throw new Error("HDR10 staged file ended before its pinned byte length."); hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; }
  await assertHdr10PqPinnedStagedFileCurrent(file); return hash.digest("hex");
}

/** Rechecks the held object and its lexical no-follow name immediately before publication. */
export async function assertHdr10PqPinnedStagedFileCurrent(file: Hdr10PqPinnedStagedFile): Promise<void> {
  const held = checkedIdentity(await file.handle.stat(), file.byteLength), named = await lstatRegular(file.path, file.byteLength);
  if (!same(file.identity, held) || !same(file.identity, named)) throw new Error("HDR10 staged file was replaced, linked, or modified after admission.");
}

export async function closeHdr10PqPinnedStagedFile(file: Hdr10PqPinnedStagedFile | undefined): Promise<void> { await file?.handle.close().catch(() => undefined); }

/**
 * The transaction's captured 0700 stage is the source-host trust boundary: the encoder receives
 * only its random work name, never the final name. Same-UID external writers with host control
 * are outside OutputDirectoryTransaction authority and are not claimed to be adversarial here.
 */
/** Copies the held work artifact into a new no-follow final child; an encoder-planted final name refuses. */
export async function copyHdr10PqPinnedStagedFileExclusive(source: Hdr10PqPinnedStagedFile, path: string, maximumBytes: number): Promise<Hdr10PqPinnedStagedFile> {
  await assertHdr10PqPinnedStagedFileCurrent(source); let handle: FileHandle | undefined;
  try {
    handle = await open(path, noFollowFlags() | fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600); const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, source.byteLength)); let offset = 0;
    while (offset < source.byteLength) { const { bytesRead } = await source.handle.read(buffer, 0, Math.min(buffer.length, source.byteLength - offset), offset); if (bytesRead < 1) throw new Error("HDR10 pinned work artifact ended during final copy."); let written = 0; while (written < bytesRead) { const result = await handle.write(buffer, written, bytesRead - written, offset + written); if (result.bytesWritten < 1) throw new Error("HDR10 final artifact copy was incomplete."); written += result.bytesWritten; } offset += bytesRead; }
    await handle.sync(); const identity = checkedIdentity(await handle.stat(), maximumBytes); if (identity.byteLength !== source.byteLength) throw new Error("HDR10 final artifact length changed during copy.");
  } finally { await handle?.close().catch(() => undefined); }
  await assertHdr10PqPinnedStagedFileCurrent(source); const copied = await openHdr10PqPinnedStagedFile(path, maximumBytes);
  try { if (await hashHdr10PqPinnedStagedFile(source) !== await hashHdr10PqPinnedStagedFile(copied)) throw new Error("HDR10 final artifact bytes differ from the pinned work artifact."); return copied; }
  catch (error) { await closeHdr10PqPinnedStagedFile(copied); throw error; }
}

/** Removes only the still-pinned private work child after its exact final copy exists. */
export async function removeHdr10PqPinnedStagedFile(file: Hdr10PqPinnedStagedFile): Promise<void> { await assertHdr10PqPinnedStagedFileCurrent(file); await unlink(file.path); await lstat(file.path).then(() => { throw new Error("HDR10 work artifact survived exact removal."); }, (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }

/** The private stage and committed output bundle never adopt sidecars, symlinks, or extra files. */
export async function assertHdr10PqExactBundleChildren(directory: string, output: Hdr10PqPinnedStagedFile, receipt: Hdr10PqPinnedStagedFile): Promise<void> { const expected = [basename(output.path), basename(receipt.path)].sort(), actual = (await readdir(directory)).sort(); if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new Error("HDR10 direct-final bundle contains unexpected encoder or external entries."); await assertHdr10PqPinnedStagedFileCurrent(output); await assertHdr10PqPinnedStagedFileCurrent(receipt); }

/** Writes one canonical receipt with exclusive no-follow creation, then holds its verified descriptor. */
export async function writeHdr10PqExclusiveStagedReceipt(path: string, bytes: Buffer): Promise<Hdr10PqPinnedStagedFile> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RECEIPT_BYTES) throw new Error("HDR10 direct-final receipt exceeds its byte ceiling.");
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, noFollowFlags() | fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600); let offset = 0;
    while (offset < bytes.byteLength) { const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset); if (bytesWritten < 1) throw new Error("HDR10 direct-final receipt write was incomplete."); offset += bytesWritten; }
    await handle.sync(); const identity = checkedIdentity(await handle.stat(), MAX_RECEIPT_BYTES); if (identity.byteLength !== bytes.byteLength) throw new Error("HDR10 direct-final receipt length changed while writing.");
  } finally { await handle?.close().catch(() => undefined); }
  const pinned = await openHdr10PqPinnedStagedFile(path, MAX_RECEIPT_BYTES);
  try { const actual = await readHdr10PqPinnedStagedFile(pinned); if (!actual.equals(bytes)) throw new Error("HDR10 direct-final receipt bytes changed before verification."); return pinned; }
  catch (error) { await closeHdr10PqPinnedStagedFile(pinned); throw error; }
}

export async function readHdr10PqPinnedStagedFile(file: Hdr10PqPinnedStagedFile): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(file.byteLength); let offset = 0;
  while (offset < bytes.byteLength) { const { bytesRead } = await file.handle.read(bytes, offset, bytes.byteLength - offset, offset); if (bytesRead < 1) throw new Error("HDR10 staged file ended before its pinned byte length."); offset += bytesRead; }
  await assertHdr10PqPinnedStagedFileCurrent(file); return bytes;
}

function noFollowFlags(): number { if (process.platform === "win32" || typeof fsConstants.O_NOFOLLOW !== "number" || fsConstants.O_NOFOLLOW === 0) throw new Error("HDR10 direct final requires platform no-follow staged-file support."); return fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW; }
async function lstatRegular(path: string, maximumBytes: number): Promise<Identity> { return checkedIdentity(await lstat(path), maximumBytes); }
function checkedIdentity(value: { isFile(): boolean; isSymbolicLink(): boolean; dev: number; ino: number; size: number; mtimeMs: number; nlink: number; mode: number }, maximumBytes: number): Identity { if (!value.isFile() || value.isSymbolicLink() || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > maximumBytes || value.nlink !== 1) throw new Error("HDR10 staged file must be one bounded, unlinked regular file."); return Object.freeze({ dev: Number(value.dev), ino: Number(value.ino), byteLength: value.size, mtimeMs: value.mtimeMs, mode: value.mode }); }
function same(left: Identity, right: Identity): boolean { return left.dev === right.dev && left.ino === right.ino && left.byteLength === right.byteLength && left.mtimeMs === right.mtimeMs && left.mode === right.mode; }
