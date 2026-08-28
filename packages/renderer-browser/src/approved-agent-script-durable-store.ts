/** Bounded durable attestation and host-receipt records for the private provenance state root. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AGENT_SCRIPT_PROVENANCE_SCHEMA,
  AGENT_SCRIPT_RESOLVER_VERSION,
  AgentScriptProvenanceRefusal,
  type ActiveScriptSource,
  type AgentScriptAttestation,
} from "@shellx-motion/core";
import {
  assertPrivateDirectoryBudget,
  atomicWritePrivateFile,
  privateReceiptDirectory,
  readPrivateRegularFile,
} from "./approved-agent-script-private-fs";

const STORE_SCHEMA = "shellx-motion/approved-agent-script-store@1" as const;
const MAX_ATTESTATIONS = 256;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_RECEIPTS = 2_048;
const MAX_RECEIPT_BYTES = 1024 * 1024;

export interface DurableAgentScriptStore {
  schema: typeof STORE_SCHEMA;
  resolverVersion: number;
  attestations: AgentScriptAttestation[];
}

export async function readDurableAgentScriptStore(stateRoot: string): Promise<DurableAgentScriptStore> {
  const path = join(stateRoot, "attestations.json");
  let text: string;
  try {
    text = await readPrivateRegularFile(path, MAX_STORE_BYTES);
  } catch (error) {
    if (isCode(error, "ENOENT")) return { schema: STORE_SCHEMA, resolverVersion: AGENT_SCRIPT_RESOLVER_VERSION, attestations: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry attestation store is not valid JSON.");
  }
  const record = readRecord(parsed);
  if (record?.schema !== STORE_SCHEMA || record.resolverVersion !== AGENT_SCRIPT_RESOLVER_VERSION || !Array.isArray(record.attestations)) {
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry attestation store has an unsupported schema.");
  }
  if (record.attestations.length > MAX_ATTESTATIONS) throw new AgentScriptProvenanceRefusal("Approved-agent-entry attestation store exceeds its bounded entry limit.");
  const attestations = record.attestations.map(parseAttestation);
  if (new Set(attestations.map((entry) => entry.attestationId)).size !== attestations.length) {
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry attestation store contains duplicate evidence ids.");
  }
  return { schema: STORE_SCHEMA, resolverVersion: AGENT_SCRIPT_RESOLVER_VERSION, attestations };
}

export async function writeDurableAgentScriptStore(stateRoot: string, store: DurableAgentScriptStore): Promise<void> {
  if (store.attestations.length > MAX_ATTESTATIONS) throw new AgentScriptProvenanceRefusal("Approved-agent-entry attestation store exceeds its bounded entry limit.");
  await atomicWritePrivateFile(join(stateRoot, "attestations.json"), stringifyBounded(store, MAX_STORE_BYTES, "Approved-agent-entry attestation store"));
}

export async function writeDurableAgentScriptReceipt(stateRoot: string, receipt: unknown): Promise<string> {
  const text = stringifyBounded(receipt, MAX_RECEIPT_BYTES, "Approved-agent-entry host receipt");
  const receiptsRoot = await privateReceiptDirectory(stateRoot);
  await assertPrivateDirectoryBudget(receiptsRoot, MAX_RECEIPTS, "Approved-agent-entry host receipt store");
  const parsed = readRecord(receipt);
  const suppliedId = typeof parsed?.id === "string" && safeAttestationId(parsed.id) ? parsed.id : randomUUID();
  const receiptPath = join(receiptsRoot, `${suppliedId}.receipt.json`);
  await atomicWritePrivateFile(receiptPath, text);
  return receiptPath;
}

function parseAttestation(value: unknown): AgentScriptAttestation {
  const record = readRecord(value);
  const identity = readRecord(record?.packageRootIdentity);
  if (!record || !identity || record.schema !== AGENT_SCRIPT_PROVENANCE_SCHEMA || record.resolverVersion !== AGENT_SCRIPT_RESOLVER_VERSION
    || !safeAttestationId(record.attestationId) || !safePackageId(record.packageId) || !safeUnsignedIdentity(identity.dev)
    || !safeUnsignedIdentity(identity.ino) || !sha256(record.packageSnapshotSha256) || typeof record.createdAt !== "string"
    || Number.isNaN(new Date(record.createdAt).getTime()) || !Array.isArray(record.sources)) {
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry attestation store contains an invalid entry.");
  }
  const sources = record.sources.map(parseSource).sort(compareSources);
  if (sources.length === 0 || sources.length !== new Set(sources.map((source) => source.layerId)).size) {
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry attestation has invalid active source evidence.");
  }
  return { schema: AGENT_SCRIPT_PROVENANCE_SCHEMA, resolverVersion: AGENT_SCRIPT_RESOLVER_VERSION, attestationId: record.attestationId,
    packageId: record.packageId, packageRootIdentity: { dev: identity.dev, ino: identity.ino }, packageSnapshotSha256: record.packageSnapshotSha256,
    sources, createdAt: record.createdAt };
}

function parseSource(value: unknown): ActiveScriptSource {
  const record = readRecord(value);
  if (!record || !safeLayerId(record.layerId) || (record.layerType !== "web" && record.layerType !== "html" && record.layerType !== "canvas")
    || typeof record.path !== "string" || !safePackageRelativePath(record.path) || !sha256(record.sha256) || !finiteNonNegative(record.bytes)) {
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry attestation contains an invalid active source descriptor.");
  }
  return { layerId: record.layerId, layerType: record.layerType, path: record.path, sha256: record.sha256, bytes: record.bytes };
}

function stringifyBounded(value: unknown, maximumBytes: number, label: string): string {
  let text: string;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    throw new AgentScriptProvenanceRefusal(`${label} must be JSON-serializable.`);
  }
  if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new AgentScriptProvenanceRefusal(`${label} exceeds its bounded size.`);
  return text;
}

function safeAttestationId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value); }
function safeLayerId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
function safePackageId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256; }
function safeUnsignedIdentity(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value)
    && BigInt(value) <= 18_446_744_073_709_551_615n;
}
function safePackageRelativePath(value: string): boolean { return !value.startsWith("/") && value.length > 0 && value.length <= 1024 && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value); }
function sha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function finiteNonNegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function readRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function compareSources(left: ActiveScriptSource, right: ActiveScriptSource): number { return left.layerId < right.layerId ? -1 : left.layerId > right.layerId ? 1 : left.path < right.path ? -1 : left.path > right.path ? 1 : 0; }
function isCode(error: unknown, code: string): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code); }
