import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MotionDebugResult } from "../command-registry.js";

export class AttestedReuseRootRequestError extends Error {}
/** Fixed v2 descriptor/lock location beneath a caller-selected output root. */
export const ATTESTED_REUSE_DIRECTORY = ".shellx-motion/render-reuse/v2";

export function invalidAttestedReuseArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

/** Translate only Darwin's stable system aliases; arbitrary caller-created symlinks stay denied. */
export function canonicalAttestedReuseHostPath(pathInput: string, platform = process.platform): string {
  const path = resolve(pathInput);
  if (platform !== "darwin") return path;
  for (const alias of ["/var", "/tmp", "/etc"]) {
    if (path === alias || path.startsWith(`${alias}${sep}`)) return `/private${path}`;
  }
  return path;
}

export async function prepareAttestedReuseOutputRoot(packageRoot: string, candidateInput: string): Promise<string> {
  const candidate = canonicalAttestedReuseHostPath(candidateInput);
  if (pathsOverlap(packageRoot, candidate)) throw new AttestedReuseRootRequestError("motion.render.final reuseAttested requires outputPath outside packageRoot.");
  const missing: string[] = [];
  let existing = candidate;
  let entry: Awaited<ReturnType<typeof lstat>>;
  for (;;) {
    try {
      entry = await lstat(existing);
      break;
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      existing = parent;
    }
  }
  if (!entry!.isDirectory() || entry!.isSymbolicLink()) throw new Error("attested-reuse output root contains a symbolic link or non-directory");
  let current = await realpath(existing);
  if (pathsOverlap(packageRoot, current) || current !== existing) throw new Error("attested-reuse output root is not canonical outside packageRoot");
  for (const part of missing) {
    const next = join(current, part);
    try {
      await mkdir(next);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
    const created = await lstat(next);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("attested-reuse output root contains a symbolic link or non-directory");
    const canonical = await realpath(next);
    if (canonical !== next || pathsOverlap(packageRoot, canonical)) throw new Error("attested-reuse output root escaped or overlaps packageRoot");
    current = canonical;
  }
  return current;
}

export async function attestedReuseDirectoryInsideRootExists(root: string, candidateInput: string, label: string): Promise<boolean> {
  const candidate = canonicalAttestedReuseHostPath(candidateInput);
  if (!isInside(root, candidate)) throw new AttestedReuseRootRequestError(`${label} must be inside the output root`);
  const relativePath = relative(root, candidate);
  let current = root;
  for (const part of relativePath ? relativePath.split(sep) : []) {
    current = join(current, part);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (code(error) === "ENOENT") return false;
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} contains a symbolic link or non-directory`);
    const canonical = await realpath(current);
    if (!isInside(root, canonical) || canonical !== current) throw new Error(`${label} escapes the output root`);
  }
  return true;
}

export async function ensureAttestedReuseDirectoryInsideRoot(root: string, candidateInput: string, label: string, callerSelected = false): Promise<string> {
  const candidate = canonicalAttestedReuseHostPath(candidateInput);
  if (!isInside(root, candidate)) {
    const message = `${label} must be inside the output root`;
    if (callerSelected) throw new AttestedReuseRootRequestError(message);
    throw new Error(message);
  }
  const relativePath = relative(root, candidate);
  let current = root;
  for (const part of relativePath ? relativePath.split(sep) : []) {
    current = join(current, part);
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (createError) {
        if (code(createError) !== "EEXIST") throw createError;
      }
      entry = await lstat(current);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} contains a symbolic link or non-directory`);
    const canonical = await realpath(current);
    if (!isInside(root, canonical) || canonical !== current) throw new Error(`${label} escapes the output root`);
  }
  return current;
}

export async function attestedReusePathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

export async function acquireAttestedReuseFillLock(lockPath: string): Promise<"acquired" | "busy" | "invalid"> {
  try {
    const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await lock.writeFile(`${process.pid}\n`, "utf8");
    } finally {
      await lock.close();
    }
    return "acquired";
  } catch (error) {
    if (code(error) !== "EEXIST") throw error;
  }
  try {
    const entry = await lstat(lockPath);
    return entry.isFile() && !entry.isSymbolicLink() ? "busy" : "invalid";
  } catch (error) {
    if (code(error) === "ENOENT") return "busy";
    throw error;
  }
}

export async function releaseAttestedReuseFillLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true }).catch(() => undefined);
}

export function attestedReuseRootRelativePath(root: string, path: string, label: string): string {
  const value = relative(canonicalAttestedReuseHostPath(root), canonicalAttestedReuseHostPath(path)).replaceAll("\\", "/");
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value)) throw new AttestedReuseRootRequestError(`${label} is outside its root`);
  return value;
}

function pathsOverlap(left: string, right: string): boolean {
  return isInside(left, right) || isInside(right, left);
}

export function isInside(root: string, candidate: string): boolean {
  const value = relative(canonicalAttestedReuseHostPath(root), canonicalAttestedReuseHostPath(candidate));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}
