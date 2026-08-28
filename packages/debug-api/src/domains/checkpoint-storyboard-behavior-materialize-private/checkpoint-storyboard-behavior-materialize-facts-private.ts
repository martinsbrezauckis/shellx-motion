/** Private exact package facts for C6B2 COW and receipt verification. */
import { canonicalJsonSha256, compareCodeUnits, hashBuffer, loadMotionPackage, readBoundedStableFile, requiredLoadedPackageDocumentHashes, resolvePackageAsset, type MotionPackage } from "@shellx-motion/core";
import { captureTrustedWorkspaceCompleteDirectoryInventory } from "@shellx-motion/core/internal/closed-directory-inventory";
import type { TrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { C6B2_RECEIPT_PATH, type C6B2ExactBase, type C6B2Inventory } from "./checkpoint-storyboard-behavior-materialize-receipt-private.js";

export interface CheckpointStoryboardBehaviorMaterializationHost {
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}
export interface CheckpointStoryboardBehaviorMaterializationOutputHost {
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}
type C6B2WorkspaceHost = Pick<CheckpointStoryboardBehaviorMaterializationHost, "packageWorkspaceRoot" | "packageWorkspaceAuthority">;
export interface C6B2PackageFacts { readonly pkg: MotionPackage; readonly base: C6B2ExactBase; readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>; }

export async function observeC6B2Package(root: string, host: C6B2WorkspaceHost): Promise<C6B2PackageFacts> {
  const pkg = await loadMotionPackage(root), loaded = requiredLoadedPackageDocumentHashes(pkg, "C6B2 materialization");
  const [manifest, motion, snapshot, inventory] = await Promise.all([
    readBoundedStableFile(join(pkg.root, "manifest.json"), { label: "C6B2 manifest", maxBytes: 4 * 1024 * 1024, withinRoot: pkg.root, allowRootAlias: true, requireSingleLink: true }),
    readBoundedStableFile(resolvePackageAsset(pkg, pkg.manifest.motion), { label: "C6B2 Motion", maxBytes: 64 * 1024 * 1024, withinRoot: pkg.root, requireSingleLink: true }),
    snapshotPackageEditTree(pkg.root), closedC6B2Inventory(root, host),
  ]);
  if (loaded["manifest.json"] !== manifest.sha256 || loaded[pkg.manifest.motion] !== motion.sha256) throw new PackageEditTransactionError("source_changed", "C6B2 package bytes changed while reopened.");
  return Object.freeze({ pkg, snapshot, base: Object.freeze({ packageId: pkg.manifest.id, manifestRawSha256: manifest.sha256, motionRawSha256: motion.sha256, manifestCanonicalSha256: canonicalJsonSha256(pkg.manifest), motionCanonicalSha256: canonicalJsonSha256(pkg.motion), inventory, planFingerprint: "", profileFingerprint: "", storeSha256: "" }) });
}

export async function closedC6B2Inventory(root: string, host: C6B2WorkspaceHost): Promise<C6B2Inventory> {
  const entry = await lstat(root, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new PackageEditTransactionError("unsupported_source_entry", "C6B2 package root is not a regular directory.");
  try {
    const inventory = await captureTrustedWorkspaceCompleteDirectoryInventory({ workspaceRoot: host.packageWorkspaceRoot, workspaceAuthority: host.packageWorkspaceAuthority, directory: root, identity: { dev: Number(entry.dev), ino: Number(entry.ino) }, label: "C6B2 package inventory" });
    return Object.freeze({ sha256: inventory.evidence.sha256, entryCount: inventory.evidence.entryCount, leafCount: inventory.evidence.entryCount });
  } catch { throw new PackageEditTransactionError("unsupported_source_entry", "C6B2 package does not satisfy closed-inventory limits."); }
}

export function c6B2PreservedLeaves(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, motionPath: string) {
  const entries = [...snapshot.entries].filter(([path, value]) => value.startsWith("file:") && path !== motionPath && path !== C6B2_RECEIPT_PATH).sort(([left], [right]) => compareCodeUnits(left, right));
  return Object.freeze({ sha256: canonicalJsonSha256(entries), count: entries.length });
}
export function c6B2CurrentInventory(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>): C6B2Inventory { return c6B2InventoryForSnapshot(snapshot, false); }
export function c6B2NonReceiptInventory(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>): C6B2Inventory { return c6B2InventoryForSnapshot(snapshot, true); }
function c6B2InventoryForSnapshot(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, excludeReceipt: boolean): C6B2Inventory {
  const entries = [...snapshot.entries].filter(([path, value]) => (!excludeReceipt || path !== C6B2_RECEIPT_PATH) && value.startsWith("file:")).map(([path, value]) => {
    const match = /^file:([0-9]+):([a-f0-9]{64})$/u.exec(value);
    if (!match) throw new PackageEditTransactionError("copy_mismatch", "C6B2 output inventory contains a non-file leaf.");
    return { path, byteLength: Number(match[1]), sha256: match[2]! };
  }).sort((left, right) => compareCodeUnits(left.path, right.path));
  return Object.freeze({ sha256: hashBuffer(Buffer.from(entries.map((entry) => `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`).join(""), "utf8")), entryCount: entries.length, leafCount: entries.length });
}
export function c6B2Same(left: unknown, right: unknown): boolean { return canonicalJsonSha256(left) === canonicalJsonSha256(right); }
