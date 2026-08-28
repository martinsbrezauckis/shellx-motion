/** No-follow signed immutable-file publication and stable reads. */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { code, exact, type AuthorityFacts, storeError } from "./checkpoint-storyboard-record-store-types.js";

export async function writeExclusiveSignedFile(path: string, payload: object, facts: AuthorityFacts, maximumBytes: number): Promise<void> {
  const bytes = signedBytes(payload, facts, maximumBytes);
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600);
  } catch {
    throw storeError("store_integrity_failed", "Checkpoint storyboard immutable record staging could not begin.");
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch {
    // Do not unlink: the host-quiescent recovery path can safely clear the unselected private temp.
    throw storeError("record_commit_uncertain", "Checkpoint storyboard immutable record staging became uncertain; host-quiescent recovery may remove only its private staging file.");
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch { /* The temp remains deliberately unselected and recoverable. */ }
    }
  }
  try {
    // link(2) is an atomic no-replace publication primitive. rename(2) is deliberately avoided:
    // it can overwrite a concurrently selected immutable key.
    await link(temp, path);
  } catch (error) {
    if (code(error) === "EEXIST") {
      try { await unlink(temp); }
      catch { throw storeError("record_commit_uncertain", "Checkpoint storyboard unselected staging residue could not be cleared."); }
      throw storeError("record_identity_conflict", "Checkpoint storyboard immutable record identity is already occupied.");
    }
    throw storeError("record_commit_uncertain", "Checkpoint storyboard immutable record final publication is uncertain.");
  }
  // A successful directory sync establishes the selected name durably. Any problem after link is
  // intentionally typed as uncertainty: a caller must never infer rollback from a thrown error.
  try { await syncPrivateDirectory(dirname(path)); }
  catch { throw storeError("record_commit_uncertain", "Checkpoint storyboard immutable final publication durability is uncertain."); }
  try { await unlink(temp); }
  catch { throw storeError("record_commit_uncertain", "Checkpoint storyboard immutable final publication left recoverable staging residue."); }
}
/** A signed mutable index is allowed only as a pointer to immutable append-only records. */
export async function replaceSignedFile(path: string, payload: object, facts: AuthorityFacts, maximumBytes: number, afterRename?: () => void | Promise<void>): Promise<void> {
  try { await readSignedFile(path, facts, maximumBytes, "record_not_found"); }
  catch (error) { if (!(error instanceof Error) || (error as { code?: string }).code !== "record_not_found") throw error; }
  const bytes = signedBytes(payload, facts, maximumBytes), temp = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try { handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(), 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined; }
  catch { try { await handle?.close(); } catch { /* retain recoverable staging */ } throw storeError("record_commit_uncertain", "Checkpoint storyboard signed index staging became uncertain."); }
  try { await rename(temp, path); await afterRename?.(); await syncPrivateDirectory(dirname(path)); }
  catch { throw storeError("record_commit_uncertain", "Checkpoint storyboard signed index publication became uncertain."); }
}

export async function readSignedFile(path: string, facts: AuthorityFacts, maximumBytes: number, absent: "record_not_found"): Promise<unknown> {
  const bytes = await readStableRegularFile(path, facts.ownerUid, maximumBytes, absent);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); assertBoundedJson(value); }
  catch { throw storeError("store_integrity_failed", "Checkpoint storyboard store file is not JSON."); }
  const signed = exact(value, ["payload", "integrity"], "Checkpoint storyboard signed store file");
  if (typeof signed.integrity !== "string" || !/^[a-f0-9]{64}$/.test(signed.integrity) || !sameMac(signed.payload, signed.integrity, facts)) throw storeError("store_integrity_failed", "Checkpoint storyboard store integrity verification failed.");
  return signed.payload;
}

async function readStableRegularFile(path: string, ownerUid: number, maximumBytes: number, absent: "record_not_found"): Promise<Buffer> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try { before = await lstat(path); }
  catch (error) {
    if (code(error) === "ENOENT") throw storeError(absent, "Checkpoint storyboard record does not exist for that exact identity.");
    throw storeError("store_integrity_failed", "Checkpoint storyboard store file could not be inspected.");
  }
  if (!privateRegular(before, ownerUid, maximumBytes)) throw storeError("store_integrity_failed", "Checkpoint storyboard store file is not a bounded single-link private regular file.");
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, fsConstants.O_RDONLY | noFollowFlag()); }
  catch { throw storeError("store_integrity_failed", "Checkpoint storyboard store file could not be opened safely."); }
  try {
    const opened = await handle.stat();
    if (!privateRegular(opened, ownerUid, maximumBytes) || opened.dev !== before.dev || opened.ino !== before.ino) throw storeError("store_integrity_failed", "Checkpoint storyboard store file changed before opening.");
    const expectedBytes = Number(opened.size);
    const buffer = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const { bytesRead } = await handle.read(buffer, offset, expectedBytes - offset, offset);
      if (bytesRead === 0) throw storeError("store_integrity_failed", "Checkpoint storyboard store file ended before its stable opened size.");
      offset += bytesRead;
    }
    const bytes = buffer;
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (!privateRegular(after, ownerUid, maximumBytes) || !privateRegular(pathAfter, ownerUid, maximumBytes) || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) throw storeError("store_integrity_failed", "Checkpoint storyboard store file changed while reading.");
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
    throw storeError("store_integrity_failed", "Checkpoint storyboard store file could not be read safely.");
  } finally {
    try { await handle.close(); }
    catch { throw storeError("store_integrity_failed", "Checkpoint storyboard store file could not be closed safely."); }
  }
}

function signedBytes(payload: object, facts: AuthorityFacts, maximumBytes: number): Buffer {
  const bytes = Buffer.from(`${canonicalJson({ payload, integrity: mac(payload, facts) })}\n`, "utf8");
  if (bytes.byteLength > maximumBytes) throw storeError("store_integrity_failed", "Checkpoint storyboard store record exceeds its bounded storage limit.");
  return bytes;
}
function mac(payload: unknown, facts: AuthorityFacts): string { return createHmac("sha256", facts.integrityKey).update(facts.storeBinding).update("\u0000").update(canonicalJson(payload)).digest("hex"); }
function sameMac(payload: unknown, expected: string, facts: AuthorityFacts): boolean {
  const found = Buffer.from(mac(payload, facts), "hex");
  const supplied = Buffer.from(expected, "hex");
  return found.byteLength === supplied.byteLength && timingSafeEqual(found, supplied);
}
function privateRegular(stat: Awaited<ReturnType<typeof lstat>>, ownerUid: number, maximumBytes: number): boolean { return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maximumBytes && stat.uid === ownerUid && (Number(stat.mode) & 0o077) === 0; }
function noFollowFlag(): number { if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Checkpoint storyboard store requires O_NOFOLLOW support."); return fsConstants.O_NOFOLLOW; }
function assertBoundedJson(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 20_000 || depth > 64) throw new Error("bounded JSON limit");
    if (Array.isArray(value)) {
      if (value.length > 1_024) throw new Error("bounded JSON limit");
      for (const child of value) pending.push({ value: child, depth: depth + 1 });
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > 256) throw new Error("bounded JSON limit");
      for (const [, child] of entries) pending.push({ value: child, depth: depth + 1 });
    }
  }
}
/** Sync a checked private directory after a link or recovery unlink. */
export async function syncPrivateDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | noFollowFlag());
  try { await handle.sync(); }
  finally { await handle.close(); }
}
