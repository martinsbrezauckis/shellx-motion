/** Descriptor data for the repository-only generic M260 acceptance fixture. */
import {
  CAPABILITY_LIFECYCLE_STAGES,
  CAPABILITY_PROOF_LEVELS,
  type CapabilityLifecycleStage,
  type CapabilityProofLevel
} from "./matrix.js";

export const M260_ACCEPTANCE_FIXTURE_DESCRIPTOR_SCHEMA = "shellx-motion/m260-acceptance-fixture@1";

export const M260_ACCEPTANCE_FIXTURE_STUDY_TOPICS = [
  "nested-groups",
  "layout-repeaters",
  "shape-diversity",
  "gradients",
  "geometry-animation",
  "behaviors",
  "points",
  "particles",
  "styled-text-runs",
  "fixed-adjustments"
] as const;

export type M260AcceptanceFixtureStudyTopic = typeof M260_ACCEPTANCE_FIXTURE_STUDY_TOPICS[number];
export type M260AcceptanceFixtureTarget =
  | "source-contract"
  | "package-reopen"
  | "browser-preview"
  | "gpu-preview"
  | "final-media"
  | "receipt"
  | "refusal";

export interface M260AcceptanceFixtureProjection {
  id: M260AcceptanceFixtureTarget;
  lifecycle: readonly CapabilityLifecycleStage[];
  requiredProof: readonly CapabilityProofLevel[];
  status: "planned";
}

export interface M260AcceptanceFixtureDescriptor {
  schema: typeof M260_ACCEPTANCE_FIXTURE_DESCRIPTOR_SCHEMA;
  id: "m260-generic-acceptance";
  materialization: "repository-tool";
  createsPackageOrOutput: false;
  studyTopics: readonly M260AcceptanceFixtureStudyTopic[];
  projections: readonly M260AcceptanceFixtureProjection[];
  specializedFamilies: readonly Readonly<{ id: "contained-png-pbr" | "lottie-dotlottie"; reason: string }>[];
}

const ALL_PROOF_LEVELS = Object.freeze([...CAPABILITY_PROOF_LEVELS]);

export const M260_ACCEPTANCE_FIXTURE_DESCRIPTOR: M260AcceptanceFixtureDescriptor = Object.freeze({
  schema: M260_ACCEPTANCE_FIXTURE_DESCRIPTOR_SCHEMA,
  id: "m260-generic-acceptance",
  materialization: "repository-tool",
  createsPackageOrOutput: false,
  studyTopics: Object.freeze([...M260_ACCEPTANCE_FIXTURE_STUDY_TOPICS]),
  projections: Object.freeze([
    projection("source-contract", ["create", "inspect", "edit"], ["source"]),
    projection("package-reopen", ["save", "reopen"], ["source", "package-reopen"]),
    projection("browser-preview", ["preview"], ["installed", "native", "hardware"]),
    projection("gpu-preview", ["preview"], ["installed", "native", "hardware"]),
    projection("final-media", ["render", "final"], ALL_PROOF_LEVELS),
    projection("receipt", ["receipt"], ["final-media", "human-reviewed"]),
    projection("refusal", ["refusal"], ["source"])
  ]),
  specializedFamilies: Object.freeze([
    Object.freeze({ id: "contained-png-pbr" as const, reason: "PBR material and contained-PNG final evidence are not implied by the generic study." }),
    Object.freeze({ id: "lottie-dotlottie" as const, reason: "Lottie and dotLottie import/export evidence are not implied by a Motion renderer result." })
  ])
});

export const M260_ACCEPTANCE_FIXTURE_REQUIRED_LIFECYCLE = Object.freeze([...CAPABILITY_LIFECYCLE_STAGES]);

function projection(id: M260AcceptanceFixtureTarget, lifecycle: readonly CapabilityLifecycleStage[], requiredProof: readonly CapabilityProofLevel[]): M260AcceptanceFixtureProjection {
  return Object.freeze({ id, lifecycle: Object.freeze([...lifecycle]), requiredProof: Object.freeze([...requiredProof]), status: "planned" });
}
