import { join, resolve, sep } from "node:path";
import {
  BoundedResourceBudget,
  DEFAULT_HOST_INTERCHANGE_LIMITS,
  OutputDirectoryTransaction,
  hashBuffer,
  readBudgetedStableFile,
  writeVerifiedBoundedFile,
  type OperationReceipt,
  type OutputDirectoryTransactionExpectedInventory
} from "@shellx-motion/core";
import { CANVAS_BRIDGE_PACKAGE_SCHEMA, type CanvasMotionExport } from "./index";
import { canvasPackageAssetEvidence } from "./package-writer-asset-evidence";
import { enrichCanvasPackageReceipt } from "./package-writer-receipt-evidence";

export interface WriteCanvasMotionPackageOptions {
  packageDir: string;
  sourceRoot?: string;
  /** A caller may share one budget across a Canvas selection and its referenced assets. */
  budget?: BoundedResourceBudget;
  /** Already-admitted asset bytes for a connector that must validate every input before its output guard runs. */
  admission?: CanvasMotionPackageAdmission;
  /** A receipt already attributed by the host, when one observed the invoking transport. */
  receipt?: OperationReceipt;
}

export interface CanvasPackageAssetEvidence {
  assetRef: string;
  sha256: string;
  byteLength: number;
  role: "canvas_image_editor_asset" | "canvas_package_layer_asset";
}

export interface WrittenCanvasMotionPackage {
  packageDir: string;
  manifestPath: string;
  motionPath: string;
  receiptPath: string;
  resourceCatalogPath: string;
  assetRefs: string[];
  copiedAssetRefs: string[];
  missingAssetRefs: string[];
  /** The exact receipt committed inside the closed package tree. */
  receipt: OperationReceipt;
  /** Hash-bound identities for every declared package asset, including layer-only references. */
  assetEvidence: CanvasPackageAssetEvidence[];
}

export interface AdmittedCanvasAsset {
  assetRef: string;
  bytes: Buffer;
  sha256: string;
}

export interface CanvasMotionPackageAdmission {
  assets: readonly AdmittedCanvasAsset[];
  missingAssetRefs: readonly string[];
}

/** Admit Canvas asset authorities without creating any package output. */
export async function admitCanvasMotionPackage(
  canvasExport: CanvasMotionExport,
  options: { sourceRoot?: string; budget?: BoundedResourceBudget }
): Promise<CanvasMotionPackageAdmission> {
  assertCanvasBridgePackageSchema(canvasExport);
  const budget = options.budget ?? new BoundedResourceBudget(DEFAULT_HOST_INTERCHANGE_LIMITS, "Canvas interchange");
  return await admitCanvasAssets(canvasExport.manifest.assets, {
    sourceRoot: options.sourceRoot,
    expectedSha256ByRef: expectedAssetHashes(canvasExport),
    budget
  });
}

/**
 * Assemble every Canvas package leaf privately, then publish it with Core's descriptor-anchored
 * exact-tree transaction. No caller receives a staging pathname or a stage mutation callback.
 */
export async function writeCanvasMotionPackage(
  canvasExport: CanvasMotionExport,
  options: WriteCanvasMotionPackageOptions
): Promise<WrittenCanvasMotionPackage> {
  assertCanvasBridgePackageSchema(canvasExport);
  const packageDir = resolve(options.packageDir);
  const manifestRef = "manifest.json";
  const motionRef = normalizedPackagePath(canvasExport.manifest.motion);
  const receiptRef = "receipts/canvas-export.receipt.json";
  const resourceCatalogRef = "resource-catalog.json";
  const manifestPath = join(packageDir, manifestRef);
  const motionPath = join(packageDir, motionRef);
  const receiptPath = join(packageDir, receiptRef);
  const resourceCatalogPath = join(packageDir, resourceCatalogRef);
  const budget = options.budget ?? new BoundedResourceBudget(DEFAULT_HOST_INTERCHANGE_LIMITS, "Canvas interchange");
  const admission = options.admission ?? await admitCanvasMotionPackage(canvasExport, { sourceRoot: options.sourceRoot, budget });
  const assets = assertCompleteCanvasAssetAdmission(canvasExport.manifest.assets, admission);
  const copiedAssetRefs = assets.map((asset) => asset.assetRef);
  const assetEvidence = canvasPackageAssetEvidence(canvasExport, assets);
  const contentFiles = packageContentFiles(canvasExport, assets, { manifestRef, motionRef, resourceCatalogRef });
  const receipt = enrichCanvasPackageReceipt(options.receipt ?? canvasExport.receipt, {
    manifestRef,
    motionRef,
    receiptRef,
    resourceCatalogRef,
    packageContentHashes: packageContentHashes(contentFiles),
    assetRefs: [...canvasExport.manifest.assets],
    copiedAssetRefs,
    missingAssetRefs: [],
    assetEvidence
  });
  const written: WrittenCanvasMotionPackage = {
    packageDir,
    manifestPath,
    motionPath,
    receiptPath,
    resourceCatalogPath,
    assetRefs: [...canvasExport.manifest.assets],
    copiedAssetRefs,
    missingAssetRefs: [],
    receipt,
    assetEvidence
  };
  const files = [...contentFiles, jsonPackageFile(receiptRef, receipt), ...assetPackageFiles(assets)];
  const expectedInventory = exactInventory(files);
  const transaction = await OutputDirectoryTransaction.create(packageDir, { requireClosedTree: true });
  try {
    for (const file of files) await writePackageFile(transaction.stagingPath, file, budget);
    await transaction.commit(expectedInventory);
    return written;
  } catch (error) {
    // Core deliberately preserves a possibly-retargeted or post-rename tree. Abort only removes a
    // still-private stage whose identity is intact.
    await transaction.abort();
    throw error;
  }
}

