/** Private exact package facts for the C6B4b relation-action COW seam. */
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
import { captureTrustedWorkspaceCompleteDirectoryInventory } from "@shellx-motion/core/internal/closed-directory-inventory";
import type { TrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { C6B4B_RECEIPT_PATH, type C6B4bExactBase, type C6B4bInventory } from "./checkpoint-storyboard-relation-action-materialize-receipt-private.js";

export interface CheckpointStoryboardRelationActionMaterializationHost {
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}

export interface CheckpointStoryboardRelationActionMaterializationOutputHost {
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}

type C6B4bWorkspaceHost = Pick<CheckpointStoryboardRelationActionMaterializationHost, "packageWorkspaceRoot" | "packageWorkspaceAuthority">;

export interface C6B4bPackageFacts {
  readonly pkg: MotionPackage;
  readonly base: C6B4bExactBase;
  readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>;
}

export async function observeC6B4bPackage(root: string, host: C6B4bWorkspaceHost): Promise<C6B4bPackageFacts> {
  const pkg = await loadMotionPackage(root);
  const loaded = requiredLoadedPackageDocumentHashes(pkg, "C6B4b materialization");
  const [manifest, motion, snapshot, inventory] = await Promise.all([
    readBoundedStableFile(join(pkg.root, "manifest.json"), { label: "C6B4b manifest", maxBytes: 4 * 1024 * 1024, withinRoot: pkg.root, allowRootAlias: true, requireSingleLink: true }),
    readBoundedStableFile(resolvePackageAsset(pkg, pkg.manifest.motion), { label: "C6B4b Motion", maxBytes: 64 * 1024 * 1024, withinRoot: pkg.root, requireSingleLink: true }),
    snapshotPackageEditTree(pkg.root),
    closedC6B4bInventory(root, host),
  ]);
  if (loaded["manifest.json"] !== manifest.sha256 || loaded[pkg.manifest.motion] !== motion.sha256) {
    throw new PackageEditTransactionError("source_changed", "C6B4b package bytes changed while reopened.");
  }
  return Object.freeze({
    pkg,
    snapshot,
    base: Object.freeze({
      packageId: pkg.manifest.id,
      manifestRawSha256: manifest.sha256,
      motionRawSha256: motion.sha256,
      manifestCanonicalSha256: canonicalJsonSha256(pkg.manifest),
      motionCanonicalSha256: canonicalJsonSha256(pkg.motion),
      inventory,
      planFingerprint: "",
      profileFingerprint: "",
      actionStoreSchema: "shellx-motion/relation-actions@2",
      actionStoreSha256: "",
      actionDefinitionId: "",
      actionDefinitionSha256: "",
      actionRequestInstanceId: "",
      actionRequestSha256: "",
      actionApplyPlanFingerprint: "",
      actionObjects: 0,
      actionRelations: 1,
      actionKeyframeWrites: 0,
      actionChangedPath: "",
      actionOutputCanonicalMotionSha256: "",
      storeSha256: "",
      staticFingerprint: "",
      gpuStaticFingerprint: "",
      startFramePlanFingerprint: "",
      endFramePlanFingerprint: "",
      relationId: "",
    }),
  });
}

export async function closedC6B4bInventory(root: string, host: C6B4bWorkspaceHost): Promise<C6B4bInventory> {
  const entry = await lstat(root, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new PackageEditTransactionError("unsupported_source_entry", "C6B4b package root is not a regular directory.");
  }
  try {
    const inventory = await captureTrustedWorkspaceCompleteDirectoryInventory({
      workspaceRoot: host.packageWorkspaceRoot,
      workspaceAuthority: host.packageWorkspaceAuthority,
      directory: root,
      identity: { dev: Number(entry.dev), ino: Number(entry.ino) },
      label: "C6B4b package inventory",
    });
    return Object.freeze({ sha256: inventory.evidence.sha256, entryCount: inventory.evidence.entryCount, leafCount: inventory.evidence.entryCount });
  } catch {
    throw new PackageEditTransactionError("unsupported_source_entry", "C6B4b package does not satisfy closed-inventory limits.");
  }
}

export function c6B4bPreservedLeaves(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, motionPath: string) {
  const entries = [...snapshot.entries]
    .filter(([path, value]) => value.startsWith("file:") && path !== motionPath && path !== C6B4B_RECEIPT_PATH)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  return Object.freeze({ sha256: canonicalJsonSha256(entries), count: entries.length });
}

export function c6B4bCurrentInventory(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>): C6B4bInventory {
  return c6B4bInventoryForSnapshot(snapshot, false);
}

export function c6B4bNonReceiptInventory(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>): C6B4bInventory {
  return c6B4bInventoryForSnapshot(snapshot, true);
}

function c6B4bInventoryForSnapshot(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>, excludeReceipt: boolean): C6B4bInventory {
  const entries = [...snapshot.entries]
    .filter(([path, value]) => (!excludeReceipt || path !== C6B4B_RECEIPT_PATH) && value.startsWith("file:"))
    .map(([path, value]) => {
      const match = /^file:([0-9]+):([a-f0-9]{64})$/u.exec(value);
      if (!match) throw new PackageEditTransactionError("copy_mismatch", "C6B4b output inventory contains a non-file leaf.");
      return { path, byteLength: Number(match[1]), sha256: match[2]! };
    })
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  return Object.freeze({
    sha256: hashBuffer(Buffer.from(entries.map((entry) => `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`).join(""), "utf8")),
    entryCount: entries.length,
    leafCount: entries.length,
  });
}

export function c6B4bSame(left: unknown, right: unknown): boolean {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}
