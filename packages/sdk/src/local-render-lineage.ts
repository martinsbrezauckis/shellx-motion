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
  type RetainedDirectoryAuthority,
} from "@shellx-motion/core";
import { resolve } from "node:path";

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
  expectedOutputPath: string;
  pkg: MotionPackage;
  preset: string;
  operationHash: string;
  sdkCacheKey: string;
  lineage: PackageRenderLineage;
  authority: RetainedDirectoryAuthority;
}): Promise<AttestedArtifactHandle | null> {
  try {
    await input.authority.assertCurrent();
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
    if (resolve(input.root, handle.rootRelativePath) !== resolve(input.expectedOutputPath)) {
      throw new Error("SDK cached render output does not match the requested outputPath.");
    }
    await assertRenderPackageLineage(input.pkg.root, input.lineage);
    await input.authority.assertCurrent();
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameLineage(left: PackageRenderLineage, right: PackageRenderLineage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
