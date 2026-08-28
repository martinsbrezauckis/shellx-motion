/** Private, fsync-backed filesystem primitives for the V25-C1 module registry. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rm, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { EffectModuleRegistryError } from "./effect-module-registry-types.js";

const ALLOWED_ROOT_ENTRIES = new Set([".registry.lock", "blobs", "generations", "staging"]);
const MAX_ROOT_ENTRIES = 4;
export const MAX_EFFECT_MODULE_STAGING_FILES = 32;

export async function withEffectModuleRegistryLock<T>(
  configuredRoot: string,
  operation: (stateRoot: string) => Promise<T>,
  retainedStagingPaths: readonly string[] = [],
  cleanStaging = true,
  orphanMinimumAgeMs = 0
): Promise<T> {
  const stateRoot = await assertEffectModuleRegistryRoot(configuredRoot);
  const lock = await acquireLock(join(stateRoot, ".registry.lock"));
  try {
    await assertEffectModuleRegistryRoot(stateRoot);
    await assertRootEntries(stateRoot);
    const paths = await ensureEffectModuleRegistryDirectories(stateRoot);
    if (cleanStaging) await cleanEffectModuleStaging(stateRoot, paths.stagingRoot, retainedStagingPaths, orphanMinimumAgeMs);
    const result = await operation(stateRoot);
    await assertEffectModuleRegistryRoot(stateRoot);
    return result;
  } finally {
    await lock.close().catch(() => undefined);
    await rm(join(stateRoot, ".registry.lock"), { force: true }).catch(() => undefined);
  }
}

export async function ensureEffectModuleRegistryDirectories(stateRoot: string): Promise<{ blobsRoot: string; generationsRoot: string; stagingRoot: string }> {
  const blobsRoot = await ensurePrivateChild(stateRoot, "blobs");
  const generationsRoot = await ensurePrivateChild(stateRoot, "generations");
  const stagingRoot = await ensurePrivateChild(stateRoot, "staging");
  return { blobsRoot, generationsRoot, stagingRoot };
}

/** Remove only bounded known staging files. Orphans are never adopted as registry state. */
export async function cleanEffectModuleStaging(
  stateRoot: string, stagingRoot: string, retainedPaths: readonly string[], orphanMinimumAgeMs = 0
): Promise<void> {
  const retained = new Set(retainedPaths.map((path) => join(stagingRoot, basenameLeaf(path))));
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  if (entries.length > MAX_EFFECT_MODULE_STAGING_FILES) {
    throw privateInvalid("Effect-module staging contains too many orphan files; operator recovery is required.");
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !safeStagingLeaf(entry.name)) {
      throw privateInvalid("Effect-module staging contains an unexpected or unsafe entry; operator recovery is required.");
    }
    const path = join(stagingRoot, entry.name);
    if (!retained.has(path)) {
      const facts = await lstat(path);
      if (Date.now() - facts.mtimeMs >= orphanMinimumAgeMs) await rm(path, { force: true });
    }
  }
  await assertEffectModuleRegistryRoot(stateRoot);
}

export async function readPrivateEffectModuleFile(path: string, maximumBytes: number, stateRoot: string): Promise<Buffer> {
  const initial = await lstat(path).catch((error: NodeJS.ErrnoException) => { throw error; });
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size < 0 || initial.size > maximumBytes) throw privateInvalid("Effect-module private file is not a bounded regular file.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!same(before, initial) || !before.isFile() || before.size > maximumBytes) throw privateChanged("Effect-module private file changed before reading.");
    const bytes = await readExactly(handle, before.size);
    const after = await handle.stat();
    const leaf = await lstat(path);
    if (bytes.byteLength !== before.size || !same(after, before) || !same(leaf, before) || leaf.isSymbolicLink()) throw privateChanged("Effect-module private file changed while reading.");
    await assertEffectModuleRegistryRoot(stateRoot);
    return bytes;
  } finally { await handle.close().catch(() => undefined); }
}

/** Publish already-read bytes under a content-derived name. Existing bytes must prove identical. */
export async function stagePrivateEffectModuleCandidate(
  stateRoot: string, stagingRoot: string, bytes: Buffer
): Promise<string> {
  const pending = join(stagingRoot, `.candidate-${randomUUID()}.json`);
  await writeSyncedExclusive(pending, bytes, stagingRoot);
  await assertEffectModuleRegistryRoot(stateRoot);
  await syncDirectory(stagingRoot);
  return pending;
}

