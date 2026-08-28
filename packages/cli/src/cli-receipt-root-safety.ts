/** Read-only canonical containment checks for CLI receipt stores. */
import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/** Resolve symlinks through the nearest existing parent before admitting a receipt store. */
export async function receiptRootIsInsidePackage(packageRoot: string, receiptsRoot: string): Promise<boolean> {
  const resolvedPackageRoot = resolve(packageRoot);
  const resolvedReceiptsRoot = resolve(receiptsRoot);
  const root = resolvedPackageRoot.endsWith(sep) ? resolvedPackageRoot : `${resolvedPackageRoot}${sep}`;
  // Keep this read-only promise even when package parsing later fails and the receipt path is new.
  if (resolvedReceiptsRoot === resolvedPackageRoot || resolvedReceiptsRoot.startsWith(root)) return true;
  const [canonicalPackageRoot, canonicalReceiptAncestor] = await Promise.all([
    realpath(packageRoot),
    canonicalExistingAncestor(receiptsRoot)
  ]);
  const canonicalRoot = canonicalPackageRoot.endsWith(sep) ? canonicalPackageRoot : `${canonicalPackageRoot}${sep}`;
  return canonicalReceiptAncestor === canonicalPackageRoot || canonicalReceiptAncestor.startsWith(canonicalRoot);
}

async function canonicalExistingAncestor(path: string): Promise<string> {
  let candidate = resolve(path);
  for (;;) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}
