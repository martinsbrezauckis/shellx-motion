import { describe, expect, it } from "vitest";
import { gpuFinalEffectModuleReceiptInputHashes } from "./gpu-final-effect-module-evidence.js";

describe("GPU final governed effect-module evidence", () => {
  it("leaves the no-module receipt identity byte shape empty and rejects injected module evidence", () => {
    const producer = { frameLane: "gpu", evidence: { provenance: { staticPlan: {} } } } as never;
    expect(gpuFinalEffectModuleReceiptInputHashes(producer, undefined)).toEqual({});
    expect(gpuFinalEffectModuleReceiptInputHashes({
      frameLane: "gpu",
      evidence: { provenance: { staticPlan: {} }, effectModules: { schema: "shellx-motion/gpu-effect-module-streaming-use@1" } }
    } as never, undefined)).toBeUndefined();
  });

  it("refuses forged descriptor, released-ledger, and resource structures before receipt projection", () => {
    const forgedEvidence = {
      provenance: {
        pipelineCatalog: { sha256: "a".repeat(64) },
        staticPlan: { fingerprint: "b".repeat(64), canonicalFrameCount: 1, effectModules: [{ layerId: "forged" }] },
        resourceBudget: { maxima: { effectModuleCount: 1, effectModuleUniformBytes: 160, effectModuleTextureLoadCount: 2, effectModulePassCount: 1 } }
      },
      effectModules: {
        schema: "shellx-motion/gpu-effect-module-streaming-use@1" as const,
        runtimeCleanup: "complete" as const, leaseRelease: "outer-host-owned-pending" as const,
        ledger: { beginUse: { staticPlanFingerprint: "b".repeat(64), canonicalFrameCount: 1, modules: [] }, applications: [], applicationSequenceSha256: "c".repeat(64) },
        resources: { live: null, terminal: null }
      }
    };
    const unreleased = {
      schema: "shellx-motion/gpu-effect-module-final-use@1" as const,
      beginUse: forgedEvidence.effectModules.ledger.beginUse,
      applications: [], applicationSequenceSha256: "c".repeat(64), release: "pending" as const
    };
    expect(gpuFinalEffectModuleReceiptInputHashes({
      frameLane: "gpu" as const,
      evidence: forgedEvidence
    } as never, unreleased as never)).toBeUndefined();
  });
});