/** Staging is intentionally never recovered as an installation after a process crash. */
export async function removePrivateEffectModuleCandidate(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

export async function publishPrivateEffectModuleBlob(
  stateRoot: string, blobsRoot: string, stagingRoot: string, fileName: string, bytes: Buffer, expectedSha256: string,
  afterTargetAbsenceCheckForTest?: () => Promise<void> | void
): Promise<void> {
  const target = join(blobsRoot, fileName);
  const existing = await tryLstat(target);
  if (existing) {
    const current = await readPrivateEffectModuleFile(target, bytes.byteLength, stateRoot);
    if (current.byteLength !== bytes.byteLength || sha256(current) !== expectedSha256) {
      throw privateChanged("Effect-module content-addressed blob is not the expected immutable bytes.");
    }
    return;
  }
  const pending = join(stagingRoot, `.blob-${randomUUID()}`);
  await writeSyncedExclusive(pending, bytes, stagingRoot);
  try {
    await assertEffectModuleRegistryRoot(stateRoot);
    await afterTargetAbsenceCheckForTest?.();
    // rename(2) silently replaces an existing destination on POSIX. A same-filesystem hard link
    // gives us the atomic no-replace publish we need: EEXIST proves a competing immutable name
    // won and is always verified rather than overwritten.
    await link(pending, target);
    await syncDirectory(blobsRoot);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      const current = await readPrivateEffectModuleFile(target, bytes.byteLength, stateRoot);
      if (current.byteLength !== bytes.byteLength || sha256(current) !== expectedSha256) {
        throw privateChanged("Effect-module content-addressed blob raced with different immutable bytes.");
      }
      return;
    }
    throw error;
  } finally {
    await rm(pending, { force: true }).catch(() => undefined);
  }
  const published = await readPrivateEffectModuleFile(target, bytes.byteLength, stateRoot);
  if (published.byteLength !== bytes.byteLength || sha256(published) !== expectedSha256) throw privateChanged("Effect-module blob changed during publication.");
}

/** Publish registry generation last. POSIX flushes both the data file and its parent directory. */
export async function publishPrivateEffectModuleRegistry(
  stateRoot: string, generationsRoot: string, stagingRoot: string, generation: number, text: Buffer,
  afterTargetAbsenceCheckForTest?: () => Promise<void> | void
): Promise<void> {
  const target = join(generationsRoot, generationFileName(generation));
  if (await tryLstat(target)) throw privateChanged("Effect-module registry generation already exists and cannot be replaced.");
  const pending = join(stagingRoot, `.generation-${randomUUID()}.json`);
  await writeSyncedExclusive(pending, text, stagingRoot);
  await assertEffectModuleRegistryRoot(stateRoot);
  try {
    await afterTargetAbsenceCheckForTest?.();
    // See blob publication above: link is same-filesystem and refuses to overwrite an immutable
    // generation on every supported host, unlike POSIX rename.
    await link(pending, target);
    await syncDirectory(generationsRoot);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      const current = await readPrivateEffectModuleFile(target, text.byteLength, stateRoot);
      if (current.byteLength !== text.byteLength || !current.equals(text)) {
        throw privateChanged("Effect-module registry generation raced with different immutable bytes.");
      }
      await syncDirectory(generationsRoot);
      return;
    }
    throw error;
  } finally {
    await rm(pending, { force: true }).catch(() => undefined);
  }
}

export async function assertEffectModuleRegistryRoot(
  configuredRoot: string,
  /** Test seam proving legitimate entry churn cannot masquerade as root-object replacement. */
  afterOpenedIdentityReadForTest?: () => Promise<void> | void
): Promise<string> {
  if (!isAbsolute(configuredRoot)) throw privateInvalid("Effect-module registry root must be an absolute private host directory.");
  const root = resolve(configuredRoot);
  const directoryFlags = constants.O_RDONLY
    | (typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0)
    | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  const handle = await open(root, directoryFlags).catch(() => { throw privateInvalid("Effect-module registry root must be pre-created by the host."); });
  try {
    const opened = await handle.stat({ bigint: true });
    const named = await lstat(root, { bigint: true });
    const canonical = await realpath(root);
    if (canonical !== root || opened.dev !== named.dev || opened.ino !== named.ino
      || !opened.isDirectory() || opened.isSymbolicLink() || !named.isDirectory() || named.isSymbolicLink()) {
      throw privateInvalid("Effect-module registry root must be a private real directory.");
    }
    if (process.platform !== "win32" && ((opened.mode & 0o077n) !== 0n || (named.mode & 0o077n) !== 0n)) {
      throw privateInvalid("Effect-module registry root must be private to the current user.");
    }
    await afterOpenedIdentityReadForTest?.();
    const after = await lstat(root, { bigint: true });
    const canonicalAfter = await realpath(root);
    // Keep the original directory open across the final path lookup. This prevents inode reuse
    // from disguising delete-and-recreate replacement, while allowing the lock protocol's
    // legitimate directory timestamp/size churn. Entry shape is checked under the acquired lock.
    if (canonicalAfter !== root || after.dev !== opened.dev || after.ino !== opened.ino || !after.isDirectory() || after.isSymbolicLink()
      || (process.platform !== "win32" && (after.mode & 0o077n) !== 0n)) {
      throw privateChanged("Effect-module registry root changed while being admitted.");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return root;
}

function asyncDelay(milliseconds: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }

async function acquireLock(path: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.sync();
      return handle;
    } catch (error: any) {
      const existing = await lstat(path).catch(() => undefined);
      if (existing?.isSymbolicLink()) throw privateInvalid("Effect-module registry lock was replaced by a symbolic link.");
      if (error?.code !== "EEXIST") throw error;
      await asyncDelay(Math.min(10 + attempt, 50));
    }
  }
  throw new EffectModuleRegistryError("Effect-module registry is busy; retry after the active operator action completes.", "private_state_busy");
}

