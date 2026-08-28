import type { MotionRelationActionApplyPlan } from "../../motion-relation-actions-public-types";
import type { MotionRelationFrameEvaluation } from "../../motion-relation-evaluate";
import type { MotionRelationFramePlan, MotionRelationStaticPlan } from "../../motion-relation-plan";
import type { MotionRelationStore } from "../../motion-relation-types";
import type { MotionDocument, PackageManifest } from "../../types";
import type { CheckpointStoryboard } from "./checkpoint-storyboard-types";

/**
 * Private C6B4a input and plan boundary for one sealed C4B relation-action lowering.  Package
 * identities are caller-described facts only: this compiler does not acquire a workspace, open a
 * package, or create output.
 */
export const CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_REQUEST_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-relation-action-profile-request@1" as const;
export const CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_PLAN_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-relation-action-profile-plan@1" as const;
export const CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-relation-action-profile@1" as const;

export type CheckpointStoryboardRelationActionOwnedProperty = "transform.x" | "transform.y";

export interface CheckpointStoryboardRelationActionProfileBinding {
  readonly objectId: string;
  readonly layerId: string;
}

export interface CheckpointStoryboardRelationActionProfileRequest {
  readonly schema: typeof CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_REQUEST_SCHEMA;
  readonly storyboard: CheckpointStoryboard;
  readonly base: {
    readonly packageId: string;
    readonly manifest: PackageManifest;
    readonly motion: MotionDocument;
    readonly persistedMotionSha256: string;
  };
  /** Exact catalog-order bindings; the selected action roles choose source and target. */
  readonly objectLayerBindings: readonly [
    CheckpointStoryboardRelationActionProfileBinding,
    CheckpointStoryboardRelationActionProfileBinding,
  ];
}

export interface CheckpointStoryboardRelationActionProfilePlan {
  readonly schema: typeof CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_PLAN_SCHEMA;
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number; readonly fingerprint: string };
  readonly base: {
    readonly package: { readonly id: string; readonly motionPath: string };
    readonly manifest: { readonly id: string; readonly sha256: string };
    readonly canonicalMotion: { readonly id: string; readonly sha256: string };
    readonly persistedMotion: { readonly id: string; readonly sha256: string };
  };
  readonly lowererProfile: {
    readonly schema: typeof CHECKPOINT_STORYBOARD_RELATION_ACTION_PROFILE_SCHEMA;
    readonly requiredCapability: "renderer.gpu";
    readonly rootShapeKinds: readonly ("rect" | "ellipse")[];
    readonly actionStoreSchema: "shellx-motion/relation-actions@2";
    readonly relationKinds: readonly ["follow"];
    readonly offsetSpaces: readonly ["world"];
    readonly roles: 2;
    readonly parameters: 0;
    readonly templateLayers: 0;
    readonly sequenceSteps: 1;
    readonly relationTemplates: 1;
    readonly ownedPropertyMask: readonly CheckpointStoryboardRelationActionOwnedProperty[];
    readonly endpointRule: "closed-whole-millisecond-legacy-bridge";
    readonly fingerprint: string;
  };
  readonly objectLayerBindings: {
    readonly source: { readonly objectId: string; readonly layerId: string; readonly layerIndex: number; readonly rootShapeKind: "rect" | "ellipse" };
    readonly target: { readonly objectId: string; readonly layerId: string; readonly layerIndex: number; readonly rootShapeKind: "rect" | "ellipse" };
  };
  readonly projection: {
    readonly edge: { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string };
    readonly recipe: { readonly id: string; readonly sha256: string; readonly revision: number; readonly recipeId: string };
    readonly action: {
      readonly store: { readonly schema: "shellx-motion/relation-actions@2"; readonly sha256: string };
      readonly definition: { readonly id: string; readonly sha256: string };
      readonly request: { readonly instanceId: string; readonly sha256: string };
      readonly applyPlan: MotionRelationActionApplyPlan;
      readonly outputCanonicalMotionSha256: string;
      readonly changedPaths: readonly string[];
      readonly relationIds: readonly [string];
    };
    readonly path: "/relations";
    readonly store: MotionRelationStore;
    readonly storeSha256: string;
    readonly staticPlan: MotionRelationStaticPlan;
    readonly staticFingerprint: string;
    readonly gpuPreviewStaticPlan: {
      readonly schema: "shellx-motion/gpu-scene-relations-static@1";
      readonly fingerprint: string;
      readonly relationStaticFingerprint: string;
    };
    readonly ownedPropertyMask: readonly CheckpointStoryboardRelationActionOwnedProperty[];
  };
  readonly endpointEvaluations: { readonly start: MotionRelationFrameEvaluation; readonly end: MotionRelationFrameEvaluation };
  readonly endpointFramePlans: { readonly start: MotionRelationFramePlan; readonly end: MotionRelationFramePlan };
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
