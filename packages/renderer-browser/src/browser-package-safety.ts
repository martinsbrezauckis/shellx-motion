import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { compareCodeUnits, readBoundedStableFile } from "@shellx-motion/core";

const MAX_FINGERPRINT_FILES = 4_096;
const MAX_FINGERPRINT_BYTES = 536_870_912;

export async function readBrowserPackageFile(
  root: string,
  path: string,
  options: { label: string; maxBytes?: number; missingMessage?: string },
) {
  try {
    return await readBoundedStableFile(path, {
      label: options.label,
      maxBytes: options.maxBytes ?? MAX_FINGERPRINT_BYTES,
      withinRoot: root,
    });
  } catch (error) {
    if (options.missingMessage && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(options.missingMessage);
    }
    throw error;
  }
}

export async function canonicalPathForBrowserSafety(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

export function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export async function browserPackageFingerprint(root: string): Promise<string> {
  const canonicalRoot = await canonicalPathForBrowserSafety(root);
  const records: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    // Code-unit order, not localeCompare: this sort fixes the order of the `path\0size\0hash`
    // records that ARE the fingerprint string, so the ambient locale decided the fingerprint of an
    // unchanged directory. A live probe on one machine, same tree: 1380b63d… under en-US,
    // 70ad8f6c… under sv-SE, f4d0b7df… under tr-TR.
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relative(canonicalRoot, path).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) throw new Error(`Browser render package contains a symbolic link: ${relativePath}`);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Browser render package entry changed while fingerprinting: ${relativePath}`);
      }
      fileCount += 1;
      totalBytes += metadata.size;
      if (fileCount > MAX_FINGERPRINT_FILES || totalBytes > MAX_FINGERPRINT_BYTES) {
        throw new Error("Browser render package exceeds the session fingerprint budget.");
      }
      const file = await readBrowserPackageFile(canonicalRoot, path, { label: `Browser render package entry ${relativePath}` });
      const after = await lstat(path);
      if (!sameFile(metadata, after) || file.byteLength !== metadata.size) {
        throw new Error(`Browser render package entry changed while fingerprinting: ${relativePath}`);
      }
      records.push(`${relativePath}\0${metadata.size}\0${file.sha256}`);
    }
  };

  await walk(canonicalRoot);
  return sha256(records.join("\n"));
}

function sameFile(before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): boolean {
  return !after.isSymbolicLink()
    && after.isFile()
    && after.dev === before.dev
    && after.ino === before.ino
    && after.size === before.size
    && after.mtimeMs === before.mtimeMs;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
