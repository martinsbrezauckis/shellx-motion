/**
 * Durable receipt vocabulary for a package validation verdict.
 *
 * Validation is deliberately read-only with respect to the package. Hosts may persist this
 * evidence in their governed receipt store, but this module never chooses a destination or writes
 * a file. Keeping those concerns separate prevents a request to inspect a package from quietly
 * creating `receipts/` inside it.
 */
import { resolve } from "node:path";
import { hashBuffer } from "./receipts.js";
import { receiptStatusForWarnings } from "./receipt-status.js";
import { hashPackageFile, resolvePackageAsset } from "./package.js";
import { loadedPackageInputHashes } from "./package-loaded-inputs.js";
import { colorPipelineValidationReceiptEvidence } from "./color-pipeline.js";
import type { MotionPackage, OperationReceipt } from "./types.js";

export interface PackageValidationReceiptFailure {
  code: string;
  message: string;
  suggestedAction?: string;
  /** Structured validation classification returned by a caller-facing surface, when present. */
  detail?: unknown;
}

/** States whether the receipt hashes package bytes or only names an unreadable package location. */
export type PackageValidationInputHashScope = "package_bytes" | "resolved_package_root_identity_only";

export interface PackageValidationReceiptOutput {
  packageRoot: string;
  valid: boolean;
  /** Never mistake a failed-load path hash for an attestation of package content. */
  inputHashScope: PackageValidationInputHashScope;
  /** The caller-facing validation summary, retained so a receipt is sufficient evidence on its own. */
  validation: Record<string, unknown>;
  /** Requested pipeline plus explicit non-execution evidence for this validation-only receipt. */
  colorPipeline?: ReturnType<typeof colorPipelineValidationReceiptEvidence>;
  error?: PackageValidationReceiptFailure;
}

export interface CreatePackageValidationReceiptInput {
  packageRoot: string;
  /** Present when Motion could load enough of the package to bind the receipt to its real bytes. */
  package?: MotionPackage;
  valid: boolean;
  validation: Record<string, unknown>;
  error?: PackageValidationReceiptFailure;
  warnings?: string[];
  createdAt?: string;
}

/**
 * Build the universal `package.validate` receipt. The result is intentionally destination-free:
 * CLI, Debug API and SDK hosts supply their own governed receipt writer.
 */
export async function createPackageValidationReceipt(input: CreatePackageValidationReceiptInput): Promise<OperationReceipt> {
  const packageRoot = resolve(input.packageRoot);
  const packageId = input.package?.manifest.id ?? "unknown-package";
  const inputHashScope: PackageValidationInputHashScope = input.package ? "package_bytes" : "resolved_package_root_identity_only";
  const inputHashes = input.package
    ? await packageValidationInputHashes(input.package)
    // The loader could not read package bytes. Hashing the resolved path gives an incident a stable
    // location identity only; `inputHashScope` makes that limitation explicit to receipt consumers.
    : { resolvedPackageRootIdentity: hashBuffer(Buffer.from(packageRoot, "utf8")) };
  const warnings = uniqueStrings([
    ...(input.warnings ?? []),
    ...(input.error ? [input.error.message] : [])
  ]);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const colorPipeline = input.package ? validationColorPipelineEvidence(input.package) : undefined;
  const output: PackageValidationReceiptOutput = {
    packageRoot,
    valid: input.valid,
    inputHashScope,
    validation: input.validation,
    ...(colorPipeline ? { colorPipeline } : {}),
    ...(input.error ? { error: input.error } : {})
  };
  const id = `package-validate-${hashBuffer(Buffer.from(JSON.stringify({
    packageId,
    inputHashes,
    output,
    createdAt
  }), "utf8")).slice(0, 24)}`;

  return {
    schema: "shellx-motion/receipt@1",
    id,
    operation: "package.validate",
    status: input.valid ? receiptStatusForWarnings({ warnings }) : "failed",
    packageId,
    inputHashes,
    createdAt,
    lane: "validation",
    output,
    warnings
  };
}

/** A malformed declaration is reported by validation; receipt construction must not hide that verdict. */
function validationColorPipelineEvidence(pkg: MotionPackage): ReturnType<typeof colorPipelineValidationReceiptEvidence> | undefined {
  try {
    return colorPipelineValidationReceiptEvidence(pkg.motion);
  } catch {
    return undefined;
  }
}

/** Hash exactly the two authored package documents whose validation produced the verdict. */
export async function packageValidationInputHashes(pkg: MotionPackage): Promise<Record<string, string>> {
  const loaded = loadedPackageInputHashes(pkg);
  if (loaded?.["manifest.json"] && loaded[pkg.manifest.motion]) {
    return {
      "manifest.json": loaded["manifest.json"],
      [pkg.manifest.motion]: loaded[pkg.manifest.motion],
    };
  }
  const manifestPath = resolvePackageAsset(pkg, "manifest.json");
  const motionPath = resolvePackageAsset(pkg, pkg.manifest.motion);
  return {
    "manifest.json": await hashPackageFile(manifestPath),
    [pkg.manifest.motion]: await hashPackageFile(motionPath)
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}
