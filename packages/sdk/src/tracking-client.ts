/** Runtime request/response guards for bounded tracking SDK operations. */
import type { MotionSdkError, MotionSdkOperation } from "./types.js";

const TRACKING_OPERATIONS = new Set<MotionSdkOperation>([
  "trackingRequest", "trackingInspect", "trackingApply", "trackingDetach", "trackingVerify",
]);

export function isTrackingOperation(operation: MotionSdkOperation): boolean {
  return TRACKING_OPERATIONS.has(operation);
}

export function validateTrackingRequest(input: Record<string, unknown>): MotionSdkError | null {
  if (!safeId(input.analysisId)) return invalid("SDK trackingRequest requires a safe analysisId.");
  if (!safeId(input.assetId)) return invalid("SDK trackingRequest requires a safe assetId.");
  if (input.mode !== "point" && input.mode !== "planar") return invalid("SDK trackingRequest mode must be point or planar.");
  if (input.model !== "translation" && input.model !== "similarity" && input.model !== "homography") {
    return invalid("SDK trackingRequest model is unsupported.");
  }
  if ((input.mode === "point" && input.model !== "translation") || (input.mode === "planar" && input.model === "translation")) {
    return invalid("SDK trackingRequest mode and model are incompatible.");
  }
  const reference = plainRecord(input.reference);
  if (!reference || unexpectedField(reference, ["atMs", "bounds", "points"]) || !nonNegative(reference.atMs)) {
    return invalid("SDK trackingRequest reference must contain bounded atMs, bounds, and points.");
  }
  const bounds = plainRecord(reference.bounds);
  if (!bounds || unexpectedField(bounds, ["x", "y", "width", "height"])
    || !nonNegative(bounds.x) || !nonNegative(bounds.y) || !positive(bounds.width) || !positive(bounds.height)) {
    return invalid("SDK trackingRequest reference bounds must be finite and positive.");
  }
  if (!Array.isArray(reference.points) || reference.points.length < 1 || reference.points.length > 64) {
    return invalid("SDK trackingRequest reference requires 1..64 points.");
  }
  for (const value of reference.points) {
    const point = plainRecord(value);
    if (!point || unexpectedField(point, ["x", "y"]) || !nonNegative(point.x) || !nonNegative(point.y)) {
      return invalid("SDK trackingRequest reference points must contain finite non-negative x/y.");
    }
  }
  const settings = plainRecord(input.settings);
  const settingFields = ["startMs", "endMs", "stepMs", "direction", "searchRadiusPx", "pyramidLevels", "maxIterations", "confidenceFloor", "deterministicSeed"];
  if (!settings || unexpectedField(settings, settingFields) || !settingFields.every((field) => Object.hasOwn(settings, field))) {
    return invalid("SDK trackingRequest requires complete bounded settings.");
  }
  if (!nonNegative(settings.startMs) || !nonNegative(settings.endMs) || Number(settings.startMs) > Number(settings.endMs)
    || !positive(settings.stepMs) || Number(settings.stepMs) > 60_000
    || !["forward", "backward", "both"].includes(String(settings.direction))
    || !positive(settings.searchRadiusPx) || Number(settings.searchRadiusPx) > 4_096
    || !integerInRange(settings.pyramidLevels, 1, 16) || !integerInRange(settings.maxIterations, 1, 10_000)
    || !unitInterval(settings.confidenceFloor) || !Number.isSafeInteger(settings.deterministicSeed)) {
    return invalid("SDK trackingRequest settings are outside supported bounds.");
  }
  return null;
}

