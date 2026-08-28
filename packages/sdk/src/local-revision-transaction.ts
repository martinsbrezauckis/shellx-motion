/** Local SDK adapter for the single-receipt typed revision transaction. */
import { loadMotionPackage, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { resolve } from "node:path";
import type { MotionDebugResult } from "@shellx-motion/debug-api";
import { verifyPersistedReceipt } from "./local-receipt";
import type { MotionSdkPackageIdentity } from "./package-types";
import type {
  MotionSdkRevisionBase, MotionSdkRevisionTransactionRequest, MotionSdkRevisionTransactionResponse,
  MotionSdkRevisionTransactionStep, MotionSdkRevisionTransactionStepSummary
} from "./revision-transaction-types";

export interface LocalRevisionTransactionDependencies {
  dispatch: (args: Record<string, unknown>) => Promise<MotionDebugResult>;
  packageIdentity: (pkg: MotionPackage) => Promise<MotionSdkPackageIdentity>;
}

export async function runLocalRevisionTransaction(
  input: MotionSdkRevisionTransactionRequest,
  dependencies: LocalRevisionTransactionDependencies
): Promise<MotionSdkRevisionTransactionResponse> {
  const request = plainDataRecord(input, "revision transaction input");
  assertOnlyFields(request, ["packageRoot", "outDir", "base", "steps", "createdBy"], "revision transaction input");
  const packageRoot = resolve(boundedStringField(request, "packageRoot", 4096));
  const outDir = resolve(boundedStringField(request, "outDir", 4096));
  const base = revisionBase(request.base);
  const steps = revisionSteps(request.steps);
  const createdBy = optionalBoundedString(request, "createdBy", 256);
  const debug = await dependencies.dispatch({ packageRoot, outDir, base, steps, ...(createdBy ? { createdBy } : {}) });
  if (!debug.ok) throw new Error(`revision transaction failed: ${debug.error.message}`);
  const result = plainDataRecord(debug.result, "revision transaction result");
  const resultPackageRoot = resolve(stringField(result, "packageDir"));
  if (resultPackageRoot !== outDir) throw new Error("Revision transaction output package does not match the requested outDir.");
  const receiptPath = resolve(stringField(result, "receiptPath"));
  const receipt = operationReceipt(result.receipt, "revision transaction receipt");
  if (receipt.operation !== "revision.transaction" || receipt.status !== "passed") throw new Error("Revision transaction receipt operation/status does not match the request.");
  const final = plainDataRecord(result.final, "revision transaction final identity");
  const finalIdentity = { manifestSha256: shaField(final, "manifestSha256"), motionSha256: shaField(final, "motionSha256") };
  const summaries = arrayField(result, "steps").map(revisionStepSummary);
  if (summaries.length !== steps.length || summaries.some((summary, index) => summary.index !== index || summary.command !== steps[index].command)) {
    throw new Error("Revision transaction step summaries do not match the request.");
  }
  const transactionSha256 = shaField(result, "transactionSha256");
  const pkg = await loadMotionPackage(resultPackageRoot);
  const identity = await dependencies.packageIdentity(pkg);
  if (receipt.packageId !== pkg.manifest.id || finalIdentity.manifestSha256 !== identity.manifestSha256 || finalIdentity.motionSha256 !== identity.motionSha256) {
    throw new Error("Revision transaction receipt/final hashes do not match the reopened package.");
  }
  const receiptSha256 = await verifyPersistedReceipt(resultPackageRoot, receiptPath, receipt, "revision transaction receipt");
  return {
    packageRoot: resultPackageRoot, package: identity, base, final: finalIdentity, transactionSha256, steps: summaries,
    receipt: { schema: "shellx-motion/receipt@1", id: receipt.id, packageId: receipt.packageId, operation: "revision.transaction", status: "passed", path: receiptPath, sha256: receiptSha256 },
    warnings: receipt.warnings
  };
}

function revisionBase(value: unknown): MotionSdkRevisionBase {
  const record = plainDataRecord(value, "revision transaction base");
  assertOnlyFields(record, ["packageId", "motionId", "manifestSha256", "motionSha256"], "revision transaction base");
  return { packageId: boundedStringField(record, "packageId", 96), motionId: boundedStringField(record, "motionId", 96), manifestSha256: shaField(record, "manifestSha256"), motionSha256: shaField(record, "motionSha256") };
}
function revisionSteps(value: unknown): MotionSdkRevisionTransactionStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("revision transaction steps must contain 1..32 entries.");
  return value as MotionSdkRevisionTransactionStep[];
}
function revisionStepSummary(value: unknown): MotionSdkRevisionTransactionStepSummary {
  const record = plainDataRecord(value, "revision transaction step summary");
  assertOnlyFields(record, ["index", "command", "stepSha256", "changedPaths"], "revision transaction step summary");
  const command = stringField(record, "command");
  if (!REVISION_STEP_COMMANDS.has(command as MotionSdkRevisionTransactionStep["command"])) throw new Error("revision transaction step summary command is unsupported.");
  return { index: integerField(record, "index", 0, 31), command: command as MotionSdkRevisionTransactionStep["command"], stepSha256: shaField(record, "stepSha256"), changedPaths: stringArray(record.changedPaths, "revision transaction changedPaths") };
}
const REVISION_STEP_COMMANDS = new Set<MotionSdkRevisionTransactionStep["command"]>([
  "motion.timeline.layer.text.set", "motion.timeline.layer.name.set", "motion.timeline.layer.visibility.set", "motion.timeline.layer.lock",
  "motion.timeline.keyframe.upsert", "motion.timeline.keyframe.delete", "motion.timeline.keyframe.move",
  "motion.timeline.spatial.position.upsert", "motion.timeline.spatial.position.move", "motion.timeline.spatial.position.delete"
]);
function plainDataRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length || !Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor)) throw new Error(`${name} must be a plain data object.`);
  return value as Record<string, unknown>;
}
function assertOnlyFields(record: Record<string, unknown>, fields: string[], name: string): void { for (const key of Object.keys(record)) if (!fields.includes(key)) throw new Error(`${name} contains unsupported field ${key}.`); }
function boundedStringField(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key]; if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${key} must be a non-empty string up to ${max} characters.`); return value;
}
function optionalBoundedString(record: Record<string, unknown>, key: string, max: number): string | undefined { return record[key] === undefined ? undefined : boundedStringField(record, key, max); }
function stringField(record: Record<string, unknown>, key: string): string { const value = record[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`); return value; }
function shaField(record: Record<string, unknown>, key: string): string { const value = stringField(record, key); if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${key} must be a lowercase SHA-256 digest.`); return value; }
function integerField(record: Record<string, unknown>, key: string, min: number, max: number): number { const value = record[key]; if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${key} must be an integer in range.`); return value as number; }
function arrayField(record: Record<string, unknown>, key: string): unknown[] { if (!Array.isArray(record[key])) throw new Error(`${key} must be an array.`); return record[key]; }
function stringArray(value: unknown, name: string): string[] { if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`${name} must be a string array.`); return value; }
function operationReceipt(value: unknown, name: string): OperationReceipt {
  const receipt = plainDataRecord(value, name) as unknown as OperationReceipt;
  if (receipt.schema !== "shellx-motion/receipt@1" || typeof receipt.id !== "string" || typeof receipt.packageId !== "string" || typeof receipt.operation !== "string" || (receipt.status !== "passed" && receipt.status !== "warning" && receipt.status !== "failed")) throw new Error(`${name} is invalid.`);
  return receipt;
}
