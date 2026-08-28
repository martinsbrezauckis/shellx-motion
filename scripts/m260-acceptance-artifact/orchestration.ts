/** Executes the bounded source-contract and refusal branches of the M260 artifact. */
import {
  canonicalJsonSha256,
  createOrReplaceMotionFixedAdjustment,
  matchRendererCapability,
  NATIVE_CAPABILITY,
  type MotionDocument,
  type MotionFixedAdjustmentDefinition
} from "../../packages/core/src/index.js";
import {
  CAPABILITY_PROOF_LEVELS,
  generateSourceCapabilityEvidenceMatrix,
  type CapabilityEvidenceMatrix,
  type CapabilityProofLevel,
  type CapabilityProofStatus
} from "./matrix.js";
import {
  M260_ACCEPTANCE_FIXTURE_DESCRIPTOR,
  type M260AcceptanceFixtureTarget
} from "./descriptor.js";

export const M260_ACCEPTANCE_ARTIFACT_COMMAND = "m260:acceptance-artifact";
export const M260_ACCEPTANCE_ARTIFACT_SCHEMA = "shellx-motion/m260-acceptance-artifact@2";
export const M260_FIXED_ADJUSTMENT_NATIVE_REFUSAL_SCHEMA = "shellx-motion/m260-fixed-adjustment-native-refusal@1";
export const M260_ACCEPTANCE_ARTIFACT_REFUSAL_LOCATOR = `${M260_ACCEPTANCE_ARTIFACT_COMMAND}#/refusal`;
export const M260_SOURCE_CONTRACT_REASON =
  "The m260:acceptance-artifact repository command emits the canonical-card source inventory and source-contract matrix; it does not imply package, host, renderer, or final-media evidence.";

export interface M260AcceptanceFixtureProofCell {
  level: CapabilityProofLevel;
  status: CapabilityProofStatus;
  evidenceRef?: string;
}

export interface M260FixedAdjustmentNativeRefusal {
  schema: typeof M260_FIXED_ADJUSTMENT_NATIVE_REFUSAL_SCHEMA;
  projectionId: "refusal";
  studyTopics: readonly ["fixed-adjustments"];
  operation: "core.motion-fixed-adjustment.create-or-replace";
  capabilityGate: "core.match-renderer-capability";
  capabilityId: "renderer.native";
  inputMotionSha256: string;
  outputMotionSha256: string;
  adjustmentSha256: string;
  changedPaths: readonly string[];
  unsupported: readonly Readonly<{ layerId: string; feature: string; reason: string }>[];
  evidenceIdentity: string;
  proof: readonly M260AcceptanceFixtureProofCell[];
}

export interface M260AcceptanceFixtureProjectionOrchestration {
  id: M260AcceptanceFixtureTarget;
  execution: "executed" | "planned";
  missingProof: readonly CapabilityProofLevel[];
  reason: string;
}

export interface M260AcceptanceFixtureArtifact {
  schema: typeof M260_ACCEPTANCE_ARTIFACT_SCHEMA;
  createsPackageOrOutput: false;
  matrix: CapabilityEvidenceMatrix;
  refusal: M260FixedAdjustmentNativeRefusal;
  projections: readonly M260AcceptanceFixtureProjectionOrchestration[];
  executedProjectionIds: readonly M260AcceptanceFixtureTarget[];
}

/** This does not open a package or renderer; it emits source-contract evidence only. */
export function generateM260AcceptanceFixtureArtifact(): M260AcceptanceFixtureArtifact {
  const matrix = generateSourceCapabilityEvidenceMatrix();
  const refusal = executeM260FixedAdjustmentNativeRefusal();
  const capturedProofLevels = capturedProofLevelsFrom(matrix);
  const projections = Object.freeze(M260_ACCEPTANCE_FIXTURE_DESCRIPTOR.projections.map((projection) => {
    const missingProof = Object.freeze(projection.requiredProof.filter((level) => !capturedProofLevels.has(level)));
    const executed = projection.id === "source-contract" || projection.id === "refusal";
    return Object.freeze({
      id: projection.id,
      execution: executed ? "executed" as const : "planned" as const,
      missingProof,
      reason: projectionReason(projection.id, missingProof.length > 0)
    });
  }));
  return Object.freeze({
    schema: M260_ACCEPTANCE_ARTIFACT_SCHEMA,
    createsPackageOrOutput: false,
    matrix,
    refusal,
    projections,
    executedProjectionIds: Object.freeze(["source-contract", "refusal"] as const)
  });
}

