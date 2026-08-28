/** Runtime guards for deterministic, data-only procedural SDK operations. */
import {
  proceduralRelationshipGraphFingerprint,
  validateMotionProceduralGraph,
  type MotionProceduralGraph,
} from "@shellx-motion/core";
import { canonicalJson } from "./cache.js";
import {
  hasMatchingProceduralAudioEnvelopeEvidence,
  proceduralAudioEnvelopeRequestProblem,
} from "./procedural-audio-envelope-client.js";
import { validProceduralMutationSemantics } from "./procedural-mutation-semantics.js";
import { attributePreflightIssues } from "./procedural-preflight-context.js";
import type { MotionSdkError, MotionSdkOperation } from "./types.js";

const OPERATIONS = new Set<MotionSdkOperation>([
  "proceduralInspect",
  "proceduralSet",
  "proceduralSetEnabled",
  "proceduralBake",
  "proceduralDetach",
  "proceduralAudioEnvelopeProduce",
]);

export function isProceduralOperation(operation: MotionSdkOperation): boolean {
  return OPERATIONS.has(operation);
}

export function validateProceduralRequest(
  operation: MotionSdkOperation,
  input: Record<string, unknown>,
): MotionSdkError | null {
  if (!isProceduralOperation(operation)) return null;
  if (operation === "proceduralInspect") {
    return input.atMs === undefined || nonNegative(input.atMs)
      ? null
      : invalid("SDK proceduralInspect atMs must be a non-negative finite number.");
  }
  if (operation === "proceduralSet") {
    const validation = validateStandaloneRelationship(input.relationship);
    if (!validation.ok) {
      const first = validation.issues[0];
      return invalid(`SDK proceduralSet ${first?.path ?? "/relationships"}: ${first?.message ?? "relationship is invalid"}.`);
    }
  }
  if (operation === "proceduralSetEnabled") {
    if (!safeId(input.relationshipId)) return invalid("SDK proceduralSetEnabled requires a safe relationshipId.");
    if (typeof input.enabled !== "boolean") return invalid("SDK proceduralSetEnabled requires boolean enabled.");
  }
  if (operation === "proceduralDetach" && !safeId(input.relationshipId)) {
    return invalid("SDK proceduralDetach requires a safe relationshipId.");
  }
  if (operation === "proceduralAudioEnvelopeProduce") {
    const problem = proceduralAudioEnvelopeRequestProblem(input);
    if (problem) return invalid(problem);
  }
  if (operation === "proceduralBake") {
    if (input.relationshipIds !== undefined
      && (!Array.isArray(input.relationshipIds)
        || input.relationshipIds.length < 1
        || input.relationshipIds.length > 64
        || input.relationshipIds.some((id) => !safeId(id)))) {
      return invalid("SDK proceduralBake relationshipIds must contain 1..64 safe ids.");
    }
    for (const key of ["startMs", "endMs"] as const) {
      if (input[key] !== undefined && !nonNegative(input[key])) {
        return invalid(`SDK proceduralBake ${key} must be a non-negative finite number.`);
      }
    }
    if (typeof input.startMs === "number" && typeof input.endMs === "number" && input.startMs > input.endMs) {
      return invalid("SDK proceduralBake startMs must not exceed endMs.");
    }
    if (input.sampleEveryFrames !== undefined && !integerInRange(input.sampleEveryFrames, 1, 120)) {
      return invalid("SDK proceduralBake sampleEveryFrames must be an integer from 1 to 120.");
    }
  }
  return null;
}

export function validateProceduralOutput(
  operation: MotionSdkOperation,
  output: Record<string, unknown>,
  requestInput: unknown,
): MotionSdkError | null {
  if (!isProceduralOperation(operation)) return null;
  const request = plainRecord(requestInput);
  const expectedRoot = operation === "proceduralInspect" ? request?.packageRoot : request?.outDir;
  const expectedAtMs = operation === "proceduralInspect" ? request?.atMs : undefined;
  if (!request || output.packageRoot !== expectedRoot || !validState(output.state, expectedAtMs)) {
    return invalidTransport(`SDK ${operation} output requires matching package and procedural state.`);
  }
  if (operation === "proceduralInspect") return null;
  const expectedOperation = sdkReceiptOperation(operation);
  const receipt = plainRecord(output.receipt);
  const pkg = plainRecord(output.package);
  if (!expectedOperation
    || output.operation !== expectedOperation
    || !pkg
    || !boundedStringArray(output.changedPaths, 192, 384)
    || !nonEmpty(output.receiptPath)
    || !receipt
    || receipt.schema !== "shellx-motion/receipt@1"
    || receipt.operation !== expectedOperation
    || receipt.packageId !== pkg.packageId
    || receipt.status !== "passed"
    || !nonEmpty(receipt.id)
    || receipt.path !== output.receiptPath
    || !sha256(receipt.sha256)) {
    return invalidTransport(`SDK ${operation} output requires matching mutation and receipt evidence.`);
  }
  if (operation === "proceduralBake" && !validBake(output.bake)) {
    return invalidTransport("SDK proceduralBake output requires bounded bake evidence.");
  }
  if (operation === "proceduralAudioEnvelopeProduce" && !hasMatchingProceduralAudioEnvelopeEvidence(output.envelope, request)) {
    return invalidTransport("SDK proceduralAudioEnvelopeProduce output requires matching bounded envelope evidence.");
  }
  if (operation !== "proceduralBake" && output.bake !== undefined) {
    return invalidTransport(`SDK ${operation} output must not include bake evidence.`);
  }
  if (operation !== "proceduralAudioEnvelopeProduce" && output.envelope !== undefined) {
    return invalidTransport(`SDK ${operation} output must not include audio-envelope evidence.`);
  }
  if (!validProceduralMutationSemantics(operation, request, output)) {
    return invalidTransport(`SDK ${operation} output does not match the requested relationship mutation.`);
  }
  return null;
}

