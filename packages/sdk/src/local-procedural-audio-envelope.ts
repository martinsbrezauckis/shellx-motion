/** Local SDK binding for the bounded procedural audio-envelope producer. */
import {
  loadMotionPackage,
  proceduralRelationshipGraphFingerprint,
  validateMotionProceduralGraph,
  type MotionDocument,
  type MotionPackage,
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugContext, MotionDebugResult } from "@shellx-motion/debug-api";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  MotionSdkPackageIdentity,
  MotionSdkProceduralAudioEnvelopeProduceRequest,
  MotionSdkProceduralMutationResponse,
  MotionSdkProceduralOperation,
  MotionSdkProceduralState,
} from "./types.js";
import { verifyPersistedReceipt } from "./local-receipt.js";
import { LocalMotionSdkError } from "./local-result.js";

export interface LocalProceduralAudioEnvelopeRuntime {
  executeDebug(
    command: MotionDebugCommand,
    args: Record<string, unknown>,
    tier: MotionDebugContext["tier"],
  ): Promise<MotionDebugResult>;
  packageIdentity(pkg: MotionPackage): Promise<MotionSdkPackageIdentity>;
}

export async function produceLocalProceduralAudioEnvelope(
  input: MotionSdkProceduralAudioEnvelopeProduceRequest,
  runtime: LocalProceduralAudioEnvelopeRuntime,
): Promise<MotionSdkProceduralMutationResponse> {
  const operation: MotionSdkProceduralOperation = "procedural.audio-envelope.produce";
  const request = inputRecord(input, [
    "packageRoot", "outDir", "sourceLayerId", "envelopeId", "sampleEveryMs", "channel", "receiptsRoot", "createdBy",
  ], operation);
  const packageRoot = resolve(pathField(request, "packageRoot"));
  const outDir = resolve(pathField(request, "outDir"));
  const sourceLayerId = safeIdField(request, "sourceLayerId");
  const envelopeId = safeIdField(request, "envelopeId");
  const sampleEveryMs = request.sampleEveryMs === undefined ? undefined : positiveNumberInRange(request, "sampleEveryMs", 16, 1_000);
  const channel = request.channel === undefined ? undefined : mixChannel(request.channel);
  const receiptsRoot = optionalPath(request, "receiptsRoot");
  const createdBy = optionalString(request, "createdBy", 256);
  const debug = await runtime.executeDebug("motion.procedural.audio-envelope.produce", {
    packageRoot,
    outDir,
    sourceLayerId,
    envelopeId,
    ...(sampleEveryMs !== undefined ? { sampleEveryMs } : {}),
    ...(channel ? { channel } : {}),
    ...(receiptsRoot ? { receiptsRoot } : {}),
    ...(createdBy ? { createdBy } : {}),
  }, "edit_motion");
  const result = successfulResult(debug, operation);
  const resultRoot = resolve(pathField(result, "packageRoot"));
  if (resultRoot !== outDir) throw new Error(`${operation} output identity does not match the request.`);
  const pkg = await loadMotionPackage(resultRoot);
  const receiptPath = resolve(pathField(result, "receiptPath"));
  const receipt = await verifiedReceipt(result.receipt, receiptPath, pkg, operation);
  const envelope = envelopeEvidence(result.envelope, sourceLayerId, envelopeId, sampleEveryMs ?? 50);
  const stored = pkg.motion.relationships?.audioEnvelopes?.find((item) => item.id === envelopeId);
  if (!stored || stored.sourceLayerId !== sourceLayerId || stored.channel !== "mix" || stored.samples.length !== envelope.sampleCount) {
    throw new Error("Persisted audio envelope does not match producer evidence.");
  }
  return {
    packageRoot: resultRoot,
    package: await runtime.packageIdentity(pkg),
    operation,
    changedPaths: stringList(result.changedPaths, "changedPaths", 8, 384),
    state: relationshipState(pkg.motion),
    envelope,
    receipt,
    receiptPath,
    warnings: [...debug.warnings],
  };
}

function relationshipState(motion: MotionDocument): MotionSdkProceduralState {
  const graph = motion.relationships ? structuredClone(motion.relationships) : null;
  return {
    graph,
    relationships: graph?.relationships.map((relationship) => ({
      id: relationship.id,
      enabled: relationship.enabled,
      target: structuredClone(relationship.target),
      sources: relationship.nodes.filter((node) => node.type === "property").map((node) => structuredClone(node.ref)),
      audioEnvelopeIds: relationship.nodes.filter((node) => node.type === "audio-envelope").map((node) => node.envelopeId),
      nodeCount: relationship.nodes.length,
      outputNodeId: relationship.outputNodeId,
    })) ?? [],
    validation: graph ? validateMotionProceduralGraph(graph, motion) : null,
    fingerprint: graph ? proceduralRelationshipGraphFingerprint(graph) : null,
    evaluation: null,
  };
}

async function verifiedReceipt(value: unknown, path: string, pkg: MotionPackage, operation: MotionSdkProceduralOperation) {
  const receipt = dataRecord(value, `${operation} receipt`);
  if (!inside(pkg.root, path) || receipt.schema !== "shellx-motion/receipt@1" || receipt.operation !== operation
    || receipt.packageId !== pkg.manifest.id || receipt.status !== "passed" || typeof receipt.id !== "string" || !receipt.id) {
    throw new Error(`${operation} receipt identity is invalid.`);
  }
  const expected = { schema: "shellx-motion/receipt@1" as const, id: receipt.id, packageId: pkg.manifest.id, operation, status: "passed" as const };
  return { ...expected, path, sha256: await verifyPersistedReceipt(pkg.root, path, expected, `${operation} receipt`) };
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
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0 || descriptors.some((descriptor) => !("value" in descriptor))) {
    throw new Error(`${label} must be a plain data object.`);
  }
  return value as Record<string, unknown>;
}

function pathField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || value.includes("\0")) throw new Error(`${key} must be a bounded path.`);
  return value;
}
function optionalPath(record: Record<string, unknown>, key: string): string | undefined { return key in record ? resolve(pathField(record, key)) : undefined; }
function optionalString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`${key} must be a bounded string.`);
  return value;
}
function positiveNumberInRange(record: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be a finite number from ${min} to ${max}.`);
  return value;
}
function mixChannel(value: unknown): "mix" { if (value !== "mix") throw new Error('channel must be "mix".'); return value; }
function safeIdField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${key} must be a safe id.`);
  return value;
}
function stringList(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === "string" && item.length <= maxLength)) throw new Error(`${label} is invalid.`);
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
function envelopeEvidence(value: unknown, sourceLayerId: string, envelopeId: string, sampleEveryMs: number) {
  const evidence = dataRecord(value, "procedural audio envelope evidence");
  if (evidence.id !== envelopeId || evidence.sourceLayerId !== sourceLayerId || evidence.channel !== "mix"
    || evidence.sampleEveryMs !== sampleEveryMs || !positiveInteger(evidence.sampleCount, "sampleCount") || !sha256Field(evidence, "samplesSha256")) {
    throw new Error("Procedural audio envelope producer evidence is invalid.");
  }
  return { id: envelopeId, sourceLayerId, channel: "mix" as const, sampleEveryMs, sampleCount: evidence.sampleCount as number, samplesSha256: evidence.samplesSha256 as string };
}
function inside(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}
