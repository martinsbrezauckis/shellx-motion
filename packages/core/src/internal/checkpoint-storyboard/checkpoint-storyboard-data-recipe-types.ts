import type { MotionParametricTracePlan } from "../../motion-parametric-trace-types";
import { CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS } from "./checkpoint-storyboard-retained-trace-profile-types";
import type { CheckpointStoryboard, CheckpointStoryboardPlan } from "./checkpoint-storyboard-types";

/** Closed descriptor accepted by the private C6D-A data-recipe compiler. */
export const DATA_RECIPE_CHECKPOINT_SCHEMA = "shellx-motion/data-recipe-checkpoint@1" as const;
export const DATA_RECIPE_CHECKPOINT_REPORT_SCHEMA = "shellx-motion/private-data-recipe-checkpoint-report@1" as const;
export const DATA_RECIPE_CHECKPOINT_FORMULA_ID = "formula.lissajous-2d@1" as const;
export const DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID = "formula.rose-curve-2d@1" as const;
export const DATA_RECIPE_CHECKPOINT_ACTION_ID = "trace.full-clip-line@1" as const;

export type DataRecipeCheckpointFormulaId =
  | typeof DATA_RECIPE_CHECKPOINT_FORMULA_ID
  | typeof DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID;

/** B7's deliberately fixed C4C ceiling; callers must supply this exact object shape. */
export const DATA_RECIPE_CHECKPOINT_LIMITS = Object.freeze({ ...CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS });

export interface DataRecipeCheckpointLimits {
  readonly maxSamples: 64;
  readonly maxVertices: 64;
  readonly maxWorkUnits: 16_384;
  readonly maxBytes: 131_072;
}

export interface DataRecipeCheckpointLineParameters {
  readonly centerX: number;
  readonly centerY: number;
  readonly sampleCount: number;
  readonly strokeWidth: number;
  readonly strokeOpacity: number;
  readonly luma: number;
  readonly speedLimit: number;
}

export interface DataRecipeCheckpointLissajousParameters extends DataRecipeCheckpointLineParameters {
  readonly amplitudeX: number;
  readonly amplitudeY: number;
  readonly frequencyX: number;
  readonly frequencyY: number;
  readonly phaseTurnsQ1024: number;
}

export interface DataRecipeCheckpointRoseParameters extends DataRecipeCheckpointLineParameters {
  readonly radius: number;
  readonly petals: number;
  readonly rotationTurnsQ1024: number;
}

export type DataRecipeCheckpointParameters =
  | DataRecipeCheckpointLissajousParameters
  | DataRecipeCheckpointRoseParameters;

export type DataRecipeCheckpointRecipe = {
  readonly seed: number;
  readonly actionId: typeof DATA_RECIPE_CHECKPOINT_ACTION_ID;
  readonly limits: DataRecipeCheckpointLimits;
} & (
  | { readonly formulaId: typeof DATA_RECIPE_CHECKPOINT_FORMULA_ID; readonly parameters: DataRecipeCheckpointLissajousParameters }
  | { readonly formulaId: typeof DATA_RECIPE_CHECKPOINT_ROSE_FORMULA_ID; readonly parameters: DataRecipeCheckpointRoseParameters }
);

export interface DataRecipeCheckpointDescriptor {
  readonly schema: typeof DATA_RECIPE_CHECKPOINT_SCHEMA;
  readonly storyboardSeed: number;
  readonly requiredCapability: "renderer.gpu";
  readonly target: { readonly objectId: string; readonly rootShapeKind: "rect" };
  readonly checkpoints: readonly [
    { readonly atUs: 0; readonly state: "present"; readonly opacity: number },
    { readonly atUs: number; readonly state: "present"; readonly opacity: number },
  ];
  readonly recipe: DataRecipeCheckpointRecipe;
}

export interface DataRecipeCheckpointReport {
  readonly schema: typeof DATA_RECIPE_CHECKPOINT_REPORT_SCHEMA;
  readonly descriptorSha256: string;
  readonly formulaId: DataRecipeCheckpointFormulaId;
  readonly actionId: typeof DATA_RECIPE_CHECKPOINT_ACTION_ID;
  readonly storyboard: CheckpointStoryboard;
  readonly c6aPlan: CheckpointStoryboardPlan;
  readonly tracePlan: MotionParametricTracePlan;
  readonly lineage: {
    readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number; readonly parentRevision?: { readonly id: string; readonly sha256: string } };
    readonly transitionRecipe: { readonly id: string; readonly sha256: string; readonly revision: number; readonly parentRevision?: { readonly id: string; readonly sha256: string } };
  };
  readonly evidence: {
    readonly b7RetainedTraceAdmitted: true;
    readonly exactFixedCaps: true;
    readonly codeOwnedGraph: true;
    readonly noIO: true;
    readonly noStore: true;
    readonly noRenderer: true;
    readonly noDebug: true;
    readonly noCli: true;
    readonly noSdk: true;
    readonly noAction: true;
    readonly noConnector: true;
    readonly noPublicCoreRoot: true;
  };
  readonly sha256: string;
  readonly fingerprint: string;
}
