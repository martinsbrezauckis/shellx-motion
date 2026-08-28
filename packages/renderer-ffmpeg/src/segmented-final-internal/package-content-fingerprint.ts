/**
 * Complete, bounded package-content identity for resumable FFmpeg work.
 *
 * This deliberately fingerprints every regular file below an already-resolved Motion package
 * root, not just manifest-declared render inputs. A resumed segment run must not attach its
 * result to a package whose web composition, font, data file, unreferenced asset, or future
 * package-local input changed since it began.
 *
 * The return value is safe receipt material: it contains only a schema, digest, count, and byte
 * total. Relative paths take part in the digest but never leave this module, so neither the
 * identity nor evidence reveals a host path or package file inventory.
 */
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Stats } from "node:fs";
import { compareCodeUnits, hashBuffer, hashFile } from "@shellx-motion/core";

export const MOTION_PACKAGE_CONTENT_FINGERPRINT_SCHEMA = "shellx-motion/renderer-ffmpeg-package-content@1" as const;
export const MOTION_PACKAGE_CONTENT_FINGERPRINT_MAX_FILES = 4_096;
export const MOTION_PACKAGE_CONTENT_FINGERPRINT_MAX_BYTES = 512 * 1024 * 1024;

export interface MotionPackageContentFingerprint {
  schema: typeof MOTION_PACKAGE_CONTENT_FINGERPRINT_SCHEMA;
  sha256: string;
  fileCount: number;
  byteLength: number;
}

/** Internal test seams; production callers use no options and cannot relax the default bounds. */
interface PackageContentFingerprintTestHooks {
  afterFileHashed?(relativePath: string): void | Promise<void>;
}

interface FingerprintResolvedMotionPackageContentOptions {
  /** Test-only narrower bounds. Production code must use the fixed package safety budget. */
  testLimits?: { maxFiles?: number; maxBytes?: number };
  testHooks?: PackageContentFingerprintTestHooks;
  /** Loader-owned hashes whose exact files must still be present in this live package scan. */
  expectedFileHashes?: Readonly<Record<string, string>>;
}

/**
 * Compute a deterministic identity over all regular files within `packageRoot`.
 *
 * `packageRoot` must already be the absolute, lexical resolution held by the loaded Motion
 * package. This module intentionally does not canonicalize it with `realpath`: a symlink at the
 * root is a refused package entry, rather than a host-dependent alias that becomes part of an
 * otherwise portable identity.
 */
export async function fingerprintResolvedMotionPackageContent(
  packageRoot: string,
  options: FingerprintResolvedMotionPackageContentOptions = {}
): Promise<MotionPackageContentFingerprint> {
  assertResolvedPackageRoot(packageRoot);
  const limits = testLimits(options.testLimits);
  const records: string[] = [MOTION_PACKAGE_CONTENT_FINGERPRINT_SCHEMA];
  const expectedFileHashes = normalizedExpectedFileHashes(options.expectedFileHashes);
  let fileCount = 0;
  let byteLength = 0;

  const walk = async (directory: string): Promise<void> => {
    const beforeDirectory = await lstatPackageEntry(directory, directory === packageRoot ? undefined : packageRelativePath(packageRoot, directory));
    if (beforeDirectory.isSymbolicLink()) throw new Error("Motion package contains a symbolic link.");
    if (!beforeDirectory.isDirectory()) throw new Error("Motion package contains a non-directory path in its directory tree.");

    const beforeEntries = await readDirectoryNames(directory);
    for (const name of beforeEntries) {
      const path = join(directory, name);
      const relativePath = packageRelativePath(packageRoot, path);
      const before = await lstatPackageEntry(path, relativePath);
      if (before.isSymbolicLink()) throw new Error(`Motion package contains a symbolic link: ${relativePath}`);

      if (before.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!before.isFile()) throw new Error(`Motion package contains a special file: ${relativePath}`);

      fileCount += 1;
      byteLength += before.size;
      if (fileCount > limits.maxFiles || byteLength > limits.maxBytes) {
        throw new Error("Motion package exceeds the package-content fingerprint budget.");
      }

      const fileSha256 = await hashPackageFile(path, relativePath);
      const expectedSha256 = expectedFileHashes.get(relativePath);
      if (expectedSha256 !== undefined) {
        if (fileSha256 !== expectedSha256) {
          throw new Error(`Motion package loaded input changed before fingerprinting: ${relativePath}`);
        }
        expectedFileHashes.delete(relativePath);
      }
      await options.testHooks?.afterFileHashed?.(relativePath);
      const after = await lstatPackageEntry(path, relativePath);
      if (!sameEntry(before, after, "file")) {
        throw new Error(`Motion package entry changed while fingerprinting: ${relativePath}`);
      }
      records.push(`${relativePath}\0${before.size}\0${fileSha256}`);
    }

    const afterEntries = await readDirectoryNames(directory);
    if (!sameEntryNames(beforeEntries, afterEntries)) {
      throw new Error("Motion package directory changed while fingerprinting.");
    }
    const afterDirectory = await lstatPackageEntry(directory, directory === packageRoot ? undefined : packageRelativePath(packageRoot, directory));
    if (!sameEntry(beforeDirectory, afterDirectory, "directory")) {
      throw new Error("Motion package directory changed while fingerprinting.");
    }
  };

  await walk(packageRoot);
  if (expectedFileHashes.size > 0) {
    throw new Error(`Motion package loaded input is missing from the content fingerprint: ${expectedFileHashes.keys().next().value}`);
  }
  return {
    schema: MOTION_PACKAGE_CONTENT_FINGERPRINT_SCHEMA,
    sha256: hashBuffer(Buffer.from(records.join("\n"), "utf8")),
    fileCount,
    byteLength
  };
}

