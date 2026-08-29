/**
 * Host-owned trust vocabulary for the deliberately narrow package-script route.
 *
 * A package may retain its requested mode as portable metadata, but this module never treats that
 * claim (or `createdBy`, sourceApp, a path, or a package-local receipt) as permission to execute.
 * The renderer asks a host-injected authority to resolve it against durable host state.
 */
import { isAbsolute, resolve } from "node:path";
import type { MotionDocument, MotionLayer, MotionPackage } from "./types";
import { AgentScriptProvenanceRefusal, canonicalPackageRoot } from "./agent-script-provenance-root";
import {
  AGENT_SCRIPT_PROVENANCE_MAX_BYTES,
  AGENT_SCRIPT_PROVENANCE_MAX_FILES,
  fingerprintAgentScriptPackage,
  readVerifiedPackageRegularFile,
} from "./agent-script-provenance-fingerprint";

export { AGENT_SCRIPT_PROVENANCE_MAX_BYTES, AGENT_SCRIPT_PROVENANCE_MAX_FILES, fingerprintAgentScriptPackage };
export { AgentScriptProvenanceRefusal, canonicalPackageRoot } from "./agent-script-provenance-root";

export const AGENT_SCRIPT_EXECUTION_EXTENSION = "x-shellx-motion-script-execution";
/** Package-local request vocabulary. It is never an attestation or permission grant. */
export const AGENT_SCRIPT_EXECUTION_REQUEST_SCHEMA = "shellx-motion/script-execution-request@1";
export const AGENT_SCRIPT_PROVENANCE_SCHEMA = "shellx-motion/approved-agent-script-provenance@1";
export const AGENT_SCRIPT_RESOLVER_VERSION = 1;
export const APPROVED_AGENT_SCRIPT_MODE = "trusted-local-agent-authored" as const;

export type ActiveScriptLayerType = "web" | "html" | "canvas";
export type AgentScriptRequestedMode = typeof APPROVED_AGENT_SCRIPT_MODE | "none" | "unrecognized";
export type AgentScriptActiveMode = "data-only" | typeof APPROVED_AGENT_SCRIPT_MODE;

export interface ActiveScriptSource {
  layerId: string;
  layerType: ActiveScriptLayerType;
  path: string;
  sha256: string;
  bytes: number;
}

export interface AgentScriptExecutionEvidence {
  schema: "shellx-motion/script-execution@1";
  detectedClass: "data-only" | "active-content";
  requestedMode: AgentScriptRequestedMode;
  activeMode: AgentScriptActiveMode;
  resolverVersion: number;
  packageSnapshotSha256?: string;
  attestationId?: string;
  sources: ActiveScriptSource[];
  /** The one attested source pinned as this browser session's executable entry. */
  entry?: ActiveScriptSource;
}

export interface AgentScriptAttestation {
  schema: typeof AGENT_SCRIPT_PROVENANCE_SCHEMA;
  resolverVersion: number;
  /** Non-secret evidence identifier. It is never accepted as a bearer capability. */
  attestationId: string;
  packageId: string;
  /** Lossless decimal filesystem identity. Numeric Node stats can exceed 2^53 on Windows. */
  packageRootIdentity: { dev: string; ino: string };
  packageSnapshotSha256: string;
  sources: ActiveScriptSource[];
  createdAt: string;
}

