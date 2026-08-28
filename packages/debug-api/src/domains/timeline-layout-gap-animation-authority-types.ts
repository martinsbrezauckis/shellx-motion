import type { StablePathIdentity } from "./timeline-layout-application-authority-store.js";

export interface PackageLineage extends StablePathIdentity {
  manifestId: string;
  manifestSha256: string;
  motionSha256: string;
  motionCanonicalSha256: string;
}

export interface StaticEvidence {
  layoutApplicationsSha256: string;
  applicationSha256: string;
  directChildrenSha256: string;
  patchesSha256: string;
}

export interface ReceiptEvidence {
  id: string;
  sha256: string;
  operation: string;
  status: "passed" | "warning";
  packageId: string;
  outputMotionSha256: string;
}

export interface ActiveAuthority {
  schema: "shellx-motion/timeline-layout-gap-animation-authority@1";
  authorityKey: string;
  receiptsRoot: StablePathIdentity;
  package: PackageLineage;
  application: { id: string; fingerprint: string };
  static: StaticEvidence;
  previousAuthorityKey: string;
  receipt: ReceiptEvidence;
}

export interface LayoutGapAnimationContinuation {
  readonly authorityKey: string;
  readonly receiptsRoot: StablePathIdentity;
  readonly source: PackageLineage;
  readonly application: { id: string; fingerprint: string };
  readonly static: StaticEvidence;
}
