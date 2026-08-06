/** Runtime request/response guards for typed compositing SDK operations. */
import {
  compositingGraphFingerprint,
  validateMotionCompositingGraph,
  type MotionCompositingGraph,
  type MotionLayer,
} from "@shellx-motion/core";
import type { MotionSdkError, MotionSdkOperation } from "./types.js";

const OPERATIONS = new Set<MotionSdkOperation>([
  "compositingInspect", "compositingSet", "compositingRemove",
]);

export function isCompositingOperation(operation: MotionSdkOperation): boolean {
  return OPERATIONS.has(operation);
}

export function validateCompositingRequest(
  operation: MotionSdkOperation,
  input: Record<string, unknown>,
): MotionSdkError | null {
  if (!isCompositingOperation(operation) || operation !== "compositingSet") return null;
  const validation = validateStandaloneGraph(input.graph);
  if (!validation.ok) {
    const first = validation.issues[0];
    return invalid(`SDK compositingSet ${first?.path ?? "/compositing"}: ${first?.message ?? "graph is invalid"}.`);
  }
  return null;
}

export function validateCompositingOutput(
  operation: MotionSdkOperation,
  output: Record<string, unknown>,
  requestInput: unknown,
): MotionSdkError | null {
  if (!isCompositingOperation(operation)) return null;
  const request = plainRecord(requestInput);
  const state = plainRecord(output.state);
  const expectedRoot = operation === "compositingInspect" ? request?.packageRoot : request?.outDir;
  if (!request || output.packageRoot !== expectedRoot || !validGraphState(state)) {
    return invalidTransport(`SDK ${operation} output requires matching package and graph state.`);
  }
  if (operation === "compositingInspect") return null;
  const expectedOperation = operation === "compositingSet"
    ? "compositing.graph.set"
    : "compositing.graph.remove";
  const receipt = plainRecord(output.receipt);
  const pkg = plainRecord(output.package);
  if (!pkg
    || !boundedStringArray(output.changedPaths, 16, 256)
    || !nonEmpty(output.receiptPath)
    || !receipt
    || receipt.schema !== "shellx-motion/receipt@1"
    || receipt.operation !== expectedOperation
    || receipt.packageId !== pkg.packageId
    || receipt.status !== "passed"
    || !nonEmpty(receipt.id)
    || !sha256(receipt.sha256)) {
    return invalidTransport(`SDK ${operation} output requires matching mutation and receipt evidence.`);
  }
  return null;
}

function validGraphState(state: Record<string, unknown> | null): boolean {
  if (!state || typeof state.compiled !== "boolean") return false;
  if (state.graph === null) {
    return state.compiled === false
      && state.metadata === null
      && state.validation === null
      && state.fingerprint === null;
  }
  const validation = validateStandaloneGraph(state.graph);
  if (!validation.ok) return false;
  const reported = plainRecord(state.validation);
  const metadata = state.metadata === null ? null : plainRecord(state.metadata);
  const fingerprint = compositingGraphFingerprint(state.graph as MotionCompositingGraph);
  if (!reported
    || typeof reported.ok !== "boolean"
    || !Array.isArray(reported.issues)
    || reported.issues.length > 256
    || state.fingerprint !== fingerprint
    || state.compiled !== Boolean(metadata)) return false;
  if (!metadata) return true;
  const graph = state.graph as MotionCompositingGraph;
  return metadata.schema === "shellx-motion/compositing-compile@1"
    && metadata.graphId === graph.id
    && metadata.fingerprint === fingerprint
    && boundedStringArray(metadata.nodeOrder, 64, 64)
    && boundedStringArray(metadata.sourceLayerIds, 64, 256)
    && boundedStringArray(metadata.outputLayerIds, 128, 256)
    && Boolean(plainRecord(metadata.estimate));
}

function validateStandaloneGraph(value: unknown) {
  const graph = plainRecord(value);
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const layers = nodes.flatMap((node) => {
    const candidate = plainRecord(node);
    return candidate?.type === "source" && safeId(candidate.layerId)
      ? [placeholderLayer(candidate.layerId)]
      : [];
  });
  return validateMotionCompositingGraph(value, { width: 1, height: 1, layers });
}

function placeholderLayer(id: string): MotionLayer {
  return {
    id,
    type: "shape",
    shape: "rectangle",
    startMs: 0,
    durationMs: 1,
    width: 1,
    height: 1,
    fill: "#ffffff",
  };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  return descriptors.every((descriptor) => "value" in descriptor)
    ? value as Record<string, unknown>
    : null;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function boundedStringArray(value: unknown, maxItems: number, maxLength: number): boolean {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((item) => typeof item === "string" && item.length <= maxLength);
}

function invalid(message: string): MotionSdkError {
  return { code: "invalid_request", message, retryable: false };
}

function invalidTransport(message: string): MotionSdkError {
  return { code: "invalid_transport_response", message, retryable: false };
}
