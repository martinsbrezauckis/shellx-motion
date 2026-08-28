/** Bounded timeline-edit and atomic-revision request/output validation. */
import { readSupportedKeyframeTarget } from "@shellx-motion/core";
import { canonicalJson } from "./cache";
import { validateSpatialTimelineEdit } from "./spatial-timeline-normalize";
import { timelineEditReceiptOperation } from "./timeline-receipt";
import type { MotionSdkError } from "./types";

export function validateTimelineEdit(value: unknown): MotionSdkError | null {
  const spatialError = validateSpatialTimelineEdit(value);
  if (spatialError !== false) return spatialError ? invalid(`SDK timelineEdit ${spatialError}`) : null;
  const edit = plainRecord(value);
  if (!edit) return invalid("SDK timelineEdit edit must be a plain object.");
  const kind = edit.kind;
  const allowedFields = kind === "rich.set" ? ["kind", "layerId", "path", "value"]
    : kind === "keyframe.upsert" ? ["kind", "layerId", "target", "atMs", "value", "easing"]
    : kind === "keyframe.delete" ? ["kind", "layerId", "target", "atMs"]
      : kind === "keyframe.range.delete" ? ["kind", "layerId", "target", "startMs", "endMs"]
      : kind === "keyframe.move" ? ["kind", "layerId", "target", "fromMs", "toMs"]
        : kind === "keyframe.easing.apply" ? ["kind", "layerId", "target", "easing", "atMs", "startMs", "endMs"]
          : kind === "keyframe.shift" || kind === "keyframe.duplicate" ? ["kind", "layerId", "target", "deltaMs", "startMs", "endMs"]
            : kind === "keyframe.scale" ? ["kind", "layerId", "target", "scale", "originMs", "startMs", "endMs"]
              : kind === "keyframe.distribute" || kind === "keyframe.reverse" ? ["kind", "layerId", "target", "startMs", "endMs"]
                : kind === "keyframe.snap" ? ["kind", "layerId", "target", "fps", "mode", "startMs", "endMs"] : null;
  if (!allowedFields) return invalid("SDK timelineEdit edit kind is unsupported.");
  const unknown = Object.keys(edit).find((key) => !allowedFields.includes(key));
  if (unknown) return invalid(`SDK timelineEdit edit contains unsupported field ${unknown}.`);
  for (const key of (kind === "rich.set" ? ["layerId", "path"] : ["layerId", "target"]) as Array<"layerId" | "path" | "target">) {
    if (!nonEmpty(edit[key]) || String(edit[key]).length > 128 || String(edit[key]) !== String(edit[key]).trim()) return invalid(`SDK timelineEdit edit requires bounded ${key}.`);
  }
  if (kind === "rich.set" && !(typeof edit.value === "number" && Number.isFinite(edit.value)) && typeof edit.value !== "boolean" && !(typeof edit.value === "string" && edit.value.trim().length > 0 && edit.value.length <= 128 && edit.value === edit.value.trim())) return invalid("SDK timelineEdit rich.set requires a finite number, boolean, or bounded string value.");
  if (kind === "keyframe.upsert") {
    if (!nonNegative(edit.atMs)) return invalid("SDK timelineEdit keyframe.upsert requires non-negative atMs.");
    if (!(typeof edit.value === "number" && Number.isFinite(edit.value)) && !(typeof edit.value === "string" && edit.value.trim().length > 0 && edit.value.length <= 128 && edit.value === edit.value.trim())) return invalid("SDK timelineEdit keyframe.upsert requires a finite number or bounded string value.");
  }
  if (kind === "keyframe.delete" && !nonNegative(edit.atMs)) return invalid("SDK timelineEdit keyframe.delete requires non-negative atMs.");
  if (kind === "keyframe.move" && (!nonNegative(edit.fromMs) || !nonNegative(edit.toMs))) return invalid("SDK timelineEdit keyframe.move requires non-negative fromMs and toMs.");
  if ((kind === "keyframe.shift" || kind === "keyframe.duplicate") && !(typeof edit.deltaMs === "number" && Number.isFinite(edit.deltaMs) && edit.deltaMs !== 0)) return invalid(`SDK timelineEdit ${kind} requires finite non-zero deltaMs.`);
  if (kind === "keyframe.scale" && !(typeof edit.scale === "number" && Number.isFinite(edit.scale) && edit.scale > 0 && edit.scale !== 1 && nonNegative(edit.originMs))) return invalid("SDK timelineEdit keyframe.scale requires positive non-unit scale and non-negative originMs.");
  if (kind === "keyframe.snap") {
    if (edit.fps !== undefined && !(typeof edit.fps === "number" && Number.isFinite(edit.fps) && edit.fps > 0)) return invalid("SDK timelineEdit keyframe.snap fps must be positive.");
    if (edit.mode !== undefined && edit.mode !== "nearest" && edit.mode !== "floor" && edit.mode !== "ceil") return invalid("SDK timelineEdit keyframe.snap mode is unsupported.");
  }
  if (kind === "keyframe.easing.apply" && !nonEmpty(edit.easing)) return invalid("SDK timelineEdit keyframe.easing.apply requires easing.");
  if (edit.easing !== undefined && (!nonEmpty(edit.easing) || String(edit.easing).length > 128 || String(edit.easing) !== String(edit.easing).trim())) return invalid("SDK timelineEdit easing must be a bounded string.");
  for (const key of ["atMs", "startMs", "endMs"] as const) if (key in edit && !nonNegative(edit[key])) return invalid(`SDK timelineEdit ${key} must be non-negative.`);
  if (typeof edit.startMs === "number" && typeof edit.endMs === "number" && edit.startMs > edit.endMs) return invalid("SDK timelineEdit startMs must not exceed endMs.");
  return null;
}

