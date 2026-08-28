import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { loadMotionPackage } from "./package";
import { requiredLoadedPackageDocumentHashes } from "./package-loaded-inputs";
import type { MotionPackage, OperationReceipt } from "./types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MOTION_BYTES = 64 * 1024 * 1024;
/** Canonical bounded package-source ceiling shared by source-preserving authoring paths. */
export const MAX_PACKAGE_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

export interface PackageRenderLineage {
  schema: "shellx-motion/package-render-lineage@1";
  manifestSha256: string;
  motionSha256: string;
  adapterId?: "adapter.gltf";
  sourceSha256?: string;
  normalizedSourceSha256?: string;
  loweringReceiptSha256?: string;
}

/** A package plus the exact bounded source identity that was stable when it was loaded. */
export interface StableRenderPackage {
  pkg: MotionPackage;
  lineage: PackageRenderLineage;
}

/**
 * Load a final-render package only after retaining and rechecking the bounded source identity.
 * This is deliberately a stability check, not an atomic snapshot: callers recheck again before
 * releasing a receipt, or retain their own immutable source authority.
 */
export async function loadStableRenderPackage(packageRoot: string): Promise<StableRenderPackage> {
  const lineage = await derivePackageRenderLineage(packageRoot);
  const pkg = await loadMotionPackage(packageRoot);
  await assertStableRenderPackageLineage(pkg, lineage);
  return { pkg, lineage };
}

/** Recheck that a loaded package still names the exact lineage used for the render. */
export async function assertStableRenderPackageLineage(
  pkg: MotionPackage,
  expected: PackageRenderLineage,
): Promise<void> {
  validatePackageRenderLineage(expected);
  const loaded = requiredLoadedPackageDocumentHashes(pkg, "Final render receipt");
  if (loaded["manifest.json"] !== expected.manifestSha256
    || loaded[pkg.manifest.motion] !== expected.motionSha256) {
    throw new Error("Loaded Motion package bytes do not match its final render lineage.");
  }
  const current = await derivePackageRenderLineage(pkg.root);
  if (!sameLineage(current, expected)) {
    throw new Error("Motion package render lineage changed during the final render operation.");
  }
}

/**
 * Attach the bounded source identity to an ordinary final receipt after rechecking the package.
 * Renderer input hashes remain additive; callers must not replace them with an unverified path.
 */
export async function bindFinalRenderReceiptLineage(
  receipt: OperationReceipt,
  pkg: MotionPackage,
  lineage: PackageRenderLineage,
): Promise<void> {
  if (receipt.operation !== "render.final") {
    throw new Error("Package render lineage may only bind an ordinary render.final receipt.");
  }
  await assertStableRenderPackageLineage(pkg, lineage);
  receipt.inputHashes = { ...receipt.inputHashes, ...packageRenderLineageInputHashes(lineage) };
}

export function packageRenderLineageInputHashes(
  lineage: PackageRenderLineage,
): Omit<PackageRenderLineage, "schema" | "adapterId"> {
  validatePackageRenderLineage(lineage);
  return {
    manifestSha256: lineage.manifestSha256,
    motionSha256: lineage.motionSha256,
    ...(lineage.sourceSha256 ? { sourceSha256: lineage.sourceSha256 } : {}),
    ...(lineage.normalizedSourceSha256 ? { normalizedSourceSha256: lineage.normalizedSourceSha256 } : {}),
    ...(lineage.loweringReceiptSha256 ? { loweringReceiptSha256: lineage.loweringReceiptSha256 } : {}),
  };
}

