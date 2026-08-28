/** Optional C5B1 anchor copy kept separate so the C5A beauty transaction remains a small audit unit. */

import {
  withRenderDeliveryEphemeralSourceAuthority,
  type MotionRenderDeliverySourceManifest,
} from "@shellx-motion/core/internal/render-delivery-source";
import {
  abandonOpenedProviderAsset,
  closeAndVerifyAdmittedProviderAsset,
  copyAdmittedProviderAsset,
  openPreparedAbsentAssetDestination,
  prepareAbsentVerifiedAssetDestination,
  type PreparedAbsentAssetDestination,
} from "../package-edit-verified-asset-copy.js";
import { PackageEditTransactionError } from "../package-edit-transaction-error.js";

export interface RenderDeliveryAnchorCopyServices {
  readonly signal?: AbortSignal;
  readonly beforeProviderAnchorCopy?: (asset: Readonly<{ packagePath: string }>) => Promise<void>;
  readonly afterCopiedAnchor?: (asset: Readonly<{ packagePath: string }>) => Promise<void>;
}

/** Reserve the optional target under package authority before any provider source descriptor opens. */
export async function prepareAdmittedRenderDeliveryAnchorDestination(
  manifest: MotionRenderDeliverySourceManifest,
  stagedRoot: string,
  existingAssets: readonly string[],
): Promise<PreparedAbsentAssetDestination | undefined> {
  const fact = manifest.sources.anchors;
  const planned = manifest.plan.assets.anchors;
  if (!fact && !planned) return;
  if (!fact || !planned || fact.packagePath !== planned.packagePath || fact.sha256 !== planned.sha256
    || fact.schema !== planned.schema || fact.deliveryBindingSha256 !== planned.deliveryBindingSha256
    || fact.frameCount !== planned.frameCount || fact.convention !== planned.convention) {
    throw new PackageEditTransactionError("copy_mismatch", "Admitted provider anchor plan does not match its source facts.");
  }
  if (existingAssets.includes(fact.packagePath)) {
    throw new PackageEditTransactionError("copy_mismatch", "Provider delivery asset is already declared by the source package inventory.");
  }
  return await prepareAbsentVerifiedAssetDestination(stagedRoot, fact.packagePath);
}

/** Copy the one already-admitted anchor payload through held two-authority descriptors. */
export async function copyAdmittedRenderDeliveryAnchor(
  manifest: MotionRenderDeliverySourceManifest,
  destination: PreparedAbsentAssetDestination | undefined,
  services: RenderDeliveryAnchorCopyServices,
): Promise<void> {
  const fact = manifest.sources.anchors;
  if (!fact && !destination) return;
  if (!fact || !destination || destination.targetAssetRef !== fact.packagePath) {
    throw new PackageEditTransactionError("copy_mismatch", "Admitted provider anchor destination no longer matches its source facts.");
  }
  assertNotAborted(services.signal);
  const opened = await openPreparedAbsentAssetDestination(destination);
  let copied = false;
  try {
    await withRenderDeliveryEphemeralSourceAuthority(manifest, async (locations) => {
      assertNotAborted(services.signal);
      const location = locations.anchors;
      if (!location || location.identity === undefined) {
        throw new PackageEditTransactionError("source_changed", "Admitted provider anchor source location no longer matches the manifest.");
      }
      await services.beforeProviderAnchorCopy?.({ packagePath: fact.packagePath });
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
  await services.afterCopiedAnchor?.({ packagePath: fact.packagePath });
  assertNotAborted(services.signal);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PackageEditTransactionError("cancelled", "Provider delivery package import was cancelled before output commit.");
}
