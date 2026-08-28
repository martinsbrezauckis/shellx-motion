import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { compareCodeUnits } from "./canonical-json";
import {
  BoundedResourceBudget,
  DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS,
  readBoundedStableFile,
  type BoundedResourceLimits
} from "./stable-file-read";

export type MotionPackageArchiveWriteLimits = BoundedResourceLimits;

export interface PackageArchiveSourceEntry {
  absolutePath: string;
  path: string;
  size: number;
  sha256: string;
  data: Buffer;
}

export async function collectBoundedPackageArchiveEntries(
  packageRoot: string,
  overrides: Partial<MotionPackageArchiveWriteLimits> | undefined
): Promise<PackageArchiveSourceEntry[]> {
  const limits = resolveArchiveWriteLimits(overrides);
  const budget = new BoundedResourceBudget(limits, "Package archive");
  const files = await collectPackageFiles(packageRoot, budget, 0, packageRoot);
  const entries: PackageArchiveSourceEntry[] = [];
  for (const path of files) {
    budget.beginRead();
    let source;
    try {
      source = await readBoundedStableFile(path, {
        label: `Package archive source ${packageRelativePath(packageRoot, path)}`,
        maxBytes: limits.maxFileBytes,
        withinRoot: packageRoot
      });
    } finally {
      budget.endRead();
    }
    entries.push({ absolutePath: path, path: packageRelativePath(packageRoot, path), size: source.byteLength, sha256: source.sha256, data: source.bytes });
  }
  // Entry order decides the archive's bytes, so a locale-sensitive sort made the archive
  // hash depend on the machine that built it. Code-unit order is the same everywhere.
  return entries.sort((left, right) => compareCodeUnits(left.path, right.path));
}

async function collectPackageFiles(root: string, budget: BoundedResourceBudget, depth = 0, packageRoot = root): Promise<string[]> {
  if (depth > budget.limits.maxPathDepth) {
    throw new Error(`Package archive exceeds the ${budget.limits.maxPathDepth}-component depth limit.`);
  }
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Package archive does not support symbolic links: ${packageRelativePath(root, path)}`);
    }
    if (info.isDirectory()) {
      files.push(...await collectPackageFiles(path, budget, depth + 1, packageRoot));
    } else if (info.isFile()) {
      budget.reserve(path, info.size, packageRoot);
      files.push(path);
    }
  }
  return files.sort((left, right) => compareCodeUnits(packageRelativePath(root, left), packageRelativePath(root, right)));
}

function resolveArchiveWriteLimits(overrides: Partial<MotionPackageArchiveWriteLimits> | undefined): MotionPackageArchiveWriteLimits {
  return {
    maxFileBytes: tighteningLimit(overrides?.maxFileBytes, DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS.maxFileBytes, "maxFileBytes"),
    maxFiles: tighteningLimit(overrides?.maxFiles, DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS.maxFiles, "maxFiles"),
    maxPathDepth: tighteningLimit(overrides?.maxPathDepth, DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS.maxPathDepth, "maxPathDepth"),
    maxAggregateBytes: tighteningLimit(overrides?.maxAggregateBytes, DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS.maxAggregateBytes, "maxAggregateBytes"),
    maxConcurrentReads: tighteningLimit(overrides?.maxConcurrentReads, DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS.maxConcurrentReads, "maxConcurrentReads")
  };
}

function tighteningLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = positiveLimit(value, fallback, name);
  if (resolved > fallback) throw new Error(`Package archive ${name} may not exceed the module cap of ${fallback}.`);
  return resolved;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`Package archive ${name} must be a positive safe integer.`);
  return resolved;
}

function packageRelativePath(root: string, path: string): string {
  const normalized = relative(root, path).split(/[/\\]+/).join("/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Package archive file escapes package root: ${path}`);
  }
  return normalized;
}