export function validatePackageRenderLineage(value: unknown): asserts value is PackageRenderLineage {
  const lineage = record(value, "package render lineage");
  const allowed = new Set([
    "schema", "manifestSha256", "motionSha256", "adapterId", "sourceSha256",
    "normalizedSourceSha256", "loweringReceiptSha256",
  ]);
  if (Object.keys(lineage).some((key) => !allowed.has(key))) {
    throw new Error("package render lineage contains unsupported fields");
  }
  if (lineage.schema !== "shellx-motion/package-render-lineage@1") {
    throw new Error("unsupported package render lineage schema");
  }
  sha256(lineage.manifestSha256, "package render lineage manifestSha256");
  sha256(lineage.motionSha256, "package render lineage motionSha256");
  const gltfFields = [lineage.sourceSha256, lineage.normalizedSourceSha256, lineage.loweringReceiptSha256];
  const hasGltfField = gltfFields.some((field) => field !== undefined);
  if (lineage.adapterId === undefined && hasGltfField) {
    throw new Error("package render lineage glTF hashes require adapterId adapter.gltf");
  }
  if (lineage.adapterId !== undefined && lineage.adapterId !== "adapter.gltf") {
    throw new Error("package render lineage adapterId is unsupported");
  }
  if (lineage.adapterId === "adapter.gltf") {
    sha256(lineage.sourceSha256, "package render lineage sourceSha256");
    sha256(lineage.normalizedSourceSha256, "package render lineage normalizedSourceSha256");
    sha256(lineage.loweringReceiptSha256, "package render lineage loweringReceiptSha256");
  }
}

/** Derive path-free render provenance from stable, bounded package-owned bytes. */
export async function derivePackageRenderLineage(packageRoot: string): Promise<PackageRenderLineage> {
  const root = await realpath(resolve(packageRoot));
  if (!(await stat(root)).isDirectory()) throw new Error("package render lineage root must be a directory");
  const manifestFile = await readPackageFile(root, "manifest.json", MAX_MANIFEST_BYTES, "package manifest");
  const manifest = jsonRecord(manifestFile.bytes, "package manifest");
  if (manifest.schema !== "shellx-motion/package-manifest@1") throw new Error("package render lineage manifest schema is invalid");
  const packageId = nonEmpty(manifest.id, "package render lineage manifest id");
  const motionRef = nonEmpty(manifest.motion, "package render lineage motion path");
  const motionFile = await readPackageFile(root, motionRef, MAX_MOTION_BYTES, "package Motion document");
  const motion = jsonRecord(motionFile.bytes, "package Motion document");
  if (motion.schema !== "shellx-motion/motion@1") throw new Error("package render lineage Motion schema is invalid");
  const motionId = nonEmpty(motion.id, "package render lineage Motion id");
  const base: PackageRenderLineage = {
    schema: "shellx-motion/package-render-lineage@1",
    manifestSha256: hash(manifestFile.bytes),
    motionSha256: hash(motionFile.bytes),
  };
  const adapter = optionalRecord(optionalRecord(manifest.data)?.adapter);
  if (adapter?.id !== "adapter.gltf") return base;

  const sourceRef = nonEmpty(adapter.source, "glTF preserved source path");
  const normalizedRef = nonEmpty(adapter.loweringSource, "glTF normalized source path");
  const receiptRef = nonEmpty(adapter.loweringReceipt, "glTF lowering receipt path");
  const declaredSourceHash = sha256(adapter.sourceSha256, "glTF preserved sourceSha256");
  const declaredNormalizedHash = sha256(adapter.loweringSourceSha256, "glTF normalized sourceSha256");
  const [sourceFile, normalizedFile, receiptFile] = await Promise.all([
    readPackageFile(root, sourceRef, MAX_PACKAGE_SOURCE_BYTES, "glTF preserved source"),
    readPackageFile(root, normalizedRef, MAX_PACKAGE_SOURCE_BYTES, "glTF normalized source"),
    readPackageFile(root, receiptRef, MAX_RECEIPT_BYTES, "glTF lowering receipt"),
  ]);
  const sourceSha256 = hash(sourceFile.bytes);
  const normalizedSourceSha256 = hash(normalizedFile.bytes);
  if (sourceSha256 !== declaredSourceHash) throw new Error("glTF preserved source hash does not match its manifest provenance");
  if (normalizedSourceSha256 !== declaredNormalizedHash) throw new Error("glTF normalized source hash does not match its manifest provenance");
  validateGltfLoweringReceipt({
    receipt: jsonRecord(receiptFile.bytes, "glTF lowering receipt"),
    adapter,
    packageId,
    motionId,
    normalizedSourceSha256,
  });
  const lineage: PackageRenderLineage = {
    ...base,
    adapterId: "adapter.gltf",
    sourceSha256,
    normalizedSourceSha256,
    loweringReceiptSha256: hash(receiptFile.bytes),
  };
  validatePackageRenderLineage(lineage);
  return lineage;
}

