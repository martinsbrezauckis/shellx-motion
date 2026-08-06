/** Local SDK adapter for copy-on-write keying and roto debug commands. */
import { loadMotionPackage, validateLayerKeyingAndRoto, type MotionChromaKey, type MotionMask, type MotionPackage } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugContext, MotionDebugResult } from "@shellx-motion/debug-api";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  MotionSdkKeyingApplyRequest, MotionSdkKeyingInspectRequest, MotionSdkKeyingInspectResponse,
  MotionSdkKeyingMutationResponse, MotionSdkKeyingOperation, MotionSdkKeyingRemoveRequest, MotionSdkLayerKeyingState,
  MotionSdkPackageIdentity, MotionSdkRotoRemoveRequest, MotionSdkRotoTrackingDetachRequest,
  MotionSdkRotoUpsertRequest,
} from "./types.js";
import { verifyPersistedReceipt } from "./local-receipt.js";

interface LocalKeyingRuntime {
  executeDebug(command: MotionDebugCommand, args: Record<string, unknown>, tier: MotionDebugContext["tier"]): Promise<MotionDebugResult>;
  packageIdentity(pkg: MotionPackage): Promise<MotionSdkPackageIdentity>;
}

export function createLocalKeyingOperations(runtime: LocalKeyingRuntime) {
  return {
    inspect: (input: MotionSdkKeyingInspectRequest) => inspect(input, runtime),
    apply: (input: MotionSdkKeyingApplyRequest) => mutate("motion.keying.apply", "keying.apply", input, runtime),
    removeKey: (input: MotionSdkKeyingRemoveRequest) => mutate("motion.keying.remove", "keying.remove", input, runtime),
    upsertRoto: (input: MotionSdkRotoUpsertRequest) => mutate("motion.roto.upsert", "roto.upsert", input, runtime),
    detachRotoTracking: (input: MotionSdkRotoTrackingDetachRequest) => mutate("motion.roto.tracking.detach", "roto.tracking.detach", input, runtime),
    removeRoto: (input: MotionSdkRotoRemoveRequest) => mutate("motion.roto.remove", "roto.remove", input, runtime),
  };
}

async function inspect(input: MotionSdkKeyingInspectRequest, runtime: LocalKeyingRuntime): Promise<MotionSdkKeyingInspectResponse> {
  const request = inputRecord(input, ["packageRoot", "layerId"], "keying inspect");
  const packageRoot = resolve(pathField(request, "packageRoot"));
  const layerId = idField(request, "layerId");
  const debug = await runtime.executeDebug("motion.keying.inspect", { packageRoot, layerId }, "read_motion");
  const result = successfulResult(debug, "keying inspect");
  const pkg = await loadMotionPackage(packageRoot);
  if (resolve(pathField(result, "packageRoot")) !== pkg.root) throw new Error("Keying inspect package identity does not match the request.");
  return { packageRoot: pkg.root, package: await runtime.packageIdentity(pkg), state: keyingState(result.state, layerId), warnings: [...debug.warnings] };
}

type MutationInput = MotionSdkKeyingApplyRequest | MotionSdkKeyingRemoveRequest | MotionSdkRotoUpsertRequest | MotionSdkRotoTrackingDetachRequest | MotionSdkRotoRemoveRequest;