export function validateTrackingOutput(
  operation: MotionSdkOperation,
  output: Record<string, unknown>,
  requestInput: unknown,
): MotionSdkError | null {
  if (!isTrackingOperation(operation)) return null;
  if (!nonEmpty(output.packageRoot) || !validPackageIdentity(output.package)) {
    return invalidTransport(`SDK ${operation} output requires a package root and valid package identity.`);
  }
  const valid = operation === "trackingRequest" ? validTrackingRequestOutput(output, requestInput)
    : operation === "trackingInspect" ? validTrackingInspectOutput(output, requestInput)
      : operation === "trackingApply" ? validTrackingApplyOutput(output, requestInput)
        : operation === "trackingDetach" ? validTrackingDetachOutput(output, requestInput)
          : validTrackingVerifyOutput(output, requestInput);
  if (valid) return null;
  const message = operation === "trackingRequest" ? "SDK trackingRequest output requires a valid lifecycle and request receipt identity."
    : operation === "trackingInspect" ? "SDK trackingInspect output requires a valid lifecycle and source identity."
      : operation === "trackingApply" ? "SDK trackingApply output requires a valid applied segment and receipt identity."
        : operation === "trackingDetach" ? "SDK trackingDetach output requires exact-restoration and receipt identity."
          : "SDK trackingVerify output requires a valid attachment verification result.";
  return invalidTransport(message);
}

function validTrackingRequestOutput(output: Record<string, unknown>, requestInput: unknown): boolean {
  const lifecycle = plainRecord(output.lifecycle);
  const receipt = plainRecord(output.receipt);
  const request = plainRecord(requestInput);
  return Boolean(nonEmpty(output.lifecyclePath) && nonEmpty(output.receiptPath)
    && validTrackingLifecycle(lifecycle) && validTrackingReceipt(receipt, "analysis.tracking.request") && sha256(receipt?.sha256)
    && receipt?.packageId === plainRecord(output.package)?.packageId
    && output.packageRoot === request?.outDir && lifecycle?.analysisId === request?.analysisId
    && plainRecord(lifecycle?.source)?.assetId === request?.assetId);
}

function validTrackingInspectOutput(output: Record<string, unknown>, requestInput: unknown): boolean {
  const source = plainRecord(output.source);
  const receipt = plainRecord(output.receipt);
  const lifecycle = plainRecord(output.lifecycle);
  const request = plainRecord(requestInput);
  return Boolean(nonEmpty(output.lifecyclePath) && validTrackingLifecycle(lifecycle)
    && validTrackingSourceInspection(source) && typeof output.current === "boolean" && source?.current === output.current
    && validTrackingReceipt(receipt, "analysis.tracking.inspect") && (receipt?.status === "passed" || receipt?.status === "warning")
    && receipt?.packageId === plainRecord(output.package)?.packageId
    && lifecycle?.analysisId === request?.analysisId && source?.assetId === plainRecord(lifecycle?.source)?.assetId);
}

function validTrackingApplyOutput(output: Record<string, unknown>, requestInput: unknown): boolean {
  const segment = plainRecord(output.segment);
  const receipt = plainRecord(output.receipt);
  const request = plainRecord(requestInput);
  return Boolean(safeId(output.layerId) && safeId(output.analysisId) && validTrackingSegment(segment)
    && (output.fidelity === "exact-similarity" || output.fidelity === "approximated-homography")
    && boundedStringArray(output.changedPaths, 32, 512) && nonEmpty(output.receiptPath)
    && validTrackingReceipt(receipt, "analysis.tracking.apply") && sha256(receipt?.sha256)
    && (receipt?.status === "passed" || receipt?.status === "warning")
    && receipt?.packageId === plainRecord(output.package)?.packageId
    && output.packageRoot === request?.outDir && output.layerId === request?.layerId && output.analysisId === request?.analysisId
    && (request?.segmentIndex === undefined || segment?.index === request.segmentIndex));
}

function validTrackingDetachOutput(output: Record<string, unknown>, requestInput: unknown): boolean {
  const receipt = plainRecord(output.receipt);
  const request = plainRecord(requestInput);
  return Boolean(safeId(output.layerId) && safeId(output.analysisId) && output.restoredPreviousKeyframes === true
    && boundedStringArray(output.changedPaths, 32, 512) && nonEmpty(output.receiptPath)
    && validTrackingReceipt(receipt, "analysis.tracking.detach") && sha256(receipt?.sha256)
    && receipt?.status === "passed" && receipt?.packageId === plainRecord(output.package)?.packageId
    && output.packageRoot === request?.outDir && output.layerId === request?.layerId);
}

