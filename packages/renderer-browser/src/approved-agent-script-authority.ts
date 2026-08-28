/**
 * Durable, host-owned resolver for the narrow approved-agent-entry script route.
 *
 * The authority is intentionally not a package feature and it has no wire representation. A host
 * constructs it with a private state root, while the renderer receives only this opaque object.
 * An attestation id is audit evidence, never a password or a capability.
 */
import { randomUUID } from "node:crypto";
import { cp, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  AGENT_SCRIPT_PROVENANCE_SCHEMA,
  AGENT_SCRIPT_RESOLVER_VERSION,
  APPROVED_AGENT_SCRIPT_MODE,
  AgentScriptProvenanceRefusal,
  activeScriptLayers,
  canonicalPackageRoot,
  describeActiveScriptSources,
  fingerprintAgentScriptPackage,
  loadMotionPackage,
  requestedAgentScriptMode,
  type AgentScriptAttestation,
  type AgentScriptProvenanceAuthority,
  type MotionPackage,
} from "@shellx-motion/core";
import { readDurableAgentScriptStore, writeDurableAgentScriptReceipt, writeDurableAgentScriptStore } from "./approved-agent-script-durable-store";
import { createPrivateSessionDirectory, withPrivateStateLock } from "./approved-agent-script-private-fs";
import {
  agentScriptExecutionEvidence,
  captureAgentScriptPackageState,
  dataOnlyAgentScriptResolution,
  onceAsync,
  sameAgentScriptSources,
  sameAgentScriptPackageState,
} from "./approved-agent-script-package-state";

export interface ApprovedAgentScriptAuthorityOptions {
  /**
   * Absolute, private host configuration directory. It is never inferred from a package path and
   * must not be inside a package the authority resolves.
   */
  stateRoot: string;
  now?: () => Date;
}

/**
 * Create the sole built-in authority accepted by the browser renderer. Construction is a trusted
 * host concern; Debug/MCP/SDK/CLI request arguments never carry this option.
 */
