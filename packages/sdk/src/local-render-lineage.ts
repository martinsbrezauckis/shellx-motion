import {
  derivePackageRenderLineage,
  loadMotionPackage,
  packageRenderLineageInputHashes,
  readAttestedArtifactHandle,
  validatePackageRenderLineage,
  verifyAttestedArtifactHandle,
  type AttestedArtifactHandle,
  type MotionPackage,
  type PackageRenderLineage,
} from "@shellx-motion/core";

export async function loadStableRenderPackage(
  packageRoot: string,
): Promise<{ pkg: MotionPackage; lineage: PackageRenderLineage }> {
  const lineage = await derivePackageRenderLineage(packageRoot);
  const pkg = await loadMotionPackage(packageRoot);
  await assertRenderPackageLineage(pkg.root, lineage);
  return { pkg, lineage };
}

export async function assertRenderPackageLineage(
  packageRoot: string,
  expected: PackageRenderLineage,
): Promise<void> {
  validatePackageRenderLineage(expected);
  const current = await derivePackageRenderLineage(packageRoot);
  if (!sameLineage(current, expected)) {
    throw new Error("Motion package render lineage changed during the render operation.");
  }
}

export function renderReceiptInputHashes(
  operationHash: string,
  lineage: PackageRenderLineage,
): Record<string, string> {
  if (!/^[a-f0-9]{64}$/.test(operationHash)) throw new Error("render operationHash must be a lowercase SHA-256");
  return { operationHash, ...packageRenderLineageInputHashes(lineage) };
}

export async function readCachedRenderArtifact(input: {
  root: string;
  path: string;
  pkg: MotionPackage;
  preset: string;
  operationHash: string;
  sdkCacheKey: string;
  lineage: PackageRenderLineage;
}): Promise<AttestedArtifactHandle | null> {
  try {
    const handle = await readAttestedArtifactHandle(input.path);
    await verifyAttestedArtifactHandle(input.root, handle, {
      expected: {
        packageId: input.pkg.manifest.id,
        motionId: input.pkg.motion.id,
        preset: input.preset,
        operationHash: input.operationHash,
        packageLineage: input.lineage,
      },
      requiredReceiptRoles: ["render"],
      probe: false,
    });
    if (handle.qualityEvidence?.sdkCacheKey !== input.sdkCacheKey) {
      throw new Error("SDK idempotency key was already used for a different render request.");
    }
    await assertRenderPackageLineage(input.pkg.root, input.lineage);
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameLineage(left: PackageRenderLineage, right: PackageRenderLineage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
