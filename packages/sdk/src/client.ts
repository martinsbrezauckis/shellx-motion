/** Runtime-validated Motion SDK client over an injected local or remote transport. */
import { JOB_STATES } from "@shellx-motion/core";
import { canonicalJson, motionSdkCacheKey } from "./cache";
import { isKeyingOperation, validateKeyingOutput, validateKeyingRequest } from "./keying-client";
import { validateTrackingOutput, validateTrackingRequest } from "./tracking-client";
import { createAuthoringClientBindings } from "./authoring-client-bindings";
import {
  isAuthoringPackageOperation,
  validateAuthoringOutput,
  validateAuthoringRequest,
} from "./authoring-client-validation";
import { validRenderArtifact, validRequestedCutHandoff } from "./render-client-guards";
import { validateSpatialTimelineEdit } from "./spatial-timeline-normalize";
import { timelineEditReceiptOperation } from "./timeline-receipt";
import { ALLOWED_OPERATION_FIELDS, REQUIRED_OPERATION_FIELDS } from "./client-operation-fields";
import {
  MOTION_SDK_SCHEMA,
  type MotionSdkClient,
  type MotionSdkError,
  type MotionSdkOperation,
  type MotionSdkRequestMap,
  type MotionSdkResponseMap,
  type MotionSdkResult,
  type MotionSdkTransport,
  type MotionSdkTransportRequest
} from "./types";
export function createMotionSdk(transport: MotionSdkTransport): MotionSdkClient {
  return {
    validate: (input) => execute(transport, "validate", input),
    compile: (input) => execute(transport, "compile", input),
    preview: (input) => execute(transport, "preview", input),
    render: (input) => execute(transport, "render", input),
    status: (input) => execute(transport, "status", input),
    cancel: (input) => execute(transport, "cancel", input),
    timelineEdit: (input) => execute(transport, "timelineEdit", input),
    trackingRequest: (input) => execute(transport, "trackingRequest", input),
    trackingInspect: (input) => execute(transport, "trackingInspect", input),
    trackingApply: (input) => execute(transport, "trackingApply", input),
    trackingDetach: (input) => execute(transport, "trackingDetach", input),
    trackingVerify: (input) => execute(transport, "trackingVerify", input),
    keyingInspect: (input) => execute(transport, "keyingInspect", input),
    keyingApply: (input) => execute(transport, "keyingApply", input),
    keyingRemove: (input) => execute(transport, "keyingRemove", input),
    rotoUpsert: (input) => execute(transport, "rotoUpsert", input),
    rotoTrackingDetach: (input) => execute(transport, "rotoTrackingDetach", input),
    rotoRemove: (input) => execute(transport, "rotoRemove", input),
    ...createAuthoringClientBindings((operation, input) => execute(transport, operation, input))
  };
}

async function execute<K extends MotionSdkOperation>(
  transport: MotionSdkTransport,
  operation: K,
  input: MotionSdkRequestMap[K]
): Promise<MotionSdkResult<MotionSdkResponseMap[K]>> {
  const requestError = validateRequest(operation, input);
  if (requestError) return failure(`sdk-${operation}-invalid`, "0".repeat(64), requestError);
  let cacheKey: string;
  try {
    cacheKey = await motionSdkCacheKey(operation, input);
  } catch (error) {
    return failure(`sdk-${operation}-invalid`, "0".repeat(64), invalid(error instanceof Error ? error.message : String(error)));
  }
  const requestId = `sdk-${operation}-${cacheKey.slice(0, 20)}`;
  const request: MotionSdkTransportRequest<K> = { schema: MOTION_SDK_SCHEMA, operation, requestId, cacheKey, input };
  let response: unknown;
  try {
    response = await transport.execute(request);
  } catch (error) {
    return failure(requestId, cacheKey, {
      code: "transport_error",
      message: error instanceof Error ? error.message : String(error),
      retryable: true
    });
  }
  const envelopeError = validateEnvelope(response, request);
  if (envelopeError) return failure(requestId, cacheKey, envelopeError);
  const envelope = response as Awaited<ReturnType<typeof transport.execute<K>>>;
  if (!envelope.ok) return failure(requestId, cacheKey, normalizeError(envelope.error), envelope.warnings);
  const outputError = validateOutput(operation, envelope.output, input);
  if (outputError) return failure(requestId, cacheKey, outputError);
  return { ok: true, output: envelope.output, requestId, cacheKey };
}