export function createApprovedAgentScriptProvenanceAuthority(
  options: ApprovedAgentScriptAuthorityOptions
): AgentScriptProvenanceAuthority {
  if (!isAbsolute(options.stateRoot)) {
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry stateRoot must be an absolute host path.");
  }
  const configuredStateRoot = resolve(options.stateRoot);
  const now = options.now ?? (() => new Date());

  return {
    resolverVersion: AGENT_SCRIPT_RESOLVER_VERSION,
    async mint(input) {
      return await withPrivateStateLock(configuredStateRoot, async (stateRoot) => {
        await assertPackageOutsideStateRoot(input.package.root, stateRoot);
        if (activeScriptLayers(input.package.motion).length === 0) {
          throw new AgentScriptProvenanceRefusal("Approved-agent-entry provenance requires an active web, html, or canvas layer.");
        }
        if (requestedAgentScriptMode(input.package.motion) !== APPROVED_AGENT_SCRIPT_MODE) {
          throw new AgentScriptProvenanceRefusal("Package did not request approved-agent-entry script execution.");
        }
        const before = await captureAgentScriptPackageState(input.package);
        const store = await readDurableAgentScriptStore(stateRoot);
        if (store.attestations.length >= 256) {
          throw new AgentScriptProvenanceRefusal("Approved-agent-entry attestation store is full; an operator must revoke entries first.");
        }
        const attestationId = randomUUID();
        const createdAt = now();
        const attestation: AgentScriptAttestation = {
          schema: AGENT_SCRIPT_PROVENANCE_SCHEMA,
          resolverVersion: AGENT_SCRIPT_RESOLVER_VERSION,
          attestationId,
          packageId: input.package.manifest.id,
          packageRootIdentity: before.rootIdentity,
          packageSnapshotSha256: before.packageSnapshotSha256,
          sources: before.sources,
          createdAt: createdAt.toISOString()
        };
        const after = await captureAgentScriptPackageState(input.package);
        if (!sameAgentScriptPackageState(before, after)) {
          throw new AgentScriptProvenanceRefusal("Package changed while approved-agent-entry provenance was being minted.");
        }
        await writeDurableAgentScriptStore(stateRoot, { ...store, attestations: [...store.attestations, attestation] });
        return attestation;
      });
    },
    async resolve(packageToResolve) {
      return await withPrivateStateLock(configuredStateRoot, async (stateRoot) => {
        await assertPackageOutsideStateRoot(packageToResolve.root, stateRoot);
        const active = activeScriptLayers(packageToResolve.motion);
        if (active.length === 0) {
          return dataOnlyAgentScriptResolution(packageToResolve);
        }
        if (requestedAgentScriptMode(packageToResolve.motion) !== APPROVED_AGENT_SCRIPT_MODE) {
          throw new AgentScriptProvenanceRefusal("Active package scripts are disabled unless the package requests approved-agent-entry provenance.");
        }
        const store = await readDurableAgentScriptStore(stateRoot);
        const before = await captureAgentScriptPackageState(packageToResolve);
        const attestation = store.attestations.find((entry) => entry.attestationId.length > 0
          && entry.packageId === packageToResolve.manifest.id
          && sameAgentScriptPackageState(entry, before));
        if (!attestation) {
          throw new AgentScriptProvenanceRefusal(
            "No current host attestation approves this local package's active script entry bytes.",
            { packageId: packageToResolve.manifest.id }
          );
        }
        const sessionDirectory = await createPrivateSessionDirectory(stateRoot);
        const snapshotRoot = join(sessionDirectory, "package");
        try {
          await cp(before.root, snapshotRoot, {
            recursive: true,
            force: false,
            errorOnExist: true,
            preserveTimestamps: true,
            verbatimSymlinks: true
          });
          const after = await captureAgentScriptPackageState(packageToResolve);
          if (!sameAgentScriptPackageState(before, after)) {
            throw new AgentScriptProvenanceRefusal("Package changed while its approved script snapshot was being created.");
          }
          const snapshot = await loadMotionPackage(snapshotRoot);
          const snapshotState = await captureAgentScriptPackageState(snapshot);
          if (snapshotState.packageSnapshotSha256 !== before.packageSnapshotSha256 || !sameAgentScriptSources(snapshotState.sources, before.sources)) {
            throw new AgentScriptProvenanceRefusal("Approved script snapshot did not exactly match the attested package bytes.");
          }
          return {
            package: snapshot,
            evidence: agentScriptExecutionEvidence(before, attestation.attestationId),
            release: onceAsync(async () => { await rm(sessionDirectory, { recursive: true, force: true }); })
          };
        } catch (error) {
          await rm(sessionDirectory, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      });
    },
    async revoke(attestationId) {
      if (!safeAttestationId(attestationId)) {
        throw new AgentScriptProvenanceRefusal("Approved-agent-entry attestation id is not a bounded safe identifier.");
      }
      await withPrivateStateLock(configuredStateRoot, async (stateRoot) => {
        const store = await readDurableAgentScriptStore(stateRoot);
        const remaining = store.attestations.filter((entry) => entry.attestationId !== attestationId);
        if (remaining.length === store.attestations.length) return;
        await writeDurableAgentScriptStore(stateRoot, { ...store, attestations: remaining });
      });
    },
    async writeReceipt(receipt) {
      return await withPrivateStateLock(configuredStateRoot, async (stateRoot) => await writeDurableAgentScriptReceipt(stateRoot, receipt));
    }
  };
}

async function assertPackageOutsideStateRoot(packageRoot: string, stateRoot: string): Promise<void> {
  const canonicalPackage = await canonicalPackageRoot(packageRoot);
  if (isInside(stateRoot, canonicalPackage) || isInside(canonicalPackage, stateRoot)) {
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry private authority state must be separate from the package tree.");
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function safeAttestationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value);
}
