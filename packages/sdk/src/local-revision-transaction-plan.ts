/** Local SDK adapter for a read-only deterministic revision-transaction preflight. */
import type { MotionDebugResult } from "@shellx-motion/debug-api";
import type {
  MotionSdkRevisionBase, MotionSdkRevisionTransactionPlanRequest, MotionSdkRevisionTransactionPlanResponse,
  MotionSdkRevisionTransactionStep, MotionSdkRevisionTransactionStepSummary
} from "./revision-transaction-types";

export interface LocalRevisionTransactionPlanDependencies {
  dispatch: (args: Record<string, unknown>) => Promise<MotionDebugResult>;
}

export async function runLocalRevisionTransactionPlan(
  input: MotionSdkRevisionTransactionPlanRequest,
  dependencies: LocalRevisionTransactionPlanDependencies
): Promise<MotionSdkRevisionTransactionPlanResponse> {
  const request = plainDataRecord(input, "revision transaction plan input");
  assertOnlyFields(request, ["packageRoot", "base", "steps"], "revision transaction plan input");
  const packageRoot = boundedStringField(request, "packageRoot", 4096);
  const base = revisionBase(request.base);
  const steps = revisionSteps(request.steps);
  const debug = await dependencies.dispatch({ packageRoot, base, steps });
  if (!debug.ok) throw new Error(`revision transaction plan failed: ${debug.error.message}`);
  const result = plainDataRecord(debug.result, "revision transaction plan result");
  assertOnlyFields(result, ["packageId", "motionId", "base", "transactionSha256", "steps", "final", "validation", "warnings"], "revision transaction plan result");
  const resultBase = revisionBase(result.base);
  if (JSON.stringify(resultBase) !== JSON.stringify(base)) throw new Error("Revision transaction plan base does not match the request.");
  const summaries = arrayField(result, "steps").map(revisionStepSummary);
  if (summaries.length !== steps.length || summaries.some((summary, index) => summary.index !== index || summary.command !== steps[index].command)) throw new Error("Revision transaction plan step summaries do not match the request.");
  const final = plainDataRecord(result.final, "revision transaction plan final identity");
  const validation = plainDataRecord(result.validation, "revision transaction plan validation");
  if (validation.ok !== true || validation.errorCount !== 0) throw new Error("Revision transaction plan validation is not compact passed validation.");
  return {
    packageId: boundedStringField(result, "packageId", 96), motionId: boundedStringField(result, "motionId", 96), base,
    final: { manifestSha256: shaField(final, "manifestSha256"), motionSha256: shaField(final, "motionSha256") },
    transactionSha256: shaField(result, "transactionSha256"), steps: summaries,
    validation: { ok: true, errorCount: 0 }, warnings: stringArray(result.warnings, "revision transaction plan warnings")
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
  const record = plainDataRecord(value, "revision transaction plan step summary");
  assertOnlyFields(record, ["index", "command", "stepSha256", "changedPaths"], "revision transaction plan step summary");
  const command = stringField(record, "command");
  if (!REVISION_STEP_COMMANDS.has(command as MotionSdkRevisionTransactionStep["command"])) throw new Error("revision transaction plan step summary command is unsupported.");
  return { index: integerField(record, "index", 0, 31), command: command as MotionSdkRevisionTransactionStep["command"], stepSha256: shaField(record, "stepSha256"), changedPaths: stringArray(record.changedPaths, "revision transaction plan changedPaths") };
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
function boundedStringField(record: Record<string, unknown>, key: string, max: number): string { const value = record[key]; if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${key} must be a non-empty string up to ${max} characters.`); return value; }
function stringField(record: Record<string, unknown>, key: string): string { const value = record[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string.`); return value; }
function shaField(record: Record<string, unknown>, key: string): string { const value = stringField(record, key); if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${key} must be a lowercase SHA-256 digest.`); return value; }
function integerField(record: Record<string, unknown>, key: string, min: number, max: number): number { const value = record[key]; if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${key} must be an integer in range.`); return value as number; }
function arrayField(record: Record<string, unknown>, key: string): unknown[] { if (!Array.isArray(record[key])) throw new Error(`${key} must be an array.`); return record[key]; }
function stringArray(value: unknown, name: string): string[] { if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`${name} must be a string array.`); return value; }