export function validTimelineEditOutput(output: Record<string, unknown>, requestInput: unknown): boolean {
  if (!nonEmpty(output.packageRoot) || validateTimelineEdit(output.edit)) return false;
  const request = plainRecord(requestInput);
  if (!request || validateTimelineEdit(request.edit) || canonicalJson(output.edit) !== canonicalJson(request.edit)) return false;
  const edit = plainRecord(output.edit); const receipt = plainRecord(output.receipt); const pkg = plainRecord(output.package);
  const expectedOperation = timelineEditReceiptOperation(edit?.kind);
  return Boolean(receipt && expectedOperation && receipt.schema === "shellx-motion/receipt@1" && nonEmpty(receipt.id) && receipt.packageId === pkg?.packageId && receipt.operation === expectedOperation && receipt.status === "passed" && nonEmpty(receipt.path) && sha256(receipt.sha256));
}

export function validateRevisionTransaction(value: Record<string, unknown>): MotionSdkError | null {
  const base = plainRecord(value.base);
  if (!base || unexpectedField(base, ["packageId", "motionId", "manifestSha256", "motionSha256"]) || !boundedString(base.packageId, 96) || !boundedString(base.motionId, 96) || !sha256(base.manifestSha256) || !sha256(base.motionSha256)) return invalid("SDK revisionTransaction base must be a closed package/motion identity with two SHA-256 hashes.");
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 32) return invalid("SDK revisionTransaction steps must contain 1..32 closed typed operations.");
  if (Buffer.byteLength(canonicalJson({ base, steps: value.steps }), "utf8") > 128 * 1024) return invalid("SDK revisionTransaction canonical base and steps exceed 131072 bytes.");
  for (const [index, candidate] of value.steps.entries()) {
    const problem = validRevisionStep(candidate);
    if (problem) return invalid(`SDK revisionTransaction steps[${index}] ${problem}`);
  }
  return null;
}

export function validateRevisionTransactionPlan(value: Record<string, unknown>): MotionSdkError | null {
  return validateRevisionTransaction(value);
}

export function validRevisionTransactionOutput(output: Record<string, unknown>, requestInput: unknown): boolean {
  const request = plainRecord(requestInput); const base = plainRecord(output.base); const final = plainRecord(output.final); const receipt = plainRecord(output.receipt); const pkg = plainRecord(output.package); const steps = output.steps;
  if (!request || !base || !final || !receipt || !pkg || !nonEmpty(output.packageRoot) || canonicalJson(base) !== canonicalJson(request.base) || !sha256(output.transactionSha256) || !sha256(final.manifestSha256) || !sha256(final.motionSha256) || final.manifestSha256 !== pkg.manifestSha256 || final.motionSha256 !== pkg.motionSha256 || !Array.isArray(steps) || steps.length !== (Array.isArray(request.steps) ? request.steps.length : -1)) return false;
  if (!steps.every((entry, index) => {
    const summary = plainRecord(entry); const requested = plainRecord((request.steps as unknown[])[index]);
    return Boolean(summary && requested && summary.index === index && summary.command === requested.command && sha256(summary.stepSha256) && Array.isArray(summary.changedPaths) && stringArray(summary.changedPaths));
  })) return false;
  return receipt.schema === "shellx-motion/receipt@1" && nonEmpty(receipt.id) && receipt.packageId === pkg.packageId && receipt.operation === "revision.transaction" && receipt.status === "passed" && nonEmpty(receipt.path) && sha256(receipt.sha256);
}

