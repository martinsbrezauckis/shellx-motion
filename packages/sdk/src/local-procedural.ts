/** Local SDK adapter for deterministic procedural relationship package revisions. */
import {
  evaluateMotionProceduralLayers,
  loadMotionPackage,
  proceduralRelationshipGraphFingerprint,
  validateMotionProceduralGraph,
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
  MotionSdkPackageIdentity,
  MotionSdkProceduralBakeRequest,
  MotionSdkProceduralDetachRequest,
  MotionSdkProceduralEnabledRequest,
  MotionSdkProceduralInspectRequest,
  MotionSdkProceduralInspectResponse,
  MotionSdkProceduralMutationResponse,
  MotionSdkProceduralOperation,
  MotionSdkProceduralSetRequest,
  MotionSdkProceduralState,
} from "./types.js";
import { verifyPersistedReceipt } from "./local-receipt.js";
import { LocalMotionSdkError } from "./local-result.js";

interface LocalProceduralRuntime {
  executeDebug(
    command: MotionDebugCommand,
    args: Record<string, unknown>,
    tier: MotionDebugContext["tier"],
  ): Promise<MotionDebugResult>;
  packageIdentity(pkg: MotionPackage): Promise<MotionSdkPackageIdentity>;
}

type Mutation = "set" | "enabled.set" | "bake" | "detach";
type MutationInput = MotionSdkProceduralSetRequest
  | MotionSdkProceduralEnabledRequest
  | MotionSdkProceduralBakeRequest
  | MotionSdkProceduralDetachRequest;

export function createLocalProceduralOperations(runtime: LocalProceduralRuntime) {
  return {
    inspect: (input: MotionSdkProceduralInspectRequest) => inspect(input, runtime),
    set: (input: MotionSdkProceduralSetRequest) => mutate("set", input, runtime),
    setEnabled: (input: MotionSdkProceduralEnabledRequest) => mutate("enabled.set", input, runtime),
    bake: (input: MotionSdkProceduralBakeRequest) => mutate("bake", input, runtime),
    detach: (input: MotionSdkProceduralDetachRequest) => mutate("detach", input, runtime),
  };
}

async function inspect(
  input: MotionSdkProceduralInspectRequest,
  runtime: LocalProceduralRuntime,
): Promise<MotionSdkProceduralInspectResponse> {
  const request = inputRecord(input, ["packageRoot", "atMs"], "procedural inspect");
  const packageRoot = resolve(pathField(request, "packageRoot"));
  const atMs = optionalNonNegative(request, "atMs");
  const debug = await runtime.executeDebug(
    "motion.procedural.inspect",
    { packageRoot, ...(atMs !== undefined ? { atMs } : {}) },
    "read_motion",
  );
  const result = successfulResult(debug, "procedural inspect");
  const pkg = await loadMotionPackage(packageRoot);
  if (resolve(pathField(result, "packageRoot")) !== pkg.root) {
    throw new Error("Procedural inspect package identity does not match the request.");
  }
  return {
    packageRoot: pkg.root,
    package: await runtime.packageIdentity(pkg),
    state: relationshipState(pkg.motion, atMs),
    warnings: [...debug.warnings],
  };
}

async function mutate(
  mutation: Mutation,
  input: MutationInput,
  runtime: LocalProceduralRuntime,
): Promise<MotionSdkProceduralMutationResponse> {
  const operation = `procedural.relationship.${mutation}` as MotionSdkProceduralOperation;
  const request = inputRecord(input, allowedFields(mutation), operation);
  const packageRoot = resolve(pathField(request, "packageRoot"));
  const outDir = resolve(pathField(request, "outDir"));
  const receiptsRoot = optionalPath(request, "receiptsRoot");
  const createdBy = optionalString(request, "createdBy", 256);
  const command = `motion.${operation}` as MotionDebugCommand;
  const debug = await runtime.executeDebug(command, {
    packageRoot,
    outDir,
    ...mutationFields(mutation, request),
    ...(receiptsRoot ? { receiptsRoot } : {}),
    ...(createdBy ? { createdBy } : {}),
  }, "edit_motion");
  const result = successfulResult(debug, operation);
  const resultRoot = resolve(pathField(result, "packageRoot"));
  if (resultRoot !== outDir) throw new Error(`${operation} output identity does not match the request.`);
  const pkg = await loadMotionPackage(resultRoot);
  const receiptPath = resolve(pathField(result, "receiptPath"));
  const receipt = await verifiedReceipt(result.receipt, receiptPath, pkg, operation);
  const bake = mutation === "bake" ? bakeEvidence(result.bake) : undefined;
  return {
    packageRoot: resultRoot,
    package: await runtime.packageIdentity(pkg),
    operation,
    changedPaths: stringList(result.changedPaths, "changedPaths", 192, 384),
    state: relationshipState(pkg.motion),
    ...(bake ? { bake } : {}),
    receipt,
    receiptPath,
    warnings: [...debug.warnings],
  };
}