async function mutate(
  command: MotionDebugCommand,
  operation: MotionSdkKeyingOperation,
  input: MutationInput,
  runtime: LocalKeyingRuntime,
): Promise<MotionSdkKeyingMutationResponse> {
  const payloadField = operation === "keying.apply" ? "keying" : operation === "roto.upsert" ? "mask" : null;
  const allowed = ["packageRoot", "outDir", "layerId", "receiptsRoot", ...(payloadField ? [payloadField] : [])];
  const request = inputRecord(input, allowed, operation);
  const packageRoot = resolve(pathField(request, "packageRoot"));
  const outDir = resolve(pathField(request, "outDir"));
  const layerId = idField(request, "layerId");
  const receiptsRoot = optionalPath(request, "receiptsRoot");
  const payload = payloadField ? dataRecord(request[payloadField], `${operation} ${payloadField}`) : null;
  const debug = await runtime.executeDebug(command, {
    packageRoot,
    outDir,
    layerId,
    ...(payloadField ? { [payloadField]: payload } : {}),
    ...(receiptsRoot ? { receiptsRoot } : {}),
  }, "edit_motion");
  const result = successfulResult(debug, operation);
  const resultRoot = resolve(pathField(result, "packageRoot"));
  if (resultRoot !== outDir || idField(result, "layerId") !== layerId) throw new Error(`${operation} output identity does not match the request.`);
  const pkg = await loadMotionPackage(resultRoot);
  const receiptPath = resolve(pathField(result, "receiptPath"));
  const receipt = await verifiedReceipt(result.receipt, receiptPath, pkg, operation);
  return {
    packageRoot: resultRoot,
    package: await runtime.packageIdentity(pkg),
    layerId,
    changedPaths: stringList(result.changedPaths, "changedPaths", 32, 512),
    state: keyingState(result.state, layerId),
    receipt,
    receiptPath,
    warnings: [...debug.warnings],
  };
}

async function verifiedReceipt(value: unknown, path: string, pkg: MotionPackage, operation: MotionSdkKeyingOperation) {
  const receipt = dataRecord(value, `${operation} receipt`);
  if (!inside(pkg.root, path) || receipt.schema !== "shellx-motion/receipt@1" || receipt.operation !== operation
    || receipt.packageId !== pkg.manifest.id || receipt.status !== "passed" || typeof receipt.id !== "string" || !receipt.id) {
    throw new Error(`${operation} receipt identity is invalid.`);
  }
  const expected = {
    schema: "shellx-motion/receipt@1" as const,
    id: receipt.id,
    packageId: pkg.manifest.id,
    operation,
    status: "passed" as const,
  };
  return { ...expected, sha256: await verifyPersistedReceipt(pkg.root, path, expected, `${operation} receipt`) };
}

function keyingState(value: unknown, layerId: string): MotionSdkLayerKeyingState {
  const state = dataRecord(value, "keying state");
  const layerType = typeof state.layerType === "string" && state.layerType.length <= 64 ? state.layerType : "";
  const keying = state.keying === null ? null : structuredClone(dataRecord(state.keying, "keying state controls")) as unknown as MotionChromaKey;
  const roto = state.roto === null ? null : structuredClone(dataRecord(state.roto, "keying state roto")) as unknown as MotionMask;
  const trackingAttached = Boolean(roto?.tracking);
  const issues = validateLayerKeyingAndRoto({ id: layerId, type: layerType, ...(keying ? { keying } : {}), ...(roto ? { mask: roto } : {}) }, "/layer");
  if (state.layerId !== layerId || !layerType || typeof state.trackingAttached !== "boolean" || issues.length > 0
    || state.trackingAttached !== trackingAttached) {
    throw new Error("Keying state is invalid or does not match the requested layer.");
  }
  return { layerId, layerType, keying, roto, trackingAttached: state.trackingAttached };
}

function inputRecord(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  const record = dataRecord(value, `${label} input`);
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} input contains unsupported field ${unexpected}.`);
  return record;
}
function successfulResult(debug: MotionDebugResult, label: string): Record<string, unknown> {
  if (!debug.ok) throw new Error(`${label} failed: ${debug.error.message}`);
  return dataRecord(debug.result, `${label} result`);
}
function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}
function pathField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > 4_096) throw new Error(`${key} must be a bounded path.`);
  return value;
}
function optionalPath(record: Record<string, unknown>, key: string): string | undefined { return key in record ? resolve(pathField(record, key)) : undefined }
function idField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${key} must be a safe identifier.`);
  return value;
}
function stringList(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((entry) => typeof entry === "string" && entry.length <= maxLength)) throw new Error(`${label} is invalid.`);
  return [...value];
}
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