function normalizedExpectedFileHashes(
  values: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [rawPath, sha256] of Object.entries(values ?? {})) {
    const path = rawPath.replaceAll("\\", "/");
    if (!path
      || path.startsWith("/")
      || /^[A-Za-z]:\//.test(path)
      || path.split("/").some((part) => !part || part === "." || part === "..")
      || !/^[a-f0-9]{64}$/.test(sha256)
      || normalized.has(path)) {
      throw new Error("Loaded package input hashes are invalid for content fingerprinting.");
    }
    normalized.set(path, sha256);
  }
  return normalized;
}

function assertResolvedPackageRoot(packageRoot: string): void {
  if (!packageRoot || !isAbsolute(packageRoot) || resolve(packageRoot) !== packageRoot) {
    throw new Error("Motion package root must be an already-resolved absolute directory path.");
  }
}

function testLimits(overrides: FingerprintResolvedMotionPackageContentOptions["testLimits"]): { maxFiles: number; maxBytes: number } {
  const maxFiles = overrides?.maxFiles ?? MOTION_PACKAGE_CONTENT_FINGERPRINT_MAX_FILES;
  const maxBytes = overrides?.maxBytes ?? MOTION_PACKAGE_CONTENT_FINGERPRINT_MAX_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Package-content fingerprint test limits must be non-negative safe integers.");
  }
  if (maxFiles > MOTION_PACKAGE_CONTENT_FINGERPRINT_MAX_FILES || maxBytes > MOTION_PACKAGE_CONTENT_FINGERPRINT_MAX_BYTES) {
    throw new Error("Package-content fingerprint test limits cannot exceed the fixed package safety budget.");
  }
  return { maxFiles, maxBytes };
}

function packageRelativePath(packageRoot: string, path: string): string {
  const relation = relative(packageRoot, path);
  if (!relation
    || isAbsolute(relation)
    || relation === ".."
    || relation.startsWith(`..${sep}`)
    || relation.split(sep).some((part) => !part || part === "." || part === "..")) {
    throw new Error("Motion package entry escapes the package root.");
  }
  return relation.split(sep).join("/");
}

async function readDirectoryNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort(compareCodeUnits);
  } catch {
    throw new Error("Motion package directory could not be read while fingerprinting.");
  }
}

async function lstatPackageEntry(path: string, relativePath: string | undefined): Promise<Stats> {
  try {
    return await lstat(path);
  } catch {
    throw new Error(relativePath ? `Motion package entry could not be inspected: ${relativePath}` : "Motion package root could not be inspected.");
  }
}

async function hashPackageFile(path: string, relativePath: string): Promise<string> {
  try {
    return await hashFile(path);
  } catch {
    throw new Error(`Motion package entry could not be hashed: ${relativePath}`);
  }
}

function sameEntry(before: Stats, after: Stats, kind: "file" | "directory"): boolean {
  return !after.isSymbolicLink()
    && (kind === "file" ? after.isFile() : after.isDirectory())
    && after.dev === before.dev
    && after.ino === before.ino
    && after.mode === before.mode
    && after.size === before.size
    && after.mtimeMs === before.mtimeMs
    && after.ctimeMs === before.ctimeMs;
}

function sameEntryNames(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((name, index) => name === after[index]);
}
