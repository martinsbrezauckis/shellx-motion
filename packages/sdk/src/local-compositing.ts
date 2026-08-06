/** Local SDK adapter for copy-on-write typed compositing graph operations. */
import {
  compositingGraphFingerprint,
  loadMotionPackage,
  restoreMotionDocumentCompositing,
  validateMotionCompositingGraph,
  type MotionCompositingCompileMetadata,
  type MotionDocument,
  type MotionPackage,
} from "@shellx-motion/core";
import type {
  MotionDebugCommand,
  MotionDebugContext,
  MotionDebugResult,
} from "@shellx-motion/debug-api";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  MotionSdkCompositingGraphState,
  MotionSdkCompositingInspectRequest,
  MotionSdkCompositingInspectResponse,
  MotionSdkCompositingMutationResponse,
  MotionSdkCompositingOperation,
  MotionSdkCompositingRemoveRequest,
  MotionSdkCompositingSetRequest,
  MotionSdkPackageIdentity,
} from "./types.js";
import { verifyPersistedReceipt } from "./local-receipt.js";

interface LocalCompositingRuntime {
  executeDebug(
    command: MotionDebugCommand,
    args: Record<string, unknown>,
    tier: MotionDebugContext["tier"],
  ): Promise<MotionDebugResult>;
  packageIdentity(pkg: MotionPackage): Promise<MotionSdkPackageIdentity>;
}

export function createLocalCompositingOperations(runtime: LocalCompositingRuntime) {
  return {
    inspect: (input: MotionSdkCompositingInspectRequest) => inspect(input, runtime),
    set: (input: MotionSdkCompositingSetRequest) => mutate("set", input, runtime),
    remove: (input: MotionSdkCompositingRemoveRequest) => mutate("remove", input, runtime),
  };
}

async function inspect(
  input: MotionSdkCompositingInspectRequest,
  runtime: LocalCompositingRuntime,
): Promise<MotionSdkCompositingInspectResponse> {
  const request = inputRecord(input, ["packageRoot"], "compositing inspect");
  const packageRoot = resolve(pathField(request, "packageRoot"));
  const debug = await runtime.executeDebug(
    "motion.compositing.graph.inspect",
    { packageRoot },
    "read_motion",
  );
  const result = successfulResult(debug, "compositing inspect");
  const pkg = await loadMotionPackage(packageRoot);
  if (resolve(pathField(result, "packageRoot")) !== pkg.root) {
    throw new Error("Compositing inspect package identity does not match the request.");
  }
  return {
    packageRoot: pkg.root,
    package: await runtime.packageIdentity(pkg),
    state: inspectState(pkg.motion),
    warnings: [...debug.warnings],
  };
}

type MutationInput = MotionSdkCompositingSetRequest | MotionSdkCompositingRemoveRequest;

async function mutate(
  mutation: "set" | "remove",
  input: MutationInput,
  runtime: LocalCompositingRuntime,
): Promise<MotionSdkCompositingMutationResponse> {
  const operation: MotionSdkCompositingOperation = `compositing.graph.${mutation}`;
  const allowed = [
    "packageRoot", "outDir", "receiptsRoot", "createdBy",
    ...(mutation === "set" ? ["graph"] : []),
  ];
  const request = inputRecord(input, allowed, operation);
  const packageRoot = resolve(pathField(request, "packageRoot"));
  const outDir = resolve(pathField(request, "outDir"));
  const receiptsRoot = optionalPath(request, "receiptsRoot");
  const createdBy = optionalString(request, "createdBy", 256);
  const graph = mutation === "set" ? dataRecord(request.graph, "compositing graph") : null;
  const command: MotionDebugCommand = mutation === "set"
    ? "motion.compositing.graph.set"
    : "motion.compositing.graph.remove";
  const debug = await runtime.executeDebug(command, {
    packageRoot,
    outDir,
    ...(graph ? { graph } : {}),
    ...(receiptsRoot ? { receiptsRoot } : {}),
    ...(createdBy ? { createdBy } : {}),
  }, "edit_motion");
  const result = successfulResult(debug, operation);
  const resultRoot = resolve(pathField(result, "packageRoot"));
  if (resultRoot !== outDir) {
    throw new Error(`${operation} output identity does not match the request.`);
  }
  const pkg = await loadMotionPackage(resultRoot);
  const receiptPath = resolve(pathField(result, "receiptPath"));
  const receipt = await verifiedReceipt(result.receipt, receiptPath, pkg, operation);
  return {
    packageRoot: resultRoot,
    package: await runtime.packageIdentity(pkg),
    changedPaths: stringList(result.changedPaths, "changedPaths", 16, 256),
    state: inspectState(pkg.motion),
    receipt,
    receiptPath,
    warnings: [...debug.warnings],
  };
}