function validTrackingVerifyOutput(output: Record<string, unknown>, requestInput: unknown): boolean {
  const verification = plainRecord(output.verification);
  const request = plainRecord(requestInput);
  if (!verification || typeof verification.attached !== "boolean" || typeof verification.current !== "boolean"
    || !safeId(verification.layerId) || !boundedStringArray(verification.mismatchedTargets, 16, 128)
    || !boundedStringArray(verification.reasons, 32, 128)
    || (verification.analysisId !== undefined && !safeId(verification.analysisId))
    || (verification.sourceSha256 !== undefined && !sha256(verification.sourceSha256))
    || (verification.segmentIndex !== undefined && !integerInRange(verification.segmentIndex, 0, 30_000))
    || verification.layerId !== request?.layerId
    || (request?.analysisId !== undefined && verification.analysisId !== undefined && verification.analysisId !== request.analysisId)
    || (verification.current === true && (!verification.attached
      || (verification.mismatchedTargets as unknown[]).length !== 0 || (verification.reasons as unknown[]).length !== 0))) return false;
  if (output.lifecycle !== undefined && !validTrackingLifecycle(plainRecord(output.lifecycle))) return false;
  if (output.source !== undefined && !validTrackingSourceInspection(plainRecord(output.source))) return false;
  const receipt = output.receipt === undefined ? null : plainRecord(output.receipt);
  return output.receipt === undefined || Boolean(validTrackingReceipt(receipt, "analysis.tracking.verify")
    && (receipt?.status === "passed" || receipt?.status === "warning"));
}

function validTrackingLifecycle(lifecycle: Record<string, unknown> | null): boolean {
  if (!lifecycle || lifecycle.schema !== "shellx-motion/tracking-lifecycle-summary@1" || !safeId(lifecycle.analysisId)
    || !["queued", "running", "succeeded", "partial", "failed", "cancelled", "stale"].includes(String(lifecycle.state))
    || !integerInRange(lifecycle.attempt, 1, 1_000_000) || !nonEmpty(lifecycle.updatedAt)
    || !validTrackingSourceSummary(plainRecord(lifecycle.source))) return false;
  const failure = lifecycle.failure === undefined ? null : plainRecord(lifecycle.failure);
  if (lifecycle.failure !== undefined && (!failure || !boundedString(failure.code, 128) || !boundedString(failure.message, 500))) return false;
  if (["failed", "cancelled", "stale"].includes(String(lifecycle.state)) !== (failure !== null)) return false;
  if (lifecycle.lastGood === undefined) return !["succeeded", "partial"].includes(String(lifecycle.state));
  const lastGood = plainRecord(lifecycle.lastGood);
  const samples = plainRecord(lastGood?.samples);
  return Boolean(lastGood && samples && ["succeeded", "partial"].includes(String(lastGood.status))
    && ["point", "planar"].includes(String(lastGood.mode))
    && ["translation", "similarity", "homography"].includes(String(lastGood.model))
    && ["ready", "partial", "unavailable"].includes(String(lastGood.planStatus))
    && ["exact-similarity", "approximated-homography"].includes(String(lastGood.fidelity))
    && validTrackingReference(plainRecord(lastGood.reference)) && validTrackingSettings(plainRecord(lastGood.settings))
    && integerInRange(samples.total, 1, 30_000)
    && ["tracked", "lowConfidence", "lost", "recovered"].every((key) => integerInRange(samples[key], 0, 30_000))
    && Number(samples.tracked) + Number(samples.lowConfidence) + Number(samples.lost) + Number(samples.recovered) === samples.total
    && unitInterval(samples.minConfidence) && unitInterval(samples.meanConfidence)
    && integerInRange(lastGood.spanCount, 0, 4_096) && Array.isArray(lastGood.segments) && lastGood.segments.length <= 4_096
    && lastGood.segments.every((segment, index) => validTrackingSegment(plainRecord(segment)) && plainRecord(segment)?.index === index)
    && boundedStringArray(lastGood.warnings, 256, 1_000));
}

