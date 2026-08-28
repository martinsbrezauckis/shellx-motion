import type { MotionParametricTraceDescriptor } from "../../motion-parametric-trace-types";
import type { MotionShapeGeometry } from "../../motion-shape-geometry-types";

/**
 * Private direct-import-only C6A contract. It deliberately has no MotionDocument root, command,
 * renderer, package, provider, or model-execution authority.
 */
export const CHECKPOINT_STORYBOARD_SCHEMA = "shellx-motion/checkpoint-storyboard@1" as const;
export const TRANSITION_RECIPE_SCHEMA = "shellx-motion/transition-recipe@1" as const;
export const CHECKPOINT_STORYBOARD_PLAN_SCHEMA = "shellx-motion/private-checkpoint-storyboard-plan@1" as const;

export const MAX_CHECKPOINT_STORYBOARD_CHECKPOINTS = 16;
export const MAX_CHECKPOINT_STORYBOARD_OBJECTS = 64;
export const MAX_CHECKPOINT_STORYBOARD_EDGES = 64;
export const MAX_CHECKPOINT_STORYBOARD_RECIPES = 64;
export const MAX_CHECKPOINT_STORYBOARD_WORK_UNITS = 16_384;
export const MAX_CHECKPOINT_STORYBOARD_STORAGE_BYTES = 256 * 1024;
export const MAX_CHECKPOINT_STORYBOARD_RECIPE_BYTES = 32 * 1024;
export const MAX_CHECKPOINT_STORYBOARD_SEED = 4_294_967_295;
export const MAX_CHECKPOINT_STORYBOARD_TIME_US = 3_600_000_000;

export const CHECKPOINT_STORYBOARD_BUDGET = Object.freeze({
  checkpoints: MAX_CHECKPOINT_STORYBOARD_CHECKPOINTS,
  objects: MAX_CHECKPOINT_STORYBOARD_OBJECTS,
  edges: MAX_CHECKPOINT_STORYBOARD_EDGES,
  recipes: MAX_CHECKPOINT_STORYBOARD_RECIPES,
  workUnits: MAX_CHECKPOINT_STORYBOARD_WORK_UNITS,
  storageBytes: MAX_CHECKPOINT_STORYBOARD_STORAGE_BYTES,
});

export const CHECKPOINT_PROPERTY_MASK = [
  "transform.x", "transform.y", "transform.rotation", "transform.scale", "opacity",
] as const;
export type CheckpointProperty = (typeof CHECKPOINT_PROPERTY_MASK)[number];
export type CheckpointPropertyValue = { readonly property: CheckpointProperty; readonly value: number };
export const CHECKPOINT_ROOT_SHAPE_KINDS = ["rect", "ellipse", "path", "geometry"] as const;
export type CheckpointRootShapeKind = (typeof CHECKPOINT_ROOT_SHAPE_KINDS)[number];
export type CheckpointSpatialTangentMode = "linear" | "smooth" | "broken" | "auto";
export type CheckpointRecipeKind =
  | "checkpoint-keyframe"
  | "checkpoint-spatial-path"
  | "checkpoint-geometry-morph"
  | "transform-behavior"
  | "relation"
  | "relation-action"
  | "parametric-trace";

/** Closed, code-owned C6A recipe vocabulary. It is not an external action registry. */
export const CHECKPOINT_RECIPE_KINDS: readonly CheckpointRecipeKind[] = Object.freeze([
  "checkpoint-keyframe", "checkpoint-spatial-path", "checkpoint-geometry-morph", "transform-behavior", "relation", "relation-action", "parametric-trace",
]);

