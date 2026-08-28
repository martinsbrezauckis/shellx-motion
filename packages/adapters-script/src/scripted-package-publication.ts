import { join, resolve, sep } from "node:path";
import {
  DEFAULT_HOST_INTERCHANGE_LIMITS,
  OutputDirectoryTransaction,
  compareCodeUnits,
  hashBuffer,
  writeVerifiedBoundedFile,
  type OperationReceipt,
  type OutputDirectoryTransactionExpectedInventory
} from "@shellx-motion/core";
import type { ScriptedMotionExport } from "./index.js";

export interface WriteScriptedMotionPackageOptions {
  packageDir: string;
}

export interface WrittenScriptedMotionPackage {
  packageDir: string;
  manifestPath: string;
  motionPath: string;
  receiptPath: string;
  /** The exact receipt committed inside the closed package tree. */
  receipt: OperationReceipt;
}

/** Assemble exactly the three public Script leaves privately before its single directory commit. */
export async function publishScriptedMotionPackage(
  scriptedExport: ScriptedMotionExport,
  options: WriteScriptedMotionPackageOptions
): Promise<WrittenScriptedMotionPackage> {
  const packageDir = resolve(options.packageDir);
  const manifestRef = "manifest.json";
  const motionRef = normalizedPackagePath(scriptedExport.manifest.motion);
  const receiptRef = "receipts/script-compile.receipt.json";
  const manifestPath = join(packageDir, manifestRef);
  const motionPath = join(packageDir, motionRef);
  const receiptPath = join(packageDir, receiptRef);
  const contentFiles = [
    jsonPackageFile(manifestRef, scriptedExport.manifest),
    jsonPackageFile(motionRef, scriptedExport.motion)
  ];
  const packageContentInventory = contentInventory(contentFiles);
  const receipt = enrichScriptedPackageReceipt(scriptedExport.receipt, {
    manifestRef,
    motionRef,
    receiptRef,
    packageContentHashes: contentHashes(contentFiles),
    packageContentInventory
  });
  const files = [...contentFiles, jsonPackageFile(receiptRef, receipt)];
  const expectedInventory = exactInventory(files);
  const transaction = await OutputDirectoryTransaction.create(packageDir, { requireClosedTree: true });
  try {
    for (const file of files) await writePackageFile(transaction.stagingPath, file);
    await transaction.commit(expectedInventory);
    return { packageDir, manifestPath, motionPath, receiptPath, receipt };
  } catch (error) {
    // Core preserves a possibly-retargeted or post-rename tree. Abort only removes an intact,
    // still-private stage, so a typed publication uncertainty retains its public evidence.
    await transaction.abort();
    throw error;
  }
}

interface ScriptedPackageFile {
  relativePath: string;
  bytes: Buffer;
  sha256: string;
  label: string;
}

interface ScriptedPackageContentInventory {
  sha256: string;
  entryCount: number;
  entries: OutputDirectoryTransactionExpectedInventory;
}

function jsonPackageFile(relativePath: string, value: unknown): ScriptedPackageFile {
  const normalizedPath = normalizedPackagePath(relativePath);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { relativePath: normalizedPath, bytes, sha256: hashBuffer(bytes), label: `Script package ${normalizedPath}` };
}

function contentHashes(files: readonly ScriptedPackageFile[]): Record<string, { sha256: string; byteLength: number }> {
  return Object.fromEntries(files.map((file) => [file.relativePath, { sha256: file.sha256, byteLength: file.bytes.byteLength }]));
}

/** The receipt binds manifest and Motion identity without a circular hash of itself. */
function contentInventory(files: readonly ScriptedPackageFile[]): ScriptedPackageContentInventory {
  const entries = exactInventory(files);
  const lines = entries.map((entry) => `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`).join("");
  return { sha256: hashBuffer(Buffer.from(lines, "utf8")), entryCount: entries.length, entries };
}

function exactInventory(files: readonly ScriptedPackageFile[]): OutputDirectoryTransactionExpectedInventory {
  const seen = new Set<string>();
  return [...files]
    .sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath))
    .map((file) => {
      if (seen.has(file.relativePath)) throw new Error(`Script package has colliding staged entry: ${file.relativePath}.`);
      seen.add(file.relativePath);
      return Object.freeze({ path: file.relativePath, sha256: file.sha256, byteLength: file.bytes.byteLength });
    });
}

async function writePackageFile(stagingPath: string, file: ScriptedPackageFile): Promise<void> {
  await writeVerifiedBoundedFile(safeResolve(stagingPath, file.relativePath), file.bytes, {
    label: file.label,
    maxBytes: DEFAULT_HOST_INTERCHANGE_LIMITS.maxFileBytes,
    withinRoot: stagingPath,
    expectedSha256: file.sha256
  });
}

/** Keep the in-package receipt independent of caller artifacts, paths, and arbitrary fields. */
function enrichScriptedPackageReceipt(
  receipt: OperationReceipt,
  paths: {
    manifestRef: string;
    motionRef: string;
    receiptRef: string;
    packageContentHashes: Record<string, { sha256: string; byteLength: number }>;
    packageContentInventory: ScriptedPackageContentInventory;
  }
): OperationReceipt {
  const output = plainRecord(receipt.output) ?? {};
  return {
    schema: "shellx-motion/receipt@1",
    id: receipt.id,
    operation: "script.compile",
    status: receipt.status,
    packageId: receipt.packageId,
    inputHashes: packageRelativeInputHashes(receipt.inputHashes),
    createdAt: receipt.createdAt,
    lane: "script",
    output: {
      ...scriptReceiptOutput(output),
      packageRoot: ".",
      manifestPath: paths.manifestRef,
      motionPath: paths.motionRef,
      receiptPath: paths.receiptRef,
      packageContentHashes: paths.packageContentHashes,
      packageContentInventory: paths.packageContentInventory
    },
    artifacts: [{ role: "motion_package", path: ".", status: "available", primary: true }],
    warnings: [],
    ...(receipt.actor ? { actor: receipt.actor } : {})
  };
}

function scriptReceiptOutput(output: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([
    "sourceApp", "workflow", "motionId", "manifestId", "frameCount", "layerCount", "durationMs", "storyboard"
  ].flatMap((key) => Object.prototype.hasOwnProperty.call(output, key) ? [[key, output[key]]] : []));
}

/** Preserve content hashes while replacing an external input path with a logical package locator. */
function packageRelativeInputHashes(inputHashes: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, [locator, sha256]] of Object.entries(inputHashes).entries()) {
    const relative = packageRelativeLocator(locator);
    const fallback = index === 0 ? "input/scripted-video.json" : `input/evidence-${index + 1}`;
    const target = relative && result[relative] === undefined ? relative : fallback;
    result[target] = sha256;
  }
  return result;
}

function packageRelativeLocator(locator: string): string | undefined {
  const normalized = locator.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return undefined;
  const parts = normalized.split("/");
  return parts.some((part) => !part || part === "." || part === "..") ? undefined : normalized;
}

function normalizedPackagePath(path: string): string {
  const normalized = path.split(sep).join("/");
  if (!normalized || normalized.includes("\\") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Script package path must be a root-relative locator: ${path}`);
  }
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Script package path must be a root-relative locator: ${path}`);
  }
  safeResolve("/script-package-root", normalized);
  return normalized;
}

function safeResolve(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, relativePath);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSep)) throw new Error(`Script package path escapes package root: ${relativePath}`);
  return resolved;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
