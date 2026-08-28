/** Local SDK adapter for bounded document-master and matched-crossfade edits. */
import { canonicalJson, loadMotionPackage, normalizeMotionAudioMaster, type MotionPackage } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugContext, MotionDebugResult } from "@shellx-motion/debug-api";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  MotionSdkAudioCrossfadeSetRequest,
  MotionSdkAudioMasterSetRequest,
  MotionSdkAudioMutationResponse,
  MotionSdkAudioOperation,
  MotionSdkPackageIdentity,
} from "./types.js";
import { verifyPersistedReceipt } from "./local-receipt.js";
import { LocalMotionSdkError } from "./local-result.js";

interface LocalAudioRuntime {
  executeDebug(command: MotionDebugCommand, args: Record<string, unknown>, tier: MotionDebugContext["tier"]): Promise<MotionDebugResult>;
  packageIdentity(pkg: MotionPackage): Promise<MotionSdkPackageIdentity>;
}

export function createLocalAudioOperations(runtime: LocalAudioRuntime) {
  return {
    masterSet: (input: MotionSdkAudioMasterSetRequest) => masterSet(input, runtime),
    crossfadeSet: (input: MotionSdkAudioCrossfadeSetRequest) => crossfadeSet(input, runtime),
  };
}

async function masterSet(input: MotionSdkAudioMasterSetRequest, runtime: LocalAudioRuntime): Promise<MotionSdkAudioMutationResponse> {
  const request = inputRecord(input, ["packageRoot", "outDir", "master", "receiptsRoot", "createdBy"], "audio master set");
  const packageRoot = resolve(pathField(request, "packageRoot"));
  const outDir = resolve(pathField(request, "outDir"));
  const master = "master" in request ? request.master : undefined;
  if (master !== null && !dataRecord(master, "audio master")) throw new Error("audio master must be a plain object or null.");
  const debug = await runtime.executeDebug("motion.audio.master.set", {
    packageRoot,
    outDir,
    ...(master === null ? { clear: true } : { master: dataRecord(master, "audio master") }),
    ...optionalReceiptAndActor(request),
  }, "edit_motion");
  const result = successfulResult(debug, "audio.master.set");
  const pkg = await matchingOutputPackage(result, outDir, "audio.master.set");
  const receiptPath = resolve(pathField(result, "receiptPath"));
  const receipt = await verifiedReceipt(result.receipt, receiptPath, pkg, "audio.master.set");
  const persisted = pkg.motion.audio?.master ? structuredClone(pkg.motion.audio.master) : null;
  if (canonicalJson(persisted) !== canonicalJson(master === null ? null : normalizeMotionAudioMaster(master))) {
    throw new Error("Persisted audio master does not match the requested master.");
  }
  return {
    packageRoot: pkg.root,
    package: await runtime.packageIdentity(pkg),
    operation: "audio.master.set",
    changedPaths: stringList(result.changedPaths, "changedPaths", 8, 384),
    master: persisted,
    receipt,
    receiptPath,
    warnings: [...debug.warnings],
  };
}