/** Closed creation facts for the private lifecycle lowerer; never a Motion layer fragment. */
export const CHECKPOINT_STORYBOARD_SHAPE_CREATION_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-shape-creation@1" as const;
export interface CheckpointStoryboardShapeCreation {
  readonly schema: typeof CHECKPOINT_STORYBOARD_SHAPE_CREATION_SCHEMA;
  readonly fill: string;
  readonly width: number;
  readonly height: number;
}
export type CheckpointObjectCatalogEntry = {
  readonly objectId: string;
  readonly rootShapeKind: Exclude<CheckpointRootShapeKind, "geometry">;
  readonly propertyMask: readonly CheckpointProperty[];
  /** Optional so legacy C6A descriptors retain their sealed canonical identity exactly. */
  readonly creation?: CheckpointStoryboardShapeCreation;
} | {
  readonly objectId: string;
  readonly rootShapeKind: "geometry";
  /** Geometry owns its topology; scalar checkpoint properties are deliberately unavailable. */
  readonly propertyMask: readonly [];
  readonly creation?: never;
};
export interface CheckpointGeometryObjectState {
  readonly objectId: string;
  readonly state: "present";
  readonly properties: readonly [];
  /** A detached, closed shape-geometry@1 snapshot. */
  readonly geometry: MotionShapeGeometry;
}
export type CheckpointObjectState =
  | { readonly objectId: string; readonly state: "absent"; readonly properties: readonly [] }
  | CheckpointGeometryObjectState
  | {
    readonly objectId: string; readonly state: "present";
    readonly properties: readonly CheckpointPropertyValue[];
  };
export interface Checkpoint { readonly id: string; readonly atUs: number; readonly objects: readonly CheckpointObjectState[] }
export type CheckpointLifecycleMapping =
  | { readonly kind: "preserve"; readonly objectId: string }
  | { readonly kind: "create"; readonly objectId: string }
  | { readonly kind: "remove"; readonly objectId: string };
export interface CheckpointEdge {
  readonly id: string;
  readonly fromCheckpointId: string;
  readonly toCheckpointId: string;
  readonly lifecycle: readonly CheckpointLifecycleMapping[];
  readonly recipeIds: readonly string[];
}

export interface CheckpointRecipeTarget { readonly objectId: string; readonly propertyMask: readonly CheckpointProperty[] }
export interface CheckpointKeyframeIntent {
  readonly kind: "checkpoint-keyframe";
  readonly targets: readonly CheckpointRecipeTarget[];
  readonly easing: "linear" | "ease-in" | "ease-out" | "ease-in-out";
}
export interface CheckpointSpatialPathIntent {
  readonly kind: "checkpoint-spatial-path";
  readonly targets: readonly { readonly objectId: string; readonly tangentMode: CheckpointSpatialTangentMode }[];
}
/** Fixed-topology geometry interpolation is intentionally narrower than scalar checkpoint keyframes. */
export interface CheckpointGeometryMorphIntent {
  readonly kind: "checkpoint-geometry-morph";
  readonly targets: readonly { readonly objectId: string; readonly easing: "linear" }[];
}
export type CheckpointTransformBehavior =
  | { readonly kind: "gravity"; readonly velocityX: number; readonly velocityY: number; readonly gravityY: number }
  | { readonly kind: "bounce"; readonly floorY: number; readonly velocityY: number; readonly gravityY: number; readonly restitution: number };
export interface CheckpointBehaviorIntent {
  readonly kind: "transform-behavior";
  readonly targetObjectId: string;
  readonly behavior: CheckpointTransformBehavior;
}
export type CheckpointRelationIntent =
  | {
    readonly kind: "relation"; readonly relationKind: "follow" | "similarity";
    readonly sourceObjectId: string; readonly targetObjectId: string;
    readonly sourceAnchor: { readonly x: number; readonly y: number };
    readonly targetAnchor: { readonly x: number; readonly y: number };
    readonly offset: { readonly space: "source" | "world"; readonly x: number; readonly y: number; readonly rotationDeg: number; readonly scale: number };
  }
  | {
    readonly kind: "relation"; readonly relationKind: "aim";
    readonly sourceObjectId: string; readonly targetObjectId: string;
    readonly sourceAnchor: { readonly x: number; readonly y: number };
    readonly targetAnchor: { readonly x: number; readonly y: number };
    readonly rotationOffsetDeg: number;
  };
