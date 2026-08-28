/** No-follow filesystem primitives shared by static and C2 layout host authority. */
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export {
  abortPreparedImmutableJsonPair,
  finalizePreparedImmutableJsonPair,
  prepareImmutableJsonPair,
  readImmutableJsonPair,
  writeImmutableJsonPair,
} from "./timeline-layout-authority-pair-store.js";
export {
  discoverInterruptedLayoutAuthorityPairs,
  openLayoutAuthorityPairDiscovery,
  repairLayoutAuthorityPairDiscoveryPage,
  repairDiscoveredLayoutAuthorityPairs,
} from "./timeline-layout-authority-pair-discovery.js";
export type {
  DiscoveredLayoutAuthorityPair,
  LayoutAuthorityPairDiscoveryPage,
  LayoutAuthorityPairDiscoveryPager,
  RepairedLayoutAuthorityPair,
} from "./timeline-layout-authority-pair-discovery.js";
import {
  recoverInterruptedImmutableJsonPair,
  runHostQuiescentPairRecovery,
} from "./timeline-layout-authority-pair-store.js";
export type {
  ImmutableJsonPair,
  ImmutableJsonPairCommitHooks,
  ImmutableJsonPairDescriptor,
  ImmutableJsonPairReadDescriptor,
  ImmutableJsonPairStep,
  PreparedImmutableJsonPair,
  HostQuiescentPairRecoveryAdmission,
} from "./timeline-layout-authority-pair-store.js";

const AUTHORITY_DIRECTORY = ".shellx-motion-layout-authority";

export interface StablePathIdentity {
  path: string;
  dev: number;
  ino: number;
}

export interface TrustedAuthorityDirectory {
  root: StablePathIdentity;
  path: string;
}

/**
 * Trusted-host repair seam for a crash before pair journal admission. The caller must first make
 * every authority writer sharing this receipts root operationally quiescent; this is intentionally
 * not a Debug command, CLI argument, MCP route, or package-data capability.
 */
export async function repairInterruptedImmutableJsonPairForTrustedHost(
  directory: TrustedAuthorityDirectory,
  input: import("./timeline-layout-authority-pair-types.js").ImmutableJsonPairReadDescriptor,
): Promise<boolean> {
  return await runHostQuiescentPairRecovery(
    directory,
    async (admission) => await recoverInterruptedImmutableJsonPair(directory, input, admission),
  );
}

export async function trustedAuthorityDirectory(
  receiptsRoot: string,
  create: boolean,
): Promise<TrustedAuthorityDirectory> {
  if (typeof receiptsRoot !== "string" || !receiptsRoot) {
    throw new Error("A host-configured receiptsRoot is required.");
  }
  const root = await stableDirectory(resolve(receiptsRoot), "configured receiptsRoot");
  const child = join(root.path, AUTHORITY_DIRECTORY);
  if (create) await mkdirIfAbsent(child);
  const directory = await stableDirectory(child, "layout authority directory");
  if (dirname(directory.path) !== root.path) {
    throw new Error("Layout authority directory escaped the configured receiptsRoot.");
  }
  return { root, path: directory.path };
}

export async function assertCurrentAuthorityDirectory(
  directory: TrustedAuthorityDirectory,
): Promise<void> {
  const root = await stableDirectory(directory.root.path, "configured receiptsRoot");
  const child = await stableDirectory(directory.path, "layout authority directory");
  if (!samePathIdentity(root, directory.root)
    || child.path !== directory.path
    || dirname(child.path) !== root.path) {
    throw new Error("Layout authority directory identity changed during persistence.");
  }
}

export async function readFileInsideRoot(
  root: string,
  candidate: string,
  maximumBytes: number,
): Promise<Buffer> {
  const path = resolve(candidate);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Layout authority file escaped its package root.");
  }
  let current = root;
  for (const segment of rel.split(/[\\/]/u).slice(0, -1)) {
    current = join(current, segment);
    await stableDirectory(current, "package file parent");
  }
  return await readRegularFile(path, maximumBytes);
}

export async function readImmutableJson(path: string, maximumBytes: number): Promise<unknown> {
  const payload = await readRegularFile(path, maximumBytes);
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("Layout authority JSON is malformed.");
  }
}

export function samePathIdentity(left: StablePathIdentity, right: StablePathIdentity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino;
}

export async function stableDirectory(path: string, label: string): Promise<StablePathIdentity> {
  const resolved = resolve(path);
  const before = await lstat(resolved);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory.`);
  }
  const canonical = await realpath(resolved);
  const handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | noFollowFlag());
  try {
    const opened = await handle.stat();
    const after = await lstat(canonical);
    if (!opened.isDirectory()
      || after.isSymbolicLink()
      || after.dev !== opened.dev
      || after.ino !== opened.ino) {
      throw new Error(`${label} changed while it was being inspected.`);
    }
    return { path: canonical, dev: opened.dev, ino: opened.ino };
  } finally {
    await handle.close();
  }
}

/** Read one bounded no-follow regular file, rechecking its opened object before returning bytes. */
export async function readRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new Error("Layout authority file is not a bounded regular file.");
  }
  const handle = await open(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    const opened = await handle.stat();
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size > maximumBytes) {
      throw new Error("Layout authority file changed before opening.");
    }
    const payload = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== opened.dev
      || pathAfter.ino !== opened.ino) {
      throw new Error("Layout authority file changed while reading.");
    }
    return payload;
  } finally {
    await handle.close();
  }
}

async function mkdirIfAbsent(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
}

export function noFollowFlag(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("Layout authority pair persistence requires O_NOFOLLOW support.");
  }
  return fsConstants.O_NOFOLLOW;
}
