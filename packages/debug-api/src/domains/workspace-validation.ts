/** Package-validation verdicts plus optional, host-governed evidence persistence. */
import {
  createPackageValidationReceipt,
  colorPipelineRenderPlan,
  motionValidationReport,
  restoreMotionDocumentCompositing,
  unreadableKeyframesRefusal,
  unrenderablePackageRefusal,
  validatePackageAssetReferences,
  validateMotionDocumentInStages,
  type MotionPackage,
  type OperationReceipt,
} from "@shellx-motion/core";
import type { MotionDebugResult } from "../command-registry.js";
import { stringArg } from "./args.js";
import type { WorkspaceDomainServices } from "./workspace.js";

/** Keep malformed documents from flooding a transport response; this matches the CLI cap. */
const MAX_REPORTED_SCHEMA_ERRORS = 50;

/**
 * Validate without changing the source package. A receipt is written only to the host-governed
 * destination, and the fence runs before loading so a broken package cannot create `receipts/`.
 */
export async function validateWorkspacePackage(
  args: unknown,
  services: WorkspaceDomainServices,
): Promise<MotionDebugResult> {
  if (!services.packageLoader) return capabilityUnavailable("Motion package validation is unavailable on this host.");
  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) {
    return invalidArgsWithAction("motion.package.validate requires packageRoot.", "Pass the directory holding manifest.json and motion.json.");
  }
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  if (receiptsRoot && (!services.writeReceipt || !services.packageLoader || !services.isUnsafePackageOutputDirectory)) {
    return capabilityUnavailable("Package validation receipt persistence is unavailable on this host.");
  }
  try {
    if (receiptsRoot && await services.isUnsafePackageOutputDirectory!(packageRoot, receiptsRoot)) {
      return invalidArgsWithAction(
        "motion.package.validate receiptsRoot must be outside packageRoot.",
        "Use a host-governed receipts directory outside the package; validate never creates receipts inside the package it inspects.",
      );
    }
    // One loaded object supplies the summary, every verdict and receipt inputs. Calling a second
    // service here would allow a concurrent edit to make the receipt describe another load.
    const pkg = await services.packageLoader(packageRoot);
    const summary = packageValidationSummary(pkg);
    const assetReferences = await validatePackageAssetReferences(pkg);
    if (!assetReferences.ok) {
      return persistValidationReceipt({
        ok: false,
        error: {
          code: "invalid_package_assets",
          message: `Package has ${assetReferences.problems.length} invalid package-local asset reference(s).`,
          suggestedAction: "Restore or import each named package-local asset, then validate again before rendering.",
        },
        result: {
          valid: false,
          packageRoot,
          ...summary,
          validation: motionValidationReport("semantic"),
          packageAssetProblems: assetReferences.problems,
        },
        warnings: [],
      }, packageRoot, pkg, receiptsRoot, services.writeReceipt);
    }
    const staged = await validateMotionDocumentInStages(pkg.motion);
    if (!staged.ok) {
      return persistValidationReceipt({
        ok: false,
        error: {
          code: "invalid_motion_document",
          message: `Motion document failed ${staged.stage} validation for shellx-motion/motion@1: ${staged.errors.length} error(s).`,
          suggestedAction: "Correct the paths listed in schemaErrors. Each path is a JSON pointer into motion.json.",
        },
        result: {
          valid: false,
          packageRoot,
          ...summary,
          validation: staged.report,
          schemaErrorCount: staged.errors.length,
          schemaErrors: staged.errors.slice(0, MAX_REPORTED_SCHEMA_ERRORS),
          schemaErrorsTruncated: staged.errors.length > MAX_REPORTED_SCHEMA_ERRORS,
        },
        warnings: [],
      }, packageRoot, pkg, receiptsRoot, services.writeReceipt);
    }
    const unrenderable = unrenderablePackageRefusal(pkg.motion);
    if (unrenderable) {
      return persistValidationReceipt({
        ok: false,
        error: { code: unrenderable.code, message: unrenderable.message, suggestedAction: unrenderable.suggestedAction },
        result: { valid: false, packageRoot, ...summary, validation: motionValidationReport("semantic"), unrenderableLayers: unrenderable.layers },
        warnings: [],
      }, packageRoot, pkg, receiptsRoot, services.writeReceipt);
    }
    const unreadableKeyframes = unreadableKeyframesRefusal(pkg.motion);
    if (unreadableKeyframes) {
      return persistValidationReceipt({
        ok: false,
        error: {
          code: unreadableKeyframes.code,
          message: unreadableKeyframes.message,
          suggestedAction: unreadableKeyframes.suggestedAction,
        },
        result: {
          valid: false,
          packageRoot,
          ...summary,
          validation: motionValidationReport("semantic"),
          unreadableKeyframeCount: unreadableKeyframes.keyframeCount,
          totalKeyframeCount: unreadableKeyframes.totalKeyframeCount,
          unreadableKeyframeTargetCount: unreadableKeyframes.targetCount,
          unreadableKeyframes: unreadableKeyframes.keyframes,
          unreadableKeyframesTruncated: unreadableKeyframes.truncated,
        },
        warnings: [],
      }, packageRoot, pkg, receiptsRoot, services.writeReceipt);
    }
    const compositingIntegrity = compositingIntegrityRefusal(pkg.motion);
    if (compositingIntegrity) {
      return persistValidationReceipt({
        ok: false,
        error: compositingIntegrity,
        result: { valid: false, packageRoot, ...summary, validation: motionValidationReport("semantic"), compositingIntegrity: "invalid" },
        warnings: [],
      }, packageRoot, pkg, receiptsRoot, services.writeReceipt);
    }
    return persistValidationReceipt({
      ok: true,
      visibleState: { panel: "workspace", operation: "package.validate", packageRoot },
      result: { ok: true, valid: true, packageRoot, ...summary, colorPipeline: colorPipelineRenderPlan(pkg.motion), validation: staged.report },
      warnings: [],
    }, packageRoot, pkg, receiptsRoot, services.writeReceipt);
  } catch (error) {
    return persistValidationReceipt({
      ok: false,
      error: {
        code: "invalid_args",
        message: error instanceof Error ? error.message : "Motion package is not valid.",
        suggestedAction: "Fix the named field in motion.json or manifest.json, then validate again.",
      },
      result: { valid: false, packageRoot },
      warnings: [],
    }, packageRoot, undefined, receiptsRoot, services.writeReceipt);
  }
}

