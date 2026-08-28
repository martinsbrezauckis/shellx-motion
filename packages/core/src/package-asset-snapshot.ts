import { readBoundedStableFile, readBudgetedStableFile, writeVerifiedBoundedFile, BoundedResourceBudget, DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS } from "./stable-file-read";
import { resolvePackageAsset } from "./package";
import type { MotionPackage } from "./types";

/**
 * Copy package-declared sidecars into a derived package from one verified source snapshot.
 *
 * Batch expansion is a package-to-package transfer, not a general-purpose file copy: each source
 * ref is confined to the loaded package, admitted under the shared archive-size ceilings, read
 * without following links, and published as those exact bytes. The returned hashes are provenance
 * for the bytes that made the derived package, rather than a later pathname re-hash.
 */
export async function copyVerifiedPackageAssetSnapshots(
  sourcePkg: Pick<MotionPackage, "root">,
  targetRoot: string,
  refs: readonly string[],
  label: string
): Promise<Readonly<Record<string, string>>> {
  const budget = new BoundedResourceBudget(DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS, label);
  const hashes = new Map<string, string>();
  for (const ref of new Set(refs)) {
    const source = await readBudgetedStableFile(resolvePackageAsset(sourcePkg, ref), {
      label: `${label} source ${ref}`,
      budget,
      withinRoot: sourcePkg.root
    });
    const targetPath = resolvePackageAsset({ root: targetRoot }, ref);
    await writeOrVerifySnapshot(targetPath, source.bytes, source.sha256, targetRoot, budget.limits.maxFileBytes, `${label} destination ${ref}`);
    hashes.set(ref, source.sha256);
  }
  return Object.freeze(Object.fromEntries([...hashes.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
}

/** Keep resumable batch packages idempotent without accepting changed or linked destination bytes. */
async function writeOrVerifySnapshot(
  targetPath: string,
  bytes: Buffer,
  sha256: string,
  targetRoot: string,
  maxBytes: number,
  label: string
): Promise<void> {
  try {
    await writeVerifiedBoundedFile(targetPath, bytes, {
      label,
      maxBytes,
      withinRoot: targetRoot,
      expectedSha256: sha256
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readBoundedStableFile(targetPath, { label, maxBytes, withinRoot: targetRoot });
    if (existing.sha256 !== sha256 || existing.byteLength !== bytes.byteLength || !existing.bytes.equals(bytes)) {
      throw new Error(`${label} already exists with different bytes.`);
    }
  }
}
