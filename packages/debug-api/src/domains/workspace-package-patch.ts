import {
  hashBuffer,
  hashPackageFile,
  loadSchema,
  resolvePackageAsset,
  validateDocument,
  type MotionDocument,
  type MotionPackage,
  type OperationReceipt
} from "@shellx-motion/core";
import { join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { objectArg, stringArg } from "./args.js";
import { commitMotionDocumentEdit } from "./package-edit-transaction.js";

const MAX_PATCH_OPERATIONS = 1_000;
const MAX_PATCH_PATH_BYTES = 4_096;
const MAX_PATCH_POINTER_TOKENS = 128;
const MAX_PATCH_VALUE_NODES = 100_000;
const MAX_PATCH_VALUE_DEPTH = 64;
const MAX_PATCH_VALUE_STRING_BYTES = 4 * 1024 * 1024;

export interface WorkspacePackagePatchServices {
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
  receiptsRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  isUnsafePackageOutputDirectory?: (packageRoot: string, outputRoot: string) => Promise<boolean>;
  isEmptyOrAbsentDirectory?: (path: string) => Promise<boolean>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

interface PackagePatchOperation {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

export async function dispatchWorkspacePackagePatch(
  command: MotionDebugCommand,
  args: unknown,
  services: WorkspacePackagePatchServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.package.patch") return null;
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const patch = readPackagePatchArg(args, "patch") ?? readPackagePatchArg(args, "operations");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.package.patch requires packageRoot.");
  if (!outDir) return invalidArgs("motion.package.patch requires outDir.");
  if (!patch) return invalidArgs("motion.package.patch requires patch operations.");
  if (patch.some((operation) => layoutGapAnimationPointer(operation.path))) {
    return invalidArgs("motion.package.patch reserves /layoutGapAnimation for the typed layout gap animation lifecycle.");
  }
  try {
    for (const operation of patch) jsonPointerTokens(operation.path);
  } catch (error) {
    return { ok: false, error: { code: "package_patch_failed", message: error instanceof Error ? error.message : String(error) }, warnings: [] };
  }
  if (!services.packageLoader || !services.isUnsafePackageOutputDirectory || !services.isEmptyOrAbsentDirectory) {
    return capabilityUnavailable("Atomic Motion package patching is unavailable.");
  }
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Package patch receipt persistence is unavailable.");

  try {
    const pkg = await services.packageLoader(packageRoot);
    const packageOutDir = resolve(outDir);
    if (await services.isUnsafePackageOutputDirectory(pkg.root, packageOutDir)) {
      return invalidArgs("motion.package.patch outDir must be outside packageRoot.");
    }
    if (!await services.isEmptyOrAbsentDirectory(packageOutDir)) {
      return invalidArgs("motion.package.patch outDir must be empty or absent before package copy.");
    }
    const manifestPath = resolvePackageAsset(pkg, "manifest.json");
    const motionPath = resolvePackageAsset(pkg, pkg.manifest.motion);
    const inputHashes = {
      "manifest.json": await hashPackageFile(manifestPath),
      [pkg.manifest.motion]: await hashPackageFile(motionPath)
    };
    const patchedMotion = applyMotionPatch(pkg.motion, patch);
    const validation = await validateDocument(await loadSchema("motion"), patchedMotion);
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          code: "package_patch_invalid",
          message: "Patched Motion document failed validation.",
          suggestedAction: validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")
        },
        warnings: []
      };
    }
    const patchedMotionPath = join(packageOutDir, pkg.manifest.motion);
    const changedPaths = patch.map((operation) => operation.path);
    const output = {
      packageDir: packageOutDir,
      manifestPath: join(packageOutDir, "manifest.json"),
      motionPath: patchedMotionPath,
      changedPaths,
      opCount: patch.length,
      validation,
      ...(createdBy ? { createdBy } : {})
    };
    const receiptPath = join(packageOutDir, "receipts", "package-patch.receipt.json");
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `package-patch-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, patch, output }), "utf8")).slice(0, 16)}`,
      operation: "package.patch",
      status: "passed",
      packageId: pkg.manifest.id,
      inputHashes,
      createdAt: new Date().toISOString(),
      lane: "debug-api",
      output,
      warnings: []
    };
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg,
      outputRoot: packageOutDir,
      authoringInputRoots: services.authoringInputRoots!,
      authoringOutputRoots: services.authoringOutputRoots!,
      patchedMotion,
      receipt,
      receiptFileName: "package-patch.receipt.json",
      ...(receiptsRoot ? { receiptsRoot, writeHostReceipt: services.writeReceipt! } : {})
    });
    return {
      ok: true,
      receiptId: receipt.id,
      visibleState: {
        panel: "templateInspector",
        operation: "package.patch",
        packageId: pkg.manifest.id,
        packageDir: packageOutDir,
        changedPaths,
        receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {})
      },
      result: {
        ok: true,
        packageId: pkg.manifest.id,
        packageDir: packageOutDir,
        manifestPath: output.manifestPath,
        motionPath: patchedMotionPath,
        receiptPath,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
        changedPaths,
        validation,
        motion: patchedMotion,
        receipt
      },
      warnings: []
    };
  } catch (error) {
    return {
      ok: false,
      error: { code: "package_patch_failed", message: error instanceof Error ? error.message : String(error) },
      warnings: []
    };
  }
}

