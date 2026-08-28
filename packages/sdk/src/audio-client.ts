/** Runtime guards for the small, data-only document audio SDK surface. */
import { normalizeMotionAudioMaster } from "@shellx-motion/core";
import type { MotionSdkError, MotionSdkOperation } from "./types.js";

const OPERATIONS = new Set<MotionSdkOperation>(["audioMasterSet", "audioCrossfadeSet"]);

export function isAudioOperation(operation: MotionSdkOperation): boolean {
  return OPERATIONS.has(operation);
}

export function validateAudioRequest(operation: MotionSdkOperation, input: Record<string, unknown>): MotionSdkError | null {
  if (!isAudioOperation(operation)) return null;
  if (operation === "audioMasterSet") {
    if (!("master" in input) || input.master === undefined) return invalid("SDK audioMasterSet requires master (or null to clear it).");
    try {
      if (input.master !== null) normalizeMotionAudioMaster(input.master);
    } catch (error) {
      return invalid(`SDK audioMasterSet ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
  if (!safeId(input.fromLayerId) || !safeId(input.toLayerId) || input.fromLayerId === input.toLayerId) {
    return invalid("SDK audioCrossfadeSet requires two different safe layer ids.");
  }
  if (typeof input.durationMs !== "number" || !Number.isFinite(input.durationMs) || input.durationMs <= 0) {
    return invalid("SDK audioCrossfadeSet durationMs must be a positive finite number.");
  }
  if (input.curve !== undefined && input.curve !== "linear" && input.curve !== "equal-power") {
    return invalid('SDK audioCrossfadeSet curve must be "linear" or "equal-power".');
  }
  return null;
}

export function validateAudioOutput(
  operation: MotionSdkOperation,
  output: Record<string, unknown>,
  requestInput: unknown,
): MotionSdkError | null {
  if (!isAudioOperation(operation)) return null;
  const request = record(requestInput);
  const expectedOperation = operation === "audioMasterSet" ? "audio.master.set" : "audio.crossfade.set";
  const pkg = record(output.package);
  const receipt = record(output.receipt);
  if (!request || output.packageRoot !== request.outDir || output.operation !== expectedOperation || !pkg
    || !stringList(output.changedPaths) || typeof output.receiptPath !== "string" || !output.receiptPath
    || !receipt || receipt.schema !== "shellx-motion/receipt@1" || receipt.operation !== expectedOperation
    || receipt.packageId !== pkg.packageId || receipt.status !== "passed" || typeof receipt.id !== "string" || !receipt.id
    || receipt.path !== output.receiptPath || !sha256(receipt.sha256)) {
    return invalidTransport(`SDK ${operation} output requires a matching package revision and passed receipt.`);
  }
  if (operation === "audioMasterSet") {
    if (!("master" in output)) return invalidTransport("SDK audioMasterSet output requires the persisted master.");
    try {
      const normalized = output.master === null ? null : normalizeMotionAudioMaster(output.master);
      const requested = request.master === null ? null : normalizeMotionAudioMaster(request.master);
      if (JSON.stringify(normalized) !== JSON.stringify(requested)) return invalidTransport("SDK audioMasterSet output master does not match the request.");
    } catch {
      return invalidTransport("SDK audioMasterSet output master is invalid.");
    }
    if (output.crossfade !== undefined) return invalidTransport("SDK audioMasterSet output must not include crossfade evidence.");
    return null;
  }
  const crossfade = record(output.crossfade);
  if (!crossfade || crossfade.fromLayerId !== request.fromLayerId || crossfade.toLayerId !== request.toLayerId
    || crossfade.durationMs !== request.durationMs || (crossfade.curve !== "linear" && crossfade.curve !== "equal-power")) {
    return invalidTransport("SDK audioCrossfadeSet output crossfade does not match the request.");
  }
  // The Debug/Core action applies equal-power when the caller omits curve. Bind the response to
  // that effective value too: accepting a forged linear response here would make the local SDK
  // claim a different edit from the one its defaulted request actually made.
  if (crossfade.curve !== (request.curve ?? "equal-power")) {
    return invalidTransport("SDK audioCrossfadeSet output curve does not match the request.");
  }
  if (output.master !== undefined) return invalidTransport("SDK audioCrossfadeSet output must not include master evidence.");
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
function stringList(value: unknown): boolean { return Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every((item) => typeof item === "string" && item.length <= 384); }
function sha256(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function invalid(message: string): MotionSdkError { return { code: "invalid_request", message, retryable: false }; }
function invalidTransport(message: string): MotionSdkError { return { code: "invalid_transport", message, retryable: false }; }
