/** Read-only v2 output-root and fill-lock inspection. It never creates a directory or lock. */
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  ATTESTED_REUSE_DIRECTORY,
  AttestedReuseRootRequestError,
  attestedReuseRootRelativePath,
  canonicalAttestedReuseHostPath,
  isInside,
} from "./attested-render-reuse-root.js";

export interface AttestedReuseOutputRootInspection {
  packageRoot: string;
  outputPath: string;
  outputRootRelativePath: string;
  /** The lexical v2 output root. It is canonical when state is materialized. */
  root: string;
  state: "materialized" | "unmaterialized";
}

/**
 * Apply v2's root/fence policy without `mkdir`. A safely absent root is a cache miss observation,
 * not permission to create it; the materialising render path rechecks this policy before writing.
 */
export async function inspectAttestedReuseOutputRootReadOnly(
  packageRoot: string,
  outputPathInput: string,
): Promise<AttestedReuseOutputRootInspection> {
  const outputPath = canonicalAttestedReuseHostPath(outputPathInput);
  const root = resolve(dirname(outputPath));
  if (pathsOverlap(packageRoot, root)) {
    throw new AttestedReuseRootRequestError("attested-reuse output root overlaps the package root");
  }

  const missing: string[] = [];
  let existing = root;
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
  if (!entry!.isDirectory() || entry!.isSymbolicLink()) {
    throw new Error("attested-reuse output root contains a symbolic link or non-directory");
  }
  const canonicalExisting = await realpath(existing);
  if (canonicalExisting !== existing || pathsOverlap(packageRoot, canonicalExisting)) {
    throw new Error("attested-reuse output root is not canonical outside packageRoot");
  }
  const outputRootRelativePath = attestedReuseRootRelativePath(root, outputPath, "render output");
  return {
    packageRoot,
    outputPath,
    outputRootRelativePath,
    root,
    state: missing.length === 0 ? "materialized" : "unmaterialized",
  };
}

/** Inspect an existing root-local fill lock without taking it. */
export async function inspectAttestedReuseFillLockReadOnly(
  root: string,
  cacheKey: string,
): Promise<"absent" | "busy" | "unsafe"> {
  const lockPath = join(root, ATTESTED_REUSE_DIRECTORY, `${cacheKey}.lock`);
  try {
    const entry = await lstat(lockPath);
    return entry.isFile() && !entry.isSymbolicLink() ? "busy" : "unsafe";
  } catch (error) {
    if (code(error) === "ENOENT") return "absent";
    throw error;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isInside(left, right) || isInside(right, left);
}

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}
