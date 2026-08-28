/** Static-layout evidence and stable package lineage helpers for C2 host authority. */
import {
  canonicalJson,
  canonicalJsonSha256,
  hashBuffer,
  MAX_PACKAGE_SOURCE_BYTES,
  type MotionDocument,
  type OperationReceipt,
} from "@shellx-motion/core";
import {
  readFileInsideRoot,
  samePathIdentity,
  stableDirectory,
  type StablePathIdentity,
} from "./timeline-layout-application-authority-store.js";
import type {
  PackageLineage,
  ReceiptEvidence,
  StaticEvidence,
} from "./timeline-layout-gap-animation-authority-types.js";

export const MAX_STABLE_PATH_CHARS = 4_096;

export function staticEvidence(
  motion: MotionDocument,
  applicationId: string,
  fingerprint: string,
): StaticEvidence {
  const applications = motion.layoutApplications ?? [];
  const application = applications.find((candidate) => candidate.id === applicationId);
  if (!application || application.fingerprint !== fingerprint) {
    throw new Error("Layout gap authority application marker is missing or stale.");
  }
  const group = motion.layers.find(
    (layer) => layer.id === application.groupId && layer.type === "group",
  );
  if (!group || canonicalJson(group.childLayerIds ?? [])
    !== canonicalJson(application.childLayerIds)) {
    throw new Error("Layout gap authority direct child topology is stale.");
  }
  const byId = new Map(motion.layers.map((layer) => [layer.id, layer]));
  const directChildren = application.childLayerIds.map((id) => {
    const layer = byId.get(id);
    if (!layer) throw new Error(`Layout gap authority child '${id}' is missing.`);
    return {
      id,
      transform: layer.transform,
      startMs: layer.startMs,
      durationMs: layer.durationMs,
    };
  });
  return {
    layoutApplicationsSha256: canonicalJsonSha256(applications),
    applicationSha256: canonicalJsonSha256(application),
    directChildrenSha256: canonicalJsonSha256(directChildren),
    patchesSha256: canonicalJsonSha256(application.patches),
  };
}

export function storePresent(motion: MotionDocument): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(motion, "layoutGapAnimation");
  return descriptor !== undefined && (!("value" in descriptor) || descriptor.value !== undefined);
}

export function receiptFacts(
  receipt: OperationReceipt,
  packageId: string,
  outputMotionSha256: string,
): ReceiptEvidence {
  if (receipt.schema !== "shellx-motion/receipt@1"
    || receipt.lane !== "debug-api"
    || receipt.packageId !== packageId
    || (receipt.status !== "passed" && receipt.status !== "warning")) {
    throw new Error("Layout gap authority receipt identity is invalid.");
  }
  const output = receipt.output as Record<string, unknown>;
  if (typeof output.outputMotionSha256 !== "string"
    || output.outputMotionSha256 !== outputMotionSha256) {
    throw new Error("Layout gap authority receipt does not bind the persisted output Motion document.");
  }
  return {
    id: receipt.id,
    sha256: canonicalJsonSha256(receipt),
    operation: receipt.operation,
    status: receipt.status,
    packageId,
    outputMotionSha256,
  };
}

export function activeKey(lineage: PackageLineage, applicationId: string): string {
  const digest = canonicalJsonSha256({
    package: lineage.path,
    dev: lineage.dev,
    ino: lineage.ino,
    applicationId,
  });
  return `layout-gap-${digest.slice(0, 48)}`;
}

export function ordinaryAuthorityKey(receiptId: string, lineage: PackageLineage): string {
  return canonicalJsonSha256({
    receiptId,
    package: lineage.path,
    dev: lineage.dev,
    ino: lineage.ino,
  }).slice(0, 48);
}

export async function readPackageLineage(
  packageRoot: string,
  manifestPath: string,
  motionPath: string,
  packageId: string,
): Promise<PackageLineage> {
  const root = await stableDirectory(packageRoot, "layout gap authority package root");
  const [manifest, motion] = await Promise.all([
    readFileInsideRoot(root.path, manifestPath, MAX_PACKAGE_SOURCE_BYTES),
    readFileInsideRoot(root.path, motionPath, MAX_PACKAGE_SOURCE_BYTES),
  ]);
  let motionCanonicalSha256: string;
  try {
    motionCanonicalSha256 = canonicalJsonSha256(JSON.parse(motion.toString("utf8")));
  } catch {
    throw new Error("Layout gap authority Motion document is not valid JSON.");
  }
  return {
    ...root,
    manifestId: identifier(packageId, "layout gap authority package id"),
    manifestSha256: hashBuffer(manifest),
    motionSha256: hashBuffer(motion),
    motionCanonicalSha256,
  };
}

export async function readPersistedMotion(
  packageRoot: string,
  motionPath: string,
): Promise<MotionDocument> {
  const root = await stableDirectory(packageRoot, "layout gap authority output package root");
  const bytes = await readFileInsideRoot(root.path, motionPath, MAX_PACKAGE_SOURCE_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8")) as MotionDocument;
  } catch {
    throw new Error("Layout gap authority output Motion document is not valid JSON.");
  }
}

export function sameLineage(left: PackageLineage, right: PackageLineage): boolean {
  return sameIdentity(left, right)
    && left.manifestId === right.manifestId
    && left.manifestSha256 === right.manifestSha256
    && left.motionSha256 === right.motionSha256
    && left.motionCanonicalSha256 === right.motionCanonicalSha256;
}

export function sameIdentity(left: StablePathIdentity, right: StablePathIdentity): boolean {
  return samePathIdentity(left, right);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 128) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