async function admitCanvasAssets(
  assetRefs: string[],
  options: { sourceRoot?: string; expectedSha256ByRef: Map<string, string>; budget: BoundedResourceBudget }
): Promise<CanvasMotionPackageAdmission> {
  if (assetRefs.length === 0) return { assets: [], missingAssetRefs: [] };
  if (!options.sourceRoot) throw new Error("Canvas package assets require an explicit host-approved sourceRoot.");

  const admitted: AdmittedCanvasAsset[] = [];
  const missingAssetRefs: string[] = [];
  const sourceRoot = resolve(options.sourceRoot);
  for (const assetRef of assetRefs) {
    const sourcePath = safeResolve(sourceRoot, assetRef);
    try {
      const source = await readBudgetedStableFile(sourcePath, {
        label: `Canvas asset ${assetRef}`,
        budget: options.budget,
        withinRoot: sourceRoot
      });
      const expectedSha256 = options.expectedSha256ByRef.get(assetRef);
      if (expectedSha256 && source.sha256 !== expectedSha256) {
        throw new Error(`Canvas asset hash mismatch for ${assetRef}: expected ${expectedSha256}, got ${source.sha256}.`);
      }
      admitted.push({ assetRef, bytes: source.bytes, sha256: source.sha256 });
    } catch (error) {
      if (isMissingFile(error)) {
        missingAssetRefs.push(assetRef);
        continue;
      }
      throw error;
    }
  }
  return { assets: admitted, missingAssetRefs };
}

function assertCompleteCanvasAssetAdmission(assetRefs: readonly string[], admission: CanvasMotionPackageAdmission): AdmittedCanvasAsset[] {
  const byRef = new Map<string, AdmittedCanvasAsset>();
  for (const asset of admission.assets) {
    if (byRef.has(asset.assetRef)) throw new Error(`Canvas asset admission has duplicate reference: ${asset.assetRef}.`);
    byRef.set(asset.assetRef, asset);
  }
  const missing = [...new Set([...admission.missingAssetRefs, ...assetRefs.filter((assetRef) => !byRef.has(assetRef))])];
  if (missing.length > 0) throw new Error(`Canvas package cannot publish missing declared assets: ${missing.join(", ")}.`);
  const unexpected = [...byRef.keys()].filter((assetRef) => !assetRefs.includes(assetRef));
  if (unexpected.length > 0) throw new Error(`Canvas asset admission includes undeclared assets: ${unexpected.join(", ")}.`);
  return assetRefs.map((assetRef) => byRef.get(assetRef)!);
}

function assertCanvasBridgePackageSchema(canvasExport: CanvasMotionExport): void {
  if (canvasExport.schema !== undefined && canvasExport.schema !== CANVAS_BRIDGE_PACKAGE_SCHEMA) {
    throw new Error(`Unsupported Canvas bridge package schema: ${String(canvasExport.schema)}.`);
  }
}

interface CanvasPackageFile {
  relativePath: string;
  bytes: Buffer;
  sha256: string;
  label: string;
}

function packageContentFiles(
  canvasExport: CanvasMotionExport,
  assets: readonly AdmittedCanvasAsset[],
  refs: { manifestRef: string; motionRef: string; resourceCatalogRef: string }
): CanvasPackageFile[] {
  return [
    jsonPackageFile(refs.manifestRef, canvasExport.manifest),
    jsonPackageFile(refs.motionRef, canvasExport.motion),
    jsonPackageFile(refs.resourceCatalogRef, buildResourceCatalog(canvasExport, assets))
  ];
}

function assetPackageFiles(assets: readonly AdmittedCanvasAsset[]): CanvasPackageFile[] {
  return assets.map((asset) => ({
    relativePath: normalizedPackagePath(asset.assetRef),
    bytes: asset.bytes,
    sha256: asset.sha256,
    label: `Canvas package asset ${asset.assetRef}`
  }));
}

function packageContentHashes(files: readonly CanvasPackageFile[]): Record<string, { sha256: string; byteLength: number }> {
  return Object.fromEntries(files.map((file) => [file.relativePath, { sha256: file.sha256, byteLength: file.bytes.byteLength }]));
}

