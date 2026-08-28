/** Shipping-private exact package facts for the C6B6b geometry-morph COW seam. */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
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
import { PackageEditTransactionError } from "../package-edit-transaction.js";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import {
  C6B6B_RECEIPT_PATH,
  type C6B6bExactBase,
  type C6B6bInventory,
} from "./checkpoint-storyboard-geometry-morph-materialize-receipt-private.js";

/** Opaque host-owned source/output/workspace authority; no caller request carries these paths. */
export interface CheckpointStoryboardGeometryMorphMaterializationHost {
  readonly sourcePackageRoot: string;
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}

/** Output-only authority intentionally has no source, plan, approval, or writer capability. */
export interface CheckpointStoryboardGeometryMorphMaterializationOutputHost {
  readonly outputPackageRoot: string;
  readonly packageWorkspaceRoot: string;
  readonly packageWorkspaceAuthority: TrustedWorkspaceAnchor;
}

export type C6B6bWorkspaceHost = Pick<
  CheckpointStoryboardGeometryMorphMaterializationHost,
  "packageWorkspaceRoot" | "packageWorkspaceAuthority"
>;

export interface C6B6bPackageFacts {
  readonly pkg: MotionPackage;
  readonly base: C6B6bExactBase;
  readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>;
}

/** Reads stable one-link manifest/Motion bytes plus the full PackageEdit and empty-directory inventories. */
export async function observeC6B6bPackage(root: string, host: C6B6bWorkspaceHost): Promise<C6B6bPackageFacts> {
  const pkg = await loadMotionPackage(root);
  const loaded = requiredLoadedPackageDocumentHashes(pkg, "C6B6b geometry-morph materialization");
  const [manifest, motion, snapshot, inventory] = await Promise.all([
    readBoundedStableFile(join(pkg.root, "manifest.json"), {
      label: "C6B6b manifest",
      maxBytes: 4 * 1024 * 1024,
      withinRoot: pkg.root,
      allowRootAlias: true,
      requireSingleLink: true,
    }),
    readBoundedStableFile(resolvePackageAsset(pkg, pkg.manifest.motion), {
      label: "C6B6b Motion",
      maxBytes: 64 * 1024 * 1024,
      withinRoot: pkg.root,
      requireSingleLink: true,
    }),
    snapshotPackageEditTree(pkg.root),
    closedC6B6bInventory(root, host),
  ]);
  if (loaded["manifest.json"] !== manifest.sha256 || loaded[pkg.manifest.motion] !== motion.sha256) {
    throw new PackageEditTransactionError("source_changed", "C6B6b package bytes changed while reopened.");
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
      // bindC6B6bExactBase replaces every unbound projection/plan fact; absence stays explicit.
      planFingerprint: "",
      profileFingerprint: "",
      storyboardId: "",
      storyboardSha256: "",
      storyboardRevision: 0,
      sourceLayerId: "",
      sourceLayerIndex: -1,
      sourceGeometrySha256: "",
      sourceGeometryKeyframes: "absent" as const,
      materializedGeometryKeyframesSha256: "",
      outputCanonicalMotionSha256: "",
    }),
  });
}

/** Complete directory evidence includes empty directories; it is not a leaf-only package listing. */
export async function closedC6B6bInventory(root: string, host: C6B6bWorkspaceHost): Promise<C6B6bInventory> {
  const entry = await lstat(root, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new PackageEditTransactionError("unsupported_source_entry", "C6B6b package root is not a regular directory.");
  }
  try {
    const inventory = await captureTrustedWorkspaceCompleteDirectoryInventoryWithEmptyDirectories({
      workspaceRoot: host.packageWorkspaceRoot,
      workspaceAuthority: host.packageWorkspaceAuthority,
      directory: root,
      identity: { dev: Number(entry.dev), ino: Number(entry.ino) },
      label: "C6B6b package inventory",
    });
    return Object.freeze({
      sha256: inventory.evidence.sha256,
      entryCount: inventory.evidence.entryCount,
      leafCount: inventory.evidence.leafCount,
    });
  } catch {
    throw new PackageEditTransactionError("unsupported_source_entry", "C6B6b package does not satisfy closed-inventory limits.");
  }
}

/** All leaves but the exactly changed Motion document and the fixed B6 receipt must remain byte-identical. */
export function c6B6bPreservedLeaves(
  snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>,
  motionPath: string,
): Readonly<{ readonly sha256: string; readonly count: number }> {
  const entries = [...snapshot.entries]
    .filter(([path, value]) => value.startsWith("file:") && path !== motionPath && path !== C6B6B_RECEIPT_PATH)
    .sort(([left], [right]) => compareCodeUnits(left, right));
  return Object.freeze({ sha256: canonicalJsonSha256(entries), count: entries.length });
}

export function c6B6bCurrentInventory(
  snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>,
): C6B6bInventory {
  return c6B6bInventoryForSnapshot(snapshot, false);
}

/** Models the fixed receipt as absent, restoring an empty receipts marker when that was its only child. */
export function c6B6bNonReceiptInventory(
  snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>,
): C6B6bInventory {
  return c6B6bInventoryForSnapshot(snapshot, true);
}

function c6B6bInventoryForSnapshot(
  snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>,
  excludeReceipt: boolean,
): C6B6bInventory {
  const inventoryEntries = [...snapshot.entries].filter(([path]) => !excludeReceipt || path !== C6B6B_RECEIPT_PATH);
  const emptyDirectories = inventoryEntries
    .filter(([path, value]) => value === "dir" && !inventoryEntries.some(([other]) => other.startsWith(`${path}/`)))
    .map(([path]) => ({ path, kind: "empty-directory" as const }));
  const files = inventoryEntries
    .filter(([, value]) => value.startsWith("file:"))
    .map(([path, value]) => {
      const match = /^file:([0-9]+):([a-f0-9]{64})$/u.exec(value);
      if (!match) throw new PackageEditTransactionError("copy_mismatch", "C6B6b output inventory contains a non-file leaf.");
      return { path, byteLength: Number(match[1]), sha256: match[2]! };
    });
  const entries = [...files, ...emptyDirectories].sort((left, right) => compareCodeUnits(left.path, right.path));
  const digest = entries.map((entry) => isEmptyDirectoryMarker(entry)
    ? `${entry.path}\u0000empty-directory\n`
    : `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`).join("");
  return Object.freeze({
    sha256: hashBuffer(Buffer.from(digest, "utf8")),
    entryCount: entries.length,
    leafCount: files.length,
  });
}

/** Canonical equality is the only comparison primitive for C6B6b sealed facts. */
export function c6B6bSame(left: unknown, right: unknown): boolean {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}

export function c6B6bHash(value: unknown): string {
  return canonicalJsonSha256(value);
}

function isEmptyDirectoryMarker(
  entry: { readonly path: string; readonly byteLength: number; readonly sha256: string } | { readonly path: string; readonly kind: "empty-directory" },
): entry is { readonly path: string; readonly kind: "empty-directory" } {
  return Object.hasOwn(entry, "kind");
}
