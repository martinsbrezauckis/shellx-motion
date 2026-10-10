import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createMotionJobEvidence,
  motionJobEvidenceFingerprint,
  parseMotionJobEvidence,
  serializeMotionJobEvidence,
  type MotionJobEvidenceInput
} from "./job-evidence";
import { validateAgainstPublishedSchema, type JsonSchemaDocument } from "./published-schema-check";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const JOB_EVIDENCE_SCHEMA = JSON.parse(readFileSync(new URL("../../../schemas/job-evidence.schema.json", import.meta.url), "utf8")) as JsonSchemaDocument;

function evidenceInput(overrides: Partial<MotionJobEvidenceInput> = {}): MotionJobEvidenceInput {
  return {
    jobId: "cut:render-1",
    callerId: "cut:workspace-a",
    operation: "render.final",
    planFingerprint: HASH_A,
    outcome: "succeeded",
    warnings: ["quality verified"],
    receiptIds: ["render-final-1"],
    producerEvidence: { frameLane: "gpu", schema: "shellx-motion/gpu-streaming-producer@1" },
    artifacts: [{ schema: "shellx-motion/artifact-handle@1", id: "artifact-0123456789abcdef01234567", operationHash: HASH_B, sha256: HASH_C }],
    ...overrides
  };
}

