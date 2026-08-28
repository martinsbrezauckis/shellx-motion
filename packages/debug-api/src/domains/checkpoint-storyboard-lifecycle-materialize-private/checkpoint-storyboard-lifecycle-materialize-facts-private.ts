/** Shipping-private exact package facts for the C6B5b lifecycle append COW seam. */
import {
  canonicalJsonSha256,
  compareCodeUnits,
  hashBuffer,
  loadMotionPackage,
  readBoundedStableFile,
  requiredLoadedPackageDocumentHashes,
  resolvePackageAsset,
  type MotionPackage,
} from "@shellx-motion/core";
import { captureTrustedWorkspaceCompleteDirectoryInventoryWithEmptyDirectories } from "@shellx-motion/core/internal/closed-directory-inventory";
import type { TrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { C6B5B_RECEIPT_PATH, type C6B5bExactBase, type C6B5bInventory } from "./checkpoint-storyboard-lifecycle-materialize-receipt-private.js";

export interface CheckpointStoryboardLifecycleMaterializationHost {
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}
export interface CheckpointStoryboardLifecycleMaterializationOutputHost {
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}
type C6B5bWorkspaceHost = Pick<CheckpointStoryboardLifecycleMaterializationHost, "packageWorkspaceRoot" | "packageWorkspaceAuthority">;
export interface C6B5bPackageFacts { readonly pkg: MotionPackage; readonly base: C6B5bExactBase; readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>; }

export async function observeC6B5bPackage(root: string, host: C6B5bWorkspaceHost): Promise<C6B5bPackageFacts> {
  const pkg = await loadMotionPackage(root);
  const loaded = requiredLoadedPackageDocumentHashes(pkg, "C6B5b materialization");
  const [manifest, motion, snapshot, inventory] = await Promise.all([
    readBoundedStableFile(join(pkg.root, "manifest.json"), { label: "C6B5b manifest", maxBytes: 4 * 1024 * 1024, withinRoot: pkg.root, allowRootAlias: true, requireSingleLink: true }),
    readBoundedStableFile(resolvePackageAsset(pkg, pkg.manifest.motion), { label: "C6B5b Motion", maxBytes: 64 * 1024 * 1024, withinRoot: pkg.root, requireSingleLink: true }),
    snapshotPackageEditTree(pkg.root), closedC6B5bInventory(root, host),
  ]);
  if (loaded["manifest.json"] !== manifest.sha256 || loaded[pkg.manifest.motion] !== motion.sha256) throw new PackageEditTransactionError("source_changed", "C6B5b package bytes changed while reopened.");
  return Object.freeze({ pkg, snapshot, base: Object.freeze({
    packageId: pkg.manifest.id, manifestRawSha256: manifest.sha256, motionRawSha256: motion.sha256,
    manifestCanonicalSha256: canonicalJsonSha256(pkg.manifest), motionCanonicalSha256: canonicalJsonSha256(pkg.motion), inventory,
    planFingerprint: "", profileFingerprint: "", storyboardId: "", storyboardSha256: "", storyboardRevision: 0,
    sourceLayerPrefixCount: 0, sourceLayerPrefixSha256: "", generatedLayerIds: Object.freeze([]), generatedLayerIdsSha256: "", generatedLayersSha256: "", timingSha256: "", outputCanonicalMotionSha256: "",
  }) });
}

export async function closedC6B5bInventory(root: string, host: C6B5bWorkspaceHost): Promise<C6B5bInventory> {
  const entry = await lstat(root, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new PackageEditTransactionError("unsupported_source_entry", "C6B5b package root is not a regular directory.");
  try {
    const inventory = await captureTrustedWorkspaceCompleteDirectoryInventoryWithEmptyDirectories({ workspaceRoot: host.packageWorkspaceRoot, workspaceAuthority: host.packageWorkspaceAuthority, directory: root, identity: { dev: Number(entry.dev), ino: Number(entry.ino) }, label: "C6B5b package inventory" });
    return Object.freeze({ sha256: inventory.evidence.sha256, entryCount: inventory.evidence.entryCount, leafCount: inventory.evidence.leafCount });
  } catch { throw new PackageEditTransactionError("unsupported_source_entry", "C6B5b package does not satisfy closed-inventory limits."); }
}

export function c6B5bPreservedLeaves(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, motionPath: string) {
  const entries = [...snapshot.entries].filter(([path, value]) => value.startsWith("file:") && path !== motionPath && path !== C6B5B_RECEIPT_PATH).sort(([left], [right]) => compareCodeUnits(left, right));
  return Object.freeze({ sha256: canonicalJsonSha256(entries), count: entries.length });
}
export function c6B5bCurrentInventory(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>): C6B5bInventory { return c6B5bInventoryForSnapshot(snapshot, false); }
export function c6B5bNonReceiptInventory(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>): C6B5bInventory { return c6B5bInventoryForSnapshot(snapshot, true); }
function c6B5bInventoryForSnapshot(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, excludeReceipt: boolean): C6B5bInventory {
  // The non-receipt inventory models the fixed receipt as absent.  This deliberately restores an
  // empty `receipts/` marker when the receipt was its only child, matching pre-receipt capture.
  const entriesForInventory = [...snapshot.entries].filter(([path]) => !excludeReceipt || path !== C6B5B_RECEIPT_PATH);
  const emptyDirectories = entriesForInventory
    .filter(([path, value]) => value === "dir" && !entriesForInventory.some(([other]) => other.startsWith(`${path}/`)))
    .map(([path]) => ({ path, kind: "empty-directory" as const }));
  const files = entriesForInventory
    .filter(([, value]) => value.startsWith("file:"))
    .map(([path, value]) => {
      const match = /^file:([0-9]+):([a-f0-9]{64})$/u.exec(value); if (!match) throw new PackageEditTransactionError("copy_mismatch", "C6B5b output inventory contains a non-file leaf.");
      return { path, byteLength: Number(match[1]), sha256: match[2]! };
    });
  const entries = [...files, ...emptyDirectories].sort((left, right) => compareCodeUnits(left.path, right.path));
  const digest = entries.map((entry) => isEmptyDirectoryMarker(entry)
    ? `${entry.path}\u0000empty-directory\n`
    : `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`).join("");
  return Object.freeze({ sha256: hashBuffer(Buffer.from(digest, "utf8")), entryCount: entries.length, leafCount: files.length });
}
export function c6B5bPrefixFacts(layers: unknown): { readonly count: number; readonly sha256: string } {
  if (!Array.isArray(layers)) throw new PackageEditTransactionError("source_changed", "C6B5b source Motion layers are invalid.");
  return Object.freeze({ count: layers.length, sha256: canonicalJsonSha256(layers) });
}
export function c6B5bSame(left: unknown, right: unknown): boolean { return canonicalJsonSha256(left) === canonicalJsonSha256(right); }
function isEmptyDirectoryMarker(entry: { readonly path: string; readonly byteLength: number; readonly sha256: string } | { readonly path: string; readonly kind: "empty-directory" }): entry is { readonly path: string; readonly kind: "empty-directory" } { return Object.hasOwn(entry, "kind"); }