async function crossfadeSet(input: MotionSdkAudioCrossfadeSetRequest, runtime: LocalAudioRuntime): Promise<MotionSdkAudioMutationResponse> {
  const request = inputRecord(input, ["packageRoot", "outDir", "fromLayerId", "toLayerId", "durationMs", "curve", "receiptsRoot", "createdBy"], "audio crossfade set");
  const packageRoot = resolve(pathField(request, "packageRoot"));
  const outDir = resolve(pathField(request, "outDir"));
  const fromLayerId = idField(request, "fromLayerId");
  const toLayerId = idField(request, "toLayerId");
  const durationMs = positiveNumber(request, "durationMs");
  const curve = request.curve === undefined ? undefined : fadeCurve(request.curve);
  const debug = await runtime.executeDebug("motion.audio.crossfade.set", {
    packageRoot,
    outDir,
    fromLayerId,
    toLayerId,
    durationMs,
    ...(curve ? { curve } : {}),
    ...optionalReceiptAndActor(request),
  }, "edit_motion");
  const result = successfulResult(debug, "audio.crossfade.set");
  const pkg = await matchingOutputPackage(result, outDir, "audio.crossfade.set");
  const receiptPath = resolve(pathField(result, "receiptPath"));
  const receipt = await verifiedReceipt(result.receipt, receiptPath, pkg, "audio.crossfade.set");
  const storedFrom = pkg.motion.layers.find((layer) => layer.id === fromLayerId);
  const storedTo = pkg.motion.layers.find((layer) => layer.id === toLayerId);
  const storedCurve = curve ?? "equal-power";
  if (!storedFrom || !storedTo || storedFrom.fadeOutMs !== durationMs || storedTo.fadeInMs !== durationMs
    || storedFrom.fadeCurve !== storedCurve || storedTo.fadeCurve !== storedCurve) {
    throw new Error("Persisted crossfade does not match the requested matched fades.");
  }
  return {
    packageRoot: pkg.root,
    package: await runtime.packageIdentity(pkg),
    operation: "audio.crossfade.set",
    changedPaths: stringList(result.changedPaths, "changedPaths", 8, 384),
    crossfade: { fromLayerId, toLayerId, durationMs, curve: storedCurve },
    receipt,
    receiptPath,
    warnings: [...debug.warnings],
  };
}

async function matchingOutputPackage(result: Record<string, unknown>, outDir: string, operation: string): Promise<MotionPackage> {
  if (resolve(pathField(result, "packageRoot")) !== outDir) throw new Error(`${operation} output identity does not match the request.`);
  return loadMotionPackage(outDir);
}

async function verifiedReceipt(value: unknown, path: string, pkg: MotionPackage, operation: MotionSdkAudioOperation) {
  const receipt = dataRecord(value, `${operation} receipt`);
  if (!inside(pkg.root, path) || receipt.schema !== "shellx-motion/receipt@1" || receipt.operation !== operation
    || receipt.packageId !== pkg.manifest.id || receipt.status !== "passed" || typeof receipt.id !== "string" || !receipt.id) {
    throw new Error(`${operation} receipt identity is invalid.`);
  }
  const expected = { schema: "shellx-motion/receipt@1" as const, id: receipt.id, packageId: pkg.manifest.id, operation, status: "passed" as const };
  return { ...expected, path, sha256: await verifyPersistedReceipt(pkg.root, path, expected, `${operation} receipt`) };
}

function optionalReceiptAndActor(record: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["receiptsRoot", "createdBy"] as const) if (key in record) result[key] = boundedString(record, key, 4_096);
  return result;
}
function successfulResult(debug: MotionDebugResult, label: string): Record<string, unknown> {
  if (!debug.ok) throw new LocalMotionSdkError(debug.error.code, `${label} failed: ${debug.error.message}`, false);
  return dataRecord(debug.result, `${label} result`);
}
function inputRecord(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  const record = dataRecord(value, `${label} input`);
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} input contains unsupported field ${unexpected}.`);
  return record;
}
function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}
function pathField(record: Record<string, unknown>, key: string): string { return boundedString(record, key, 4_096); }
function boundedString(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`${key} must be a bounded non-empty string.`);
  return value;
}
function idField(record: Record<string, unknown>, key: string): string {
  const value = boundedString(record, key, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${key} must be a safe id.`);
  return value;
}
function positiveNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive finite number.`);
  return value;
}
function fadeCurve(value: unknown): "linear" | "equal-power" {
  if (value !== "linear" && value !== "equal-power") throw new Error('curve must be "linear" or "equal-power".');
  return value;
}
function stringList(value: unknown, label: string, max: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max || !value.every((item) => typeof item === "string" && item.length <= maxLength)) throw new Error(`${label} is invalid.`);
  return [...value];
}
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