async function ensurePrivateChild(stateRoot: string, name: "blobs" | "generations" | "staging"): Promise<string> {
  const path = join(stateRoot, name);
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw privateInvalid(`Effect-module ${name} directory is unsafe.`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) await chmod(path, 0o700);
  const canonical = await realpath(path);
  if (canonical !== path || !inside(stateRoot, canonical)) throw privateInvalid(`Effect-module ${name} directory traverses a symbolic link.`);
  return canonical;
}

async function assertRootEntries(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length > MAX_ROOT_ENTRIES) throw privateInvalid("Effect-module registry root contains too many entries; operator recovery is required.");
  for (const entry of entries) {
    const expected = entry.name === "blobs" || entry.name === "generations" || entry.name === "staging" ? "directory" : entry.name === ".registry.lock" ? "file" : null;
    if (!expected || !ALLOWED_ROOT_ENTRIES.has(entry.name) || entry.isSymbolicLink() || (expected === "file" ? !entry.isFile() : !entry.isDirectory())) {
      throw privateInvalid("Effect-module registry root contains an unexpected or unsafe entry; operator recovery is required.");
    }
  }
}

async function writeSyncedExclusive(path: string, bytes: Buffer, directory: string): Promise<void> {
  const before = await lstat(directory);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (written.bytesWritten === 0) throw privateChanged("Effect-module private write made no progress.");
      offset += written.bytesWritten;
    }
    await handle.sync();
  } finally { await handle?.close().catch(() => undefined); }
  const after = await lstat(directory);
  if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory() || after.isSymbolicLink()) {
    throw privateChanged("Effect-module private directory changed while writing.");
  }
}

async function readExactly(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size + 1); let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return bytes.subarray(0, offset);
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose a directory fsync through Node. Publication uses an immutable,
  // already-synced generation file and recovery scans only complete exact generation names: a
  // power interruption therefore observes either the previous immutable generation or the new one,
  // never adopts staging. POSIX additionally flushes the containing directory below.
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close().catch(() => undefined); }
}

async function tryLstat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function generationFileName(generation: number): string { return `generation-${String(generation).padStart(12, "0")}.json`; }
export function isEffectModuleGenerationFileName(value: string): boolean { return /^generation-[0-9]{12}\.json$/.test(value); }
function basenameLeaf(path: string): string { return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1); }
function safeStagingLeaf(value: string): boolean { return /^\.(?:candidate|blob|generation)-[0-9a-f-]{16,64}(?:\.json)?$/i.test(value); }
function same(left: { dev: number; ino: number; size?: number; mtimeMs?: number; ctimeMs?: number }, right: { dev: number; ino: number; size?: number; mtimeMs?: number; ctimeMs?: number }): boolean { return left.dev === right.dev && left.ino === right.ino && (left.size === undefined || right.size === undefined || left.size === right.size) && (left.mtimeMs === undefined || right.mtimeMs === undefined || left.mtimeMs === right.mtimeMs) && (left.ctimeMs === undefined || right.ctimeMs === undefined || left.ctimeMs === right.ctimeMs); }
function inside(root: string, value: string): boolean { const relation = relative(resolve(root), resolve(value)); return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation)); }
function privateInvalid(message: string): EffectModuleRegistryError { return new EffectModuleRegistryError(message, "private_state_invalid"); }
function privateChanged(message: string): EffectModuleRegistryError { return new EffectModuleRegistryError(message, "private_state_changed"); }
