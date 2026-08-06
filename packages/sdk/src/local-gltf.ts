import { hashFile, loadMotionPackage, type MotionPackage } from "@shellx-motion/core";
import type {
  MotionDebugCommand,
  MotionDebugContext,
  MotionDebugResult,
} from "@shellx-motion/debug-api";
import { resolve } from "node:path";
import type {
  MotionSdkGltfImportRequest,
  MotionSdkGltfImportResponse,
  MotionSdkPackageIdentity,
} from "./types.js";
import { verifyPersistedReceipt } from "./local-receipt.js";
import { LocalMotionSdkError } from "./local-result.js";

interface LocalGltfRuntime {
  executeDebug(
    command: MotionDebugCommand,
    args: Record<string, unknown>,
    tier: MotionDebugContext["tier"],
  ): Promise<MotionDebugResult>;
  packageIdentity(pkg: MotionPackage): Promise<MotionSdkPackageIdentity>;
}

export function createLocalGltfOperations(runtime: LocalGltfRuntime) {
  return {
    import: (input: MotionSdkGltfImportRequest) => importGltf(input, runtime),
  };
}

async function importGltf(
  input: MotionSdkGltfImportRequest,
  runtime: LocalGltfRuntime,
): Promise<MotionSdkGltfImportResponse> {
  const debug = await runtime.executeDebug("motion.scene3d.gltf.import", {
    sourcePath: input.sourcePath,
    outDir: input.outDir,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  }, "write_local");
  const result = successfulResult(debug);
  const packageRoot = pathField(result, "packageRoot");
  if (resolve(packageRoot) !== resolve(input.outDir)) {
    throw new Error("glTF import output identity does not match the request.");
  }
  const pkg = await loadMotionPackage(packageRoot);
  const format = formatField(result.format);
  const sourcePath = packagePathField(
    result,
    "sourcePath",
    resolve(pkg.root, "source", format === "glb" ? "input.glb" : "input.gltf"),
  );
  const normalizedSourcePath = packagePathField(
    result,
    "normalizedSourcePath",
    resolve(pkg.root, "source", "normalized.gltf.json"),
  );
  const sourceSha256 = sha256Field(result, "sourceSha256");
  if (await hashFile(sourcePath) !== sourceSha256) {
    throw new Error("glTF preserved source hash does not match the import result.");
  }
  const receiptValue = dataRecord(result.loweringReceipt, "glTF lowering receipt");
  const receiptPath = pathField(result, "loweringReceiptPath");
  const status = receiptStatus(receiptValue.status);
  const receipt = {
    schema: "shellx-motion/receipt@1" as const,
    id: stringField(receiptValue, "id"),
    packageId: pkg.manifest.id,
    operation: "adapter.lower" as const,
    status,
    path: receiptPath,
    sha256: await verifyPersistedReceipt(pkg.root, receiptPath, {
      id: stringField(receiptValue, "id"),
      packageId: pkg.manifest.id,
      operation: "adapter.lower",
      status,
    }, "glTF lowering receipt"),
  };
  if (receiptValue.packageId !== pkg.manifest.id || receiptValue.operation !== "adapter.lower") {
    throw new Error("glTF lowering receipt identity does not match the package.");
  }
  return {
    packageRoot: pkg.root,
    package: await runtime.packageIdentity(pkg),
    format,
    sourcePath,
    normalizedSourcePath,
    sourceSha256,
    bufferSha256: sha256List(result.bufferSha256, "bufferSha256"),
    sourceByteLength: positiveInteger(result.sourceByteLength, "sourceByteLength"),
    receipt,
    warnings: [...debug.warnings],
  };
}

function successfulResult(debug: MotionDebugResult): Record<string, unknown> {
  if (!debug.ok) {
    throw new LocalMotionSdkError(debug.error.code, `glTF import failed: ${debug.error.message}`, false);
  }
  return dataRecord(debug.result, "glTF import result");
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if ((prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0
    || descriptors.some((descriptor) => !("value" in descriptor))) {
    throw new Error(`${label} must be a plain data object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw new Error(`glTF import ${key} is invalid.`);
  return value;
}

function pathField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (value.includes("\0")) throw new Error(`glTF import ${key} is invalid.`);
  return resolve(value);
}

function packagePathField(
  record: Record<string, unknown>,
  key: string,
  expected: string,
): string {
  const path = pathField(record, key);
  if (path !== expected) throw new Error(`glTF import ${key} must stay at its package-owned path.`);
  return path;
}

function sha256Field(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`glTF import ${key} is invalid.`);
  return value;
}

function sha256List(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4
    || !value.every((item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))) {
    throw new Error(`glTF import ${label} is invalid.`);
  }
  return [...value];
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`glTF import ${label} is invalid.`);
  }
  return value;
}

function formatField(value: unknown): "gltf" | "glb" {
  if (value !== "gltf" && value !== "glb") throw new Error("glTF import format is invalid.");
  return value;
}

function receiptStatus(value: unknown): "passed" | "warning" {
  if (value !== "passed" && value !== "warning") throw new Error("glTF receipt status is invalid.");
  return value;
}
