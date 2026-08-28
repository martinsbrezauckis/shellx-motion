/** Package-state capture and receipt evidence for the approved-agent-entry authority. */
import { lstat } from "node:fs/promises";
import {
  AGENT_SCRIPT_RESOLVER_VERSION,
  APPROVED_AGENT_SCRIPT_MODE,
  AgentScriptProvenanceRefusal,
  canonicalPackageRoot,
  describeActiveScriptSources,
  fingerprintAgentScriptPackage,
  requestedAgentScriptMode,
  type ActiveScriptSource,
  type AgentScriptAttestation,
  type AgentScriptExecutionEvidence,
  type MotionPackage,
  type ResolvedAgentScriptPackage,
} from "@shellx-motion/core";

export interface PackageState {
  root: string;
  rootIdentity: { dev: string; ino: string };
  packageId: string;
  packageSnapshotSha256: string;
  sources: ActiveScriptSource[];
}

export async function captureAgentScriptPackageState(pkg: MotionPackage): Promise<PackageState> {
  const root = await canonicalPackageRoot(pkg.root);
  const rootBefore = await lstat(root, { bigint: true });
  const [packageSnapshotSha256, sources] = await Promise.all([
    fingerprintAgentScriptPackage(root),
    describeActiveScriptSources({ ...pkg, root })
  ]);
  const rootAfter = await lstat(root, { bigint: true });
  if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink() || rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino) {
    throw new AgentScriptProvenanceRefusal("Package root changed while approved-agent-entry provenance was being verified.");
  }
  return {
    root,
    rootIdentity: { dev: rootBefore.dev.toString(10), ino: rootBefore.ino.toString(10) },
    packageId: pkg.manifest.id,
    packageSnapshotSha256,
    sources
  };
}

export function sameAgentScriptPackageState(
  left: Pick<AgentScriptAttestation, "packageId" | "packageRootIdentity" | "packageSnapshotSha256" | "sources"> | PackageState,
  right: PackageState
): boolean {
  const identity = "rootIdentity" in left ? left.rootIdentity : left.packageRootIdentity;
  return left.packageId === right.packageId && identity.dev === right.rootIdentity.dev && identity.ino === right.rootIdentity.ino
    && left.packageSnapshotSha256 === right.packageSnapshotSha256 && sameSources(left.sources, right.sources);
}

export function sameAgentScriptSources(left: ActiveScriptSource[], right: ActiveScriptSource[]): boolean {
  return sameSources(left, right);
}

export function agentScriptExecutionEvidence(state: PackageState, attestationId: string): AgentScriptExecutionEvidence {
  return {
    schema: "shellx-motion/script-execution@1",
    detectedClass: "active-content",
    requestedMode: APPROVED_AGENT_SCRIPT_MODE,
    activeMode: APPROVED_AGENT_SCRIPT_MODE,
    resolverVersion: AGENT_SCRIPT_RESOLVER_VERSION,
    packageSnapshotSha256: state.packageSnapshotSha256,
    attestationId,
    sources: state.sources
  };
}

export function dataOnlyAgentScriptResolution(pkg: MotionPackage): ResolvedAgentScriptPackage {
  return {
    package: pkg,
    evidence: {
      schema: "shellx-motion/script-execution@1",
      detectedClass: "data-only",
      requestedMode: requestedAgentScriptMode(pkg.motion),
      activeMode: "data-only",
      resolverVersion: AGENT_SCRIPT_RESOLVER_VERSION,
      sources: []
    },
    release: async () => undefined
  };
}

export function onceAsync(operation: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= operation();
    return pending;
  };
}

function sameSources(left: ActiveScriptSource[], right: ActiveScriptSource[]): boolean {
  return left.length === right.length && left.every((source, index) => {
    const other = right[index];
    return Boolean(other) && source.layerId === other.layerId && source.layerType === other.layerType
      && source.path === other.path && source.sha256 === other.sha256 && source.bytes === other.bytes;
  });
}
