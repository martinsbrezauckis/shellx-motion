import type { PackageManifest, MotionDocument } from "../../types";
import type { CheckpointStoryboard } from "./checkpoint-storyboard-types";

/** Source-only C6B6a geometry-morph compiler. It owns no package, renderer, or public ABI. */
export const CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_REQUEST_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-geometry-morph-profile-request@1" as const;
export const CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_PLAN_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-geometry-morph-profile-plan@1" as const;
export const CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-geometry-morph-profile@1" as const;

export interface CheckpointStoryboardGeometryMorphProfileBinding {
  readonly objectId: string;
  readonly layerId: string;
}

export interface CheckpointStoryboardGeometryMorphProfileRequest {
  readonly schema: typeof CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_REQUEST_SCHEMA;
  readonly storyboard: CheckpointStoryboard;
  /** Detached observed facts only. Package-relative locators are inert data; host paths, handles, and authority are absent. */
  readonly base: {
    readonly packageId: string;
    readonly manifest: PackageManifest;
    readonly motion: MotionDocument;
    readonly persistedMotionSha256: string;
  };
  readonly objectLayerBindings: readonly [CheckpointStoryboardGeometryMorphProfileBinding];
}

export interface CheckpointStoryboardGeometryMorphAreaProof {
  readonly polynomial: { readonly constant: number; readonly linear: number; readonly quadratic: number };
  readonly orientation: "clockwise" | "counterclockwise";
  readonly minimumAbsoluteTwiceArea: number;
  readonly witnessTimes: readonly number[];
  readonly witnessTwiceAreas: readonly number[];
}

/** The only runtime-admitted C6B6a geometry snapshot: a frozen ordinal triangle. */
export interface CheckpointStoryboardGeometryMorphTriangle {
  readonly schema: "shellx-motion/shape-geometry@1";
  readonly kind: "polygon";
  readonly viewBox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly points: readonly [
    { readonly x: number; readonly y: number },
    { readonly x: number; readonly y: number },
    { readonly x: number; readonly y: number },
  ];
}

/** Exact two-snapshot geometry sequence emitted by the sealed C6B6a profile. */
export interface CheckpointStoryboardGeometryMorphKeyframes {
  readonly schema: "shellx-motion/shape-geometry-keyframes@1";
  readonly keyframes: readonly [
    { readonly atUs: number; readonly geometry: CheckpointStoryboardGeometryMorphTriangle; readonly easing: "linear" },
    { readonly atUs: number; readonly geometry: CheckpointStoryboardGeometryMorphTriangle },
  ];
}

export interface CheckpointStoryboardGeometryMorphProfilePlan {
  readonly schema: typeof CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_PLAN_SCHEMA;
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number; readonly fingerprint: string };
  readonly base: {
    readonly package: { readonly id: string; readonly motionPath: string };
    readonly manifest: { readonly id: string; readonly sha256: string };
    readonly canonicalMotion: { readonly id: string; readonly sha256: string };
    readonly persistedMotion: { readonly id: string; readonly sha256: string };
  };
  readonly lowererProfile: {
    readonly schema: typeof CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_PROFILE_SCHEMA;
    readonly requiredCapability: "renderer.gpu";
    readonly rootShapeKind: "geometry";
    readonly geometryKind: "polygon";
    readonly pointCount: 3;
    readonly correspondence: "ordinal";
    readonly easing: "linear";
    readonly lifecycle: "preserve";
    readonly ownedWriteMask: readonly ["geometry"];
    readonly fingerprint: string;
  };
  readonly objectLayerBinding: { readonly objectId: string; readonly layerId: string; readonly layerIndex: 0; readonly rootShapeKind: "geometry" };
  readonly projection: {
    readonly edge: { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string };
    readonly recipe: { readonly id: string; readonly sha256: string; readonly revision: number; readonly recipeId: string };
    readonly path: "/layers/0/geometryKeyframes";
    readonly staticGeometry: { readonly sha256: string; readonly geometry: CheckpointStoryboardGeometryMorphTriangle };
    readonly endpoints: readonly [
      { readonly atUs: number; readonly geometry: CheckpointStoryboardGeometryMorphTriangle; readonly sha256: string; readonly evaluationFingerprint: string },
      { readonly atUs: number; readonly geometry: CheckpointStoryboardGeometryMorphTriangle; readonly sha256: string; readonly evaluationFingerprint: string },
    ];
    readonly geometryKeyframes: CheckpointStoryboardGeometryMorphKeyframes;
    readonly topology: { readonly kind: "polygon"; readonly viewBoxSha256: string; readonly pointCount: 3; readonly correspondence: "ordinal" };
    readonly areaProof: CheckpointStoryboardGeometryMorphAreaProof;
  };
  readonly intendedChanges: { readonly paths: readonly ["/layers/0/geometryKeyframes"]; readonly geometryKeyframes: { readonly operation: "replace-absent"; readonly keyframeCount: 2 } };
  readonly budget: { readonly objects: 1; readonly checkpoints: 2; readonly edges: 1; readonly recipes: 1; readonly snapshots: 2; readonly interpolationScalars: 6; readonly changedPaths: 1 };
  readonly evidence: { readonly noPackageIO: true; readonly noPackageWrites: true; readonly noCOW: true; readonly noReceipt: true; readonly noPublicSurface: true; readonly noRenderer: true };
  readonly fingerprint: string;
}
