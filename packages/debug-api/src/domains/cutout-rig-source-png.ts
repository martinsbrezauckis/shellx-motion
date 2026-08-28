import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  hashBuffer,
  inspectPngBuffer,
  MAX_PACKAGE_SOURCE_BYTES,
  resolvePackageAsset,
  type CutoutRigSourceIdentity,
  type MotionLayer,
  type MotionPackage
} from "@shellx-motion/core";

// Reuse Core's package-source ceiling before Buffer.alloc/read/decode; PNG inspection separately
// rejects dimensions above existing renderer-compatible image limits.
const MAX_CUTOUT_RIG_PNG_BYTES = MAX_PACKAGE_SOURCE_BYTES;

export interface VerifiedCutoutRigSource {
  layer: MotionLayer;
  identity: CutoutRigSourceIdentity;
}

/** Read exactly one stable, regular package PNG through O_NOFOLLOW before authoring starts. */
export async function readCutoutRigSourcePng(pkg: MotionPackage, sourceLayerId: string): Promise<VerifiedCutoutRigSource> {
  const layer = pkg.motion.layers.find((candidate) => candidate.id === sourceLayerId);
  if (!layer) throw new Error(`Cutout rig source layer ${sourceLayerId} does not exist.`);
  if (layer.type !== "image") throw new Error("Cutout rig source must be an image layer.");
  const assetRef = imageAssetRef(pkg, layer);
  const bytes = await readStableBoundedPackageFile(resolvePackageAsset(pkg, assetRef));
  const inspected = inspectPngBuffer(bytes);
  if (!inspected.ok) throw new Error(`Cutout rig source must be a bounded native-compatible PNG: ${inspected.message}`);
  return { layer, identity: { assetRef, width: inspected.width, height: inspected.height, sha256: hashBuffer(bytes) } };
}

/** Repeat the same no-follow, bounded read after the package is copied into the hidden stage. */
export async function revalidateCutoutRigSourcePng(
  pkg: MotionPackage,
  sourceLayerId: string,
  expected: CutoutRigSourceIdentity
): Promise<void> {
  const actual = await readCutoutRigSourcePng(pkg, sourceLayerId);
  if (actual.identity.assetRef !== expected.assetRef
    || actual.identity.width !== expected.width
    || actual.identity.height !== expected.height
    || actual.identity.sha256 !== expected.sha256) {
    throw new Error("Cutout rig source PNG identity changed before the staged package was edited.");
  }
}

function imageAssetRef(pkg: MotionPackage, layer: MotionLayer): string {
  const direct = stringValue(layer.assetRef) ?? stringValue(layer.source) ?? stringValue(layer.src);
  const assetRef = direct ?? assetPathForId(pkg, stringValue(layer.assetId));
  if (!assetRef || !isPackageAssetRef(assetRef) || !pkg.manifest.assets.includes(assetRef)) {
    throw new Error("Cutout rig source must resolve to a manifest-declared package-local assets/ PNG.");
  }
  return assetRef;
}

function assetPathForId(pkg: MotionPackage, assetId: string | null): string | null {
  if (!assetId) return null;
  for (const asset of pkg.motion.assets) {
    const record = recordValue(asset);
    if (record?.id !== assetId) continue;
    const source = recordValue(record.source);
    const path = stringValue(source?.path);
    if (path) return path;
  }
  return null;
}

async function readStableBoundedPackageFile(path: string): Promise<Buffer> {
  const pathBefore = await lstat(path);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size <= 0 || pathBefore.size > MAX_CUTOUT_RIG_PNG_BYTES) {
    throw new Error(`Cutout rig PNG must be a regular non-symlink file no larger than ${MAX_CUTOUT_RIG_PNG_BYTES} bytes.`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(before, pathBefore) || before.size <= 0 || before.size > MAX_CUTOUT_RIG_PNG_BYTES) {
      throw new Error("Cutout rig PNG changed before it was opened.");
    }
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead <= 0) throw new Error("Cutout rig PNG changed while it was read.");
      offset += read.bytesRead;
    }
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (!stable(before, after) || !stable(after, pathAfter) || pathAfter.isSymbolicLink()) {
      throw new Error("Cutout rig PNG changed while it was read.");
    }
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isPackageAssetRef(value: string): boolean {
  return /^assets\/[^/]/.test(value) && !value.includes("\\") && !value.includes("..") && !value.endsWith("/");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stable(left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
