/** Copy one host-approved external file into an ordinary existing Motion package revision. */
import {
  hashBuffer,
  hashPackageFile,
  isImportablePackageAssetRef,
  MAX_PACKAGE_ASSET_IMPORT_BYTES,
  readBoundedStableFile,
  resolvePackageAsset,
  validatePackageAssetReferences,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact,
  type StableFileIdentity,
} from "@shellx-motion/core";
import { lstat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { stringArg } from "./args.js";
import { assertConfiguredAuthoringInputFile, configuredAuthoringInputRoot } from "./authoring-root-policy.js";
import { commitMotionDocumentEdit, PackageEditTransactionError } from "./package-edit-transaction.js";

export interface WorkspacePackageAssetImportServices {
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
  receiptsRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  isUnsafePackageOutputDirectory?: (packageRoot: string, outputRoot: string) => Promise<boolean>;
  isEmptyOrAbsentDirectory?: (path: string) => Promise<boolean>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchWorkspacePackageAssetImport(
  command: MotionDebugCommand,
  args: unknown,
  services: WorkspacePackageAssetImportServices,
): Promise<MotionDebugResult | null> {
  if (command !== "motion.package.asset.import") return null;
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const assetPath = stringArg(args, "assetPath");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.package.asset.import requires packageRoot.");
  if (!outDir) return invalidArgs("motion.package.asset.import requires outDir.");
  if (!assetPath) return invalidArgs("motion.package.asset.import requires assetPath.");
  if (!services.packageLoader || !services.isUnsafePackageOutputDirectory || !services.isEmptyOrAbsentDirectory) {
    return capabilityUnavailable("Atomic Motion package asset import is unavailable.");
  }
  if (!services.authoringInputRoots?.length || !services.authoringOutputRoots?.length) {
    return capabilityUnavailable("Package asset import requires host-approved authoring input and output roots.");
  }
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Package asset import receipt persistence is unavailable on this host.");

  try {
    const pkg = await services.packageLoader(packageRoot);
    const sourceAssetPath = resolve(assetPath);
    const assetRef = stringArg(args, "assetRef") ?? `assets/${basename(sourceAssetPath)}`;
    if (!isImportablePackageAssetRef(assetRef)) {
      return invalidArgs("motion.package.asset.import assetRef must be a portable package-local assets/ path.");
    }
    const packageOutDir = resolve(outDir);
    if (await services.isUnsafePackageOutputDirectory(pkg.root, packageOutDir)) {
      return invalidArgs("motion.package.asset.import outDir must be outside packageRoot.");
    }
    if (!await services.isEmptyOrAbsentDirectory(packageOutDir)) {
      return invalidArgs("motion.package.asset.import outDir must be empty or absent before package copy.");
    }
    const existingTarget = await lstat(resolvePackageAsset(pkg, assetRef)).catch((error: unknown) => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    if (existingTarget) {
      return {
        ok: false,
        error: {
          code: "package_asset_import_failed",
          message: "Package asset import target already exists in the source package.",
          suggestedAction: "Choose a new assets/ target path; package asset import never replaces an existing file.",
        },
        warnings: [],
      };
    }
    const source = await admitPackageAssetImportSource(sourceAssetPath, services.authoringInputRoots);
    const sourceSha256 = source.sha256;
    const inputHashes = {
      "manifest.json": await hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
      [pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion)),
      asset: sourceSha256,
    };
    const manifest = {
      ...pkg.manifest,
      assets: pkg.manifest.assets.includes(assetRef) ? [...pkg.manifest.assets] : [...pkg.manifest.assets, assetRef],
    };
    const manifestPath = join(packageOutDir, "manifest.json");
    const motionPath = join(packageOutDir, pkg.manifest.motion);
    const copiedAssetPath = resolvePackageAsset({ root: packageOutDir }, assetRef);
    const receiptPath = join(packageOutDir, "receipts", "package-asset-import.receipt.json");
    const artifacts: ReceiptArtifact[] = [
      { role: "motion_package", path: packageOutDir, status: "available", primary: true },
      { role: "package_asset", path: copiedAssetPath, status: "available" },
      { role: "package_asset_import_receipt", path: receiptPath, status: "available", mediaType: "application/json" },
    ];
    const output = {
      packageDir: packageOutDir,
      manifestPath,
      motionPath,
      assetRef,
      copiedAssetPath,
      assetSha256: sourceSha256,
      assetByteLength: source.byteLength,
      manifestAssets: manifest.assets,
      ...(createdBy ? { createdBy } : {}),
    };
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `package-asset-import-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`,
      operation: "package.asset.import",
      status: "passed",
      packageId: pkg.manifest.id,
      inputHashes,
      createdAt: createdAt ?? new Date().toISOString(),
      lane: "debug-api",
      output,
      artifacts,
      warnings: [],
    };
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg,
      outputRoot: packageOutDir,
      authoringInputRoots: services.authoringInputRoots,
      authoringOutputRoots: services.authoringOutputRoots,
      patchedMotion: pkg.motion,
      patchedManifest: manifest,
      stagedFiles: [{
        sourcePath: sourceAssetPath,
        sourceRoot: source.root,
        targetAssetRef: assetRef,
        expectedSha256: sourceSha256,
        expectedByteLength: source.byteLength,
        expectedIdentity: source.identity,
      }],
      validateStagedPackage: async (stagedPackage) => {
        const validation = await validatePackageAssetReferences(stagedPackage);
        if (!validation.ok) {
          throw new PackageEditTransactionError("copy_mismatch", "Staged package asset import did not produce a complete package-local asset set.");
        }
      },
      receipt,
      receiptFileName: "package-asset-import.receipt.json",
      ...(receiptsRoot ? { receiptsRoot, writeHostReceipt: services.writeReceipt! } : {}),
    });
    return {
      ok: true,
      receiptId: receipt.id,
      visibleState: {
        panel: "assets",
        operation: "package.asset.import",
        packageId: pkg.manifest.id,
        packageDir: packageOutDir,
        assetRef,
        copiedAssetPath,
        receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
      },
      result: {
        ok: true,
        packageId: pkg.manifest.id,
        packageDir: packageOutDir,
        manifestPath,
        motionPath,
        assetRef,
        copiedAssetPath,
        assetSha256: sourceSha256,
        assetByteLength: source.byteLength,
        manifestAssets: manifest.assets,
        receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
        artifacts,
        receipt,
      },
      warnings: [],
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "package_asset_import_failed",
        message: packageAssetImportFailureMessage(error),
      },
      warnings: [],
    };
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