function jsonPackageFile(relativePath: string, value: unknown): CanvasPackageFile {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { relativePath: normalizedPackagePath(relativePath), bytes, sha256: hashBuffer(bytes), label: `Canvas package ${relativePath}` };
}

function exactInventory(files: readonly CanvasPackageFile[]): OutputDirectoryTransactionExpectedInventory {
  const paths = new Set<string>();
  return files.map((file) => {
    if (paths.has(file.relativePath)) throw new Error(`Canvas package has colliding staged entry: ${file.relativePath}.`);
    paths.add(file.relativePath);
    return Object.freeze({ path: file.relativePath, sha256: file.sha256, byteLength: file.bytes.byteLength });
  });
}

async function writePackageFile(stagingPath: string, file: CanvasPackageFile, budget: BoundedResourceBudget): Promise<void> {
  await writeVerifiedBoundedFile(safeResolve(stagingPath, file.relativePath), file.bytes, {
    label: file.label,
    maxBytes: budget.limits.maxFileBytes,
    withinRoot: stagingPath,
    expectedSha256: file.sha256
  });
}

function expectedAssetHashes(canvasExport: CanvasMotionExport): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const assetValue of canvasExport.motion.assets ?? []) {
    const asset = readRecord(assetValue);
    const source = readRecord(asset?.source);
    const hash = readRecord(asset?.hash);
    if (typeof source?.path !== "string" || typeof hash?.sha256 !== "string") continue;
    if (/^[a-f0-9]{64}$/i.test(hash.sha256)) hashes.set(source.path, hash.sha256.toLowerCase());
  }
  return hashes;
}

function buildResourceCatalog(canvasExport: CanvasMotionExport, admittedAssets: readonly AdmittedCanvasAsset[]): Record<string, unknown> {
  const actualByRef = new Map(admittedAssets.map((asset) => [asset.assetRef, asset]));
  const motionAssetRefs = new Set<string>();
  const declaredResources = canvasExport.motion.assets.flatMap((assetValue) => {
    const asset = readRecord(assetValue);
    if (!asset) return [];
    const source = readRecord(asset.source) ?? {};
    const hash = readRecord(asset.hash) ?? {};
    const provenance = readRecord(asset.provenance) ?? {};
    const ref = typeof source.path === "string" ? source.path : "";
    if (!ref) return [];
    motionAssetRefs.add(ref);
    const admitted = actualByRef.get(ref);
    return [{
      id: typeof asset.id === "string" ? asset.id : `canvas-asset-${hashBuffer(Buffer.from(ref, "utf8")).slice(0, 16)}`,
      ref,
      kind: typeof asset.kind === "string" ? asset.kind : "unknown",
      mimeType: typeof source.mimeType === "string" ? source.mimeType : undefined,
      sha256: admitted?.sha256 ?? (typeof hash.sha256 === "string" ? hash.sha256 : undefined),
      source: {
        app: typeof source.app === "string" ? source.app : canvasExport.manifest.sourceApp,
        sourceFrameId: typeof provenance.sourceFrameId === "string" ? provenance.sourceFrameId : undefined,
        receiptId: typeof provenance.receiptId === "string" ? provenance.receiptId : undefined
      }
    }];
  });
  const packageLayerResources = admittedAssets
    .filter((asset) => !motionAssetRefs.has(asset.assetRef))
    .map((asset) => ({
      id: `canvas-package-layer-${hashBuffer(Buffer.from(asset.assetRef, "utf8")).slice(0, 16)}`,
      ref: asset.assetRef,
      kind: "package_layer_asset",
      sha256: asset.sha256,
      byteLength: asset.bytes.byteLength,
      source: { app: canvasExport.manifest.sourceApp }
    }));
  return {
    schema: "shellx-motion/resource-catalog@1",
    packageId: canvasExport.manifest.id,
    sourceApp: canvasExport.manifest.sourceApp,
    resources: [motionPackageCatalogResource(canvasExport), ...declaredResources, ...packageLayerResources]
  };
}

function motionPackageCatalogResource(canvasExport: CanvasMotionExport): Record<string, unknown> {
  const motionProvenance = readRecord(canvasExport.motion.provenance) ?? {};
  const selectedFrameId = typeof canvasExport.manifest.selectedFrameId === "string"
    ? canvasExport.manifest.selectedFrameId
    : typeof motionProvenance.selectedFrameId === "string" ? motionProvenance.selectedFrameId : undefined;
  return {
    id: canvasExport.manifest.id,
    ref: ".",
    kind: "motion_package",
    source: {
      app: canvasExport.manifest.sourceApp,
      ...(selectedFrameId ? { sourceFrameId: selectedFrameId } : {}),
      receiptId: canvasExport.receipt.id
    }
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function normalizedPackagePath(path: string): string {
  const normalized = path.split(sep).join("/");
  safeResolve("/canvas-package-root", normalized);
  return normalized;
}

function safeResolve(root: string, assetRef: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, assetRef);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSep)) throw new Error(`Asset path escapes package root: ${assetRef}`);
  return resolved;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