export function validRevisionTransactionPlanOutput(output: Record<string, unknown>, requestInput: unknown): boolean {
  const request = plainRecord(requestInput); const base = plainRecord(output.base); const final = plainRecord(output.final); const validation = plainRecord(output.validation); const steps = output.steps;
  if (!request || !base || !final || !validation || !boundedString(output.packageId, 96) || !boundedString(output.motionId, 96) || canonicalJson(base) !== canonicalJson(request.base) || !sha256(output.transactionSha256) || !sha256(final.manifestSha256) || !sha256(final.motionSha256) || final.manifestSha256 !== base.manifestSha256 || validation.ok !== true || validation.errorCount !== 0 || !Array.isArray(steps) || steps.length !== (Array.isArray(request.steps) ? request.steps.length : -1)) return false;
  return steps.every((entry, index) => {
    const summary = plainRecord(entry); const requested = plainRecord((request.steps as unknown[])[index]);
    return Boolean(summary && requested && summary.index === index && summary.command === requested.command && sha256(summary.stepSha256) && Array.isArray(summary.changedPaths) && summary.changedPaths.length <= 4 && stringArray(summary.changedPaths));
  });
}

function validRevisionStep(value: unknown): string | null {
  const step = plainRecord(value); const command = step?.command;
  if (!step || typeof command !== "string") return "must be a typed operation object.";
  const shape = (required: string[], optional: string[] = []): string | null => unexpectedField(step, ["command", ...required, ...optional]) ? "contains an unsupported field." : required.some((field) => !(field in step)) ? "is missing a required field." : null;
  const layer = () => boundedString(step.layerId, 256) ? null : "requires bounded layerId.";
  const target = () => boundedString(step.target, 256) && readSupportedKeyframeTarget(String(step.target)) ? null : "requires a current typed keyframe target.";
  const at = (field: string) => nonNegative(step[field]) ? null : `requires non-negative ${field}.`;
  const easing = () => step.easing === undefined || boundedString(step.easing, 128) ? null : "easing must be a bounded string when supplied.";
  switch (command) {
    case "motion.timeline.layer.text.set": return shape(["layerId", "text"]) ?? layer() ?? (typeof step.text === "string" && step.text.length <= 16_384 ? null : "requires text up to 16384 characters.");
    case "motion.timeline.layer.name.set": return shape(["layerId", "name"]) ?? layer() ?? (boundedString(step.name, 256) ? null : "requires a non-blank name.");
    case "motion.timeline.layer.visibility.set": return shape(["layerId", "visible"]) ?? layer() ?? (typeof step.visible === "boolean" ? null : "requires boolean visible.");
    case "motion.timeline.layer.lock": return shape(["layerId", "locked"]) ?? layer() ?? (typeof step.locked === "boolean" ? null : "requires boolean locked.");
    case "motion.timeline.keyframe.upsert": return shape(["layerId", "target", "atMs", "value"], ["easing"]) ?? layer() ?? target() ?? at("atMs") ?? easing() ?? ((typeof step.value === "number" && Number.isFinite(step.value)) || boundedString(step.value, 128) ? null : "requires finite numeric or bounded string value.");
    case "motion.timeline.keyframe.delete": return shape(["layerId", "target", "atMs"]) ?? layer() ?? target() ?? at("atMs");
    case "motion.timeline.keyframe.move": return shape(["layerId", "target", "fromMs", "toMs"]) ?? layer() ?? target() ?? at("fromMs") ?? at("toMs");
    case "motion.timeline.spatial.position.upsert": return shape(["layerId", "atMs", "x", "y"], ["easing"]) ?? layer() ?? at("atMs") ?? easing() ?? (typeof step.x === "number" && Number.isFinite(step.x) && typeof step.y === "number" && Number.isFinite(step.y) ? null : "requires finite x and y.");
    case "motion.timeline.spatial.position.move": return shape(["layerId", "fromMs", "toMs"]) ?? layer() ?? at("fromMs") ?? at("toMs");
    case "motion.timeline.spatial.position.delete": return shape(["layerId", "atMs"]) ?? layer() ?? at("atMs");
    default: return "command is not an allowlisted revision operation.";
  }
}
function invalid(message: string): MotionSdkError { return { code: "invalid_request", message, retryable: false }; }
function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor) ? value as Record<string, unknown> : null;
}
function nonEmpty(value: unknown): boolean { return typeof value === "string" && value.trim().length > 0; }
function nonNegative(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function sha256(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function boundedString(value: unknown, max: number): boolean { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function unexpectedField(record: Record<string, unknown>, allowed: string[]): string | undefined { return Object.keys(record).find((key) => !allowed.includes(key)); }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
