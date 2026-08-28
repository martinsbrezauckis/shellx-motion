import type { PackageManifest, MotionDocument } from "../../types";
import type { MotionRelationFrameEvaluation } from "../../motion-relation-evaluate";
import type { MotionRelationFramePlan, MotionRelationStaticPlan } from "../../motion-relation-plan";
import type { MotionRelationStore } from "../../motion-relation-types";
import type { CheckpointStoryboard } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-types.js";

/**
 * Private C6B3a input and plan boundary for one semantic T3 `follow` relation. Base identities
 * are caller-described plan facts only; this module accepts no workspace, package, or host authority.
 */
export const CHECKPOINT_STORYBOARD_RELATION_PROFILE_REQUEST_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-relation-profile-request@1" as const;
export const CHECKPOINT_STORYBOARD_RELATION_PROFILE_PLAN_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-relation-profile-plan@1" as const;
export const CHECKPOINT_STORYBOARD_RELATION_PROFILE_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-relation-profile@1" as const;

export type CheckpointStoryboardRelationOwnedProperty = "transform.x" | "transform.y";

export interface CheckpointStoryboardRelationProfileBinding {
  readonly objectId: string;
  readonly layerId: string;
}

export interface CheckpointStoryboardRelationProfileRequest {
  readonly schema: typeof CHECKPOINT_STORYBOARD_RELATION_PROFILE_REQUEST_SCHEMA;
  readonly storyboard: CheckpointStoryboard;
  readonly base: {
    readonly packageId: string;
    readonly manifest: PackageManifest;
    readonly motion: MotionDocument;
    readonly persistedMotionSha256: string;
  };
  /** Exact catalog-order bindings. Roles are selected only by the sealed follow recipe. */
  readonly objectLayerBindings: readonly [
    CheckpointStoryboardRelationProfileBinding,
    CheckpointStoryboardRelationProfileBinding,
  ];
}

export interface CheckpointStoryboardRelationProfilePlan {
  readonly schema: typeof CHECKPOINT_STORYBOARD_RELATION_PROFILE_PLAN_SCHEMA;
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number; readonly fingerprint: string };
  /** Caller-described identities; never a capability, file handle, path root, or host authority. */
  readonly base: {
    readonly package: { readonly id: string; readonly motionPath: string };
    readonly manifest: { readonly id: string; readonly sha256: string };
    readonly canonicalMotion: { readonly id: string; readonly sha256: string };
    readonly persistedMotion: { readonly id: string; readonly sha256: string };
  };
  readonly lowererProfile: {
    readonly schema: typeof CHECKPOINT_STORYBOARD_RELATION_PROFILE_SCHEMA;
    readonly requiredCapability: "renderer.gpu";
    readonly rootShapeKinds: readonly ("rect" | "ellipse")[];
    readonly relationKinds: readonly ["follow"];
    readonly offsetSpaces: readonly ["world"];
    readonly ownedPropertyMask: readonly CheckpointStoryboardRelationOwnedProperty[];
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
    readonly interval: { readonly startUs: number; readonly durationUs: number };
    readonly path: "/relations";
    readonly store: MotionRelationStore;
    readonly storeSha256: string;
    readonly staticPlan: MotionRelationStaticPlan;
    readonly staticFingerprint: string;
    /** Exact T3 Browser-GPU relation-preview static admission, never renderer execution authority. */
    readonly gpuPreviewStaticPlan: {
      readonly schema: "shellx-motion/gpu-scene-relations-static@1";
      readonly fingerprint: string;
      readonly relationStaticFingerprint: string;
    };
    readonly ownedPropertyMask: readonly CheckpointStoryboardRelationOwnedProperty[];
  };
  readonly endpointEvaluations: {
    readonly start: MotionRelationFrameEvaluation;
    readonly end: MotionRelationFrameEvaluation;
  };
  readonly endpointFramePlans: {
    readonly start: MotionRelationFramePlan;
    readonly end: MotionRelationFramePlan;
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