function validState(value: unknown, expectedAtMs: unknown): boolean {
  const state = plainRecord(value);
  if (!state || !Array.isArray(state.relationships)) return false;
  if (state.graph === null) {
    return state.relationships.length === 0
      && state.validation === null
      && state.fingerprint === null
      && state.evaluation === null;
  }
  const graph = plainRecord(state.graph);
  if (!graph) return false;
  const validation = validateStandaloneGraph(graph);
  const reported = plainRecord(state.validation);
  if (!validation.ok
    || !reported
    || reported.ok !== true
    || !sameCanonical(reported, validation)
    || state.fingerprint !== safeGraphFingerprint(graph)) return false;
  const relations = Array.isArray(graph.relationships) ? graph.relationships : [];
  if (state.relationships.length !== relations.length) return false;
  for (let index = 0; index < relations.length; index += 1) {
    if (!validSummary(state.relationships[index], relations[index])) return false;
  }
  return expectedAtMs === undefined
    ? state.evaluation === null
    : validEvaluation(state.evaluation, relations, expectedAtMs);
}

function validSummary(value: unknown, relationshipValue: unknown): boolean {
  const summary = plainRecord(value);
  const relationship = plainRecord(relationshipValue);
  const nodes = Array.isArray(relationship?.nodes) ? relationship.nodes : [];
  if (!summary || !relationship
    || summary.id !== relationship.id
    || summary.enabled !== relationship.enabled
    || JSON.stringify(summary.target) !== JSON.stringify(relationship.target)
    || summary.nodeCount !== nodes.length
    || summary.outputNodeId !== relationship.outputNodeId
    || !Array.isArray(summary.sources)
    || !boundedStringArray(summary.audioEnvelopeIds, 64, 128)) return false;
  const expectedSources = nodes
    .map(plainRecord)
    .filter((node) => node?.type === "property")
    .map((node) => node?.ref);
  const expectedEnvelopeIds = nodes
    .map(plainRecord)
    .filter((node) => node?.type === "audio-envelope")
    .map((node) => node?.envelopeId);
  return sameCanonical(summary.sources, expectedSources)
    && sameCanonical(summary.audioEnvelopeIds, expectedEnvelopeIds);
}

function validEvaluation(value: unknown, relations: unknown[], expectedAtMs: unknown): boolean {
  const evaluation = plainRecord(value);
  const values = plainRecord(evaluation?.values);
  return Boolean(evaluation
    && nonNegative(evaluation.atMs)
    && evaluation.atMs === expectedAtMs
    && values
    && Object.keys(values).every((key) => relations.some((item) => plainRecord(item)?.id === key))
    && Object.values(values).every((item) => typeof item === "number" && Number.isFinite(item)));
}

function validBake(value: unknown): boolean {
  const bake = plainRecord(value);
  return Boolean(bake
    && Array.isArray(bake.relationshipIds)
    && bake.relationshipIds.length > 0
    && bake.relationshipIds.length <= 64
    && bake.relationshipIds.every(safeId)
    && positiveInteger(bake.sampleCount)
    && bake.keyframeCount === Number(bake.sampleCount) * bake.relationshipIds.length
    && sha256(bake.fingerprint));
}

/**
 * Check one relationship on its own, with the document context it needs invented around it.
 * `attributePreflightIssues` keeps the refusal about what the caller sent rather than about the
 * invented half — see `procedural-preflight-context.ts`, which also records why this check is not
 * the authority on whether a named envelope exists.
 */
function validateStandaloneRelationship(value: unknown) {
  const relationship = plainRecord(value);
  const graph = {
    schema: "shellx-motion/procedural-relationships@1",
    relationships: [value],
    ...placeholderEnvelopes([value]),
  };
  return attributePreflightIssues(relationship
    ? validateStandaloneGraph(graph)
    : validateMotionProceduralGraph(graph, { durationMs: 1_000, fps: 30, layers: [] }));
}