function validTrackingReference(reference: Record<string, unknown> | null): boolean {
  if (!reference || !nonNegative(reference.atMs) || !Array.isArray(reference.points)
    || reference.points.length < 1 || reference.points.length > 64) return false;
  const bounds = plainRecord(reference.bounds);
  return Boolean(bounds && nonNegative(bounds.x) && nonNegative(bounds.y) && positive(bounds.width) && positive(bounds.height)
    && reference.points.every((value) => { const point = plainRecord(value); return Boolean(point && nonNegative(point.x) && nonNegative(point.y)); }));
}

function validTrackingSettings(settings: Record<string, unknown> | null): boolean {
  return Boolean(settings && nonNegative(settings.startMs) && nonNegative(settings.endMs) && Number(settings.startMs) <= Number(settings.endMs)
    && positive(settings.stepMs) && ["forward", "backward", "both"].includes(String(settings.direction))
    && positive(settings.searchRadiusPx) && integerInRange(settings.pyramidLevels, 1, 16)
    && integerInRange(settings.maxIterations, 1, 10_000) && unitInterval(settings.confidenceFloor)
    && Number.isSafeInteger(settings.deterministicSeed));
}

function validTrackingSourceSummary(source: Record<string, unknown> | null): boolean {
  return Boolean(source && safeId(source.assetId) && sha256(source.sha256) && positive(source.byteLength)
    && positive(source.width) && positive(source.height) && positive(source.durationMs));
}
function validTrackingSourceInspection(source: Record<string, unknown> | null): boolean {
  return Boolean(source && safeId(source.assetId) && nonEmpty(source.assetRef)
    && (source.sha256 === null || sha256(source.sha256)) && nonNegative(source.byteLength) && typeof source.current === "boolean"
    && (!source.current || sha256(source.sha256)));
}
function validTrackingSegment(segment: Record<string, unknown> | null): boolean {
  return Boolean(segment && integerInRange(segment.index, 0, 4_095) && nonNegative(segment.startMs)
    && nonNegative(segment.endMs) && Number(segment.startMs) <= Number(segment.endMs) && integerInRange(segment.keyframeCount, 1, 30_000));
}
function validTrackingReceipt(receipt: Record<string, unknown> | null, operation: string): boolean {
  return Boolean(receipt && receipt.schema === "shellx-motion/receipt@1" && safeId(receipt.id) && safeId(receipt.packageId)
    && receipt.operation === operation && ["passed", "warning", "failed", "not_run"].includes(String(receipt.status))
    && (receipt.sha256 === undefined || sha256(receipt.sha256)));
}
function validPackageIdentity(value: unknown): boolean {
  const record = plainRecord(value);
  return Boolean(record && nonEmpty(record.packageId) && nonEmpty(record.motionId)
    && positive(record.durationMs) && positive(record.fps) && positive(record.width) && positive(record.height)
    && sha256(record.manifestSha256) && sha256(record.motionSha256));
}
function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}
function invalid(message: string): MotionSdkError { return { code: "invalid_request", message, retryable: false } }
function invalidTransport(message: string): MotionSdkError { return { code: "invalid_transport_response", message, retryable: false } }
function nonEmpty(value: unknown): boolean { return typeof value === "string" && value.trim().length > 0 }
function positive(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value > 0 }
function nonNegative(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0 }
function unitInterval(value: unknown): boolean { return nonNegative(value) && Number(value) <= 1 }
function sha256(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function safeId(value: unknown): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) }
function boundedString(value: unknown, max: number): boolean { return nonEmpty(value) && String(value).length <= max }
function integerInRange(value: unknown, min: number, max: number): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max }
function unexpectedField(record: Record<string, unknown>, allowed: string[]): string | undefined { return Object.keys(record).find((key) => !allowed.includes(key)) }
function boundedStringArray(value: unknown, maxItems: number, maxLength: number): boolean {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length <= maxLength);
}
