import {
  APPROVED_AGENT_SCRIPT_MODE,
  describeActiveScriptSources,
  type AgentScriptProvenanceAuthority,
} from "@shellx-motion/core";

/** Trusted-host test seam for renderer cases whose subject is not durable provenance storage. */
export const TEST_APPROVED_AGENT_SCRIPT_AUTHORITY: AgentScriptProvenanceAuthority = {
  resolverVersion: 1,
  async mint() { throw new Error("The renderer test authority does not mint attestations."); },
  async resolve(packageToResolve) {
    return {
      package: packageToResolve,
      evidence: {
        schema: "shellx-motion/script-execution@1",
        detectedClass: "active-content",
        requestedMode: APPROVED_AGENT_SCRIPT_MODE,
        activeMode: APPROVED_AGENT_SCRIPT_MODE,
        resolverVersion: 1,
        packageSnapshotSha256: "a".repeat(64),
        attestationId: "renderer-test-attestation",
        sources: await describeActiveScriptSources(packageToResolve),
      },
      release: async () => undefined,
    };
  },
  async revoke() { throw new Error("The renderer test authority does not revoke attestations."); },
  async writeReceipt() { throw new Error("The renderer test authority does not persist receipts."); },
};