function readPackagePatchArg(args: unknown, key: string): PackagePatchOperation[] | null {
  const argsRecord = objectArg(args);
  if (!argsRecord || !Object.hasOwn(argsRecord, key)) return null;
  const value = argsRecord[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATCH_OPERATIONS) return null;
  const operations: PackagePatchOperation[] = [];
  for (const item of value) {
    const record = objectArg(item);
    if (!record || !Object.hasOwn(record, "op") || !Object.hasOwn(record, "path")) return null;
    const op = record.op;
    const path = record.path;
    if ((op !== "add" && op !== "replace" && op !== "remove")
      || typeof path !== "string"
      || !path.startsWith("/")
      || Buffer.byteLength(path, "utf8") > MAX_PATCH_PATH_BYTES) return null;
    const hasValue = Object.hasOwn(record, "value");
    if ((op === "add" || op === "replace") && !hasValue) return null;
    if (hasValue && !isBoundedJsonValue(record.value)) return null;
    operations.push({ op, path, ...(hasValue ? { value: structuredClone(record.value) } : {}) });
  }
  return operations;
}

function applyMotionPatch(motion: MotionDocument, patch: PackagePatchOperation[]): MotionDocument {
  const next = structuredClone(motion);
  for (const operation of patch) {
    if (operation.op === "remove") removeJsonPointer(next, operation.path);
    else setJsonPointer(next, operation.path, structuredClone(operation.value), operation.op);
  }
  return next;
}

function setJsonPointer(root: unknown, path: string, value: unknown, op: "add" | "replace"): void {
  const tokens = jsonPointerTokens(path);
  if (tokens.length === 0) throw new Error("Cannot patch the Motion document root.");
  const parent = parentForPointer(root, tokens, op === "add");
  const key = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    const index = arrayIndexForToken(key, parent.length, op === "add");
    if (op === "add") parent.splice(index, 0, value);
    else parent[index] = value;
    return;
  }
  if (!isObject(parent)) throw new Error(`Patch parent is not an object: ${path}`);
  if (op === "replace" && !Object.hasOwn(parent, key)) throw new Error(`Patch path does not exist: ${path}`);
  Reflect.set(parent, key, value);
}

function removeJsonPointer(root: unknown, path: string): void {
  const tokens = jsonPointerTokens(path);
  if (tokens.length === 0) throw new Error("Cannot remove the Motion document root.");
  const parent = parentForPointer(root, tokens, false);
  const key = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    const index = arrayIndexForToken(key, parent.length, false);
    parent.splice(index, 1);
    return;
  }
  if (!isObject(parent) || !Object.hasOwn(parent, key)) throw new Error(`Patch path does not exist: ${path}`);
  Reflect.deleteProperty(parent, key);
}

function parentForPointer(root: unknown, tokens: string[], createMissing: boolean): unknown {
  let cursor = root;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];
    if (Array.isArray(cursor)) {
      cursor = cursor[arrayIndexForToken(token, cursor.length, false)];
      continue;
    }
    if (!isObject(cursor)) throw new Error(`Patch path parent is not an object: /${tokens.slice(0, index + 1).join("/")}`);
    if (!Object.hasOwn(cursor, token)) {
      if (!createMissing) throw new Error(`Patch path does not exist: /${tokens.slice(0, index + 1).join("/")}`);
      Reflect.set(cursor, token, isNumericPointerToken(nextToken) ? [] : {});
    }
    cursor = Reflect.get(cursor, token);
  }
  return cursor;
}

function jsonPointerTokens(path: string): string[] {
  const tokens = path.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (tokens.length > MAX_PATCH_POINTER_TOKENS) throw new Error(`Patch path exceeds ${MAX_PATCH_POINTER_TOKENS} segments.`);
  const unsafeToken = tokens.find((token) => token === "__proto__" || token === "prototype" || token === "constructor");
  if (unsafeToken) throw new Error(`Patch path contains unsafe segment: ${unsafeToken}`);
  return tokens;
}

/** Generic JSON patch must never create, edit, test, move, copy, or remove the C2 authority root. */
function layoutGapAnimationPointer(path: string): boolean {
  const firstToken = path.slice(1).split("/", 1)[0]!
    .replace(/~1/g, "/")
    .replace(/~0/g, "~");
  return firstToken === "layoutGapAnimation";
}

function arrayIndexForToken(token: string, length: number, allowAppend: boolean): number {
  if (allowAppend && token === "-") return length;
  if (!isNumericPointerToken(token)) throw new Error(`Patch array index must be numeric: ${token}`);
  const index = Number(token);
  if (!Number.isSafeInteger(index) || index < 0 || index > (allowAppend ? length : length - 1)) {
    throw new Error(`Patch array index is out of bounds: ${token}`);
  }
  return index;
}

function isNumericPointerToken(token: string): boolean {
  return token === "0" || /^[1-9]\d*$/.test(token);
}

function isBoundedJsonValue(value: unknown): boolean {
  let nodes = 0;
  let stringBytes = 0;
  const visit = (entry: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_PATCH_VALUE_NODES || depth > MAX_PATCH_VALUE_DEPTH) return false;
    if (entry === null || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (typeof entry === "string") {
      stringBytes += Buffer.byteLength(entry, "utf8");
      return stringBytes <= MAX_PATCH_VALUE_STRING_BYTES;
    }
    if (Array.isArray(entry)) return entry.every((item) => visit(item, depth + 1));
    if (!isObject(entry)) return false;
    for (const [key, item] of Object.entries(entry)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") return false;
      stringBytes += Buffer.byteLength(key, "utf8");
      if (stringBytes > MAX_PATCH_VALUE_STRING_BYTES || !visit(item, depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return {
    ok: false,
    error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." },
    warnings: []
  };
}
