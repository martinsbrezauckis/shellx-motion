/** Private C6B6b receipt constants and inert evidence shapes. */
export const C6B6B_RECEIPT_PATH = "receipts/checkpoint-storyboard-geometry-morph.materialize.receipt.json" as const;
export const C6B6B_LOGICAL_MOTION_PATH = "/layers/0/geometryKeyframes" as const;
export const C6B6B_RECEIPT_SCHEMA = "shellx-motion/private-checkpoint-storyboard-geometry-morph-materialization-receipt@1" as const;
export const C6B6B_RECEIPT_OPERATION = "checkpoint-storyboard.geometry-morph.materialize" as const;

export interface C6B6bInventory { readonly sha256: string; readonly entryCount: number; readonly leafCount: number; }
export interface C6B6bGeometry {
  readonly schema: "shellx-motion/shape-geometry@1";
  readonly kind: "polygon";
  readonly viewBox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly points: readonly [{ readonly x: number; readonly y: number }, { readonly x: number; readonly y: number }, { readonly x: number; readonly y: number }];
}
export interface C6B6bProjectionIdentity {
  readonly sourceLayerId: string;
  readonly sourceLayerIndex: 0;
  readonly sourceGeometrySha256: string;
  readonly sourceGeometryKeyframes: "absent";
  readonly materializedGeometryKeyframesSha256: string;
  readonly endpointSequenceSha256: string;
  readonly topologySha256: string;
  readonly areaProofSha256: string;
}
export interface C6B6bExactBase {
  readonly packageId: string;
  readonly manifestRawSha256: string;
  readonly motionRawSha256: string;
  readonly manifestCanonicalSha256: string;
  readonly motionCanonicalSha256: string;
  readonly inventory: C6B6bInventory;
  readonly planFingerprint: string;
  readonly profileFingerprint: string;
  readonly storyboardId: string;
  readonly storyboardSha256: string;
  readonly storyboardRevision: number;
  readonly sourceLayerId: string;
  readonly sourceLayerIndex: number;
  readonly sourceGeometrySha256: string;
  /** This own-property fact is intentionally not compressed into a sentinel hash. */
  readonly sourceGeometryKeyframes: "absent";
  readonly materializedGeometryKeyframesSha256: string;
  /** Canonical identity of the only permitted post-write Motion document. */
  readonly outputCanonicalMotionSha256: string;
}
export interface C6B6bPlanEvidence {
  readonly schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-profile-plan@1";
  readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number; readonly fingerprint: string };
  readonly base: {
    readonly package: { readonly id: string; readonly motionPath: string };
    readonly manifest: { readonly id: string; readonly sha256: string };
    readonly canonicalMotion: { readonly id: string; readonly sha256: string };
    readonly persistedMotion: { readonly id: string; readonly sha256: string };
  };
  readonly lowererProfile: {
    readonly schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-profile@1";
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
    readonly path: typeof C6B6B_LOGICAL_MOTION_PATH;
    readonly staticGeometry: { readonly sha256: string; readonly geometry: C6B6bGeometry };
    readonly endpoints: readonly [
      { readonly atUs: number; readonly geometry: C6B6bGeometry; readonly sha256: string; readonly evaluationFingerprint: string },
      { readonly atUs: number; readonly geometry: C6B6bGeometry; readonly sha256: string; readonly evaluationFingerprint: string },
    ];
    readonly geometryKeyframes: { readonly schema: "shellx-motion/shape-geometry-keyframes@1"; readonly keyframes: readonly [
      { readonly atUs: number; readonly geometry: C6B6bGeometry; readonly easing: "linear" },
      { readonly atUs: number; readonly geometry: C6B6bGeometry },
    ] };
    readonly topology: { readonly kind: "polygon"; readonly viewBoxSha256: string; readonly pointCount: 3; readonly correspondence: "ordinal" };
    readonly areaProof: { readonly polynomial: { readonly constant: number; readonly linear: number; readonly quadratic: number }; readonly orientation: "clockwise" | "counterclockwise"; readonly minimumAbsoluteTwiceArea: number; readonly witnessTimes: readonly number[]; readonly witnessTwiceAreas: readonly number[] };
  };
  readonly intendedChanges: { readonly paths: readonly [typeof C6B6B_LOGICAL_MOTION_PATH]; readonly geometryKeyframes: { readonly operation: "replace-absent"; readonly keyframeCount: 2 } };
  readonly budget: { readonly objects: 1; readonly checkpoints: 2; readonly edges: 1; readonly recipes: 1; readonly snapshots: 2; readonly interpolationScalars: 6; readonly changedPaths: 1 };
  readonly evidence: { readonly noPackageIO: true; readonly noPackageWrites: true; readonly noCOW: true; readonly noReceipt: true; readonly noPublicSurface: true; readonly noRenderer: true };
  readonly fingerprint: string;
}
export interface CheckpointStoryboardGeometryMorphMaterializationReceipt {
  readonly schema: typeof C6B6B_RECEIPT_SCHEMA;
  readonly operation: typeof C6B6B_RECEIPT_OPERATION;
  readonly status: "passed";
  readonly approval: {
    readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number; readonly record: unknown };
    readonly plan: C6B6bPlanEvidence;
    readonly projection: C6B6bProjectionIdentity;
  };
  readonly base: { readonly expected: C6B6bExactBase; readonly reopened: C6B6bExactBase };
  readonly output: {
    readonly packageId: string;
    readonly manifestRawSha256: string;
    readonly manifestCanonicalSha256: string;
    readonly motionRawSha256: string;
    readonly canonicalMotionSha256: string;
    /** Full output inventory excluding the self-referential fixed receipt. */
    readonly nonReceiptInventory: C6B6bInventory;
    readonly preservedLeaves: { readonly sha256: string; readonly count: number };
    readonly changed: { readonly paths: readonly [string, typeof C6B6B_RECEIPT_PATH] | readonly [typeof C6B6B_RECEIPT_PATH, string]; readonly count: 2; readonly motionPropertyPaths: readonly [typeof C6B6B_LOGICAL_MOTION_PATH]; readonly motionPropertyPathCount: 1 };
  };
  readonly transaction: { readonly cow: "closed-inventory-finalize-after-edit"; readonly installed: true; readonly exclusiveReceipt: true; readonly workspaceCleanup: "not-attested" };
  readonly renderer: { readonly invoked: false; readonly pixels: false };
  readonly fingerprint: string;
}
