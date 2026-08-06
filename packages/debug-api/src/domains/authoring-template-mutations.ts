/** Atomic template value and media mutations in the authoring domain. */
import {
  applyTemplateValues,
  hashBuffer,
  hashPackageFile,
  loadSchema,
  replaceTemplateMedia,
  resolvePackageAsset,
  validateDocument,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact,
  type TemplateApplyError,
  type TemplateValue
} from "@shellx-motion/core";
import { basename, join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { objectArg, stringArg } from "./args.js";
import { commitMotionDocumentEdit } from "./package-edit-transaction.js";

export interface TemplateMutationServices {
  receiptsRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  isUnsafePackageOutputDirectory?: (packageRoot: string, outputRoot: string) => Promise<boolean>;
  isEmptyOrAbsentDirectory?: (path: string) => Promise<boolean>;
  hashInputFile?: (path: string) => Promise<string>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchTemplateMutationCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TemplateMutationServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.template.apply") return apply(args, services);
  if (command === "motion.template.media.replace") return replaceMedia(args, services);
  return null;
}

async function apply(args: unknown, services: TemplateMutationServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const values = templateValuesArg(args, "values");
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.template.apply requires packageRoot.");
  if (!outDir) return invalidArgs("motion.template.apply requires outDir.");
  if (!values) return invalidArgs("motion.template.apply requires values.");
  const unavailable = mutationCapabilityError(services, receiptsRoot);
  if (unavailable) return unavailable;

  const pkg = await services.packageLoader!(packageRoot);
  const applied = applyTemplateValues(pkg, values);
  if (!applied.ok) return templateApplyFailure("template_apply_failed", "Template values could not be applied.", applied.errors);
  const receiptId = `template-apply-${hashBuffer(Buffer.from(`${pkg.manifest.id}:${JSON.stringify(applied.changedBindings)}`, "utf8")).slice(0, 16)}`;
  try {
    const packageOutDir = resolve(outDir);
    const outputError = await packageOutputError("motion.template.apply", pkg, packageOutDir, services);
    if (outputError) return outputError;
    const validation = await validateDocument(await loadSchema("motion"), applied.motion);
    if (!validation.ok) return validationFailure("template_apply_invalid", "Applied Motion document failed validation.", validation, applied.warnings);
    const inputHashes: Record<string, string> = {
      "manifest.json": await hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
      [pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion)),
      updates: hashBuffer(Buffer.from(JSON.stringify(values), "utf8"))
    };
    if (pkg.manifest.template) inputHashes[pkg.manifest.template] = await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.template));
    const manifestPath = join(packageOutDir, "manifest.json");
    const motionPath = join(packageOutDir, pkg.manifest.motion);
    const receiptPath = join(packageOutDir, "receipts", "template-apply.receipt.json");
    const artifacts: ReceiptArtifact[] = [
      { role: "motion_package", path: packageOutDir, status: "available", primary: true },
      { role: "template_apply_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
    ];
    const output = {
      packageDir: packageOutDir, manifestPath, motionPath,
      changedParams: applied.changedParams, changedBindings: applied.changedBindings, validation,
      ...(createdBy ? { createdBy } : {})
    };
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1", id: receiptId, operation: "template.apply", status: "passed",
      packageId: pkg.manifest.id, inputHashes, createdAt: new Date().toISOString(), lane: "template",
      output, artifacts, warnings: applied.warnings
    };
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg, outputRoot: packageOutDir, patchedMotion: applied.motion,
      receipt, receiptFileName: "template-apply.receipt.json",
      ...(receiptsRoot ? { receiptsRoot, writeHostReceipt: services.writeReceipt! } : {})
    });
    return {
      ok: true,
      receiptId,
      visibleState: {
        panel: "templateInspector", operation: "template.apply", packageId: pkg.manifest.id,
        templateId: pkg.template?.id, packageDir: packageOutDir, changedParams: applied.changedParams,
        receiptPath, ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {})
      },
      result: {
        ok: true, packageId: pkg.manifest.id, templateId: pkg.template?.id, packageDir: packageOutDir,
        manifestPath, motionPath, changedParams: applied.changedParams, changedBindings: applied.changedBindings,
        validation, motion: applied.motion, receipt, receiptPath, artifacts,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {})
      },
      warnings: applied.warnings
    };
  } catch (error) {
    return commandFailure("template_apply_failed", error, applied.warnings);
  }
}