function packageValidationSummary(pkg: MotionPackage): Record<string, unknown> {
  return {
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    name: pkg.manifest.name,
    layers: pkg.motion.layers.length,
    width: pkg.motion.width,
    height: pkg.motion.height,
    fps: pkg.motion.fps,
    durationMs: pkg.motion.durationMs,
    hosts: pkg.manifest.compatibility.hosts,
    lanes: pkg.manifest.compatibility.lanes,
  };
}

/**
 * A document that carries compiled compositing output has more to prove than its JSON Schema
 * shape: the output must be the deterministic compilation of the editable graph. This restores
 * only an in-memory clone, so it validates the exact loaded package snapshot without mutating it.
 */
function compositingIntegrityRefusal(motion: MotionPackage["motion"]): Extract<MotionDebugResult, { ok: false }> ["error"] | null {
  try {
    restoreMotionDocumentCompositing(motion);
    return null;
  } catch (error) {
    return {
      code: "invalid_motion_document",
      message: error instanceof Error ? error.message : "Motion compositing metadata is invalid.",
      suggestedAction: "Recompile the compositing graph through Motion, then validate the package again.",
      // Local SDK validation previously exposed this as local_operation_failed. The marker allows
      // that narrow compatibility mapping without making Debug/MCP emit an SDK-specific code.
      detail: { validation: "compositing_compile_integrity" },
    };
  }
}

/** Attach a universal validation receipt without changing the validation answer itself. */
async function persistValidationReceipt(
  response: MotionDebugResult,
  packageRoot: string,
  pkg: MotionPackage | undefined,
  receiptsRoot: string | undefined,
  writeReceipt: ((root: string, receipt: OperationReceipt) => Promise<string>) | undefined,
): Promise<MotionDebugResult> {
  if (!receiptsRoot) return response;
  if (!writeReceipt) return capabilityUnavailable("Package validation receipt persistence is unavailable on this host.");
  const validation = response.result && typeof response.result === "object" && !Array.isArray(response.result)
    ? response.result as Record<string, unknown>
    : { valid: response.ok, packageRoot };
  const failure = response.ok ? undefined : response.error;
  try {
    const receipt = await createPackageValidationReceipt({
      packageRoot,
      ...(pkg ? { package: pkg } : {}),
      valid: response.ok,
      validation,
      ...(failure ? { error: failure } : {}),
      warnings: response.warnings,
    });
    const receiptPath = await writeReceipt(receiptsRoot, receipt);
    return { ...response, receiptId: receipt.id, result: { ...validation, receipt, receiptPath } };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "receipt_persistence_failed",
        message: error instanceof Error
          ? `Package validation finished but its receipt could not be persisted: ${error.message}`
          : "Package validation finished but its receipt could not be persisted.",
        suggestedAction: "Choose a writable governed receiptsRoot and validate again.",
      },
      result: response.result,
      warnings: response.warnings,
    };
  }
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message }, warnings: [] };
}

function invalidArgsWithAction(message: string, suggestedAction: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message, suggestedAction }, warnings: [] };
}
