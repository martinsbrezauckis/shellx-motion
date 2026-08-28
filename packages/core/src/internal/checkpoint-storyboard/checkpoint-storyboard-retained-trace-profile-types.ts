import type { MotionParametricTracePlan } from "../../motion-parametric-trace-types";
import type { MotionDocument, PackageManifest } from "../../types";
import type { CheckpointStoryboard } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-types";

/** Shipping-private C6B7 compiler contract. It persists no pixels and issues no renderer authority. */
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_REQUEST_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-retained-trace-profile-request@1" as const;
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_PLAN_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-retained-trace-profile-plan@1" as const;
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-retained-trace-profile@1" as const;

/** The B7a ceiling is deliberately far below generic C4C admission. */
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS = Object.freeze({
  maxSamples: 64,
  maxVertices: 64,
  maxWorkUnits: 16_384,
  maxBytes: 128 * 1024,
});

export interface CheckpointStoryboardRetainedTraceProfileBinding {
  readonly objectId: string;
  readonly layerId: string;
}

export interface CheckpointStoryboardRetainedTraceProfileRequest {
  readonly schema: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_REQUEST_SCHEMA;
  readonly storyboard: CheckpointStoryboard;
  /** Detached observed facts only. Package-relative locators are inert data; host authority is absent. */
  readonly base: {
    readonly packageId: string;
    readonly manifest: PackageManifest;
    readonly motion: MotionDocument;
    readonly persistedMotionSha256: string;
  };
  readonly objectLayerBindings: readonly [CheckpointStoryboardRetainedTraceProfileBinding];
}

export interface CheckpointStoryboardRetainedTraceProfilePlan {
  readonly schema: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_PLAN_SCHEMA;
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number; readonly fingerprint: string };
  readonly base: {
    readonly package: { readonly id: string; readonly motionPath: string };
    readonly manifest: { readonly id: string; readonly sha256: string };
    readonly canonicalMotion: { readonly id: string; readonly sha256: string };
    readonly persistedMotion: { readonly id: string; readonly sha256: string };
  };
  readonly lowererProfile: {
    readonly schema: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_SCHEMA;
    readonly requiredCapability: "renderer.gpu";
    readonly rootShapeKind: "rect";
    readonly checkpointPropertyMask: readonly ["opacity"];
    readonly lifecycle: "preserve";
    readonly drawerCount: 1;
    readonly driverKind: "parametric-graph";
    readonly retention: "full-clip";
    readonly outputMode: "line";
    readonly signals: "constant";
    readonly caps: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_PROFILE_CAPS;
    readonly fingerprint: string;
  };
  readonly objectLayerBinding: {
    readonly objectId: string;
    readonly layerId: string;
    readonly layerIndex: 0;
    readonly rootShapeKind: "rect";
    readonly staticOpacity: number;
  };
  /** This is a frozen C4C planning artifact, not a Motion document write or GPU execution wrapper. */
  readonly projection: {
    readonly edge: { readonly id: string; readonly fromCheckpointId: string; readonly toCheckpointId: string };
    readonly recipe: { readonly id: string; readonly sha256: string; readonly revision: number; readonly recipeId: string };
    readonly outputObjectId: string;
    readonly trace: MotionParametricTracePlan;
  };
  readonly budget: {
    readonly objects: 1;
    readonly checkpoints: 2;
    readonly edges: 1;
    readonly recipes: 1;
    readonly scheduleSamples: number;
    readonly vertices: number;
    readonly compileWorkUnits: number;
    readonly storageBytes: number;
    readonly peakBytes: number;
  };
  readonly evidence: {
    readonly noPackageIO: true;
    readonly noPackageWrites: true;
    readonly noCOW: true;
    readonly noReceipt: true;
    readonly noPublicSurface: true;
    readonly noRenderer: true;
    readonly noGpuExecutionWrapper: true;
  };
  readonly fingerprint: string;
}
