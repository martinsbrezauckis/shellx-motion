/** Shipping-private C6B5b workspace authority and canonical-path checks. */
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import type { CheckpointStoryboardLifecycleMaterializationHost } from "./checkpoint-storyboard-lifecycle-materialize-facts-private.js";

export interface C6B5bCanonicalRoots { readonly workspaceRoot: string; readonly sourceRoot: string; readonly outputRoot: string; }

/** The paths here are host-owned capability fields, never materialization request data. */
export async function withC6B5bWorkspaceAuthority<T>(host: CheckpointStoryboardLifecycleMaterializationHost, operation: (roots: C6B5bCanonicalRoots) => Promise<T>): Promise<T> {
  const workspaceRoot = resolve(host.packageWorkspaceRoot), sourceSpelling = resolve(host.sourcePackageRoot), outputRoot = resolve(host.outputPackageRoot);
  if (!strictDescendant(workspaceRoot, sourceSpelling) || !strictDescendant(workspaceRoot, outputRoot) || overlaps(sourceSpelling, outputRoot)) throw new PackageEditTransactionError("unsafe_output", "C6B5b source and absent output must be non-overlapping strict descendants of the host workspace.");
  try { await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspaceRoot); }
  catch (error) { throw new PackageEditTransactionError("unsafe_output", `C6B5b host workspace authority is invalid: ${message(error)}`); }
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    const sourceBefore = await lstat(sourceSpelling);
    if (!sourceBefore.isDirectory() || sourceBefore.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B5b source package root must be a non-symlink directory.");
    const sourceRoot = await realpath(sourceSpelling).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C6B5b source package root cannot be canonicalized: ${message(error)}`); });
    if (sourceRoot !== sourceSpelling || !strictDescendant(workspaceRoot, sourceRoot)) throw new PackageEditTransactionError("unsafe_output", "C6B5b source package root must be a canonical strict workspace descendant without intermediate symlinks.");
    const sourceAfter = await lstat(sourceRoot);
    if (!sourceAfter.isDirectory() || sourceAfter.isSymbolicLink() || sourceAfter.dev !== sourceBefore.dev || sourceAfter.ino !== sourceBefore.ino) throw new PackageEditTransactionError("unsafe_output", "C6B5b source package root changed while canonicalizing.");
    const canonicalOutput = await canonicalPathForSafety(outputRoot).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C6B5b output package root cannot be canonicalized: ${message(error)}`); });
    if (canonicalOutput !== outputRoot || !strictDescendant(workspaceRoot, canonicalOutput) || overlaps(sourceRoot, canonicalOutput)) throw new PackageEditTransactionError("unsafe_output", "C6B5b output package root must be a canonical non-overlapping strict workspace descendant without intermediate symlinks.");
    try { await lstat(outputRoot); throw new PackageEditTransactionError("output_not_empty", "C6B5b output package root must be absent."); }
    catch (error) { if (!missing(error)) throw error; }
    return await operation(Object.freeze({ workspaceRoot, sourceRoot, outputRoot }));
  });
}

export function canonicalC6B5bHost(host: CheckpointStoryboardLifecycleMaterializationHost, roots: C6B5bCanonicalRoots): CheckpointStoryboardLifecycleMaterializationHost {
  return Object.freeze({ ...host, packageWorkspaceRoot: roots.workspaceRoot, sourcePackageRoot: roots.sourceRoot, outputPackageRoot: roots.outputRoot });
}

async function canonicalPathForSafety(path: string): Promise<string> {
  const resolved = resolve(path);
  try { return await realpath(resolved); }
  catch { const parent = dirname(resolved); if (parent === resolved) return resolved; return join(await canonicalPathForSafety(parent), basename(resolved)); }
}
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function overlaps(left: string, right: string): boolean { return left === right || strictDescendant(left, right) || strictDescendant(right, left); }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
