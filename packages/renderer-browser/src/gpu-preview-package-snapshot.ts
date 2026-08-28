import { canonicalJsonSha256, type MotionDocument, type MotionPackage } from "@shellx-motion/core";
import { gpuLoadedPackageInputHashes } from "./gpu-loaded-input-hashes";

/** Frozen package identity retained from preflight through the irreversible output commit. */
export interface GpuPreviewPackageSnapshot {
  packageId: string;
  manifestFingerprint: string;
  documentFingerprint: string;
  inputHashes: Readonly<Record<string, string>>;
}

/** Captured before the async Core route, without reading/hashing the Motion document. */
export interface GpuPreviewManifestIdentity { packageId: string; manifestFingerprint: string; }

export function captureGpuPreviewManifestIdentity(pkg: MotionPackage): GpuPreviewManifestIdentity {
  return Object.freeze({ packageId: pkg.manifest.id, manifestFingerprint: canonicalJsonSha256(pkg.manifest) });
}

/** Capture identity only after the selected Core wrapper has admitted this document. */
export function captureGpuPreviewPackageSnapshot(
  pkg: MotionPackage,
  manifest: GpuPreviewManifestIdentity,
  admittedMotion?: MotionDocument,
  expectedDocumentFingerprint?: string,
): GpuPreviewPackageSnapshot {
  if (manifest.packageId !== pkg.manifest.id || manifest.manifestFingerprint !== canonicalJsonSha256(pkg.manifest)) {
    throw new Error("GPU preview package manifest identity changed before loaded-input hashing.");
  }
  const document = admittedMotion ?? pkg.motion;
  const documentFingerprint = canonicalJsonSha256(document);
  if (expectedDocumentFingerprint && documentFingerprint !== expectedDocumentFingerprint) {
    throw new Error("GPU preview admitted Motion snapshot does not match its Core execution authority.");
  }
  return Object.freeze({
    packageId: manifest.packageId,
    manifestFingerprint: manifest.manifestFingerprint,
    documentFingerprint,
    inputHashes: Object.freeze({ ...gpuLoadedPackageInputHashes(pkg, admittedMotion) }),
  });
}

/** Refuse a mutated package after any await; never bind a stale plan to a new package identity. */
export function gpuPreviewPackageSnapshotFreshness(
  pkg: MotionPackage,
  snapshot: GpuPreviewPackageSnapshot,
  admittedMotion?: MotionDocument,
): { ok: true } | { ok: false; message: string } {
  if (snapshot.packageId !== pkg.manifest.id
    || snapshot.manifestFingerprint !== canonicalJsonSha256(pkg.manifest)
    || snapshot.documentFingerprint !== canonicalJsonSha256(admittedMotion ?? pkg.motion)) {
    return {
      ok: false,
      message: "GPU preview package snapshot is stale after an asynchronous boundary."
    };
  }
  return { ok: true };
}