interface AdmittedPackageAssetImportSource {
  readonly root: string;
  readonly identity: StableFileIdentity;
  readonly sha256: string;
  readonly byteLength: number;
}

/** Admit bounded bytes and retain the exact source identity the later COW copy must reproduce. */
async function admitPackageAssetImportSource(
  sourcePath: string,
  roots: string[],
): Promise<AdmittedPackageAssetImportSource> {
  await assertConfiguredAuthoringInputFile(sourcePath, roots, "Package asset import source");
  const root = configuredAuthoringInputRoot(sourcePath, roots, "Package asset import source");
  const admitted = await readBoundedStableFile(sourcePath, {
    label: "Package asset import source",
    maxBytes: MAX_PACKAGE_ASSET_IMPORT_BYTES,
    withinRoot: root,
    requireSingleLink: true,
    captureIdentity: true,
  });
  if (!admitted.identity) throw new Error("Package asset import source could not retain a stable identity.");
  return { root, identity: admitted.identity, sha256: admitted.sha256, byteLength: admitted.byteLength };
}

/** Do not reflect a rejected host pathname or filesystem error through the public command. */
function packageAssetImportFailureMessage(error: unknown): string {
  if (error instanceof PackageEditTransactionError) return error.message;
  if (error instanceof Error && error.message.startsWith("Package asset import source")) return error.message;
  return "Package asset import could not complete safely.";
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