function validateRequest(operation: MotionSdkOperation, value: unknown): MotionSdkError | null {
  const record = plainRecord(value);
  if (!record) return invalid(`SDK ${operation} input must be a plain object.`);
  const unknown = Object.keys(record).find((key) => !ALLOWED_OPERATION_FIELDS[operation].includes(key));
  if (unknown) return invalid(`SDK ${operation} input contains unsupported field ${unknown}.`);
  for (const key of REQUIRED_OPERATION_FIELDS[operation]) {
    if (typeof record[key] !== "string" || !(record[key] as string).trim()) return invalid(`SDK ${operation} requires ${key}.`);
  }
  if (operation === "compile" && (!("script" in record) || record.script === undefined)) return invalid("SDK compile requires script.");
  if (operation === "timelineEdit") {
    const editError = validateTimelineEdit(record.edit);
    if (editError) return editError;
  }
  if (operation === "trackingRequest") {
    const trackingError = validateTrackingRequest(record);
    if (trackingError) return trackingError;
  }
  if (operation === "trackingInspect" || operation === "trackingApply") {
    if (!safeId(record.analysisId)) return invalid(`SDK ${operation} requires a safe analysisId.`);
  }
  if (operation === "trackingVerify" && record.analysisId !== undefined && !safeId(record.analysisId)) {
    return invalid("SDK trackingVerify analysisId must be safe when provided.");
  }
  if (operation === "trackingApply" || operation === "trackingDetach" || operation === "trackingVerify") {
    if (!safeId(record.layerId)) return invalid(`SDK ${operation} requires a safe layerId.`);
  }
  if (operation === "trackingApply") {
    if (record.segmentIndex !== undefined && (!Number.isSafeInteger(record.segmentIndex) || Number(record.segmentIndex) < 0)) {
      return invalid("SDK trackingApply segmentIndex must be a non-negative safe integer.");
    }
    if (record.includeLowConfidence !== undefined && typeof record.includeLowConfidence !== "boolean") {
      return invalid("SDK trackingApply includeLowConfidence must be boolean.");
    }
  }
  const keyingError = validateKeyingRequest(operation, record);
  if (keyingError) return keyingError;
  const authoringError = validateAuthoringRequest(operation, record);
  if (authoringError) return authoringError;
  if (operation === "render" && record.cutHandoff !== undefined) {
    const cut = plainRecord(record.cutHandoff);
    if (!cut || Object.keys(cut).some((key) => key !== "target" && key !== "mode")
      || cut.target !== "shellx-cut" || cut.mode !== "rendered_media") {
      return invalid("SDK render cutHandoff must request shellx-cut rendered_media.");
    }
  }
  for (const key of ["createdAt", "workflowPath", "artifactRoot", "receiptsRoot", "qualityManifestPath", "jobId", "reason", "createdBy"] as const) {
    if (key in record && (typeof record[key] !== "string" || !(record[key] as string).trim())) return invalid(`SDK ${operation} ${key} must be a non-empty string.`);
  }
  if (record.createdAt !== undefined && !Number.isFinite(Date.parse(String(record.createdAt)))) return invalid(`SDK ${operation} createdAt must be an ISO timestamp.`);
  if (record.idempotencyKey !== undefined && (typeof record.idempotencyKey !== "string" || !/^[a-f0-9]{64}$/.test(record.idempotencyKey))) {
    return invalid("SDK render idempotencyKey must be a 64-character lowercase SHA-256 value.");
  }
  for (const key of ["atMs"] as const) {
    if (key in record && (typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] < 0)) {
      return invalid(`SDK ${operation} ${key} must be a non-negative finite number.`);
    }
  }
  return null;
}