function executeM260FixedAdjustmentNativeRefusal(): M260FixedAdjustmentNativeRefusal {
  const mutation = createOrReplaceMotionFixedAdjustment(fixedAdjustmentRefusalSource(), {
    adjustment: M260_FIXED_ADJUSTMENT_DEFINITION
  });
  const match = matchRendererCapability(mutation.motion, NATIVE_CAPABILITY);
  if (mutation.adjustmentFingerprint === null || match.ok || match.lane !== "native" || match.unsupported.length !== 1) {
    throw new Error("M260 fixed-adjustment fixture must be refused by the native capability gate.");
  }
  const unsupported = Object.freeze(match.unsupported.map((entry) => Object.freeze({
    layerId: entry.layerId,
    feature: entry.feature,
    reason: entry.reason
  })));
  const identityInput = Object.freeze({
    schema: M260_FIXED_ADJUSTMENT_NATIVE_REFUSAL_SCHEMA,
    projectionId: "refusal" as const,
    studyTopics: ["fixed-adjustments"] as const,
    operation: "core.motion-fixed-adjustment.create-or-replace" as const,
    capabilityGate: "core.match-renderer-capability" as const,
    capabilityId: "renderer.native" as const,
    inputMotionSha256: mutation.inputFingerprint,
    outputMotionSha256: mutation.outputFingerprint,
    adjustmentSha256: mutation.adjustmentFingerprint,
    changedPaths: mutation.changedPaths,
    unsupported
  });
  const evidenceIdentity = canonicalJsonSha256(identityInput);
  const proof = Object.freeze(CAPABILITY_PROOF_LEVELS.map((level) => level === "source"
    ? Object.freeze({ level, status: "captured" as const, evidenceRef: M260_ACCEPTANCE_ARTIFACT_REFUSAL_LOCATOR })
    : Object.freeze({ level, status: "not-captured" as const })));
  return Object.freeze({ ...identityInput, changedPaths: Object.freeze([...mutation.changedPaths]), evidenceIdentity, proof });
}

const M260_FIXED_ADJUSTMENT_DEFINITION = Object.freeze({
  id: "fixed-adjustment-refusal",
  startMs: 0,
  durationMs: 1_000,
  effects: Object.freeze({
    vignette: Object.freeze({ amount: 0.7, softness: 0.45, color: "#10203080" }),
    filmGrain: Object.freeze({ amount: 0.25, size: 3, seed: 42 })
  })
} satisfies MotionFixedAdjustmentDefinition);

function fixedAdjustmentRefusalSource(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "m260-generic-fixed-adjustment-refusal",
    name: "M260 generic fixed-adjustment refusal",
    durationMs: 1_000,
    fps: 30,
    width: 100,
    height: 60,
    assets: [],
    provenance: { sourceApp: "m260-acceptance-fixture", createdBy: "m260-acceptance-fixture" },
    layers: [{ id: "plate", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 1_000 }]
  };
}

function capturedProofLevelsFrom(matrix: CapabilityEvidenceMatrix): ReadonlySet<CapabilityProofLevel> {
  const captured = new Set<CapabilityProofLevel>();
  for (const level of CAPABILITY_PROOF_LEVELS) {
    const capturedForEveryCard = matrix.rows.length > 0 && matrix.rows.every((row) =>
      row.proof.find((cell) => cell.level === level)?.status === "captured"
    );
    if (capturedForEveryCard) captured.add(level);
  }
  return captured;
}

function projectionReason(id: M260AcceptanceFixtureTarget, evidenceMissing: boolean): string {
  if (id === "source-contract") return M260_SOURCE_CONTRACT_REASON;
  if (id === "refusal") {
    return "The fixed-adjustment Core mutation is refused by the renderer-native capability preflight before raster work; package and host proof remain uncaptured.";
  }
  if (evidenceMissing) return "No exact evidence is captured for every proof level required by this projection.";
  return "No operation is bound for this projection.";
}
