/** Local SDK validation routed through the Debug API's shared verdict and receipt policy. */
import { loadMotionPackage, type MotionPackage } from "@shellx-motion/core";
import { dispatchDebugCommand } from "@shellx-motion/debug-api";
import { resolve } from "node:path";
import { localDebugContext } from "./local-debug-context.js";
import { LocalMotionSdkError } from "./local-result.js";
import { createTemplateParameterSchema } from "./template.js";
import { validMotionValidationReport } from "./validation-report.js";
import type { LocalMotionSdkOptions } from "./local.js";
import type { MotionSdkPackageIdentity } from "./package-types.js";
import type { MotionSdkValidateRequest, MotionSdkValidateResponse } from "./validation-types.js";

type PackageIdentityReader = (pkg: MotionPackage) => Promise<MotionSdkPackageIdentity>;

/**
 * The SDK is intentionally another door to `motion.package.validate`, rather than a second verdict
 * implementation. That preserves validation receipts, root fencing, and specialised errors.
 */
export async function validateLocalMotionPackage(
  input: MotionSdkValidateRequest,
  options: LocalMotionSdkOptions,
  packageIdentity: PackageIdentityReader,
): Promise<MotionSdkValidateResponse> {
  const packageRoot = resolve(input.packageRoot);
  const debug = await dispatchDebugCommand("motion.package.validate", {
    packageRoot,
    ...(input.receiptsRoot ? { receiptsRoot: resolve(input.receiptsRoot) } : {}),
  }, localDebugContext("read_motion", options));
  const result = debug.result && typeof debug.result === "object" && !Array.isArray(debug.result)
    ? debug.result as Record<string, unknown>
    : {};
  if (!debug.ok) {
    throw new LocalMotionSdkError(localValidationErrorCode(debug.error), debug.error.message, false, {
      ...(debug.error.suggestedAction ? { suggestedAction: debug.error.suggestedAction } : {}),
      ...(debug.error.detail && typeof debug.error.detail === "object" && !Array.isArray(debug.error.detail)
        ? debug.error.detail as Record<string, unknown>
        : {}),
      ...failureValidationDetail(result, debug.error.detail),
      ...(Array.isArray(result.unrenderableLayers) ? { unrenderableLayers: result.unrenderableLayers } : {}),
      ...(typeof debug.receiptId === "string" ? { receiptId: debug.receiptId } : {}),
      ...(typeof result.receiptPath === "string" ? { receiptPath: result.receiptPath } : {}),
    });
  }
  const pkg = await loadMotionPackage(packageRoot);
  const validation = readValidationReport(result.validation);
  return {
    package: await packageIdentity(pkg),
    validation,
    ...(pkg.template ? { template: createTemplateParameterSchema(pkg.template.id, pkg.template.params) } : {}),
    ...(typeof debug.receiptId === "string" ? { receiptId: debug.receiptId } : {}),
    ...(typeof result.receiptPath === "string" ? { receiptPath: result.receiptPath } : {}),
    warnings: debug.warnings,
  };
}

function readValidationReport(value: unknown): MotionSdkValidateResponse["validation"] {
  if (!validMotionValidationReport(value, localPlainRecord)) {
    throw new LocalMotionSdkError("invalid_transport_response", "Motion validation response contained an invalid two-stage validation report.", false);
  }
  return value as MotionSdkValidateResponse["validation"];
}

/**
 * Most validation failures expose the completed two-stage report as `detail.validation`.
 * Compiled-compositing failures predate that report and already expose a string marker at the
 * same key. Keep that narrow compatibility marker and carry the report under the unambiguous
 * `validationReport` key instead; replacing either would make callers lose actionable evidence.
 */
function failureValidationDetail(result: Record<string, unknown>, errorDetail: unknown): Record<string, unknown> {
  const validation = result.validation === undefined ? undefined : readValidationReport(result.validation);
  return {
    ...(validation
      ? isCompositingCompileIntegrityFailure(errorDetail)
        ? { validationReport: validation }
        : { validation }
      : {}),
    ...(isNonNegativeInteger(result.schemaErrorCount) ? { schemaErrorCount: result.schemaErrorCount } : {}),
    ...(Array.isArray(result.schemaErrors) ? { schemaErrors: result.schemaErrors } : {}),
    ...(typeof result.schemaErrorsTruncated === "boolean" ? { schemaErrorsTruncated: result.schemaErrorsTruncated } : {}),
  };
}

function localPlainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The SDK historically reported malformed compiled compositing metadata as an in-process
 * `local_operation_failed` error. Retain that one public SDK compatibility case while all other
 * Debug validation errors keep their shared, actionable Debug/MCP code.
 */
function localValidationErrorCode(error: { code: string; detail?: unknown }): string {
  return error.code === "invalid_motion_document" && isCompositingCompileIntegrityFailure(error.detail)
    ? "local_operation_failed"
    : error.code;
}

function isCompositingCompileIntegrityFailure(detail: unknown): boolean {
  return typeof detail === "object"
    && detail !== null
    && !Array.isArray(detail)
    && (detail as Record<string, unknown>).validation === "compositing_compile_integrity";
}
