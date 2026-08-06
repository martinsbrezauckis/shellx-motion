/** Copy-on-write chroma-key and roto-mask authoring commands. */
import {
  applyMotionLayerChromaKey,
  detachMotionLayerRotoTracking,
  hashBuffer,
  hashPackageFile,
  inspectMotionLayerKeying,
  loadSchema,
  removeMotionLayerChromaKey,
  removeMotionLayerRotoMask,
  resolvePackageAsset,
  upsertMotionLayerRotoMask,
  validateDocument,
  type MotionChromaKey,
  type MotionKeyingEditResult,
  type MotionMask,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact,
} from "@shellx-motion/core";
import { join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { recordArg, stringArg } from "./args.js";
import { commitMotionDocumentEdit, PackageEditTransactionError } from "./package-edit-transaction.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface KeyingAuthoringServices {
  receiptsRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchKeyingAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: KeyingAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (command === "motion.keying.inspect") return inspect(args, services);
  if (command === "motion.keying.apply") return mutate(command, args, services, "keying.apply");
  if (command === "motion.keying.remove") return mutate(command, args, services, "keying.remove");
  if (command === "motion.roto.upsert") return mutate(command, args, services, "roto.upsert");
  if (command === "motion.roto.tracking.detach") return mutate(command, args, services, "roto.tracking.detach");
  if (command === "motion.roto.remove") return mutate(command, args, services, "roto.remove");
  return null;
}

async function inspect(args: unknown, services: KeyingAuthoringServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const layerId = safeIdArg(args, "layerId");
  if (!packageRoot) return invalidArgs("motion.keying.inspect requires packageRoot.");
  if (!layerId) return invalidArgs("motion.keying.inspect requires a safe layerId.");
  if (!services.packageLoader) return capabilityUnavailable("Motion package inspection is unavailable.");
  try {
    const pkg = await services.packageLoader(packageRoot);
    const state = inspectMotionLayerKeying(pkg.motion, layerId);
    return {
      ok: true,
      result: { packageId: pkg.manifest.id, packageRoot: pkg.root, state },
      visibleState: { panel: "keyingInspector", operation: "keying.inspect", packageId: pkg.manifest.id, layerId, state },
      warnings: [],
    };
  } catch (error) {
    return commandFailure("keying_inspect_failed", error);
  }
}

type KeyingMutationOperation = "keying.apply" | "keying.remove" | "roto.upsert" | "roto.tracking.detach" | "roto.remove";

async function mutate(
  command: MotionDebugCommand,
  args: unknown,
  services: KeyingAuthoringServices,
  operation: KeyingMutationOperation,
): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outputArg = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const layerId = safeIdArg(args, "layerId");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  if (!outputArg) return invalidArgs(`${command} requires outDir.`);
  if (!layerId) return invalidArgs(`${command} requires a safe layerId.`);
  if (operation === "keying.apply" && !recordArg(args, "keying")) return invalidArgs(`${command} requires keying.`);
  if (operation === "roto.upsert" && !recordArg(args, "mask")) return invalidArgs(`${command} requires mask.`);
  if (!services.packageLoader) return capabilityUnavailable("Atomic keying package editing is unavailable.");
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Keying receipt persistence is unavailable.");

  try {
    const pkg = await services.packageLoader(packageRoot);
    const outputRoot = resolve(outputArg);
    const edit = applyMutation(operation, pkg, layerId, args);
    const validation = await validateDocument(await loadSchema("motion"), edit.motion);
    if (!validation.ok) throw new Error(`Patched Motion document failed validation: ${validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
    const receiptFileName = `${operation.replaceAll(".", "-")}-${layerId}.receipt.json`;
    const receiptPath = join(outputRoot, "receipts", receiptFileName);
    const artifacts: ReceiptArtifact[] = [
      { role: "motion_package", path: outputRoot, status: "available", primary: true },
      { role: "keying_receipt", path: receiptPath, status: "available", mediaType: "application/json" },
    ];
    const inputHashes = {
      "manifest.json": await hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
      [pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion)),
      mutation: hashBuffer(Buffer.from(JSON.stringify({ operation, layerId, keying: recordArg(args, "keying"), mask: recordArg(args, "mask") }), "utf8")),
    };
    const output = { packageRoot: outputRoot, layerId, changedPaths: edit.changedPaths, state: edit.state, validation };
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `${operation.replaceAll(".", "-")}-${hashBuffer(Buffer.from(JSON.stringify({ packageId: pkg.manifest.id, inputHashes }), "utf8")).slice(0, 16)}`,
      operation,
      status: "passed",
      packageId: pkg.manifest.id,
      inputHashes,
      createdAt: new Date().toISOString(),
      lane: "debug-api",
      output,
      artifacts,
      warnings: [],
    };
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg,
      outputRoot,
      patchedMotion: edit.motion,
      receipt,
      receiptFileName,
      ...(receiptsRoot ? { receiptsRoot, writeHostReceipt: services.writeReceipt! } : {}),
    });
    const result = { ...output, packageId: pkg.manifest.id, motionPath: installed.motionPath, receiptPath: installed.receiptPath, receipt, ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}) };
    return {
      ok: true,
      result,
      receiptId: receipt.id,
      visibleState: { panel: "keyingInspector", operation, packageId: pkg.manifest.id, packageRoot: outputRoot, layerId, state: edit.state, receiptPath: installed.receiptPath },
      warnings: [],
    };
  } catch (error) {
    return commandFailure(error instanceof PackageEditTransactionError ? error.code : `${operation.replaceAll(".", "_")}_failed`, error);
  }
}

function applyMutation(operation: KeyingMutationOperation, pkg: MotionPackage, layerId: string, args: unknown): MotionKeyingEditResult {
  if (operation === "keying.apply") return applyMotionLayerChromaKey(pkg.motion, layerId, recordArg(args, "keying") as unknown as MotionChromaKey);
  if (operation === "keying.remove") return removeMotionLayerChromaKey(pkg.motion, layerId);
  if (operation === "roto.upsert") return upsertMotionLayerRotoMask(pkg.motion, layerId, recordArg(args, "mask") as unknown as MotionMask);
  if (operation === "roto.tracking.detach") return detachMotionLayerRotoTracking(pkg.motion, layerId);
  return removeMotionLayerRotoMask(pkg.motion, layerId);
}

function safeIdArg(args: unknown, key: string): string | null {
  const value = stringArg(args, key);
  return value && SAFE_ID.test(value) ? value : null;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}

function commandFailure(code: string, error: unknown): MotionDebugResult {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}