function mutationFields(mutation: Mutation, request: Record<string, unknown>): Record<string, unknown> {
  if (mutation === "set") return { relationship: dataRecord(request.relationship, "procedural relationship") };
  if (mutation === "enabled.set") {
    if (typeof request.enabled !== "boolean") throw new Error("Procedural enabled mutation requires boolean enabled.");
    return { relationshipId: safeIdField(request, "relationshipId"), enabled: request.enabled };
  }
  if (mutation === "detach") return { relationshipId: safeIdField(request, "relationshipId") };
  const relationshipIds = optionalIdList(request, "relationshipIds");
  return {
    ...(relationshipIds ? { relationshipIds } : {}),
    ...optionalNumberFields(request, ["startMs", "endMs", "sampleEveryFrames"]),
  };
}

function allowedFields(mutation: Mutation): string[] {
  const shared = ["packageRoot", "outDir", "receiptsRoot", "createdBy"];
  if (mutation === "set") return [...shared, "relationship"];
  if (mutation === "enabled.set") return [...shared, "relationshipId", "enabled"];
  if (mutation === "detach") return [...shared, "relationshipId"];
  return [...shared, "relationshipIds", "startMs", "endMs", "sampleEveryFrames"];
}

function relationshipState(motion: MotionDocument, atMs?: number): MotionSdkProceduralState {
  const graph = motion.relationships ? structuredClone(motion.relationships) : null;
  const relationships = graph?.relationships.map((relationship) => ({
    id: relationship.id,
    enabled: relationship.enabled,
    target: structuredClone(relationship.target),
    sources: relationship.nodes
      .filter((node) => node.type === "property")
      .map((node) => structuredClone(node.ref)),
    audioEnvelopeIds: relationship.nodes
      .filter((node) => node.type === "audio-envelope")
      .map((node) => node.envelopeId),
    nodeCount: relationship.nodes.length,
    outputNodeId: relationship.outputNodeId,
  })) ?? [];
  return {
    graph,
    relationships,
    validation: graph ? validateMotionProceduralGraph(graph, motion) : null,
    fingerprint: graph ? proceduralRelationshipGraphFingerprint(graph) : null,
    evaluation: graph && atMs !== undefined
      ? { atMs, values: evaluateMotionProceduralLayers(motion, atMs).values }
      : null,
  };
}

async function verifiedReceipt(
  value: unknown,
  path: string,
  pkg: MotionPackage,
  operation: MotionSdkProceduralOperation,
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

function bakeEvidence(value: unknown) {
  const bake = dataRecord(value, "procedural bake evidence");
  return {
    relationshipIds: stringList(bake.relationshipIds, "relationshipIds", 64, 128),
    sampleCount: positiveInteger(bake.sampleCount, "sampleCount"),
    keyframeCount: positiveInteger(bake.keyframeCount, "keyframeCount"),
    fingerprint: sha256Field(bake, "fingerprint"),
  };
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if ((prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0
    || descriptors.some((descriptor) => !("value" in descriptor))) {
    throw new Error(`${label} must be a plain data object.`);
  }
  return value as Record<string, unknown>;
}

function pathField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || value.includes("\0")) {
    throw new Error(`${key} must be a bounded path.`);
  }
  return value;
}
function optionalPath(record: Record<string, unknown>, key: string): string | undefined {
  return key in record ? resolve(pathField(record, key)) : undefined;
}
function optionalString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`${key} must be a bounded string.`);
  return value;
}
function optionalNonNegative(record: Record<string, unknown>, key: string): number | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${key} must be non-negative.`);
  return value;
}
function optionalNumberFields(record: Record<string, unknown>, keys: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of keys) if (key in record) result[key] = optionalNonNegative(record, key)!;
  return result;
}
function safeIdField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${key} must be a safe id.`);
  return value;
}
function optionalIdList(record: Record<string, unknown>, key: string): string[] | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || !value.every((item) => typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item))) {
    throw new Error(`${key} must contain 1..64 safe ids.`);
  }
  return [...value];
}
function stringList(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === "string" && item.length <= maxLength)) {
    throw new Error(`${label} is invalid.`);
  }
  return [...value];
}
function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}
function sha256Field(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${key} must be a SHA-256 value.`);
  return value;
}
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
