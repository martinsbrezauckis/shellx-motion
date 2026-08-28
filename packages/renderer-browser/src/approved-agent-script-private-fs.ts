/** Governed private filesystem primitives for the host-owned provenance authority. */
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AgentScriptProvenanceRefusal } from "@shellx-motion/core";

export async function withPrivateStateLock<T>(configuredRoot: string, operation: (stateRoot: string) => Promise<T>): Promise<T> {
  const stateRoot = await ensurePrivateStateRoot(configuredRoot);
  const lockPath = join(stateRoot, ".authority.lock");
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      lock = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    } catch (error) {
      const existing = await lstat(lockPath).catch(() => undefined);
      if (existing?.isSymbolicLink()) throw new AgentScriptProvenanceRefusal("Approved-agent-entry authority lock was replaced by a symbolic link.");
      if (isCode(error, "EEXIST")) throw new AgentScriptProvenanceRefusal("Approved-agent-entry authority is busy or requires operator recovery after an interrupted write.");
      throw error;
    }
    await lock.sync();
    await assertStateRootContents(stateRoot);
    return await operation(stateRoot);
  } finally {
    await lock?.close().catch(() => undefined);
    if (lock) await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export async function createPrivateSessionDirectory(stateRoot: string): Promise<string> {
  const sessionsRoot = await ensurePrivateChildDirectory(stateRoot, "sessions");
  await assertDirectoryEntryBudget(sessionsRoot, 4, "Approved-agent-entry snapshot store");
  const sessionDirectory = await mkdtemp(join(sessionsRoot, "resolve-"));
  const info = await lstat(sessionDirectory);
  if (!info.isDirectory() || info.isSymbolicLink() || !isInside(sessionsRoot, sessionDirectory)) {
    await rm(sessionDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry snapshot directory was not created safely.");
  }
  return sessionDirectory;
}

export async function privateReceiptDirectory(stateRoot: string): Promise<string> {
  return await ensurePrivateChildDirectory(stateRoot, "receipts");
}

export async function assertPrivateDirectoryBudget(directory: string, maximum: number, label: string): Promise<void> {
  await assertDirectoryEntryBudget(directory, maximum, label);
}

export async function readPrivateRegularFile(path: string, maximumBytes: number): Promise<string> {
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > maximumBytes) throw new AgentScriptProvenanceRefusal("Approved-agent-entry private state file is not a bounded regular file.");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino || before.size > maximumBytes) {
      throw new AgentScriptProvenanceRefusal("Approved-agent-entry private state file changed before it could be read.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new AgentScriptProvenanceRefusal("Approved-agent-entry private state file changed while it was being read.");
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function atomicWritePrivateFile(path: string, text: string): Promise<void> {
  const directory = dirname(path);
  const directoryBefore = await lstat(directory);
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) throw new AgentScriptProvenanceRefusal("Approved-agent-entry private state directory is unsafe.");
  const pending = join(directory, `.${basename(path)}.writing-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(pending, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const directoryAfter = await lstat(directory);
    if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink() || directoryAfter.dev !== directoryBefore.dev || directoryAfter.ino !== directoryBefore.ino) {
      throw new AgentScriptProvenanceRefusal("Approved-agent-entry private state directory changed while writing.");
    }
    await rename(pending, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(pending, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

async function assertStateRootContents(stateRoot: string): Promise<void> {
  const entries = await readdir(stateRoot, { withFileTypes: true });
  if (entries.length > 4) throw new AgentScriptProvenanceRefusal("Approved-agent-entry state root contains too many entries; operator recovery is required.");
  for (const entry of entries) {
    const expected = entry.name === ".authority.lock" || entry.name === "attestations.json" ? "file"
      : entry.name === "receipts" || entry.name === "sessions" ? "directory" : null;
    if (!expected || entry.isSymbolicLink() || (expected === "file" ? !entry.isFile() : !entry.isDirectory())) {
      throw new AgentScriptProvenanceRefusal("Approved-agent-entry state root contains an unexpected or unsafe entry; operator recovery is required.");
    }
  }
}

async function ensurePrivateStateRoot(configuredRoot: string): Promise<string> {
  let initial: Awaited<ReturnType<typeof lstat>>;
  try {
    initial = await lstat(configuredRoot);
  } catch {
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry state root must be a pre-created private real directory.");
  }
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new AgentScriptProvenanceRefusal("Approved-agent-entry state root must be a private real directory.");
  const canonical = await realpath(configuredRoot);
  if (canonical !== configuredRoot) throw new AgentScriptProvenanceRefusal("Approved-agent-entry state root must not traverse a symbolic link.");
  if (process.platform !== "win32" && (initial.mode & 0o077) !== 0) throw new AgentScriptProvenanceRefusal("Approved-agent-entry state root must not be readable or writable by group or other users.");
  const after = await lstat(canonical);
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== initial.dev || after.ino !== initial.ino) {
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry state root changed while it was being verified.");
  }
  return canonical;
}

async function ensurePrivateChildDirectory(stateRoot: string, name: "receipts" | "sessions"): Promise<string> {
  const child = join(stateRoot, name);
  try {
    await mkdir(child, { mode: 0o700 });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  const info = await lstat(child);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AgentScriptProvenanceRefusal(`Approved-agent-entry ${name} directory must be a private real directory.`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new AgentScriptProvenanceRefusal(`Approved-agent-entry ${name} directory must not be readable or writable by group or other users.`);
  const canonical = await realpath(child);
  if (canonical !== child || !isInside(stateRoot, canonical)) throw new AgentScriptProvenanceRefusal(`Approved-agent-entry ${name} directory must not traverse a symbolic link.`);
  return canonical;
}

async function assertDirectoryEntryBudget(directory: string, maximum: number, label: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) throw new AgentScriptProvenanceRefusal(`${label} contains a symbolic link.`);
  if (entries.length >= maximum) throw new AgentScriptProvenanceRefusal(`${label} is full; an operator must review or remove expired entries.`);
}

function isInside(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}
