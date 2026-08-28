import { resolvePackageAsset } from "./package";
import { readBoundedStableFile, type StableFileReadResult } from "./stable-file-read";
import type { MotionPackage } from "./types";

/** The hard ceiling shared by package-local runtime asset reads. */
export const MAX_PACKAGE_ASSET_READ_BYTES = 512 * 1024 * 1024;

/**
 * Engine-owned ceiling for admitting one external file into a package revision. It is lower than
 * the runtime-read ceiling because import must make two identity-stable in-memory observations:
 * admission and the later COW copy. Request arguments cannot change this limit.
 */
export const MAX_PACKAGE_ASSET_IMPORT_BYTES = 64 * 1024 * 1024;

/**
 * Read a package-local asset as one bounded, no-follow, inode-stable snapshot.
 *
 * `resolvePackageAsset` remains the pathname API for callers that only need a path. Callers that
 * consume bytes must retain this result's bytes/hash together: re-opening the checked pathname
 * would let a concurrent package supplier substitute a different file before consumption.
 */
export async function readVerifiedPackageAsset(
  pkg: Pick<MotionPackage, "root">,
  assetRef: string,
  options: { label: string; maxBytes?: number }
): Promise<StableFileReadResult> {
  return await readBoundedStableFile(resolvePackageAsset(pkg, assetRef), {
    label: options.label,
    maxBytes: options.maxBytes ?? MAX_PACKAGE_ASSET_READ_BYTES,
    withinRoot: pkg.root
  });
}