/** A claim only. C6A never resolves it or declares its definition accepted. */
export interface DeferredExactBaseRequirement {
  readonly resolution: "deferred-exact-base";
  readonly definitionId: string;
  readonly definitionSha256: string;
}
export interface CheckpointRelationActionIntent {
  readonly kind: "relation-action";
  readonly roleBindings: readonly { readonly roleId: string; readonly objectId: string }[];
  readonly parameterValues: readonly { readonly parameterId: string; readonly value: number | string }[];
  readonly declaredWrites: readonly CheckpointRecipeTarget[];
}
export interface CheckpointParametricTraceIntent {
  readonly kind: "parametric-trace";
  readonly outputObjectId: string;
  readonly trace: MotionParametricTraceDescriptor;
}
export type CheckpointRecipeIntent =
  | CheckpointKeyframeIntent
  | CheckpointSpatialPathIntent
  | CheckpointGeometryMorphIntent
  | CheckpointBehaviorIntent
  | CheckpointRelationIntent
  | CheckpointRelationActionIntent
  | CheckpointParametricTraceIntent;

export interface TransitionRecipe {
  readonly schema: typeof TRANSITION_RECIPE_SCHEMA;
  readonly id: string;
  readonly sha256: string;
  readonly revision: number;
  readonly parentRevision?: { readonly id: string; readonly sha256: string };
  readonly recipeId: string;
  readonly seed: number;
  readonly intent: CheckpointRecipeIntent;
  readonly exactBaseRequirements: readonly DeferredExactBaseRequirement[];
  readonly budget: { readonly workUnits: number; readonly storageBytes: number };
}
export interface TransitionRecipeDescriptor {
  readonly recipeId: string;
  readonly seed: number;
  readonly intent: CheckpointRecipeIntent;
  readonly exactBaseRequirements: readonly DeferredExactBaseRequirement[];
  readonly parent?: TransitionRecipe;
}
export interface CheckpointStoryboard {
  readonly schema: typeof CHECKPOINT_STORYBOARD_SCHEMA;
  readonly id: string;
  readonly sha256: string;
  readonly revision: number;
  readonly parentRevision?: { readonly id: string; readonly sha256: string };
  readonly seed: number;
  readonly capabilityRequirements: readonly string[];
  readonly objectCatalog: readonly CheckpointObjectCatalogEntry[];
  readonly checkpoints: readonly Checkpoint[];
  readonly edges: readonly CheckpointEdge[];
  readonly recipes: readonly TransitionRecipe[];
  readonly budget: typeof CHECKPOINT_STORYBOARD_BUDGET;
}
export interface CheckpointStoryboardDescriptor {
  readonly seed: number;
  readonly capabilityRequirements: readonly string[];
  readonly objectCatalog: readonly CheckpointObjectCatalogEntry[];
  readonly checkpoints: readonly Checkpoint[];
  readonly edges: readonly CheckpointEdge[];
  readonly recipes: readonly TransitionRecipe[];
  readonly parent?: CheckpointStoryboard;
}
export interface CheckpointStoryboardPlan {
  readonly schema: typeof CHECKPOINT_STORYBOARD_PLAN_SCHEMA;
  readonly storyboard: { readonly id: string; readonly sha256: string };
  readonly capabilityRequirements: readonly string[];
  readonly exactBaseRequirements: readonly DeferredExactBaseRequirement[];
  readonly edges: readonly { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string; readonly recipeIds: readonly string[]; readonly workUnits: number }[];
  readonly budget: {
    readonly checkpointCount: number; readonly objectStateCount: number; readonly edgeCount: number;
    readonly recipeCount: number; readonly workUnits: number; readonly storageBytes: number;
    readonly limits: typeof CHECKPOINT_STORYBOARD_BUDGET;
  };
  readonly evidence: { readonly noRenderer: true; readonly noArbitraryTimeEvaluation: true; readonly unresolvedExactBaseRequirements: true };
  readonly fingerprint: string;
}
