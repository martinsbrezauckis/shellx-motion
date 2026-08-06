/** Runtime request/response guards for keying SDK operations. */
import { validateLayerKeyingAndRoto } from "@shellx-motion/core";
import type { MotionSdkError, MotionSdkOperation } from "./types.js";

const KEYING_OPERATIONS = new Set<MotionSdkOperation>([
  "keyingInspect", "keyingApply", "keyingRemove", "rotoUpsert", "rotoTrackingDetach", "rotoRemove",
]);
const OPERATION_BY_SDK = {
  keyingApply: "keying.apply",
  keyingRemove: "keying.remove",
  rotoUpsert: "roto.upsert",
  rotoTrackingDetach: "roto.tracking.detach",
  rotoRemove: "roto.remove",
} as const;

export function isKeyingOperation(operation: MotionSdkOperation): boolean {
  return KEYING_OPERATIONS.has(operation);
}

export function validateKeyingRequest(operation: MotionSdkOperation, input: Record<string, unknown>): MotionSdkError | null {
  if (!isKeyingOperation(operation)) return null;
  if (!safeId(input.layerId)) return invalid(`SDK ${operation} requires a safe layerId.`);
  if (operation === "keyingApply") {
    const issues = validateLayerKeyingAndRoto({ id: input.layerId, type: "video", keying: input.keying }, "/layer");
    if (issues.length > 0) return invalid(`SDK keyingApply ${issues[0].path}: ${issues[0].message}.`);
  }
  if (operation === "rotoUpsert") {
    const issues = validateLayerKeyingAndRoto({ id: input.layerId, type: "video", mask: input.mask }, "/layer");
    if (issues.length > 0 || plainRecord(input.mask)?.type !== "roto") {
      return invalid(issues.length > 0 ? `SDK rotoUpsert ${issues[0].path}: ${issues[0].message}.` : "SDK rotoUpsert requires a roto mask.");
    }
  }
  return null;
}

export function validateKeyingOutput(
  operation: MotionSdkOperation,
  output: Record<string, unknown>,
  requestInput: unknown,
): MotionSdkError | null {
  if (!isKeyingOperation(operation)) return null;
  const request = plainRecord(requestInput);
  const pkg = plainRecord(output.package);
  const state = plainRecord(output.state);
  const expectedRoot = operation === "keyingInspect" ? request?.packageRoot : request?.outDir;
  if (!request || !pkg || output.packageRoot !== expectedRoot || !validState(state, request.layerId)) {
    return invalidTransport(`SDK ${operation} output requires matching package and layer state.`);
  }
  if (operation === "keyingInspect") return null;
  const expectedOperation = OPERATION_BY_SDK[operation as keyof typeof OPERATION_BY_SDK];
  const receipt = plainRecord(output.receipt);
  if (output.layerId !== request.layerId || !boundedStringArray(output.changedPaths, 32, 512)
    || !nonEmpty(output.receiptPath) || !receipt || receipt.schema !== "shellx-motion/receipt@1"
    || receipt.operation !== expectedOperation || receipt.packageId !== pkg.packageId || receipt.status !== "passed"
    || !nonEmpty(receipt.id) || !sha256(receipt.sha256)) {
    return invalidTransport(`SDK ${operation} output requires matching mutation and receipt evidence.`);
  }
  return null;
}

function validState(state: Record<string, unknown> | null, requestedLayerId: unknown): boolean {
  if (!state || state.layerId !== requestedLayerId || !safeId(state.layerId) || !boundedString(state.layerType, 64)
    || typeof state.trackingAttached !== "boolean") return false;
  const layer = { id: state.layerId, type: state.layerType, ...(state.keying === null ? {} : { keying: state.keying }), ...(state.roto === null ? {} : { mask: state.roto }) };
  if (state.keying !== null && !plainRecord(state.keying)) return false;
  if (state.roto !== null && plainRecord(state.roto)?.type !== "roto") return false;
  return validateLayerKeyingAndRoto(layer, "/layer").length === 0
    && state.trackingAttached === Boolean(plainRecord(state.roto)?.tracking);
}

function invalid(message: string): MotionSdkError { return { code: "invalid_request", message, retryable: false } }
function invalidTransport(message: string): MotionSdkError { return { code: "invalid_transport_response", message, retryable: false } }
function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}
function nonEmpty(value: unknown): boolean { return typeof value === "string" && value.trim().length > 0 }
function boundedString(value: unknown, max: number): boolean { return nonEmpty(value) && String(value).length <= max }
function safeId(value: unknown): boolean { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) }
function sha256(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function boundedStringArray(value: unknown, maxItems: number, maxLength: number): boolean {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length <= maxLength);
}
