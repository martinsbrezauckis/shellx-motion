import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const MAX_TIMELINE_STATE_BYTES = 1024 * 1024;

export interface TrustedTimelineStateDirectory { path: string; dev: number; ino: number; }

/** Private deterministic race seam; production callers leave it empty. */
export interface TimelineControlPersistenceServices {
  afterDirectoryRecheck?: (input: { temporaryStatePath: string }) => Promise<void>;
}

export async function persistTimelineControlState(
  directory: TrustedTimelineStateDirectory,
  state: unknown,
  currentDirectory: () => Promise<TrustedTimelineStateDirectory | null>,
  services: TimelineControlPersistenceServices = {}
): Promise<void> {
  const capability = await retainStateDirectoryCapability(directory);
  const statePath = capabilityChildPath(capability, "timeline-state.json");
  const tempPath = capabilityChildPath(capability, `.timeline-state.${randomUUID()}.tmp`);
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_TIMELINE_STATE_BYTES) throw new Error("Timeline control state exceeds the byte limit.");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(payload, "utf8"); await handle.sync();
    if (!await isExclusivePayload(handle, payload)) throw new Error("Timeline control temporary state lost its exclusive file identity.");
    await handle.close(); handle = undefined;
    if (!await exactDirectory(currentDirectory, directory)) throw new Error("Timeline control state directory changed before commit.");
    try {
      const existing = await lstat(statePath);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Timeline control state destination must be a regular file.");
    } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    await services.afterDirectoryRecheck?.({ temporaryStatePath: tempPath });
    const prepared = await lstat(tempPath);
    if (!prepared.isFile() || prepared.isSymbolicLink() || prepared.nlink !== 1 || prepared.size !== Buffer.byteLength(payload, "utf8")) {
      throw new Error("Timeline control temporary state changed before commit.");
    }
    await rename(tempPath, statePath);
    if (!await exactDirectory(currentDirectory, directory)) throw new Error("Timeline control state directory changed during commit.");
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    await capability.handle.close().catch(() => {});
  }
}

export { MAX_TIMELINE_STATE_BYTES };

async function isExclusivePayload(handle: Awaited<ReturnType<typeof open>>, payload: string): Promise<boolean> {
  const written = await handle.stat();
  return written.isFile() && written.nlink === 1 && written.size === Buffer.byteLength(payload, "utf8");
}

async function exactDirectory(current: () => Promise<TrustedTimelineStateDirectory | null>, expected: TrustedTimelineStateDirectory): Promise<boolean> {
  const actual = await current();
  return actual !== null && actual.dev === expected.dev && actual.ino === expected.ino;
}

async function retainStateDirectoryCapability(directory: TrustedTimelineStateDirectory): Promise<{ handle: Awaited<ReturnType<typeof open>>; path: string; dev: number; ino: number }> {
  if (process.platform !== "linux" || typeof fsConstants.O_DIRECTORY !== "number" || typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("Timeline control persistence requires retained no-follow directory capability support.");
  }
  const handle = await open(directory.path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat(); const current = await lstat(directory.path);
    if (!opened.isDirectory() || current.isSymbolicLink() || current.dev !== directory.dev || current.ino !== directory.ino) {
      throw new Error("Timeline control state directory changed before capability retention.");
    }
    const path = `/proc/self/fd/${handle.fd}`;
    if (!(await lstat(path)).isSymbolicLink()) throw new Error("Timeline control directory capability is unavailable.");
    return { handle, path, dev: opened.dev, ino: opened.ino };
  } catch (error) { await handle.close().catch(() => {}); throw error; }
}

function capabilityChildPath(capability: { path: string; dev: number; ino: number }, leaf: string): string {
  if (capability.dev <= 0 || capability.ino <= 0 || leaf.includes("/") || leaf.includes("\\")) throw new Error("Timeline control directory capability is invalid.");
  return join(capability.path, leaf);
}

function errorCode(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined; }
