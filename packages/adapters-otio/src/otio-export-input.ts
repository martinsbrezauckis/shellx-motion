import {
  loadMotionPackage,
  requiredLoadedPackageDocumentHashes,
  type MotionPackage
} from "@shellx-motion/core";

interface OtioExportInputTestHooks {
  afterPackageLoaded?(pkg: MotionPackage): void | Promise<void>;
}

/** Load once and retain the exact structural hashes used by every OTIO export receipt. */
export async function loadOtioExportInput(
  packageRoot: string,
  testHooks: OtioExportInputTestHooks = {}
): Promise<{ pkg: MotionPackage; inputHashes: Record<string, string> }> {
  const pkg = await loadMotionPackage(packageRoot);
  const inputHashes = requiredLoadedPackageDocumentHashes(pkg, "OTIO export");
  await testHooks.afterPackageLoaded?.(pkg);
  return { pkg, inputHashes };
}