async function replaceMedia(args: unknown, services: TemplateMutationServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const paramId = stringArg(args, "paramId");
  const assetPath = stringArg(args, "assetPath");
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.template.media.replace requires packageRoot.");
  if (!outDir) return invalidArgs("motion.template.media.replace requires outDir.");
  if (!paramId) return invalidArgs("motion.template.media.replace requires paramId.");
  if (!assetPath) return invalidArgs("motion.template.media.replace requires assetPath.");
  const unavailable = mutationCapabilityError(services, receiptsRoot, true);
  if (unavailable) return unavailable;

  try {
    const pkg = await services.packageLoader!(packageRoot);
    const sourceAssetPath = resolve(assetPath);
    const assetRef = stringArg(args, "assetRef") ?? `assets/${basename(sourceAssetPath)}`;
    const replaced = replaceTemplateMedia(pkg, { paramId, assetRef });
    if (!replaced.ok) return templateApplyFailure("template_media_replace_failed", "Template media could not be replaced.", replaced.errors);
    const packageOutDir = resolve(outDir);
    const outputError = await packageOutputError("motion.template.media.replace", pkg, packageOutDir, services);
    if (outputError) return outputError;
    const sourceHash = await services.hashInputFile!(sourceAssetPath);
    const inputHashes: Record<string, string> = {
      "manifest.json": await hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
      [pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion)),
      [sourceAssetPath]: sourceHash
    };
    if (pkg.manifest.template) inputHashes[pkg.manifest.template] = await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.template));
    const validation = await validateDocument(await loadSchema("motion"), replaced.motion);
    if (!validation.ok) return validationFailure("template_media_replace_invalid", "Patched Motion document failed validation.", validation, replaced.warnings);
    const manifestPath = join(packageOutDir, "manifest.json");
    const motionPath = join(packageOutDir, pkg.manifest.motion);
    const copiedAssetPath = resolvePackageAsset({ root: packageOutDir }, replaced.assetRef);
    const receiptPath = join(packageOutDir, "receipts", "template-media-replace.receipt.json");
    const artifacts: ReceiptArtifact[] = [
      { role: "motion_package", path: packageOutDir, status: "available", primary: true },
      { role: "template_media_asset", path: copiedAssetPath, status: "available" },
      { role: "template_media_replace_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
    ];
    const output = {
      packageDir: packageOutDir, manifestPath, motionPath, paramId: replaced.paramId,
      assetRef: replaced.assetRef, copiedAssetPath, changedParams: replaced.changedParams,
      changedBindings: replaced.changedBindings, manifestAssets: replaced.manifestAssets, validation,
      ...(createdBy ? { createdBy } : {})
    };
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `template-media-replace-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`,
      operation: "template.media.replace", status: "passed", packageId: pkg.manifest.id,
      inputHashes, createdAt: new Date().toISOString(), lane: "debug-api", output, artifacts, warnings: replaced.warnings
    };
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg, outputRoot: packageOutDir, patchedMotion: replaced.motion, patchedManifest: replaced.manifest,
      stagedFiles: [{ sourcePath: sourceAssetPath, targetAssetRef: replaced.assetRef, expectedSha256: sourceHash }],
      receipt, receiptFileName: "template-media-replace.receipt.json",
      ...(receiptsRoot ? { receiptsRoot, writeHostReceipt: services.writeReceipt! } : {})
    });
    return {
      ok: true,
      receiptId: receipt.id,
      visibleState: {
        panel: "templateInspector", operation: "template.media.replace", packageId: replaced.packageId,
        templateId: replaced.templateId, packageDir: packageOutDir, paramId: replaced.paramId,
        assetRef: replaced.assetRef, copiedAssetPath, changedBindings: replaced.changedBindings, receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {})
      },
      result: {
        ok: true, packageId: replaced.packageId, templateId: replaced.templateId, packageDir: packageOutDir,
        manifestPath, motionPath, receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
        paramId: replaced.paramId, assetRef: replaced.assetRef, copiedAssetPath,
        changedParams: replaced.changedParams, changedBindings: replaced.changedBindings,
        manifestAssets: replaced.manifestAssets, validation, artifacts, receipt
      },
      warnings: replaced.warnings
    };
  } catch (error) {
    return commandFailure("template_media_replace_failed", error);
  }
}

function mutationCapabilityError(
  services: TemplateMutationServices,
  receiptsRoot: string | undefined,
  needsInputHash = false
): MotionDebugResult | null {
  if (!services.packageLoader || !services.isUnsafePackageOutputDirectory || !services.isEmptyOrAbsentDirectory) {
    return capabilityUnavailable("Atomic template package editing is unavailable.");
  }
  if (needsInputHash && !services.hashInputFile) return capabilityUnavailable("Template media source hashing is unavailable.");
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Template edit receipt persistence is unavailable.");
  return null;
}

async function packageOutputError(
  command: string,
  pkg: MotionPackage,
  outputRoot: string,
  services: TemplateMutationServices
): Promise<MotionDebugResult | null> {
  if (await services.isUnsafePackageOutputDirectory!(pkg.root, outputRoot)) return invalidArgs(`${command} outDir must be outside packageRoot.`);
  if (!await services.isEmptyOrAbsentDirectory!(outputRoot)) return invalidArgs(`${command} outDir must be empty or absent before package copy.`);
  return null;
}

function templateValuesArg(args: unknown, key: string): Record<string, TemplateValue> | null {
  const record = objectArg(args);
  const raw = record && Object.hasOwn(record, key) ? objectArg(record[key]) : null;
  if (!raw) return null;
  const values: Record<string, TemplateValue> = {};
  for (const [paramId, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) values[paramId] = value;
  }
  return values;
}

function templateApplyFailure(code: string, message: string, errors: TemplateApplyError[]): MotionDebugResult {
  return { ok: false, error: { code, message, suggestedAction: errors.map((error) => `${error.paramId}: ${error.message}`).join("; ") }, warnings: [] };
}

function validationFailure(
  code: string,
  message: string,
  validation: { errors: Array<{ path: string; message: string }> },
  warnings: string[]
): MotionDebugResult {
  return { ok: false, error: { code, message, suggestedAction: validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ") }, warnings };
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}

function commandFailure(code: string, error: unknown, warnings: string[] = []): MotionDebugResult {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings };
}