function inspectState(motion: MotionDocument): MotionSdkCompositingGraphState {
  const source = restoreMotionDocumentCompositing(motion);
  const graph = source.compositing ? structuredClone(source.compositing) : null;
  const validation = graph
    ? validateMotionCompositingGraph(graph, {
      width: source.width,
      height: source.height,
      layers: source.layers,
    })
    : null;
  const metadata = compileMetadata(motion["x-compositing-compile"]);
  const fingerprint = graph ? compositingGraphFingerprint(graph) : null;
  if (metadata && (!graph
    || metadata.graphId !== graph.id
    || metadata.fingerprint !== fingerprint)) {
    throw new Error("Compositing compile metadata does not match the editable graph.");
  }
  return { graph, compiled: Boolean(graph && metadata), metadata, validation, fingerprint };
}

function compileMetadata(value: unknown): MotionCompositingCompileMetadata | null {
  if (value === undefined) return null;
  const metadata = dataRecord(value, "compositing compile metadata");
  if (metadata.schema !== "shellx-motion/compositing-compile@1"
    || typeof metadata.graphId !== "string"
    || typeof metadata.fingerprint !== "string"
    || !stringListShape(metadata.nodeOrder, 64, 64)
    || !stringListShape(metadata.sourceLayerIds, 64, 256)
    || !stringListShape(metadata.outputLayerIds, 128, 256)) {
    throw new Error("Compositing compile metadata is invalid.");
  }
  dataRecord(metadata.estimate, "compositing resource estimate");
  return structuredClone(metadata) as unknown as MotionCompositingCompileMetadata;
}

async function verifiedReceipt(
  value: unknown,
  path: string,
  pkg: MotionPackage,
  operation: MotionSdkCompositingOperation,
) {
  const receipt = dataRecord(value, `${operation} receipt`);
  if (!inside(pkg.root, path)
    || receipt.schema !== "shellx-motion/receipt@1"
    || receipt.operation !== operation
    || receipt.packageId !== pkg.manifest.id
    || receipt.status !== "passed"
    || typeof receipt.id !== "string"
    || !receipt.id) {
    throw new Error(`${operation} receipt identity is invalid.`);
  }
  const expected = {
    schema: "shellx-motion/receipt@1" as const,
    id: receipt.id,
    packageId: pkg.manifest.id,
    operation,
    status: "passed" as const,
  };
  return {
    ...expected,
    path,
    sha256: await verifyPersistedReceipt(pkg.root, path, expected, `${operation} receipt`),
  };
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if ((prototype !== Object.prototype && prototype !== null)
    || descriptors.some((descriptor) => !("value" in descriptor))) {
    throw new Error(`${label} must be a plain data object.`);
  }
  return value as Record<string, unknown>;
}

function pathField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > 4_096) {
    throw new Error(`${key} must be a bounded path.`);
  }
  return value;
}

function optionalPath(record: Record<string, unknown>, key: string): string | undefined {
  return key in record ? resolve(pathField(record, key)) : undefined;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${key} must be a bounded string.`);
  }
  return value;
}

function stringList(
  value: unknown,
  label: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!stringListShape(value, maxItems, maxLength)) throw new Error(`${label} is invalid.`);
  return [...value];
}

function stringListShape(
  value: unknown,
  maxItems: number,
  maxLength: number,
): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((entry) => typeof entry === "string" && entry.length <= maxLength);
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
