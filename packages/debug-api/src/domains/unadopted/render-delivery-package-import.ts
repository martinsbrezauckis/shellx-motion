/**
 * Debug-host-only C5A-B package delivery adapter. It is deliberately unregistered: no provider
 * process, runtime connector, CLI, SDK, action, or public capability claim reaches this boundary.
 */
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalJsonSha256,
  compareCodeUnits,
  hashPackageFile,
  loadMotionPackage,
  readBoundedStableFile,
  resolvePackageAsset,
  writeVerifiedBoundedFile,
  type MotionPackage,
} from "@shellx-motion/core";
import {
  revalidateMotionRenderDeliverySources,
  withRenderDeliveryEphemeralSourceAuthority,
  type MotionRenderDeliverySourceManifest,
} from "@shellx-motion/core/internal/render-delivery-source";
import { type TrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { PackageEditTransactionError, commitPackageEdit, writeJson } from "../package-edit-transaction.js";
import {
  abandonOpenedProviderAsset,
  closeAndVerifyAdmittedProviderAsset,
  copyAdmittedProviderAsset,
  openPreparedAbsentAssetDestination,
  prepareAbsentVerifiedAssetDestination,
  type PreparedAbsentAssetDestination,
} from "../package-edit-verified-asset-copy.js";
import {
  copyAdmittedRenderDeliveryAnchor,
  prepareAdmittedRenderDeliveryAnchorDestination,
} from "./render-delivery-package-import-anchor.js";
import {
  assertRenderDeliveryPackageImportReceipt,
  createRenderDeliveryPackageImportReceipt,
  serializedRenderDeliveryPackageImportReceipt,
  type PackageIdentity,
  type RenderDeliveryPackageImportReceipt,
} from "./render-delivery-package-import-receipt.js";
import { withRenderDeliveryPackageWorkspaceAuthority } from "./render-delivery-package-workspace.js";

const PACKAGE_RECEIPT_PATH = "receipts/render-delivery-import.v1.json";
const MAX_PACKAGE_RECEIPT_BYTES = 1024 * 1024;

export interface RenderDeliveryPackageImportHost {
  /** Host-selected package input. This path is never placed in the durable package receipt. */
  readonly sourcePackageRoot: string;
  /** Host-selected COW package output. This path is never placed in the durable package receipt. */
  readonly outputPackageRoot: string;
  /**
   * Exact host-selected root containing both package source and COW output. This opaque authority
   * is distinct from Core's provider-input anchor and is never retained in a receipt.
   */
  readonly packageWorkspaceRoot: string;
  /** Required on POSIX and must be a factory-issued anchor for exactly packageWorkspaceRoot. */
  readonly packageWorkspaceAuthority?: TrustedWorkspaceAnchor;
}

export interface RenderDeliveryPackageImportServices {
  /** Cancellation is observed only before output claim; after the claim begins the COW may complete. */
  readonly signal?: AbortSignal;
  /** Test-only target-side failure after the held destination descriptor exists. */
  readonly beforeProviderSourceCopy?: (asset: Readonly<{ frameIndex: number; packagePath: string }>) => Promise<void>;
  /** Test-only source-side seam for the one optional opaque anchor payload. */
  readonly beforeProviderAnchorCopy?: (asset: Readonly<{ packagePath: string }>) => Promise<void>;
  /** Test-only interruption after a verified staged asset, before transaction validation/commit. */
  readonly afterCopiedAsset?: (asset: Readonly<{ frameIndex: number; packagePath: string }>) => Promise<void>;
  /** Test-only interruption after the verified staged anchor payload, before output claim. */
  readonly afterCopiedAnchor?: (asset: Readonly<{ packagePath: string }>) => Promise<void>;
}

export type { RenderDeliveryPackageImportReceipt } from "./render-delivery-package-import-receipt.js";

export interface RenderDeliveryPackageImportResult {
  /** Non-durable host result; package root selection is not copied into the package receipt. */
  readonly packageRoot: string;
  readonly receipt: RenderDeliveryPackageImportReceipt;
  readonly copiedAssetCount: number;
  readonly copiedByteLength: number;
  /** commitPackageEdit resolved, so its transaction-owned workspace cleanup has completed. */
  readonly workspaceCleanup: "completed";
}

interface StagedImportResult {
  readonly receipt: RenderDeliveryPackageImportReceipt;
}

/**
 * COW-import an original Core-admitted source manifest. A reconstructed/deserialized manifest is
 * rejected by the Core WeakMap handoff before any provider source read can occur.
 */
export async function importAdmittedRenderDeliveryToPackage(
  manifest: MotionRenderDeliverySourceManifest,
  host: RenderDeliveryPackageImportHost,
  services: RenderDeliveryPackageImportServices = {},
): Promise<RenderDeliveryPackageImportResult> {
  assertNotAborted(services.signal);
  return await withPackageWorkspaceAuthority(host, async () => {
    // This initial provider-only revalidation intentionally runs before any package transaction or
    // target-route work, so stale/reconstructed input cannot touch the host package workspace.
    await revalidateMotionRenderDeliverySources(manifest);
    const sourcePackage = await loadMotionPackage(host.sourcePackageRoot);
    const transaction = await commitPackageEdit<StagedImportResult, void>({
      sourceRoot: sourcePackage.root,
      outputRoot: host.outputPackageRoot,
      edit: async (stagedRoot) => {
        const stagedInput = await loadMotionPackage(stagedRoot);
        assertSamePackageDocument(sourcePackage, stagedInput);
        const packageInput = await packageIdentity(stagedInput);
        const facts = manifest.sources.beauty;
        const planned = manifest.plan.assets.beauty;
        if (facts.length !== planned.length || facts.length !== manifest.plan.timing.frameCount) {
          throw new PackageEditTransactionError("copy_mismatch", "Admitted provider delivery plan does not match its source facts.");
        }

        // The copy-stage two-authority handoff acquires all package target routes under package
        // scope before entering Core's exact provider root for a source descriptor.
        const destinations: PreparedAbsentAssetDestination[] = [];
        for (const fact of facts) {
          if (stagedInput.manifest.assets.includes(fact.packagePath)) {
            throw new PackageEditTransactionError("copy_mismatch", "Provider delivery asset is already declared by the source package inventory.");
          }
          destinations.push(await prepareAbsentVerifiedAssetDestination(stagedRoot, fact.packagePath));
        }
        const anchorDestination = await prepareAdmittedRenderDeliveryAnchorDestination(
          manifest,
          stagedRoot,
          stagedInput.manifest.assets,
        );

        for (let index = 0; index < facts.length; index += 1) {
          assertNotAborted(services.signal);
          const fact = facts[index]!;
          const plannedAsset = planned[index];
          const destination = destinations[index];
          if (!plannedAsset || !destination || fact.frameIndex !== plannedAsset.frameIndex
            || fact.packagePath !== plannedAsset.packagePath || fact.sha256 !== plannedAsset.sha256
            || destination.targetAssetRef !== fact.packagePath) {
            throw new PackageEditTransactionError("source_changed", "Admitted provider delivery source ordering changed before package copy.");
          }
          // Open this destination under the package anchor now. The following narrow provider
          // scope only opens the matching source and streams it into this held descriptor.
          const opened = await openPreparedAbsentAssetDestination(destination);
          let copied = false;
          try {
            await withRenderDeliveryEphemeralSourceAuthority(manifest, async (locations) => {
              assertNotAborted(services.signal);
              const location = locations.beauty[index];
              if (locations.beauty.length !== facts.length || !location || location.index !== fact.frameIndex) {
                throw new PackageEditTransactionError("source_changed", "Admitted provider delivery source locations no longer match the manifest.");
              }
              await services.beforeProviderSourceCopy?.({ frameIndex: fact.frameIndex, packagePath: fact.packagePath });
              await copyAdmittedProviderAsset(opened, {
                sourcePath: location.providerLocalPath,
                sourceRoot: locations.providerInputRoot,
                identity: location.identity,
                sha256: fact.sha256,
                byteLength: fact.byteLength,
              });
              assertNotAborted(services.signal);
            });
            copied = true;
          } finally {
            if (!copied) await abandonOpenedProviderAsset(opened);
          }
          await closeAndVerifyAdmittedProviderAsset(opened, fact);
          await services.afterCopiedAsset?.({ frameIndex: fact.frameIndex, packagePath: fact.packagePath });
          assertNotAborted(services.signal);
        }

        await copyAdmittedRenderDeliveryAnchor(manifest, anchorDestination, services);

        const assetInventory = mergeAssets(stagedInput.manifest.assets, [
          ...facts.map((fact) => fact.packagePath),
          ...(manifest.sources.anchors ? [manifest.sources.anchors.packagePath] : []),
        ]);
        await writeJson(join(stagedRoot, "manifest.json"), { ...stagedInput.manifest, assets: assetInventory });
        const reopenedPackage = await packageIdentity(await loadMotionPackage(stagedRoot));
        const receipt = createRenderDeliveryPackageImportReceipt(manifest, packageInput, reopenedPackage);
        await writeExclusivePackageReceipt(stagedRoot, receipt);
        return { receipt };
      },
      validate: async (stagedRoot, staged) => {
        assertNotAborted(services.signal);
        await assertStagedImport(stagedRoot, manifest, staged.receipt);
        // Immediately before output claim, revalidate every source under the original Core-owned
        // provider root. This checks the terminal delivery/source facts after the staged copies.
        await revalidateMotionRenderDeliverySources(manifest);
        assertNotAborted(services.signal);
      },
      beforeCommit: async () => assertNotAborted(services.signal),
      afterCommit: async (outputRoot, staged) => {
        await assertStagedImport(outputRoot, manifest, staged.receipt);
      },
    });
    return {
      packageRoot: transaction.outputRoot,
      receipt: transaction.editResult.receipt,
      copiedAssetCount: manifest.sources.beauty.length + (manifest.sources.anchors ? 1 : 0),
      copiedByteLength: manifest.sourceByteLength,
      workspaceCleanup: "completed",
    };
  });
}

async function withPackageWorkspaceAuthority<T>(
  host: RenderDeliveryPackageImportHost,
  operation: () => Promise<T>,
): Promise<T> {
  const workspace = resolve(host.packageWorkspaceRoot);
  if (!strictDescendant(workspace, resolve(host.outputPackageRoot))) {
    throw new PackageEditTransactionError("unsafe_output", "Package source and COW output must be strict descendants of the host-selected workspace.");
  }
  return await withRenderDeliveryPackageWorkspaceAuthority(host, operation);
}

function strictDescendant(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PackageEditTransactionError("cancelled", "Provider delivery package import was cancelled before output commit.");
}

async function assertStagedImport(
  packageRoot: string,
  manifest: MotionRenderDeliverySourceManifest,
  expectedReceipt: RenderDeliveryPackageImportReceipt,
): Promise<void> {
  assertRenderDeliveryPackageImportReceipt(expectedReceipt);
  const reopened = await loadMotionPackage(packageRoot);
  const actualIdentity = await packageIdentity(reopened);
  if (canonicalJsonSha256(actualIdentity) !== canonicalJsonSha256(expectedReceipt.reopenedPackage)) {
    throw new PackageEditTransactionError("copy_mismatch", "Package reopen identity differs from the provider delivery receipt.");
  }
  const expectedAssets = [...manifest.sources.beauty, ...(manifest.sources.anchors ? [manifest.sources.anchors] : [])];
  if (reopened.manifest.assets.filter((asset) => expectedAssets.some((fact) => fact.packagePath === asset)).length !== expectedAssets.length) {
    throw new PackageEditTransactionError("copy_mismatch", "Reopened package asset inventory omits a copied provider delivery asset.");
  }
  for (const fact of expectedAssets) {
    const asset = await readBoundedStableFile(resolvePackageAsset(reopened, fact.packagePath), {
      label: "Copied provider delivery package asset",
      maxBytes: fact.byteLength,
      withinRoot: reopened.root,
      requireSingleLink: true,
    });
    if (asset.byteLength !== fact.byteLength || asset.sha256 !== fact.sha256) {
      throw new PackageEditTransactionError("copy_mismatch", "Reopened package provider delivery asset does not match its receipt facts.");
    }
  }
  const receipt = await readBoundedStableFile(join(packageRoot, PACKAGE_RECEIPT_PATH), {
    label: "Copied provider delivery package receipt",
    maxBytes: MAX_PACKAGE_RECEIPT_BYTES,
    withinRoot: packageRoot,
    requireSingleLink: true,
  });
  let actualReceipt: unknown;
  try {
    actualReceipt = JSON.parse(receipt.bytes.toString("utf8"));
  } catch {
    throw new PackageEditTransactionError("copy_mismatch", "Reopened package provider delivery receipt is not valid JSON.");
  }
  assertRenderDeliveryPackageImportReceipt(actualReceipt);
  if (receipt.bytes.toString("utf8") !== serializedRenderDeliveryPackageImportReceipt(expectedReceipt)) {
    throw new PackageEditTransactionError("copy_mismatch", "Reopened package provider delivery receipt differs from its staged receipt.");
  }
}

async function writeExclusivePackageReceipt(
  packageRoot: string,
  receipt: RenderDeliveryPackageImportReceipt,
): Promise<void> {
  const bytes = Buffer.from(serializedRenderDeliveryPackageImportReceipt(receipt), "utf8");
  await writeVerifiedBoundedFile(join(packageRoot, PACKAGE_RECEIPT_PATH), bytes, {
    label: "Provider delivery package receipt",
    maxBytes: MAX_PACKAGE_RECEIPT_BYTES,
    withinRoot: packageRoot,
  });
}

async function packageIdentity(pkg: MotionPackage): Promise<PackageIdentity> {
  const [manifestSha256, motionSha256] = await Promise.all([
    hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
    hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion)),
  ]);
  return {
    packageId: pkg.manifest.id,
    manifestSha256,
    motionSha256,
    assetInventorySha256: canonicalJsonSha256(pkg.manifest.assets),
  };
}

function assertSamePackageDocument(source: MotionPackage, staged: MotionPackage): void {
  if (canonicalJsonSha256({ manifest: source.manifest, motion: source.motion }) !== canonicalJsonSha256({ manifest: staged.manifest, motion: staged.motion })) {
    throw new PackageEditTransactionError("source_changed", "Package source changed before provider delivery staging.");
  }
}

function mergeAssets(existing: readonly string[], imported: readonly string[]): string[] {
  return [...new Set([...existing, ...imported])].sort(compareCodeUnits);
}