describe("MotionJobEvidence", () => {
  it("is canonical across key order and self-verifies its fingerprint", () => {
    const first = createMotionJobEvidence(evidenceInput());
    const reordered = createMotionJobEvidence({
      artifacts: evidenceInput().artifacts,
      producerEvidence: { schema: "shellx-motion/gpu-streaming-producer@1", frameLane: "gpu" },
      receiptIds: ["render-final-1"],
      warnings: ["quality verified"],
      outcome: "succeeded",
      planFingerprint: HASH_A,
      operation: "render.final",
      callerId: "cut:workspace-a",
      jobId: "cut:render-1"
    });
    expect(reordered.fingerprint).toBe(first.fingerprint);
    expect(motionJobEvidenceFingerprint(first)).toBe(first.fingerprint);
    expect(serializeMotionJobEvidence(reordered)).toBe(serializeMotionJobEvidence(first));
  });

  it("changes its fingerprint for every mutable evidence field", () => {
    const baseline = createMotionJobEvidence(evidenceInput());
    const variants = [
      evidenceInput({ jobId: "cut:render-2" }),
      evidenceInput({ callerId: "cut:workspace-b" }),
      evidenceInput({ planFingerprint: HASH_B }),
      evidenceInput({ outcome: "failed" }),
      evidenceInput({ warnings: ["quality warning"] }),
      evidenceInput({ receiptIds: ["render-final-2"] }),
      evidenceInput({ producerEvidence: null }),
      evidenceInput({ artifacts: [{ schema: "shellx-motion/artifact-handle@1", id: "artifact-fedcba9876543210fedcba98", operationHash: HASH_B, sha256: HASH_C }] })
    ];
    for (const variant of variants) expect(createMotionJobEvidence(variant).fingerprint).not.toBe(baseline.fingerprint);
  });

  it("refuses path, secret, inherited, extra, artifact-path, and tampered input", () => {
    const evidence = createMotionJobEvidence(evidenceInput());
    expect(() => parseMotionJobEvidence({ ...evidence, rootRelativePath: "never" })).toThrow(/unknown field/i);
    expect(() => createMotionJobEvidence(evidenceInput({ warnings: ["file:///tmp/output.mp4"] }))).toThrow(/path or URL/i);
    expect(() => createMotionJobEvidence(evidenceInput({ warnings: ["authorization: bearer-value"] }))).toThrow(/secret/i);
    expect(() => createMotionJobEvidence(evidenceInput({ artifacts: [{ ...evidence.artifacts[0]!, rootRelativePath: "media/out.mp4" } as never] }))).toThrow(/unknown field/i);
    const inherited = Object.assign(Object.create({ inherited: true }), evidence);
    expect(() => parseMotionJobEvidence(inherited)).toThrow(/plain object/i);
    expect(() => parseMotionJobEvidence({ ...evidence, fingerprint: HASH_B })).toThrow(/fingerprint/i);
  });

  it("keeps the published schema aligned with opaque, caller, and primary-artifact refusals", () => {
    const evidence = createMotionJobEvidence(evidenceInput());
    const rendererWarnings = Array.from({ length: 64 }, (_, index) => `renderer warning ${index}`);
    expect(validateAgainstPublishedSchema(JOB_EVIDENCE_SCHEMA, evidence)).toEqual([]);
    expect(validateAgainstPublishedSchema(JOB_EVIDENCE_SCHEMA, { ...evidence, warnings: rendererWarnings })).toEqual([]);
    expect(validateAgainstPublishedSchema(JOB_EVIDENCE_SCHEMA, { ...evidence, warnings: ["file:///tmp/output.mp4"] })).not.toEqual([]);
    expect(validateAgainstPublishedSchema(JOB_EVIDENCE_SCHEMA, { ...evidence, warnings: ["Authorization: Bearer token"] })).not.toEqual([]);
    expect(validateAgainstPublishedSchema(JOB_EVIDENCE_SCHEMA, { ...evidence, callerId: "secret-caller" })).not.toEqual([]);
    expect(validateAgainstPublishedSchema(JOB_EVIDENCE_SCHEMA, { ...evidence, receiptIds: ["render-final-1", "render-final-1"] })).not.toEqual([]);
    expect(validateAgainstPublishedSchema(JOB_EVIDENCE_SCHEMA, { ...evidence, artifacts: [] })).toEqual([]);
    expect(validateAgainstPublishedSchema(JOB_EVIDENCE_SCHEMA, { ...evidence, artifacts: [evidence.artifacts[0]] })).toEqual([]);
    expect(createMotionJobEvidence(evidenceInput({ artifacts: [] })).artifacts).toHaveLength(0);
    expect(createMotionJobEvidence(evidenceInput()).artifacts).toHaveLength(1);
    const sameOperationDifferentSha = { ...evidence.artifacts[0]!, sha256: HASH_A };
    const contradictoryArtifacts = { ...evidence, artifacts: [evidence.artifacts[0], sameOperationDifferentSha] };
    expect(validateAgainstPublishedSchema(JOB_EVIDENCE_SCHEMA, contradictoryArtifacts)).toEqual([{ path: "/artifacts", message: "must contain at most 1 item(s)" }]);
    expect(() => parseMotionJobEvidence(contradictoryArtifacts)).toThrow(/at most one primary artifact/i);
    expect(() => createMotionJobEvidence(evidenceInput({ artifacts: [evidence.artifacts[0]!, sameOperationDifferentSha] }))).toThrow(/at most one primary artifact/i);
  });

  it("bounds warning, receipt, and artifact arrays", () => {
    const warnings = Array.from({ length: 64 }, (_, index) => `warning ${index}`);
    expect(createMotionJobEvidence(evidenceInput({ warnings })).warnings).toEqual(warnings);
    expect(() => createMotionJobEvidence(evidenceInput({ warnings: [...warnings, "overflow"] }))).toThrow(/at most 64/i);
    expect(() => createMotionJobEvidence(evidenceInput({ receiptIds: Array.from({ length: 65 }, (_, index) => `receipt-${index}`) }))).toThrow(/at most 64/i);
    expect(() => createMotionJobEvidence(evidenceInput({ receiptIds: ["render-final-1", "render-final-1"] }))).toThrow(/duplicates/i);
    expect(() => createMotionJobEvidence(evidenceInput({ artifacts: [evidenceInput().artifacts[0]!, evidenceInput().artifacts[0]!] }))).toThrow(/at most one primary artifact/i);
  });
});
