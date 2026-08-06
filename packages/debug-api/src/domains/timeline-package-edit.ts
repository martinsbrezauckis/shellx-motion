/** Shared capability-gated executor for atomic timeline package mutations. */
import {
  hashBuffer,
  hashPackageFile,
  loadSchema,
  resolvePackageAsset,
  validateDocument,
  type MotionDocument,
  type MotionPackage,
  type OperationReceipt
} from "@shellx-motion/core";
import { join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { stringArg } from "./args.js";
import { commitMotionDocumentEdit } from "./package-edit-transaction.js";

export interface TimelinePackageEditServices {
  receiptsRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  isUnsafePackageOutputDirectory?: (packageRoot: string, outputRoot: string) => Promise<boolean>;
  isEmptyOrAbsentDirectory?: (path: string) => Promise<boolean>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export interface TimelineCommonEditArgs {
  packageRoot: string;
  outDir: string;
  receiptsRoot?: string;
  createdBy?: string;
}

export interface AtomicTimelineMutation<T extends { motion: MotionDocument }> extends TimelineCommonEditArgs {
  command: MotionDebugCommand;
  receiptPrefix: string;
  receiptFileName: string;
  invalidCode: string;
  failureCode: string;
  services: TimelinePackageEditServices;
  additionalInputHashes?: (pkg: MotionPackage) => Promise<Record<string, string>>;
  mutate: (pkg: MotionPackage) => T | Promise<T>;
  outputFacts: (mutation: T) => Record<string, unknown>;
  resultFacts: (mutation: T) => Record<string, unknown>;
  visibleFacts: (mutation: T) => Record<string, unknown>;
}

export async function commitAtomicTimelineMutation<T extends { motion: MotionDocument }>(
  input: AtomicTimelineMutation<T>
): Promise<MotionDebugResult> {
  const { services } = input;
  try {
    const pkg = await services.packageLoader!(input.packageRoot);
    const packageOutDir = resolve(input.outDir);
    if (await services.isUnsafePackageOutputDirectory!(pkg.root, packageOutDir)) {
      return invalidArgs(`${input.command} outDir must be outside packageRoot.`);
    }
    if (!await services.isEmptyOrAbsentDirectory!(packageOutDir)) {
      return invalidArgs(`${input.command} outDir must be empty or absent before package copy.`);
    }
    const inputHashes = {
      "manifest.json": await hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
      [pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion))
    };
    if (input.additionalInputHashes) Object.assign(inputHashes, await input.additionalInputHashes(pkg));
    const mutation = await input.mutate(pkg);
    const validation = await validateDocument(await loadSchema("motion"), mutation.motion);
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          code: input.invalidCode,
          message: "Patched Motion document failed validation.",
          suggestedAction: validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")
        },
        warnings: []
      };
    }
    const manifestPath = join(packageOutDir, "manifest.json");
    const motionPath = join(packageOutDir, pkg.manifest.motion);
    const output = {
      packageDir: packageOutDir,
      manifestPath,
      motionPath,
      ...input.outputFacts(mutation),
      validation,
      ...(input.createdBy ? { createdBy: input.createdBy } : {})
    };
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `${input.receiptPrefix}-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`,
      operation: input.command.replace("motion.", ""),
      status: "passed",
      packageId: pkg.manifest.id,
      inputHashes,
      createdAt: new Date().toISOString(),
      lane: "debug-api",
      output,
      warnings: []
    };
    const receiptPath = join(packageOutDir, "receipts", input.receiptFileName);
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg,
      outputRoot: packageOutDir,
      patchedMotion: mutation.motion,
      receipt,
      receiptFileName: input.receiptFileName,
      ...(input.receiptsRoot ? { receiptsRoot: input.receiptsRoot, writeHostReceipt: services.writeReceipt! } : {})
    });
    return {
      ok: true,
      receiptId: receipt.id,
      visibleState: {
        panel: "timeline",
        operation: receipt.operation,
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        packageDir: packageOutDir,
        ...input.visibleFacts(mutation),
        receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {})
      },
      result: {
        ok: true,
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        packageDir: packageOutDir,
        manifestPath,
        motionPath,
        receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
        ...input.resultFacts(mutation),
        validation,
        motion: mutation.motion,
        receipt
      },
      warnings: []
    };
  } catch (error) {
    return commandFailure(input.failureCode, error);
  }
}

export function readTimelineCommonEditArgs(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelinePackageEditServices
): TimelineCommonEditArgs | MotionDebugResult {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  if (!packageRoot) return invalidArgs(`${command} requires packageRoot.`);
  if (!outDir) return invalidArgs(`${command} requires outDir.`);
  if (!services.packageLoader || !services.isUnsafePackageOutputDirectory || !services.isEmptyOrAbsentDirectory) {
    return capabilityUnavailable("Atomic timeline package editing is unavailable.");
  }
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Timeline edit receipt persistence is unavailable.");
  return { packageRoot, outDir, ...(receiptsRoot ? { receiptsRoot } : {}), ...(createdBy ? { createdBy } : {}) };
}

export function isTimelineCommonEditResult(
  value: TimelineCommonEditArgs | MotionDebugResult
): value is MotionDebugResult {
  return "ok" in value;
}

export function timelineMutationFacts<T extends { motion: MotionDocument }>(mutation: T): Omit<T, "motion"> {
  const { motion: _motion, ...facts } = mutation;
  return facts;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return {
    ok: false,
    error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." },
    warnings: []
  };
}

function commandFailure(code: string, error: unknown): MotionDebugResult {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}
