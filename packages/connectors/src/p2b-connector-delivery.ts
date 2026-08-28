/** Private P2B package admission, producer-proof, and private-stage helpers. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep, win32 } from "node:path";
import {
  activeScriptLayers,
  assertPublicSourceUrl,
  DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS,
  isPackageAssetRef,
  readBoundedStableFile,
  type MotionPackage,
  type OperationReceipt,
  type OutputDirectoryTransactionExpectedInventory
} from "@shellx-motion/core";
import type { AdmittedPackageTree } from "./bounded-package-copy";
import { admitBoundedPackageTree, publishAdmittedPackageTree } from "./bounded-package-copy";
import type { PrivateConnectorDelivery } from "./connector-delivery";

export const P2B_MAX_MEDIA_BYTES = 64 * 1024 * 1024;
/** Scripted-video JSON is control data, not media. Bound it before JSON.parse. */
export const P2B_MAX_SCRIPT_INPUT_BYTES = 1 * 1024 * 1024;

/** Refuse every path-bound producer/content lane before Browser execution. */
export function assertP2BPathlessExecutionInput(pkg: MotionPackage, label: string): void {
  if (activeScriptLayers(pkg.motion).length > 0) throw new Error(`${label} accepted delivery refuses active agent scripts until their execution provenance is closed over the admitted package snapshot.`);
  const audioLayer = pkg.motion.layers.find((layer) => layer.type === "audio" || layer.includeAudio === true);
  if (audioLayer || pkg.motion.audio?.master) throw new Error(`${label} accepted delivery refuses audio because P2B has no immutable admitted-package audio fulfillment.`);
  const gpuLayer = pkg.motion.layers.find((layer) => layer.type === "shader" || layer.type === "scene3d" || layer.type === "environment");
  if (gpuLayer) throw new Error(`${label} accepted delivery refuses ${gpuLayer.type} layer ${gpuLayer.id}: P2B has no closed GPU provenance.`);
}

/**
 * P2B admits only package-local asset locators and logical source-evidence locators.
 * This deliberately inspects typed package fields, never arbitrary visible text.
 */
