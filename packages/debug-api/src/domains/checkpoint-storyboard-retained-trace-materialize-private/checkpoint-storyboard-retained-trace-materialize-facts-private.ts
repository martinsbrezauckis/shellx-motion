/** Private C6B7b package observations and complete-inventory projections. */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJsonSha256, compareCodeUnits, hashBuffer, loadMotionPackage, readBoundedStableFile, requiredLoadedPackageDocumentHashes, resolvePackageAsset, type MotionPackage } from "@shellx-motion/core";
import { captureTrustedWorkspaceCompleteDirectoryInventoryWithEmptyDirectories } from "@shellx-motion/core/internal/closed-directory-inventory";
import type { TrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
export const C6B7B_SIDECAR_PATH = "analysis/checkpoint-storyboard/parametric-trace.plan.json" as const;
export const C6B7B_RECEIPT_PATH = "receipts/checkpoint-storyboard-parametric-trace.materialize.receipt.json" as const;
export interface C6B7bInventory { readonly sha256: string; readonly entryCount: number; readonly leafCount: number; }
export interface CheckpointStoryboardRetainedTraceMaterializationHost { readonly sourcePackageRoot: string; readonly outputPackageRoot: string; readonly packageWorkspaceRoot: string; readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor; }
export interface CheckpointStoryboardRetainedTraceMaterializationOutputHost { readonly outputPackageRoot: string; readonly packageWorkspaceRoot: string; readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor; }
export type C6B7bWorkspaceHost = Pick<CheckpointStoryboardRetainedTraceMaterializationHost, "packageWorkspaceRoot" | "packageWorkspaceAuthority">;
export interface C6B7bPackageIdentity { readonly packageId: string; readonly manifestRawSha256: string; readonly manifestCanonicalSha256: string; readonly motionRawSha256: string; readonly motionCanonicalSha256: string; readonly inventory: C6B7bInventory; }
export interface C6B7bPackageFacts { readonly pkg: MotionPackage; readonly base: C6B7bPackageIdentity; readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>; }
export async function observeC6B7bPackage(root: string, host: C6B7bWorkspaceHost): Promise<C6B7bPackageFacts> {
  const pkg = await loadMotionPackage(root), loaded = requiredLoadedPackageDocumentHashes(pkg, "C6B7b retained-trace materialization");
  const [manifest, motion, snapshot, inventory] = await Promise.all([
    readBoundedStableFile(join(pkg.root, "manifest.json"), { label: "C6B7b manifest", maxBytes: 4 * 1024 * 1024, withinRoot: pkg.root, allowRootAlias: true, requireSingleLink: true }),
    readBoundedStableFile(resolvePackageAsset(pkg, pkg.manifest.motion), { label: "C6B7b Motion", maxBytes: 64 * 1024 * 1024, withinRoot: pkg.root, requireSingleLink: true }), snapshotPackageEditTree(pkg.root), closedC6B7bInventory(root, host),
  ]);
  if (loaded["manifest.json"] !== manifest.sha256 || loaded[pkg.manifest.motion] !== motion.sha256) throw new PackageEditTransactionError("source_changed", "C6B7b package bytes changed while reopened.");
  return Object.freeze({ pkg, snapshot, base: Object.freeze({ packageId: pkg.manifest.id, manifestRawSha256: manifest.sha256, manifestCanonicalSha256: canonicalJsonSha256(pkg.manifest), motionRawSha256: motion.sha256, motionCanonicalSha256: canonicalJsonSha256(pkg.motion), inventory }) });
}
export async function closedC6B7bInventory(root: string, host: C6B7bWorkspaceHost): Promise<C6B7bInventory> {
  const entry = await lstat(root, { bigint: true }); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new PackageEditTransactionError("unsupported_source_entry", "C6B7b package root is not a regular directory.");
  try { const inventory = await captureTrustedWorkspaceCompleteDirectoryInventoryWithEmptyDirectories({ workspaceRoot: host.packageWorkspaceRoot, workspaceAuthority: host.packageWorkspaceAuthority, directory: root, identity: { dev: Number(entry.dev), ino: Number(entry.ino) }, label: "C6B7b package inventory" }); return Object.freeze({ sha256: inventory.evidence.sha256, entryCount: inventory.evidence.entryCount, leafCount: inventory.evidence.leafCount }); }
  catch { throw new PackageEditTransactionError("unsupported_source_entry", "C6B7b package does not satisfy closed-inventory limits."); }
}
export function c6B7bInventoryForSnapshot(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, omit: readonly string[] = []): C6B7bInventory {
  const entries = [...snapshot.entries].filter(([path]) => !omit.includes(path));
  const files = entries.filter(([, value]) => value.startsWith("file:")).map(([path, value]) => { const match = /^file:([0-9]+):([a-f0-9]{64})$/u.exec(value); if (!match) throw new PackageEditTransactionError("copy_mismatch", "C6B7b inventory contains an invalid file leaf."); return { path, byteLength: Number(match[1]), sha256: match[2]! }; });
  const empties = entries.filter(([path, value]) => value === "dir" && !entries.some(([other]) => other.startsWith(`${path}/`))).map(([path]) => ({ path, kind: "empty-directory" as const }));
  const all = [...files, ...empties].sort((left, right) => compareCodeUnits(left.path, right.path)); const digest = all.map((entry) => "kind" in entry ? `${entry.path}\u0000empty-directory\n` : `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`).join("");
  return Object.freeze({ sha256: hashBuffer(Buffer.from(digest, "utf8")), entryCount: all.length, leafCount: files.length });
}
export function c6B7bPreservedLeaves(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>): { readonly sha256: string; readonly count: number } { const leaves = [...snapshot.entries].filter(([path, value]) => value.startsWith("file:") && path !== C6B7B_SIDECAR_PATH && path !== C6B7B_RECEIPT_PATH).sort(([left], [right]) => compareCodeUnits(left, right)); return Object.freeze({ sha256: canonicalJsonSha256(leaves), count: leaves.length }); }
export function c6B7bSame(left: unknown, right: unknown): boolean { return canonicalJsonSha256(left) === canonicalJsonSha256(right); }
