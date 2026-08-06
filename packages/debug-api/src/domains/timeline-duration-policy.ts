/** Read and atomically mutate the ShellX Motion duration-policy extension. */
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
import { objectArg, stringArg } from "./args.js";
import { commitMotionDocumentEdit } from "./package-edit-transaction.js";

export const DURATION_POLICY_EXTENSION_KEY = "x-shellx-duration-policy";

export interface DurationProtectedRegion {
  id: string;
  label?: string;
  role?: string;
  startMs: number;
  durationMs: number;
}

export interface DurationPolicy {
  schema: "shellx-motion/duration-policy@1";
  minDurationMs?: number;
  maxDurationMs?: number;
  resizeMode?: "stretch-middle" | "ripple" | "fixed";
  protectedRegions: DurationProtectedRegion[];
}

export interface TimelineDurationPolicyServices {
  receiptsRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  isUnsafePackageOutputDirectory?: (packageRoot: string, outputRoot: string) => Promise<boolean>;
  isEmptyOrAbsentDirectory?: (path: string) => Promise<boolean>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchTimelineDurationPolicyCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineDurationPolicyServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.timeline.duration.policy.set") return null;
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const policyInput = ownRecordArg(args, "policy");
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.timeline.duration.policy.set requires packageRoot.");
  if (!outDir) return invalidArgs("motion.timeline.duration.policy.set requires outDir.");
  if (!policyInput) return invalidArgs("motion.timeline.duration.policy.set requires policy.");
  if (!services.packageLoader || !services.isUnsafePackageOutputDirectory || !services.isEmptyOrAbsentDirectory) {
    return capabilityUnavailable("Atomic timeline duration-policy editing is unavailable.");
  }
  if (receiptsRoot && !services.writeReceipt) {
    return capabilityUnavailable("Timeline duration-policy receipt persistence is unavailable.");
  }

  try {
    const pkg = await services.packageLoader(packageRoot);
    const normalizedPolicy = normalizeDurationPolicy(policyInput, pkg.motion.durationMs);
    if (typeof normalizedPolicy === "string") return invalidArgs(normalizedPolicy);
    const packageOutDir = resolve(outDir);
    if (await services.isUnsafePackageOutputDirectory(pkg.root, packageOutDir)) {
      return invalidArgs("motion.timeline.duration.policy.set outDir must be outside packageRoot.");
    }
    if (!await services.isEmptyOrAbsentDirectory(packageOutDir)) {
      return invalidArgs("motion.timeline.duration.policy.set outDir must be empty or absent before package copy.");
    }
    const manifestPath = resolvePackageAsset(pkg, "manifest.json");
    const motionPath = resolvePackageAsset(pkg, pkg.manifest.motion);
    const inputHashes = {
      "manifest.json": await hashPackageFile(manifestPath),
      [pkg.manifest.motion]: await hashPackageFile(motionPath)
    };
    const previousPolicy = readMotionDurationPolicy(pkg.motion).policy;
    const patchedMotion: MotionDocument = {
      ...pkg.motion,
      [DURATION_POLICY_EXTENSION_KEY]: normalizedPolicy
    };
    const validation = await validateDocument(await loadSchema("motion"), patchedMotion);
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          code: "timeline_duration_policy_invalid",
          message: "Patched Motion document failed validation.",
          suggestedAction: validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")
        },
        warnings: []
      };
    }

    const patchedMotionPath = join(packageOutDir, pkg.manifest.motion);
    const changedPath = `/${DURATION_POLICY_EXTENSION_KEY}`;
    const output = {
      packageDir: packageOutDir,
      manifestPath: join(packageOutDir, "manifest.json"),
      motionPath: patchedMotionPath,
      changedPath,
      changedPaths: [changedPath],
      previousPolicy,
      policy: normalizedPolicy,
      protectedRegions: normalizedPolicy.protectedRegions,
      validation,
      ...(createdBy ? { createdBy } : {})
    };
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `timeline-duration-policy-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`,
      operation: "timeline.duration.policy.set",
      status: "passed",
      packageId: pkg.manifest.id,
      inputHashes,
      createdAt: new Date().toISOString(),
      lane: "debug-api",
      output,
      warnings: []
    };
    const receiptPath = join(packageOutDir, "receipts", "timeline-duration-policy.receipt.json");
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg,
      outputRoot: packageOutDir,
      patchedMotion,
      receipt,
      receiptFileName: "timeline-duration-policy.receipt.json",
      ...(receiptsRoot ? { receiptsRoot, writeHostReceipt: services.writeReceipt! } : {})
    });
    return {
      ok: true,
      receiptId: receipt.id,
      visibleState: {
        ...visibleDurationPolicyState(pkg, normalizedPolicy),
        operation: "timeline.duration.policy.set",
        packageDir: packageOutDir,
        changedPath,
        receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {})
      },
      result: {
        ok: true,
        packageId: pkg.manifest.id,
        motionId: pkg.motion.id,
        packageDir: packageOutDir,
        manifestPath: output.manifestPath,
        motionPath: patchedMotionPath,
        receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
        changedPath,
        changedPaths: [changedPath],
        previousPolicy,
        policy: normalizedPolicy,
        protectedRegions: normalizedPolicy.protectedRegions,
        validation,
        motion: patchedMotion,
        receipt
      },
      warnings: []
    };
  } catch (error) {
    return commandFailure("timeline_duration_policy_failed", error);
  }
}

