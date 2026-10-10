import { describe, expect, it } from "vitest";
import { assertResumableTemplateProofEvidence } from "./template-proof-resume";

const selected = ["audio-launch", "product-metric-card"];
const policySha256 = "a".repeat(64);

function retainedEvidence(): Record<string, unknown> {
  return {
    schema: "shellx-motion/template-moving-proof@1",
    command: "template-pack:proof",
    ok: false,
    proofProfile: { fps: 8, preserveStoryDurations: true, selectedTemplateDirs: selected },
    policy: { sha256: policySha256 },
    retention: { state: "retained", reason: "failure_diagnostics" },
    failureCount: 1,
    failures: [{ packageDirName: "product-metric-card", code: "proof_failed", message: "ENOENT: scandir frame root" }]
  };
}

function overwrittenPreReadbackEvidence(): Record<string, unknown> {
  return {
    ...retainedEvidence(),
    proofProfile: { fps: 8, preserveStoryDurations: true, selectedTemplateDirs: selected, mode: "retained_diagnostics_inspection" },
    recovery: { mode: "retained_diagnostics_inspection", priorEvidenceSha256: "c".repeat(64) },
    failureCount: selected.length,
    templateCount: 0,
    renderedMp4Count: 0,
    templates: [],
    failures: selected.map((packageDirName) => ({
      packageDirName,
      code: "quality_check_failed",
      message: "--min-psnr-db and --min-ssim require --baseline or --preview-package"
    }))
  };
}

describe("retained moving-proof recovery evidence", () => {
  it("accepts only the exact fresh recoverable evidence shape", () => {
    expect(() => assertResumableTemplateProofEvidence({ evidence: retainedEvidence(), selectedTemplateDirs: selected, policySha256 })).not.toThrow();
    expect(() => assertResumableTemplateProofEvidence({ evidence: overwrittenPreReadbackEvidence(), selectedTemplateDirs: selected, policySha256 })).not.toThrow();
  });

  it("refuses stale, partial, and tampered retained evidence", () => {
    const stale = retainedEvidence();
    (stale.policy as Record<string, unknown>).sha256 = "b".repeat(64);
    expect(() => assertResumableTemplateProofEvidence({ evidence: stale, selectedTemplateDirs: selected, policySha256 })).toThrow("stale");

    const partial = retainedEvidence();
    (partial.proofProfile as Record<string, unknown>).selectedTemplateDirs = ["audio-launch"];
    expect(() => assertResumableTemplateProofEvidence({ evidence: partial, selectedTemplateDirs: selected, policySha256 })).toThrow("exact current promoted catalog");

    const tampered = retainedEvidence();
    tampered.ok = true;
    expect(() => assertResumableTemplateProofEvidence({ evidence: tampered, selectedTemplateDirs: selected, policySha256 })).toThrow("failed template-pack proof");

    const mixed = overwrittenPreReadbackEvidence();
    ((mixed.failures as Record<string, unknown>[])[1]!).message = "different failure";
    expect(() => assertResumableTemplateProofEvidence({ evidence: mixed, selectedTemplateDirs: selected, policySha256 })).toThrow("mixed");
  });
});
