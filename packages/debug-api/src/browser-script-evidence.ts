/** Aggregate browser-script evidence without trusting renderer-provided receipt claims. */
import {
  AGENT_SCRIPT_RESOLVER_VERSION,
  APPROVED_AGENT_SCRIPT_MODE,
  AgentScriptProvenanceRefusal,
  activeScriptLayers,
  type ActiveScriptSource,
  type AgentScriptExecutionEvidence,
  type AgentScriptRequestedMode,
  type MotionPackage,
  type OperationReceipt
} from "@shellx-motion/core";
import type { BrowserFrameResult } from "@shellx-motion/renderer-browser";

export function activeBrowserScripts(pkg: MotionPackage): boolean {
  return activeScriptLayers(pkg.motion).length > 0;
}

export class BrowserScriptEvidenceAccumulator {
  private evidence: AgentScriptExecutionEvidence | undefined;
  private serialized: string | undefined;

  observe(frame: BrowserFrameResult, required: boolean): void {
    const output = ownPlainDataRecord(frame.output);
    const receipt = ownPlainDataRecord(frame.receipt);
    const receiptOutput = ownPlainDataRecord(receipt?.output);
    const rawOutputEvidence = output?.scriptExecution;
    const rawReceiptEvidence = receiptOutput?.scriptExecution;
    if (rawOutputEvidence === undefined && rawReceiptEvidence === undefined && !required && !this.evidence) return;
    const outputEvidence = readScriptEvidence(rawOutputEvidence);
    const receiptEvidence = readScriptEvidence(rawReceiptEvidence);
    if (!outputEvidence || !receiptEvidence) {
      throw refusal("Browser frame omitted its matching session-owned script evidence.");
    }
    const serialized = JSON.stringify(outputEvidence);
    if (serialized !== JSON.stringify(receiptEvidence)) {
      throw refusal("Browser frame output and receipt contradict their script evidence.");
    }
    if (required && outputEvidence.activeMode !== APPROVED_AGENT_SCRIPT_MODE) {
      throw refusal("Active browser content did not carry approved-agent-entry execution evidence.");
    }
    if (this.serialized !== undefined && this.serialized !== serialized) {
      throw refusal("Browser script evidence changed during one multi-frame operation.");
    }
    this.evidence = outputEvidence;
    this.serialized = serialized;
  }

  finish(required: boolean): AgentScriptExecutionEvidence | undefined {
    if (required && !this.evidence) throw refusal("Active browser content produced no script evidence.");
    return this.evidence;
  }
}

export function applyBrowserScriptEvidence(
  receipt: OperationReceipt,
  evidence: AgentScriptExecutionEvidence | undefined
): void {
  if (!evidence) return;
  receipt.output = { ...ownPlainDataRecord(receipt.output), scriptExecution: evidence };
}

function readScriptEvidence(value: unknown): AgentScriptExecutionEvidence | null {
  const record = ownPlainDataRecord(value);
  if (!record || record.schema !== "shellx-motion/script-execution@1"
    || record.resolverVersion !== AGENT_SCRIPT_RESOLVER_VERSION) return null;
  const requestedMode = readRequestedMode(record.requestedMode);
  if (!requestedMode) return null;
  if (record.detectedClass === "data-only") {
    if (record.activeMode !== "data-only" || record.packageSnapshotSha256 !== undefined
      || record.attestationId !== undefined || !Array.isArray(record.sources) || record.sources.length !== 0
      || !hasExactKeys(record, ["schema", "detectedClass", "requestedMode", "activeMode", "resolverVersion", "sources"])) return null;
    return {
      schema: "shellx-motion/script-execution@1", detectedClass: "data-only", requestedMode,
      activeMode: "data-only", resolverVersion: AGENT_SCRIPT_RESOLVER_VERSION, sources: []
    };
  }
  if (record.detectedClass !== "active-content" || requestedMode !== APPROVED_AGENT_SCRIPT_MODE
    || record.activeMode !== APPROVED_AGENT_SCRIPT_MODE || !isSha256(record.packageSnapshotSha256)
    || !isSafeText(record.attestationId, 128) || !hasExactKeys(record, [
      "schema", "detectedClass", "requestedMode", "activeMode", "resolverVersion",
      "packageSnapshotSha256", "attestationId", "sources", "entry"
    ])) return null;
  const sources = readActiveSources(record.sources);
  const entry = sources && readActiveEntry(record.entry, sources);
  if (!entry) return null;
  return {
    schema: "shellx-motion/script-execution@1", detectedClass: "active-content",
    requestedMode: APPROVED_AGENT_SCRIPT_MODE, activeMode: APPROVED_AGENT_SCRIPT_MODE,
    resolverVersion: AGENT_SCRIPT_RESOLVER_VERSION, packageSnapshotSha256: record.packageSnapshotSha256,
    attestationId: record.attestationId, sources, entry
  };
}

function readActiveEntry(value: unknown, sources: ActiveScriptSource[]): ActiveScriptSource | null {
  const entry = ownPlainDataRecord(value);
  if (!entry || !hasExactKeys(entry, ["layerId", "layerType", "path", "sha256", "bytes"])) return null;
  return sources.find((source) => source.layerId === entry.layerId && source.layerType === entry.layerType
    && source.path === entry.path && source.sha256 === entry.sha256 && source.bytes === entry.bytes) ?? null;
}

function readRequestedMode(value: unknown): AgentScriptRequestedMode | null {
  return value === APPROVED_AGENT_SCRIPT_MODE || value === "none" || value === "unrecognized" ? value : null;
}

function readActiveSources(value: unknown): ActiveScriptSource[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4_096) return null;
  const sources: ActiveScriptSource[] = [];
  const layerIds = new Set<string>();
  for (const item of value) {
    const source = ownPlainDataRecord(item);
    if (!source || !hasExactKeys(source, ["layerId", "layerType", "path", "sha256", "bytes"])
      || !isSafeText(source.layerId, 256) || layerIds.has(source.layerId)
      || (source.layerType !== "web" && source.layerType !== "html" && source.layerType !== "canvas")
      || !isSafePackagePath(source.path) || !isSha256(source.sha256)
      || typeof source.bytes !== "number" || !Number.isSafeInteger(source.bytes) || source.bytes < 0) return null;
    layerIds.add(source.layerId);
    sources.push({
      layerId: source.layerId, layerType: source.layerType, path: source.path,
      sha256: source.sha256, bytes: source.bytes
    });
  }
  return sources;
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

function isSafeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isSafePackagePath(value: unknown): value is string {
  return isSafeText(value, 1_024) && !value.startsWith("/")
    && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function ownPlainDataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function refusal(message: string): AgentScriptProvenanceRefusal {
  return new AgentScriptProvenanceRefusal(message);
}
