/** Exact package-lineage facts shared by static layout authority publication and removal. */
import { canonicalJsonSha256, hashBuffer, MAX_PACKAGE_SOURCE_BYTES } from "@shellx-motion/core";
import {
  readFileInsideRoot,
  samePathIdentity,
  stableDirectory,
} from "./timeline-layout-application-authority-store.js";
import type { PackageLineage } from "./timeline-layout-application-authority-records.js";

export function authorityKeyFor(receiptId: string, lineage: PackageLineage): string {
  return canonicalJsonSha256({ receiptId, package: lineage.path, dev: lineage.dev, ino: lineage.ino }).slice(0, 48);
}

export async function readPackageLineage(
  packageRoot: string,
  manifestPath: string,
  motionPath: string,
  packageId: string,
): Promise<PackageLineage> {
  assertIdentifier(packageId, "package id");
  const root = await stableDirectory(packageRoot, "output package root");
  const [manifest, motion] = await Promise.all([
    readFileInsideRoot(root.path, manifestPath, MAX_PACKAGE_SOURCE_BYTES),
    readFileInsideRoot(root.path, motionPath, MAX_PACKAGE_SOURCE_BYTES),
  ]);
  let motionCanonicalSha256: string;
  try {
    motionCanonicalSha256 = canonicalJsonSha256(JSON.parse(motion.toString("utf8")));
  } catch {
    throw new Error("Layout authority Motion document is not valid JSON.");
  }
  return {
    ...root,
    manifestId: packageId,
    manifestSha256: hashBuffer(manifest),
    motionSha256: hashBuffer(motion),
    motionCanonicalSha256,
  };
}

export function samePackageLineage(left: PackageLineage, right: PackageLineage): boolean {
  return samePathIdentity(left, right)
    && left.manifestId === right.manifestId
    && left.manifestSha256 === right.manifestSha256
    && left.motionSha256 === right.motionSha256
    && left.motionCanonicalSha256 === right.motionCanonicalSha256;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 128) {
    throw new Error(`${label} is invalid.`);
  }
}