function validateEnvelope(value: unknown, request: MotionSdkTransportRequest): MotionSdkError | null {
  const record = plainRecord(value);
  if (!record) return invalidTransport("Transport response must be a plain object.");
  for (const [key, expected] of [["schema", MOTION_SDK_SCHEMA], ["operation", request.operation], ["requestId", request.requestId], ["cacheKey", request.cacheKey]] as const) {
    if (record[key] !== expected) return invalidTransport(`Transport response ${key} does not match the request.`);
  }
  if (typeof record.ok !== "boolean") return invalidTransport("Transport response ok must be boolean.");
  if (record.ok === true && !plainRecord(record.output)) return invalidTransport("Successful transport response requires an output object.");
  if (record.ok === false) {
    const error = plainRecord(record.error);
    if (!error || !nonEmpty(error.code) || !nonEmpty(error.message) || typeof error.retryable !== "boolean") {
      return invalidTransport("Failed transport response requires a valid error object.");
    }
    if (!stringArray(record.warnings)) return invalidTransport("Failed transport response requires string warnings.");
  }
  return null;
}

function validateOutput(operation: MotionSdkOperation, value: unknown, requestInput: unknown): MotionSdkError | null {
  const record = plainRecord(value);
  if (!record) return invalidTransport(`SDK ${operation} output must be an object.`);
  const requiredStrings: Partial<Record<MotionSdkOperation, string[]>> = {
    compile: ["packageRoot", "receiptPath"],
    preview: ["packageId", "motionId", "receiptId"],
    render: ["jobId", "state", "packageId", "motionId", "preset"],
    cancel: ["targetJobId", "state", "receiptId"]
  };
  for (const key of requiredStrings[operation] ?? []) {
    if (typeof record[key] !== "string" || !(record[key] as string).trim()) return invalidTransport(`SDK ${operation} output requires ${key}.`);
  }
  if ((operation === "validate" || operation === "compile" || isAuthoringPackageOperation(operation))
    && !validPackageIdentity(record.package)) {
    return invalidTransport(`SDK ${operation} output requires a valid package identity.`);
  }
  if (operation === "preview" && !validPreviewFrame(record.frame)) return invalidTransport("SDK preview output requires a valid frame identity.");
  if (operation === "render" && record.artifact !== undefined && !validRenderArtifact(record.artifact, record)) {
    return invalidTransport("SDK render artifact identity is invalid or does not match the render.");
  }
  if (operation === "render" && !validRequestedCutHandoff(record, requestInput)) {
    return invalidTransport("SDK render Cut handoff/reference identity is invalid or does not match the request and artifact.");
  }
  if (operation === "render" && !jobState(record.state)) return invalidTransport("SDK render output state is invalid.");
  if (operation === "status" && (!Array.isArray(record.jobs) || !record.jobs.every(validJob) || !validStateCounts(record.stateCounts, record.jobs))) {
    return invalidTransport("SDK status output requires valid jobs and stateCounts.");
  }
  if (operation === "cancel" && record.state !== "cancelled") return invalidTransport("SDK cancel output state must be cancelled.");
  if (operation === "timelineEdit" && (!validPackageIdentity(record.package) || !validTimelineEditOutput(record, requestInput))) {
    return invalidTransport("SDK timelineEdit output requires a valid package, edit, and passed receipt identity.");
  }
  if (isKeyingOperation(operation) && (!nonEmpty(record.packageRoot) || !validPackageIdentity(record.package))) {
    return invalidTransport(`SDK ${operation} output requires a package root and valid package identity.`);
  }
  const trackingError = validateTrackingOutput(operation, record, requestInput);
  if (trackingError) return trackingError;
  const keyingError = validateKeyingOutput(operation, record, requestInput);
  if (keyingError) return keyingError;
  const authoringError = validateAuthoringOutput(operation, record, requestInput);
  if (authoringError) return authoringError;
  if (!("warnings" in record) || !stringArray(record.warnings)) return invalidTransport(`SDK ${operation} output requires string warnings.`);
  return null;
}