export interface ResolvedAgentScriptPackage {
  package: MotionPackage;
  evidence: AgentScriptExecutionEvidence;
  /** Deletes a private immutable session snapshot. It is safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Opaque host capability. It is deliberately configured by a trusted embedding host, never
 * serialized into package data or accepted by Debug/MCP/SDK/CLI request arguments.
 */
export interface AgentScriptProvenanceAuthority {
  readonly resolverVersion: number;
  /** The authority, not the caller, mints the evidence id and timestamp. */
  mint(input: { package: MotionPackage }): Promise<AgentScriptAttestation>;
  resolve(packageToResolve: MotionPackage): Promise<ResolvedAgentScriptPackage>;
  /** Host-only revocation. No agent-facing command may invoke it. */
  revoke(attestationId: string): Promise<void>;
  /** Host-owned receipt persistence under the authority's configured private root. */
  writeReceipt(receipt: unknown): Promise<string>;
}

export function activeScriptLayers(motion: Pick<MotionDocument, "layers">): MotionLayer[] {
  return motion.layers.filter((layer) => isActiveScriptLayerType(layer.type));
}

export function isActiveScriptLayerType(value: unknown): value is ActiveScriptLayerType {
  return value === "web" || value === "html" || value === "canvas";
}

/** Read a portable request as evidence only; a resolver independently verifies every active layer. */
export function requestedAgentScriptMode(motion: MotionDocument): AgentScriptRequestedMode {
  const record = (motion as unknown as Record<string, unknown>)[AGENT_SCRIPT_EXECUTION_EXTENSION];
  if (!record || typeof record !== "object" || Array.isArray(record)) return "none";
  const requested = record as Record<string, unknown>;
  const requestedMode = requested.requestedMode;
  if (requested.schema !== AGENT_SCRIPT_EXECUTION_REQUEST_SCHEMA) return "unrecognized";
  return requestedMode === APPROVED_AGENT_SCRIPT_MODE ? APPROVED_AGENT_SCRIPT_MODE : "unrecognized";
}

/**
 * Hash the exact package-local active sources a renderer would execute. This is intentionally
 * independent of package provenance fields. A symlink, remote reference, duplicate source, or
 * missing source is a fail-closed provenance refusal rather than a best-effort warning.
 */
export async function describeActiveScriptSources(pkg: MotionPackage): Promise<ActiveScriptSource[]> {
  const canonicalRoot = await canonicalPackageRoot(pkg.root);
  const active = activeScriptLayers(pkg.motion);
  if (active.length > AGENT_SCRIPT_PROVENANCE_MAX_FILES) {
    throw new AgentScriptProvenanceRefusal("Active script package exceeds the provenance snapshot budget.", { fileCount: active.length, totalBytes: 0 });
  }
  const seen = new Set<string>();
  const sources: ActiveScriptSource[] = [];
  let totalBytes = 0;
  for (const layer of active) {
    const source = typeof layer.source === "string" ? layer.source : "";
    if (!source || isAbsolute(source) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source)) {
      throw new AgentScriptProvenanceRefusal(
        `Active script layer ${layer.id} must name one package-relative source file.`,
        { layerId: layer.id }
      );
    }
    const normalized = source.replaceAll("\\", "/");
    if (!safePackageRelativePath(normalized)) {
      throw new AgentScriptProvenanceRefusal(
        `Active script layer ${layer.id} must name a simple package-relative source file.`,
        { layerId: layer.id }
      );
    }
    if (seen.has(normalized)) {
      throw new AgentScriptProvenanceRefusal(
        `Active script source ${normalized} is referenced by more than one layer.`,
        { source: normalized }
      );
    }
    seen.add(normalized);
    const path = resolve(canonicalRoot, normalized);
    const file = await readVerifiedPackageRegularFile(
      canonicalRoot,
      path,
      normalized,
      AGENT_SCRIPT_PROVENANCE_MAX_BYTES - totalBytes
    );
    totalBytes += file.byteLength;
    sources.push({
      layerId: layer.id,
      layerType: layer.type as ActiveScriptLayerType,
      path: normalized,
      sha256: file.sha256,
      bytes: file.byteLength
    });
  }
  return sources.sort(compareSources);
}

export function agentScriptExecutionEvidenceForDataOnly(motion: MotionDocument): AgentScriptExecutionEvidence {
  return {
    schema: "shellx-motion/script-execution@1",
    detectedClass: "data-only",
    requestedMode: requestedAgentScriptMode(motion),
    activeMode: "data-only",
    resolverVersion: AGENT_SCRIPT_RESOLVER_VERSION,
    sources: []
  };
}

function safePackageRelativePath(value: string): boolean {
  return value.length > 0
    && value.length <= 1024
    && !value.includes("\0")
    && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function compareSources(left: ActiveScriptSource, right: ActiveScriptSource): number {
  if (left.layerId < right.layerId) return -1;
  if (left.layerId > right.layerId) return 1;
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}
