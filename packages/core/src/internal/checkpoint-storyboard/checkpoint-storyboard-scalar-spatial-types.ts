import type { PackageManifest, MotionDocument } from "../../types";
import type { CheckpointProperty, CheckpointStoryboard } from "./checkpoint-storyboard-types";

/**
 * Private C6B1a input and plan boundary. This is deliberately direct-import-only: it receives
 * already-observed package facts and never opens, changes, or claims a Motion package.
 */
export const CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA = "shellx-motion/private-checkpoint-storyboard-scalar-spatial-request@1" as const;
export const CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_PLAN_SCHEMA = "shellx-motion/private-checkpoint-storyboard-scalar-spatial-plan@1" as const;
export const CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_LOWERER_PROFILE_SCHEMA = "shellx-motion/private-checkpoint-storyboard-scalar-spatial-lowerer-profile@1" as const;

export type CheckpointScalarProperty = Extract<CheckpointProperty, "transform.rotation" | "transform.scale" | "opacity">;
export type CheckpointScalarSpatialCapability = "renderer.browser" | "renderer.native";

export interface CheckpointStoryboardScalarSpatialBinding {
  readonly objectId: string;
  readonly layerId: string;
}

/**
 * `persistedMotionSha256` is a host-observed raw persisted-byte identity. The compiler separately
 * computes `canonicalMotion` from its detached input, so a later exact-base COW seam can bind both.
 */
export interface CheckpointStoryboardScalarSpatialRequest {
  readonly schema: typeof CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_REQUEST_SCHEMA;
  readonly storyboard: CheckpointStoryboard;
  readonly base: {
    readonly packageId: string;
    readonly manifest: PackageManifest;
    readonly motion: MotionDocument;
    readonly persistedMotionSha256: string;
  };
  readonly objectLayerBindings: readonly CheckpointStoryboardScalarSpatialBinding[];
}

export interface CheckpointStoryboardScalarSpatialKeyframe {
  readonly atMs: number;
  readonly value: number;
  readonly easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out";
  readonly spatial?: {
    readonly mode: "linear" | "auto";
    readonly in: { readonly x: 0; readonly y: 0 };
    readonly out: { readonly x: 0; readonly y: 0 };
  };
}

export type CheckpointStoryboardScalarSpatialLowering =
  | {
    readonly kind: "checkpoint-keyframe";
    readonly edge: { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string };
    readonly recipe: { readonly id: string; readonly sha256: string; readonly revision: number; readonly recipeId: string };
    readonly object: { readonly objectId: string; readonly layerId: string; readonly layerIndex: number };
    readonly properties: readonly {
      readonly property: CheckpointScalarProperty;
      readonly keyframes: readonly [CheckpointStoryboardScalarSpatialKeyframe, CheckpointStoryboardScalarSpatialKeyframe];
    }[];
  }
  | {
    readonly kind: "checkpoint-spatial-path";
    readonly edge: { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string };
    readonly recipe: { readonly id: string; readonly sha256: string; readonly revision: number; readonly recipeId: string };
    readonly object: { readonly objectId: string; readonly layerId: string; readonly layerIndex: number };
    readonly tangentMode: "linear" | "auto";
    readonly keyframes: {
      readonly x: readonly [CheckpointStoryboardScalarSpatialKeyframe, CheckpointStoryboardScalarSpatialKeyframe];
      readonly y: readonly [CheckpointStoryboardScalarSpatialKeyframe, CheckpointStoryboardScalarSpatialKeyframe];
    };
  };

export interface CheckpointStoryboardScalarSpatialPlan {
  readonly schema: typeof CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_PLAN_SCHEMA;
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number; readonly fingerprint: string };
  readonly base: {
    readonly package: { readonly id: string; readonly motionPath: string };
    readonly manifest: { readonly id: string; readonly sha256: string };
    readonly canonicalMotion: { readonly id: string; readonly sha256: string };
    readonly persistedMotion: { readonly id: string; readonly sha256: string };
  };
  readonly lowererProfile: {
    readonly schema: typeof CHECKPOINT_STORYBOARD_SCALAR_SPATIAL_LOWERER_PROFILE_SCHEMA;
    readonly supportedCapabilities: readonly CheckpointScalarSpatialCapability[];
    readonly scalarProperties: readonly CheckpointScalarProperty[];
    readonly spatialTangentModes: readonly ("linear" | "auto")[];
    readonly fingerprint: string;
  };
  readonly objectLayerBindings: readonly {
    readonly objectId: string;
    readonly layerId: string;
    readonly layerIndex: number;
    readonly rootShapeKind: "rect" | "ellipse";
  }[];
  readonly lowerings: readonly CheckpointStoryboardScalarSpatialLowering[];
  readonly intendedChanges: {
    readonly paths: readonly string[];
    readonly keys: readonly { readonly path: string; readonly atMs: number; readonly value: number }[];
  };
  readonly evidence: {
    readonly noPackageIO: true;
    readonly noPackageWrites: true;
    readonly noReceipt: true;
    readonly noPublicSurface: true;
    readonly noRenderer: true;
  };
  readonly fingerprint: string;
}
