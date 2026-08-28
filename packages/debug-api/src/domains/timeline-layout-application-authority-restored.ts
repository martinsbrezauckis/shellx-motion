/** Restore Core's static-layout removal authorization after verified C2 teardown. */
import { canonicalJsonSha256, type MotionPackage } from "@shellx-motion/core";
import {
  mintMotionLayoutRemovalAuthorization,
  type MotionLayoutRemovalAuthorization,
} from "@shellx-motion/core/internal/layout-removal-authority";
import { samePackageLineage } from "./timeline-layout-application-authority-lineage.js";
import type { RestoredGapAuthority, PackageLineage } from "./timeline-layout-application-authority-records.js";

export function authorizeRestoredGapAuthority(
  authority: RestoredGapAuthority,
  lineage: PackageLineage,
  input: { pkg: MotionPackage; applicationId: string; applicationFingerprint: string },
  receipt: unknown,
): MotionLayoutRemovalAuthorization {
  if (!samePackageLineage(authority.package, lineage)
    || authority.application.id !== input.applicationId
    || authority.application.fingerprint !== input.applicationFingerprint) {
    throw new Error("Restored layout removal authority does not match the current package lineage or application marker.");
  }
  if (canonicalJsonSha256(receipt) !== authority.teardown.receiptSha256) {
    throw new Error("Restored layout removal host receipt does not match its immutable authority record.");
  }
  const record = receiptRecord(receipt);
  const output = receiptRecord(record.output);
  const outputMotionSha256 = sha256(output.outputMotionSha256, "layout gap teardown receipt outputMotionSha256");
  if (record.schema !== "shellx-motion/receipt@1" || record.lane !== "debug-api"
    || record.id !== authority.teardown.receiptId || record.operation !== authority.teardown.operation
    || record.status !== authority.teardown.status || record.packageId !== input.pkg.manifest.id
    || authority.teardown.packageId !== input.pkg.manifest.id) {
    throw new Error("Restored layout removal teardown receipt identity is not exact.");
  }
  if (outputMotionSha256 !== authority.teardown.outputMotionSha256
    || authority.teardown.outputMotionSha256 !== lineage.motionCanonicalSha256) {
    throw new Error("Restored layout removal teardown receipt does not bind the current Motion document.");
  }
  return mintMotionLayoutRemovalAuthorization({
    packageId: input.pkg.manifest.id,
    applicationId: input.applicationId,
    applicationFingerprint: input.applicationFingerprint,
    receiptId: authority.teardown.receiptId,
  });
}

function receiptRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Restored layout removal teardown receipt is malformed.");
  }
  return value as Record<string, unknown>;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}
