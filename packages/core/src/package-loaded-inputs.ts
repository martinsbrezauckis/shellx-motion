import type { MotionPackage } from "./types.js";
import { readBoundedStableFile } from "./stable-file-read.js";
import { parseBoundedPackageJsonBytes } from "./package-json-admission.js";

const loadedPackageHashes = new WeakMap<MotionPackage, Readonly<Record<string, string>>>();
export const PACKAGE_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
export const PACKAGE_MOTION_MAX_BYTES = 64 * 1024 * 1024;
export const PACKAGE_TEMPLATE_MAX_BYTES = 4 * 1024 * 1024;

/** Read one package JSON authority and retain the digest of the exact parsed bytes. */
export async function readStablePackageJson(
  path: string,
  root: string,
  maxBytes: number,
  label: string,
): Promise<{ value: unknown; sha256: string }> {
  // A package root is admitted as one host-selected unit and may itself be reached through a
  // stable POSIX symlink or Windows junction. The stable reader canonicalizes only that root;
  // symlinked descendants and leaf files remain refused.
  const file = await readBoundedStableFile(path, { label, maxBytes, withinRoot: root, allowRootAlias: true });
  return { value: parseBoundedPackageJsonBytes(file.bytes, maxBytes, label), sha256: file.sha256 };
}

/** Attach loader-owned hashes without publishing a caller-forgeable MotionPackage field. */
export function rememberLoadedPackageHashes(pkg: MotionPackage, hashes: Record<string, string>): void {
  loadedPackageHashes.set(pkg, Object.freeze({ ...hashes }));
}

export function loadedPackageInputHashes(pkg: MotionPackage): Readonly<Record<string, string>> | null {
  return loadedPackageHashes.get(pkg) ?? null;
}

/** Require the exact manifest and Motion bytes retained by the package loader. */
export function requiredLoadedPackageInputHashes(pkg: MotionPackage, operation: string): Readonly<Record<string, string>> {
  const loaded = loadedPackageInputHashes(pkg);
  if (!loaded?.["manifest.json"] || !loaded[pkg.manifest.motion]) {
    throw new Error(`${operation} requires loader-owned manifest and Motion input hashes.`);
  }
  return loaded;
}

export function requiredLoadedPackageDocumentHashes(pkg: MotionPackage, operation: string): Record<string, string> {
  const loaded = requiredLoadedPackageInputHashes(pkg, operation);
  return { "manifest.json": loaded["manifest.json"], [pkg.manifest.motion]: loaded[pkg.manifest.motion] };
}
