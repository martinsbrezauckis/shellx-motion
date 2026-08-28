import type { CheckpointStoryboard, CheckpointStoryboardPlan } from "./checkpoint-storyboard-types";

export const DATA_RECIPE_CHOREOGRAPHY_SCHEMA = "shellx-motion/data-recipe-choreography@1" as const;
export const DATA_RECIPE_CHOREOGRAPHY_REPORT_SCHEMA = "shellx-motion/private-data-recipe-choreography-report@1" as const;
export const DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID = "formula.orbit-checkpoints-2d@1" as const;
export const DATA_RECIPE_CHOREOGRAPHY_ACTION_ID = "transform.checkpoint-orbit@1" as const;

export const DATA_RECIPE_CHOREOGRAPHY_LIMITS = Object.freeze({
  maxObjects: 8 as const,
  maxCheckpoints: 8 as const,
  maxRecipes: 14 as const,
  maxWorkUnits: 16_384 as const,
  maxBytes: 262_144 as const,
});

export interface DataRecipeChoreographyLimits {
  readonly maxObjects: 8;
  readonly maxCheckpoints: 8;
  readonly maxRecipes: 14;
  readonly maxWorkUnits: 16_384;
  readonly maxBytes: 262_144;
}

export interface DataRecipeChoreographyObject {
  readonly objectId: string;
  readonly rootShapeKind: "rect" | "ellipse";
  readonly orbitRadius: number;
  readonly phaseTurnsQ1024: number;
}

export interface DataRecipeChoreographyCheckpoint {
  readonly atUs: number;
  readonly orbitTurnsQ1024: number;
  readonly radiusScaleQ1024: number;
  readonly scaleQ1024: number;
  readonly opacityQ1024: number;
}

export interface DataRecipeChoreographyDescriptor {
  readonly schema: typeof DATA_RECIPE_CHOREOGRAPHY_SCHEMA;
  readonly storyboardSeed: number;
  readonly requiredCapability: "renderer.browser";
  readonly objects: readonly DataRecipeChoreographyObject[];
  readonly checkpoints: readonly DataRecipeChoreographyCheckpoint[];
  readonly recipe: {
    readonly seed: number;
    readonly formulaId: typeof DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID;
    readonly actionId: typeof DATA_RECIPE_CHOREOGRAPHY_ACTION_ID;
    readonly parameters: {
      readonly centerX: number;
      readonly centerY: number;
      readonly spatialTangentMode: "linear" | "auto";
      readonly scalarEasing: "linear" | "ease-in" | "ease-out" | "ease-in-out";
    };
    readonly limits: DataRecipeChoreographyLimits;
  };
}

export interface DataRecipeChoreographyReport {
  readonly schema: typeof DATA_RECIPE_CHOREOGRAPHY_REPORT_SCHEMA;
  readonly descriptorSha256: string;
  readonly formulaId: typeof DATA_RECIPE_CHOREOGRAPHY_FORMULA_ID;
  readonly actionId: typeof DATA_RECIPE_CHOREOGRAPHY_ACTION_ID;
  readonly storyboard: CheckpointStoryboard;
  readonly c6aPlan: CheckpointStoryboardPlan;
  readonly lineage: {
    readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number; readonly parentRevision?: { readonly id: string; readonly sha256: string } };
    readonly transitionRecipes: readonly { readonly id: string; readonly sha256: string; readonly revision: number; readonly recipeId: string; readonly parentRevision?: { readonly id: string; readonly sha256: string } }[];
  };
  readonly evidence: {
    readonly c6b1ScalarSpatialAdmitted: true;
    readonly exactFixedCaps: true;
    readonly codeOwnedFormula: true;
    readonly noIO: true;
    readonly noStore: true;
    readonly noRenderer: true;
    readonly noPublicCoreRoot: true;
  };
  readonly sha256: string;
  readonly fingerprint: string;
}
