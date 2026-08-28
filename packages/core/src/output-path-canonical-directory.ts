import { lstat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { assertWindowsOutputDirectoryAuthorities, WindowsOutputAclError } from "./windows-output-acl";
import { OutputPathTopologyError } from "./output-path-topology-error";

export type CanonicalDirectoryRequest = { path: string; requiresChildWrite: boolean };

export async function canonicalDirectory(path: string, options: { requiresChildWrite: boolean }) {
  return (await canonicalDirectories([{ path, requiresChildWrite: options.requiresChildWrite }]))[0]!;
}

/** Preserve POSIX's per-directory checks while batching a Windows route into one raw-DACL query. */
export async function canonicalRouteDirectories(requests: readonly CanonicalDirectoryRequest[]) {
  if (process.platform === "win32") return await canonicalDirectories(requests);
  const facts = [];
  for (const request of requests) facts.push(await canonicalDirectory(request.path, request));
  return facts;
}

export async function collectEntireExistingRoute(root: string, parentPath: string): Promise<string[] | null> {
  const paths = [root];
  let current = root;
  for (const part of parentPath.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) return null;
    paths.push(current);
  }
  return paths;
}

async function canonicalDirectories(requests: readonly CanonicalDirectoryRequest[]) {
  const before = [];
  for (const request of requests) before.push(await captureCanonicalDirectory(request.path));
  try {
    await assertWindowsOutputDirectoryAuthorities(requests);
  } catch (error) {
    const message = error instanceof WindowsOutputAclError ? error.message : String(error);
    const path = error instanceof WindowsOutputAclError ? error.path ?? requests[0]?.path : requests[0]?.path;
    throw new OutputPathTopologyError(message, path);
  }
  const after = [];
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]!;
    const facts = await captureCanonicalDirectory(request.path);
    const original = before[index]!;
    if (Number(facts.dev) !== Number(original.dev) || Number(facts.ino) !== Number(original.ino)) {
      throw new OutputPathTopologyError("Output parent changed while its authority was inspected.", request.path);
    }
    after.push(facts);
  }
  return after;
}

async function captureCanonicalDirectory(path: string) {
  const facts = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    throw new OutputPathTopologyError(`Output parent could not be inspected safely (${error.code ?? "unknown error"}).`, path);
  });
  if (!facts.isDirectory() || facts.isSymbolicLink()) {
    throw new OutputPathTopologyError("Output parent must be a canonical non-symlink directory.", path);
  }
  if (await realpath(path).catch(() => null) !== path) {
    throw new OutputPathTopologyError("Output parent must be a canonical non-symlink directory.", path);
  }
  assertPosixDirectoryAuthority(facts, path);
  return facts;
}

function assertPosixDirectoryAuthority(facts: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  if (facts.uid !== uid && facts.uid !== 0) {
    throw new OutputPathTopologyError("Output parent is owned by an unrelated POSIX principal.", path);
  }
  const mode = Number(facts.mode);
  if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
    throw new OutputPathTopologyError("Output parent is group- or world-writable without sticky-bit protection.", path);
  }
}
