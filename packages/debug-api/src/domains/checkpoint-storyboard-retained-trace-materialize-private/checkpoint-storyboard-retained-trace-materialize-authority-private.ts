/** Private C6B7b host-root authority. Caller data never supplies filesystem paths. */
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import type { CheckpointStoryboardRetainedTraceMaterializationHost } from "./checkpoint-storyboard-retained-trace-materialize-facts-private.js";

export interface C6B7bCanonicalRoots { readonly workspaceRoot: string; readonly sourceRoot: string; readonly outputRoot: string; }
export async function withC6B7bWorkspaceAuthority<T>(host: CheckpointStoryboardRetainedTraceMaterializationHost, operation: (roots: C6B7bCanonicalRoots) => Promise<T>): Promise<T> {
  const workspaceRoot = resolve(host.packageWorkspaceRoot), sourceSpelling = resolve(host.sourcePackageRoot), outputRoot = resolve(host.outputPackageRoot);
  if (!descendant(workspaceRoot, sourceSpelling) || !descendant(workspaceRoot, outputRoot) || overlaps(sourceSpelling, outputRoot)) throw new PackageEditTransactionError("unsafe_output", "C6B7b source and absent output must be non-overlapping strict descendants of the host workspace.");
  try { await assertTrustedWorkspaceAnchorPath(host.packageWorkspaceAuthority, workspaceRoot); } catch (error) { throw new PackageEditTransactionError("unsafe_output", `C6B7b host workspace authority is invalid: ${message(error)}`); }
  return await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => {
    const before = await lstat(sourceSpelling); if (!before.isDirectory() || before.isSymbolicLink()) throw new PackageEditTransactionError("unsafe_output", "C6B7b source package root must be a non-symlink directory.");
    const sourceRoot = await realpath(sourceSpelling).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C6B7b source package root cannot be canonicalized: ${message(error)}`); });
    const after = await lstat(sourceRoot);
    if (sourceRoot !== sourceSpelling || !descendant(workspaceRoot, sourceRoot) || !after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new PackageEditTransactionError("unsafe_output", "C6B7b source package root changed while canonicalizing.");
    const canonicalOutput = await canonicalPath(outputRoot).catch((error) => { throw new PackageEditTransactionError("unsafe_output", `C6B7b output package root cannot be canonicalized: ${message(error)}`); });
    if (canonicalOutput !== outputRoot || !descendant(workspaceRoot, canonicalOutput) || overlaps(sourceRoot, canonicalOutput)) throw new PackageEditTransactionError("unsafe_output", "C6B7b output package root must be a canonical non-overlapping strict workspace descendant.");
    try { await lstat(outputRoot); throw new PackageEditTransactionError("output_not_empty", "C6B7b output package root must be absent."); } catch (error) { if (!missing(error)) throw error; }
    return await operation(Object.freeze({ workspaceRoot, sourceRoot, outputRoot }));
  });
}
export function canonicalC6B7bHost(host: CheckpointStoryboardRetainedTraceMaterializationHost, roots: C6B7bCanonicalRoots): CheckpointStoryboardRetainedTraceMaterializationHost { return Object.freeze({ ...host, packageWorkspaceRoot: roots.workspaceRoot, sourcePackageRoot: roots.sourceRoot, outputPackageRoot: roots.outputRoot }); }
function descendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function overlaps(left: string, right: string): boolean { return left === right || descendant(left, right) || descendant(right, left); }
async function canonicalPath(path: string): Promise<string> { const resolved = resolve(path); try { return await realpath(resolved); } catch { const parent = dirname(resolved); return parent === resolved ? resolved : join(await canonicalPath(parent), basename(resolved)); } }
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT"; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