function validateStandaloneGraph(value: unknown) {
  const graph = plainRecord(value);
  const relationships = Array.isArray(graph?.relationships) ? graph.relationships : [];
  const refs = relationships.flatMap((candidate) => {
    const relationship = plainRecord(candidate);
    const nodes = Array.isArray(relationship?.nodes) ? relationship.nodes : [];
    return [relationship?.target, ...nodes.map(plainRecord).filter((node) => node?.type === "property").map((node) => node?.ref)];
  });
  const layers = placeholderLayers(refs, Array.isArray(graph?.audioEnvelopes) ? graph.audioEnvelopes : []);
  return validateMotionProceduralGraph(value, { durationMs: standaloneDuration(graph), fps: 30, layers });
}

function standaloneDuration(graph: Record<string, unknown> | null): number {
  const envelopes = Array.isArray(graph?.audioEnvelopes) ? graph.audioEnvelopes : [];
  const times = envelopes.flatMap((entry) => {
    const record = plainRecord(entry);
    const samples = Array.isArray(record?.samples) ? record.samples : [];
    return samples
      .map((sample) => plainRecord(sample)?.atMs)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  });
  return Math.max(1_000, ...times);
}

function placeholderLayers(refs: unknown[], envelopes: unknown[]): Array<Record<string, unknown> & { id: string }> {
  const layers = new Map<string, Record<string, unknown> & { id: string }>();
  for (const value of [...refs, ...envelopes.map((entry) => ({ layerId: plainRecord(entry)?.sourceLayerId }))]) {
    const ref = plainRecord(value);
    if (!safeId(ref?.layerId)) continue;
    const layer = layers.get(String(ref!.layerId)) ?? { id: String(ref!.layerId), type: "shape" };
    if (typeof ref?.property === "string") writePath(layer, ref.property, 0);
    layers.set(layer.id, layer);
  }
  return [...layers.values()];
}

/**
 * Invent one envelope record per envelope id the relationship names, so a relationship driven by
 * audio can be checked for shape without the document that owns the real envelopes. Not a runtime
 * and not data anyone renders. Renamed from `fakeEnvelopes` : "fake" reads as a
 * simulated runtime in a codebase that just removed one; this is placeholder context, like
 * `placeholderLayers`. */
function placeholderEnvelopes(relationships: unknown[]) {
  const ids = relationships.flatMap((candidate) => {
    const relationship = plainRecord(candidate);
    const nodes = Array.isArray(relationship?.nodes) ? relationship.nodes : [];
    return nodes.map(plainRecord).filter((node) => node?.type === "audio-envelope" && safeId(node.envelopeId)).map((node) => String(node!.envelopeId));
  });
  if (!ids.length) return {};
  const first = plainRecord(relationships[0]);
  const target = plainRecord(first?.target);
  return {
    audioEnvelopes: [...new Set(ids)].map((id) => ({
      id,
      sourceLayerId: String(target?.layerId ?? "source"),
      channel: "mix" as const,
      samples: [{ atMs: 0, value: 0 }],
    })),
  };
}

function writePath(target: Record<string, unknown>, property: string, value: number): void {
  let current = target;
  for (const part of property.split(".").slice(0, -1)) {
    const next = plainRecord(current[part]) ?? {};
    current[part] = next;
    current = next;
  }
  current[property.split(".").at(-1)!] = value;
}

function sdkReceiptOperation(operation: MotionSdkOperation): string | null {
  if (operation === "proceduralSet") return "procedural.relationship.set";
  if (operation === "proceduralSetEnabled") return "procedural.relationship.enabled.set";
  if (operation === "proceduralBake") return "procedural.relationship.bake";
  if (operation === "proceduralDetach") return "procedural.relationship.detach";
  if (operation === "proceduralAudioEnvelopeProduce") return "procedural.audio-envelope.produce";
  return null;
}

function safeGraphFingerprint(value: unknown): string | null {
  try {
    return proceduralRelationshipGraphFingerprint(value as MotionProceduralGraph);
  } catch {
    return null;
  }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  return (prototype === Object.prototype || prototype === null)
    && descriptors.every((descriptor) => "value" in descriptor)
    ? value as Record<string, unknown>
    : null;
}
function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
function nonEmpty(value: unknown): boolean { return typeof value === "string" && value.trim().length > 0; }
function nonNegative(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function positiveInteger(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function integerInRange(value: unknown, min: number, max: number): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max; }
function sha256(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function boundedStringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length <= maxLength);
}
function invalid(message: string): MotionSdkError { return { code: "invalid_request", message, retryable: false }; }
function invalidTransport(message: string): MotionSdkError { return { code: "invalid_transport_response", message, retryable: false }; }