function validPackageIdentity(value: unknown): boolean {
  const record = plainRecord(value);
  return Boolean(record && nonEmpty(record.packageId) && nonEmpty(record.motionId)
    && positive(record.durationMs) && positive(record.fps) && positive(record.width) && positive(record.height)
    && sha256(record.manifestSha256) && sha256(record.motionSha256));
}

function validPreviewFrame(value: unknown): boolean {
  const record = plainRecord(value);
  return Boolean(record && nonEmpty(record.path) && sha256(record.sha256) && positive(record.width) && positive(record.height)
    && typeof record.atMs === "number" && Number.isFinite(record.atMs) && record.atMs >= 0
    && (record.mediaType === "image/png" || record.mediaType === "image/jpeg"));
}

function validateTimelineEdit(value: unknown): MotionSdkError | null {
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
  if (kind === "rich.set"
    && !(typeof edit.value === "number" && Number.isFinite(edit.value))
    && typeof edit.value !== "boolean"
    && !(typeof edit.value === "string" && edit.value.trim().length > 0 && edit.value.length <= 128 && edit.value === edit.value.trim())) {
    return invalid("SDK timelineEdit rich.set requires a finite number, boolean, or bounded string value.");
  }
  if (kind === "keyframe.upsert") {
    if (!nonNegative(edit.atMs)) return invalid("SDK timelineEdit keyframe.upsert requires non-negative atMs.");
    if (!(typeof edit.value === "number" && Number.isFinite(edit.value))
      && !(typeof edit.value === "string" && edit.value.trim().length > 0 && edit.value.length <= 128 && edit.value === edit.value.trim())) {
      return invalid("SDK timelineEdit keyframe.upsert requires a finite number or bounded string value.");
    }
  }
  if (kind === "keyframe.delete" && !nonNegative(edit.atMs)) {
    return invalid("SDK timelineEdit keyframe.delete requires non-negative atMs.");
  }
  if (kind === "keyframe.move" && (!nonNegative(edit.fromMs) || !nonNegative(edit.toMs))) {
    return invalid("SDK timelineEdit keyframe.move requires non-negative fromMs and toMs.");
  }
  if ((kind === "keyframe.shift" || kind === "keyframe.duplicate")
    && !(typeof edit.deltaMs === "number" && Number.isFinite(edit.deltaMs) && edit.deltaMs !== 0)) {
    return invalid(`SDK timelineEdit ${kind} requires finite non-zero deltaMs.`);
  }
  if (kind === "keyframe.scale"
    && !(typeof edit.scale === "number" && Number.isFinite(edit.scale) && edit.scale > 0 && edit.scale !== 1 && nonNegative(edit.originMs))) {
    return invalid("SDK timelineEdit keyframe.scale requires positive non-unit scale and non-negative originMs.");
  }
  if (kind === "keyframe.snap") {
    if (edit.fps !== undefined && !(typeof edit.fps === "number" && Number.isFinite(edit.fps) && edit.fps > 0)) {
      return invalid("SDK timelineEdit keyframe.snap fps must be positive.");
    }
    if (edit.mode !== undefined && edit.mode !== "nearest" && edit.mode !== "floor" && edit.mode !== "ceil") {
      return invalid("SDK timelineEdit keyframe.snap mode is unsupported.");
    }
  }
  if (kind === "keyframe.easing.apply" && !nonEmpty(edit.easing)) {
    return invalid("SDK timelineEdit keyframe.easing.apply requires easing.");
  }
  if (edit.easing !== undefined && (!nonEmpty(edit.easing) || String(edit.easing).length > 128 || String(edit.easing) !== String(edit.easing).trim())) {
    return invalid("SDK timelineEdit easing must be a bounded string.");
  }
  for (const key of ["atMs", "startMs", "endMs"] as const) {
    if (key in edit && !nonNegative(edit[key])) return invalid(`SDK timelineEdit ${key} must be non-negative.`);
  }
  if (typeof edit.startMs === "number" && typeof edit.endMs === "number" && edit.startMs > edit.endMs) {
    return invalid("SDK timelineEdit startMs must not exceed endMs.");
  }
  return null;
}
function validTimelineEditOutput(output: Record<string, unknown>, requestInput: unknown): boolean {
  if (!nonEmpty(output.packageRoot) || validateTimelineEdit(output.edit)) return false;
  const request = plainRecord(requestInput);
  if (!request || validateTimelineEdit(request.edit) || canonicalJson(output.edit) !== canonicalJson(request.edit)) return false;
  const edit = plainRecord(output.edit);
  const receipt = plainRecord(output.receipt);
  const pkg = plainRecord(output.package);
  const expectedOperation = timelineEditReceiptOperation(edit?.kind);
  return Boolean(receipt && expectedOperation && receipt.schema === "shellx-motion/receipt@1"
    && nonEmpty(receipt.id) && receipt.packageId === pkg?.packageId && receipt.operation === expectedOperation && receipt.status === "passed"
    && nonEmpty(receipt.path) && sha256(receipt.sha256));
}