function validateGltfLoweringReceipt(input: {
  receipt: Record<string, unknown>;
  adapter: Record<string, unknown>;
  packageId: string;
  motionId: string;
  normalizedSourceSha256: string;
}): void {
  const { receipt } = input;
  const output = record(receipt.output, "glTF lowering receipt output");
  const hashes = record(receipt.inputHashes, "glTF lowering receipt inputHashes");
  const container = record(input.adapter.container, "glTF adapter container provenance");
  const format = container.format;
  if (format !== "gltf" && format !== "glb") throw new Error("glTF adapter container format is invalid");
  const bufferHashes = container.bufferSha256;
  if (!Array.isArray(bufferHashes) || bufferHashes.length > 4) throw new Error("glTF adapter buffer provenance is invalid");
  const expectedHashes: Record<string, string> = { source: input.normalizedSourceSha256 };
  bufferHashes.forEach((value, index) => { expectedHashes[`buffer${index}`] = sha256(value, `glTF buffer${index} sha256`); });
  if (!sameHashRecord(hashes, expectedHashes)) throw new Error("glTF lowering receipt input hashes do not match normalized provenance");
  const loweredMotionSha256 = sha256(output.motionSha256, "glTF lowering receipt output motionSha256");
  if (receipt.schema !== "shellx-motion/receipt@1"
    || receipt.id !== `adapter-lowering-gltf-${loweredMotionSha256.slice(0, 16)}`
    || receipt.operation !== "adapter.lower"
    || (receipt.status !== "passed" && receipt.status !== "warning")
    || receipt.packageId !== input.packageId
    || receipt.lane !== "adapter") {
    throw new Error("glTF lowering receipt identity is invalid");
  }
  if (output.adapterId !== "adapter.gltf" || output.format !== format
    || output.motionId !== input.motionId) {
    throw new Error("glTF lowering receipt output does not bind the package Motion identity");
  }
}

async function readPackageFile(root: string, ref: string, maxBytes: number, label: string): Promise<{ bytes: Buffer }> {
  assertCanonicalPackageRef(ref, label);
  const lexical = resolve(root, ref);
  const lexicalBefore = await lstat(lexical);
  if (!lexicalBefore.isFile() || lexicalBefore.isSymbolicLink() || lexicalBefore.size > maxBytes) {
    throw new Error(`${label} must be a bounded regular non-symlink file`);
  }
  const canonical = await realpath(lexical);
  if (!inside(root, canonical)) throw new Error(`${label} escapes the package root`);
  const beforePath = await lstat(canonical);
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > maxBytes || !sameFile(lexicalBefore, beforePath)) {
    throw new Error(`${label} must be a bounded regular non-symlink file`);
  }
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || !sameFile(beforePath, before) || before.size > maxBytes) throw new Error(`${label} changed before it was read`);
    const bytes = await file.readFile();
    const after = await file.stat();
    const afterPath = await lstat(canonical);
    const lexicalAfter = await lstat(lexical);
    if (bytes.byteLength !== before.size || !stable(before, after) || !stable(after, afterPath)
      || !stable(afterPath, lexicalAfter) || afterPath.isSymbolicLink() || lexicalAfter.isSymbolicLink()) {
      throw new Error(`${label} changed while it was read`);
    }
    return { bytes };
  } finally {
    await file.close();
  }
}

function assertCanonicalPackageRef(value: string, label: string): void {
  if (!value || isAbsolute(value) || win32.isAbsolute(value) || value.includes("\\")
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} path must be canonical and package-relative`);
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stable(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function jsonRecord(bytes: Buffer, label: string): Record<string, unknown> {
  try { return record(JSON.parse(bytes.toString("utf8")), label); }
  catch (error) { if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`); throw error; }
}

function record(value: unknown, label: string): Record<string, unknown> {
  const found = optionalRecord(value);
  if (!found) throw new Error(`${label} must be a plain object`);
  return found;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameHashRecord(left: Record<string, unknown>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function sameLineage(left: PackageRenderLineage, right: PackageRenderLineage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