export function assertP2BPackageDataLocators(
  pkg: MotionPackage,
  files: ReadonlyMap<string, Readonly<{ bytes: Buffer; sha256: string }>>,
  label: string
): void {
  for (const assetRef of pkg.manifest.assets) assertP2BAdmittedAssetLocator(assetRef, files, `${label} manifest.assets`);
  for (const [index, assetValue] of pkg.motion.assets.entries()) {
    const source = p2bPlainRecord(p2bPlainRecord(assetValue)?.source);
    if (source?.path !== undefined) assertP2BAdmittedAssetLocator(source.path, files, `${label} motion.assets[${index}].source.path`);
  }
  for (const scene of pkg.motion.scenes ?? []) {
    const storyboard = p2bPlainRecord(p2bPlainRecord(scene)?.["x-storyboard"]);
    if (storyboard?.sourceRefs === undefined) continue;
    if (!Array.isArray(storyboard.sourceRefs)) throw new Error(`${label} storyboard sourceRefs must be a typed array.`);
    for (const [refIndex, sourceRefValue] of storyboard.sourceRefs.entries()) {
      const sourceRef = p2bPlainRecord(sourceRefValue);
      if (!sourceRef) throw new Error(`${label} storyboard sourceRefs[${refIndex}] must be a typed record.`);
      if (sourceRef.path !== undefined && !isP2BLogicalInputLocator(sourceRef.path)) {
        throw new Error(`${label} storyboard sourceRefs[${refIndex}].path must be a logical input/ locator.`);
      }
      if (sourceRef.url !== undefined) {
        if (typeof sourceRef.url !== "string") throw new Error(`${label} storyboard sourceRefs[${refIndex}].url must be a string.`);
        try { assertPublicSourceUrl(sourceRef.url); }
        catch (error) { throw new Error(`${label} storyboard sourceRefs[${refIndex}].url must be a public http(s) URL: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
  }
}

/** P1's exact final-tree limits include every route-owned leaf, not just the package. */
export function assertP2BClosedTreeCapacity(tree: AdmittedPackageTree, extraLeaves: number, packageRootRelativePath = "package"): void {
  const prefixComponents = packageRootRelativePath.split("/");
  if (prefixComponents.some((part) => !part || part === "." || part === "..")) throw new Error("P2B package root prefix must be a code-owned relative path.");
  const packageLeaves = tree.evidence.entries.filter((entry) => entry.kind === "file");
  const tooDeep = packageLeaves.find((entry) => prefixComponents.length + entry.path.split("/").length > 16);
  if (tooDeep) throw new Error(`P2B accepted delivery cannot place ${packageRootRelativePath}/${tooDeep.path}: P1 permits at most 16 final root-relative path components.`);
  if (tree.evidence.fileCount + extraLeaves > DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS.maxFiles) throw new Error(`P2B accepted delivery reserves ${extraLeaves} non-package leaves, exceeding P1's ${DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS.maxFiles}-file limit.`);
  const reservedBytes = (2 * P2B_MAX_MEDIA_BYTES) + (8 * 1024 * 1024);
  if (tree.evidence.aggregateBytes + reservedBytes > DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS.maxAggregateBytes) throw new Error("P2B accepted delivery cannot fit the P1 256MiB closed-tree aggregate limit.");
}

/** Admit generated bytes into Core's copied immutable map before any producer can reopen a source path. */
export async function admitGeneratedP2BPackage(input: { delivery: PrivateConnectorDelivery; label: string; writeGeneratedPackage(path: string): Promise<void> }): Promise<AdmittedPackageTree> {
  const generatedPath = join(input.delivery.stagingRoot, ".p2b-generated-package");
  await input.writeGeneratedPackage(generatedPath);
  try {
    const admitted = await admitBoundedPackageTree(generatedPath, { label: input.label, limits: DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS });
    assertP2BAdmittedPackageHasNoPrivateDeliveryPath(admitted, input.delivery);
    return admitted;
  } finally {
    const relation = relative(input.delivery.stagingRoot, generatedPath);
    if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) throw new Error("P2B generated package cleanup escaped its private stage.");
    await rm(generatedPath, { recursive: true, force: true });
  }
}

export async function publishP2BAdmittedPackage(tree: AdmittedPackageTree, packagePath: string): Promise<void> {
  await publishAdmittedPackageTree(tree, packagePath);
}

export function bindP2BPackageTreeDigest(receipt: OperationReceipt, treeSha256: string, label: string): void {
  const existing = receipt.inputHashes["admitted-package-tree"];
  if (existing !== undefined && existing !== treeSha256) throw new Error(`${label} conflicts with the immutable admitted package-tree identity.`);
  receipt.inputHashes = { "admitted-package-tree": treeSha256, ...receipt.inputHashes };
}

export function bindP2BPackageTreeDigestToCutPlan(plan: { receipt: OperationReceipt }, treeSha256: string): void {
  bindP2BPackageTreeDigest(plan.receipt, treeSha256, "P2B Cut plan");
}

export function assertP2BBrowserPreviewPackageTreeDigest(receipt: OperationReceipt, treeSha256: string): void {
  if (receipt.inputHashes["admitted-package-tree"] !== treeSha256) throw new Error("P2B browser preview did not attest the immutable admitted package-tree identity.");
}

export function assertP2BBrowserStreamingPackageTreeDigest(receipt: OperationReceipt, treeSha256: string): void {
  const output = p2bPlainRecord(receipt.output);
  const frameTransport = output ? p2bPlainRecord(output.frameTransport) : undefined;
  const producer = frameTransport ? p2bPlainRecord(frameTransport.producer) : undefined;
  const evidence = producer ? p2bPlainRecord(producer.evidence) : undefined;
  const union = evidence ? p2bPlainRecord(evidence.stableInputHashUnion) : undefined;
  const conflicts = evidence?.stableInputHashConflictKeys;
  if (!union || union["admitted-package-tree"] !== treeSha256 || !Array.isArray(conflicts) || conflicts.some((entry) => entry === "admitted-package-tree") || evidence?.stableInputHashConflictKeysOmitted !== 0) throw new Error("P2B browser final render did not prove a conflict-free immutable admitted package-tree input.");
}

export async function writeP2BDeliveryJson(delivery: PrivateConnectorDelivery, path: string, value: unknown, exclusive = false): Promise<void> {
  assertNoP2BPrivateDeliveryPath(value, delivery);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, p2bJsonBytes(value), exclusive ? { flag: "wx", mode: 0o600 } : undefined);
}

export function remapP2BPrivateDeliveryPaths<T>(value: T, delivery: PrivateConnectorDelivery): T {
  if (typeof value === "string") return (value === delivery.stagingRoot ? delivery.publicRoot : value.startsWith(`${delivery.stagingRoot}${sep}`) ? `${delivery.publicRoot}${value.slice(delivery.stagingRoot.length)}` : value) as T;
  if (Array.isArray(value)) return value.map((entry) => remapP2BPrivateDeliveryPaths(entry, delivery)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, remapP2BPrivateDeliveryPaths(entry, delivery)])) as T;
  return value;
}

export function assertNoP2BPrivateDeliveryPath(value: unknown, delivery: PrivateConnectorDelivery): void {
  if (JSON.stringify(value).includes(delivery.stagingRoot)) throw new Error("P2B final delivery leaked a private staging path.");
}

/** Scan every admitted package leaf before it can be re-materialized under the public delivery. */
function assertP2BAdmittedPackageHasNoPrivateDeliveryPath(tree: AdmittedPackageTree, delivery: PrivateConnectorDelivery): void {
  const prohibited = Buffer.from(delivery.stagingRoot, "utf8");
  const generatedPackage = Buffer.from(".p2b-generated-package", "utf8");
  for (const [path, file] of tree.files) {
    if (file.bytes.includes(prohibited)) {
      throw new Error(`P2B admitted package file ${path} leaked a private delivery path.`);
    }
    if (file.bytes.includes(generatedPackage)) {
      throw new Error(`P2B admitted package file ${path} leaked its private generated-package path.`);
    }
  }
}

export function assertP2BNoExternalPath(value: unknown, paths: readonly string[], label: string): void {
  const serialized = JSON.stringify(value);
  for (const path of paths) if (path && serialized.includes(resolve(path))) throw new Error(`${label} leaked an external local path into accepted delivery evidence.`);
}

export async function captureP2BReceiptBoundDeliveryLeaf(input: { delivery: PrivateConnectorDelivery; publicPath: string; receipt: OperationReceipt; label: string }): Promise<OutputDirectoryTransactionExpectedInventory[number]> {
  const expected = p2bReceiptOutputBinding(input.receipt, input.publicPath, input.label);
  const stagedPath = input.delivery.stagePath(input.publicPath);
  const captured = await readBoundedStableFile(stagedPath, { label: input.label, maxBytes: P2B_MAX_MEDIA_BYTES, withinRoot: input.delivery.stagingRoot, requireSingleLink: true });
  if (captured.sha256 !== expected.sha256) throw new Error(`${input.label} changed after its receipt was assembled.`);
  return Object.freeze({ path: relative(input.delivery.stagingRoot, stagedPath).split(sep).join("/"), sha256: expected.sha256, byteLength: captured.byteLength });
}

export async function captureP2BDeliveryLeaf(input: { delivery: PrivateConnectorDelivery; publicPath: string; label: string; maxBytes?: number }): Promise<OutputDirectoryTransactionExpectedInventory[number]> {
  const stagedPath = input.delivery.stagePath(input.publicPath);
  const captured = await readBoundedStableFile(stagedPath, { label: input.label, maxBytes: input.maxBytes ?? P2B_MAX_MEDIA_BYTES, withinRoot: input.delivery.stagingRoot, requireSingleLink: true });
  return Object.freeze({ path: relative(input.delivery.stagingRoot, stagedPath).split(sep).join("/"), sha256: captured.sha256, byteLength: captured.byteLength });
}

export function assertP2BLinuxBeforeInput(): void {
  if (process.platform !== "linux") throw new Error("P2B accepted delivery is Linux-only until a descriptor/DACL-equivalent exact-tree publication capability is available on this host.");
}

export function assertP2BExternalInput(outDir: string, inputPath: string, label: string): void {
  const output = resolve(outDir), source = resolve(inputPath), relation = relative(output, source);
  if (relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`))) throw new Error(`${label} must be external to the caller-selected output directory.`);
}

export function p2bJsonBytes(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
export function p2bPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : undefined;
}

function p2bReceiptOutputBinding(receipt: OperationReceipt, publicPath: string, label: string): { sha256: string } {
  const record = p2bPlainRecord(receipt.output);
  if (resolve(String(record?.path ?? "")) !== resolve(publicPath) || typeof record?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error(`${label} receipt does not bind its code-owned output path and sha256.`);
  return { sha256: record.sha256 };
}

function assertP2BAdmittedAssetLocator(value: unknown, files: ReadonlyMap<string, Readonly<{ bytes: Buffer; sha256: string }>>, label: string): void {
  if (!isP2BPackageAssetLocator(value)) throw new Error(`${label} must be an admitted package-local assets/ locator.`);
  if (!files.has(value)) throw new Error(`${label} must name an admitted package file leaf: ${value}.`);
}

function isP2BPackageAssetLocator(value: unknown): value is string {
  return isPackageAssetRef(value) && isP2BRelativeLocator(value);
}

function isP2BLogicalInputLocator(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("input/") && isP2BRelativeLocator(value);
}

function isP2BRelativeLocator(value: string): boolean {
  if (!value || value.startsWith("/") || win32.isAbsolute(value) || value.includes("\\") || value.includes(":")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
