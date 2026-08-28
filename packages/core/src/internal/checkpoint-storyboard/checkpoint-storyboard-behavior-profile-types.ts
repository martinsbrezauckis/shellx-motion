import type { PackageManifest, MotionDocument } from "../../types";
import type { MotionBehaviorStore } from "../../motion-behavior-types";
import type { MotionTransformBehaviorEvaluation } from "../../motion-transform-behavior";
import type { CheckpointStoryboard } from "./checkpoint-storyboard-types";

/** Private C6B2 input and plan boundary for one behaviors@1 transform binding. */
export const CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_REQUEST_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-behavior-profile-request@1" as const;
export const CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_PLAN_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-behavior-profile-plan@1" as const;
export const CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-behavior-profile@1" as const;

export type CheckpointStoryboardBehaviorOwnedProperty = "transform.x" | "transform.y";

export interface CheckpointStoryboardBehaviorProfileBinding {
  readonly objectId: string;
  readonly layerId: string;
}

export interface CheckpointStoryboardBehaviorProfileRequest {
  readonly schema: typeof CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_REQUEST_SCHEMA;
  readonly storyboard: CheckpointStoryboard;
  readonly base: {
    readonly packageId: string;
    readonly manifest: PackageManifest;
    readonly motion: MotionDocument;
    readonly persistedMotionSha256: string;
  };
  readonly objectLayerBindings: readonly [CheckpointStoryboardBehaviorProfileBinding];
}

export interface CheckpointStoryboardBehaviorProfilePlan {
  readonly schema: typeof CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_PLAN_SCHEMA;
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number; readonly fingerprint: string };
  readonly base: {
    readonly package: { readonly id: string; readonly motionPath: string };
    readonly manifest: { readonly id: string; readonly sha256: string };
    readonly canonicalMotion: { readonly id: string; readonly sha256: string };
    readonly persistedMotion: { readonly id: string; readonly sha256: string };
  };
  readonly lowererProfile: {
    readonly schema: typeof CHECKPOINT_STORYBOARD_BEHAVIOR_PROFILE_SCHEMA;
    readonly requiredCapability: "renderer.gpu";
    readonly rootShapeKinds: readonly ("rect" | "ellipse")[];
    readonly behaviorKinds: readonly ("gravity" | "bounce")[];
    readonly endpointRule: "direct-exact-us-equality";
    readonly fingerprint: string;
  };
  readonly objectLayerBinding: {
    readonly objectId: string;
    readonly layerId: string;
    readonly layerIndex: 0;
    readonly rootShapeKind: "rect" | "ellipse";
  };
  readonly projection: {
    readonly edge: { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string };
    readonly recipe: { readonly id: string; readonly sha256: string; readonly revision: number; readonly recipeId: string };
    readonly interval: { readonly startUs: number; readonly durationUs: number };
    readonly path: "/behaviors";
    readonly store: MotionBehaviorStore;
    readonly storeSha256: string;
    readonly ownedPropertyMask: readonly CheckpointStoryboardBehaviorOwnedProperty[];
  };
  readonly endpointEvaluations: {
    readonly start: MotionTransformBehaviorEvaluation;
    readonly end: MotionTransformBehaviorEvaluation;
  };
  readonly evidence: {
    readonly noPackageIO: true;
    readonly noPackageWrites: true;
    readonly noCOW: true;
    readonly noReceipt: true;
    readonly noPublicSurface: true;
    readonly noRenderer: true;
  };
  readonly fingerprint: string;
}

/** Direct-import-only C6B2 behavior projection. It is not a renderer or package mutation ABI. */
