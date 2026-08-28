import type { MotionDocument, PackageManifest } from "../../types";
import type { CheckpointProperty, CheckpointStoryboard } from "./checkpoint-storyboard-types";

/** Source-only C6B5a lifecycle lowering. It has no package, renderer, or public ABI authority. */
export const CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_REQUEST_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-lifecycle-profile-request@1" as const;
export const CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_PLAN_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-lifecycle-profile-plan@1" as const;
export const CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-lifecycle-profile@1" as const;

export type CheckpointStoryboardLifecycleCapability = "renderer.browser" | "renderer.native";
export type CheckpointStoryboardLifecycleProperty = CheckpointProperty;

export interface CheckpointStoryboardLifecycleProfileRequest {
  readonly schema: typeof CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_REQUEST_SCHEMA;
  readonly storyboard: CheckpointStoryboard;
  /** Detached, already-observed base facts only; no package path, handle, or host authority. */
  readonly base: {
    readonly packageId: string;
    readonly manifest: PackageManifest;
    readonly motion: MotionDocument;
    readonly persistedMotionSha256: string;
  };
}

export interface CheckpointStoryboardLifecycleLayer {
  readonly id: string;
  readonly type: "shape";
  readonly shape: "rect" | "ellipse";
  readonly startMs: number;
  readonly durationMs: number;
  readonly fill: string;
  readonly opacity: number;
  readonly transform: {
    readonly x: number;
    readonly y: number;
    readonly rotation: number;
    readonly scale: number;
    readonly width: number;
    readonly height: number;
    readonly originX: number;
    readonly originY: number;
  };
}

export interface CheckpointStoryboardLifecycleProfilePlan {
  readonly schema: typeof CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_PLAN_SCHEMA;
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number; readonly fingerprint: string };
  readonly base: {
    readonly package: { readonly id: string; readonly motionPath: string };
    readonly manifest: { readonly id: string; readonly sha256: string };
    readonly canonicalMotion: { readonly id: string; readonly sha256: string };
    readonly persistedMotion: { readonly id: string; readonly sha256: string };
  };
  readonly lowererProfile: {
    readonly schema: typeof CHECKPOINT_STORYBOARD_LIFECYCLE_PROFILE_SCHEMA;
    readonly supportedCapabilities: readonly CheckpointStoryboardLifecycleCapability[];
    readonly rootShapeKinds: readonly ("rect" | "ellipse")[];
    readonly propertyMask: readonly CheckpointStoryboardLifecycleProperty[];
    readonly lifecycle: "absent-create-present-optional-remove";
    readonly fingerprint: string;
  };
  /** Catalog-order identity and timing facts; layer content is emitted separately below. */
  readonly operations: readonly {
    readonly objectId: string;
    readonly targetLayerId: string;
    readonly rootShapeKind: "rect" | "ellipse";
    readonly create: { readonly edge: { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string }; readonly atMs: number };
    readonly remove?: { readonly edge: { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string }; readonly atMs: number };
    readonly interval: { readonly startMs: number; readonly endMs: number; readonly durationMs: number };
  }[];
  /** New ordinary layers only, in exact catalog order. Source layers remain conceptual C6B5b input. */
  readonly layers: readonly CheckpointStoryboardLifecycleLayer[];
  readonly intendedChanges: {
    readonly paths: readonly ["/layers"];
    readonly layers: { readonly operation: "append"; readonly sourceLayerCount: number; readonly appendLayerIds: readonly string[] };
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