function validJob(value: unknown): boolean {
  const job = plainRecord(value);
  return Boolean(job && nonEmpty(job.jobId) && jobState(job.state) && nonEmpty(job.packageId)
    && (job.operation === "render.final" || job.operation === "render.batch" || job.operation === "render.retry") && nonEmpty(job.receiptId)
    && typeof job.retryCount === "number" && Number.isInteger(job.retryCount) && job.retryCount >= 0
    && stringArray(job.warnings) && (job.outputPath === undefined || nonEmpty(job.outputPath)));
}

function validStateCounts(value: unknown, jobs: unknown[]): boolean {
  const counts = plainRecord(value);
  if (!counts || !Object.entries(counts).every(([key, count]) => jobState(key)
    && typeof count === "number" && Number.isInteger(count) && count >= 0)) return false;
  const expected = new Map<string, number>();
  for (const value of jobs) {
    const state = String((value as Record<string, unknown>).state);
    expected.set(state, (expected.get(state) ?? 0) + 1);
  }
  return Object.entries(counts).every(([state, count]) => count === (expected.get(state) ?? 0))
    && [...expected].every(([state, count]) => counts[state] === count);
}

function normalizeError(value: MotionSdkError): MotionSdkError {
  const record = plainRecord(value);
  return {
    code: nonEmpty(record?.code) ? String(record?.code) : "transport_failed",
    message: nonEmpty(record?.message) ? String(record?.message) : "Motion SDK transport failed.",
    retryable: record?.retryable === true,
    ...(record && "detail" in record ? { detail: record.detail } : {})
  };
}

function failure(requestId: string, cacheKey: string, error: MotionSdkError, warnings: string[] = []): MotionSdkResult<never> {
  return { ok: false, error, warnings: stringArray(warnings) ? warnings : [], requestId, cacheKey };
}

function invalid(message: string): MotionSdkError {
  return { code: "invalid_request", message, retryable: false };
}

function invalidTransport(message: string): MotionSdkError {
  return { code: "invalid_transport_response", message, retryable: false };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.values(descriptors).every((descriptor) => "value" in descriptor) ? value as Record<string, unknown> : null;
}

function nonEmpty(value: unknown): boolean { return typeof value === "string" && value.trim().length > 0; }
function positive(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function nonNegative(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function sha256(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function safeId(value: unknown): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
function boundedString(value: unknown, max: number): boolean { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }
function unitInterval(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function integerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function unexpectedField(record: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(record).find((key) => !allowed.includes(key));
}
function boundedStringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length <= maxLength);
}
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
/** Validate against the authored contract rather than a hand-copied list. */
function jobState(value: unknown): boolean { return typeof value === "string" && (JOB_STATES as readonly string[]).includes(value); }