export function readMotionDurationPolicy(motion: MotionDocument): { policy: DurationPolicy | null; warnings: string[] } {
  const value = motion[DURATION_POLICY_EXTENSION_KEY];
  if (value === undefined) return { policy: null, warnings: [] };
  const policy = normalizeDurationPolicy(value, motion.durationMs);
  if (typeof policy === "string") return { policy: null, warnings: [`Ignored invalid duration policy: ${policy}`] };
  return { policy, warnings: [] };
}

export function visibleDurationPolicyState(pkg: MotionPackage, policy: DurationPolicy | null): Record<string, unknown> {
  return {
    panel: "timeline",
    operation: "timeline.duration.policy",
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    hasPolicy: policy !== null,
    protectedRegionCount: policy?.protectedRegions.length ?? 0,
    durationMs: pkg.motion.durationMs,
    ...(policy?.minDurationMs !== undefined ? { minDurationMs: policy.minDurationMs } : {}),
    ...(policy?.maxDurationMs !== undefined ? { maxDurationMs: policy.maxDurationMs } : {}),
    ...(policy?.resizeMode !== undefined ? { resizeMode: policy.resizeMode } : {})
  };
}

export function normalizeDurationPolicy(value: unknown, motionDurationMs: number): DurationPolicy | string {
  const record = ownRecord(value);
  if (!record) return "policy must be an object.";
  const minDurationMs = readOptionalDurationPolicyNumber(record, "minDurationMs");
  if (minDurationMs === false) return "minDurationMs must be a non-negative finite number.";
  const maxDurationMs = readOptionalDurationPolicyNumber(record, "maxDurationMs");
  if (maxDurationMs === false) return "maxDurationMs must be a non-negative finite number.";
  if (minDurationMs !== undefined && maxDurationMs !== undefined && minDurationMs > maxDurationMs) {
    return "minDurationMs must be less than or equal to maxDurationMs.";
  }
  const resizeMode = readDurationResizeMode(record.resizeMode);
  if (resizeMode === false) return "resizeMode must be stretch-middle, ripple, or fixed.";
  const protectedRegions = normalizeDurationProtectedRegions(record.protectedRegions, motionDurationMs);
  if (typeof protectedRegions === "string") return protectedRegions;
  return {
    schema: "shellx-motion/duration-policy@1",
    ...(minDurationMs !== undefined ? { minDurationMs } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    ...(resizeMode !== undefined ? { resizeMode } : {}),
    protectedRegions
  };
}

function normalizeDurationProtectedRegions(value: unknown, motionDurationMs: number): DurationProtectedRegion[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "protectedRegions must be an array.";
  const ids = new Set<string>();
  const regions: DurationProtectedRegion[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const record = ownRecord(value[index]);
    if (!record) return `protectedRegions[${index}] must be an object.`;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return `protectedRegions[${index}].id must be a non-empty string.`;
    if (ids.has(id)) return `protectedRegions[${id}] id must be unique.`;
    ids.add(id);
    const startMs = record.startMs;
    if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0) {
      return `protectedRegions[${id}].startMs must be a non-negative finite number.`;
    }
    const durationMs = record.durationMs;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
      return `protectedRegions[${id}].durationMs must be a positive finite number.`;
    }
    if (startMs + durationMs > motionDurationMs) return `protectedRegions[${id}] must end within motion duration.`;
    regions.push({
      id,
      ...(typeof record.label === "string" && record.label.length > 0 ? { label: record.label } : {}),
      ...(typeof record.role === "string" && record.role.length > 0 ? { role: record.role } : {}),
      startMs,
      durationMs
    });
  }
  return regions;
}

function ownRecordArg(args: unknown, key: string): Record<string, unknown> | null {
  const record = objectArg(args);
  return record && Object.hasOwn(record, key) ? ownRecord(record[key]) : null;
}

// Copying enumerable own fields prevents prototype-supplied policy authority.
function ownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function readOptionalDurationPolicyNumber(record: Record<string, unknown>, key: string): number | false | undefined {
  if (!Object.hasOwn(record, key) || record[key] === undefined) return undefined;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : false;
}

function readDurationResizeMode(value: unknown): DurationPolicy["resizeMode"] | false | undefined {
  if (value === undefined) return undefined;
  return value === "stretch-middle" || value === "ripple" || value === "fixed" ? value : false;
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
