import type { GltfObjectSceneCheckpoint } from "./gltf-object-scene-types";

export const GLTF_OBJECT_SCENE_EVALUATION_SCHEMA = "shellx-motion/gltf-object-scene-evaluation@1" as const;
export const GLTF_OBJECT_SCENE_EVALUATION_PLAN_SCHEMA = "shellx-motion/private-gltf-object-scene-evaluation-plan@1" as const;
export const GLTF_OBJECT_SCENE_FRAME_SCHEMA = "shellx-motion/private-gltf-object-scene-frame@1" as const;

export const GLTF_OBJECT_SCENE_EVALUATION_CAPS = Object.freeze({
  segments: 15,
  controlPolicies: 480,
  planBytes: 1024 * 1024,
});

export type GltfObjectSceneTransformInterpolation = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold";

export type GltfObjectSceneEvaluationControl = Readonly<{
  controlId: string;
  kind: "transform";
  interpolation: GltfObjectSceneTransformInterpolation;
}> | Readonly<{
  controlId: string;
  kind: "material";
  switchAtUs: number;
}>;

export interface GltfObjectSceneEvaluationSegment {
  readonly id: string;
  readonly fromCheckpointId: string;
  readonly toCheckpointId: string;
  readonly controls: readonly GltfObjectSceneEvaluationControl[];
}

export interface GltfObjectSceneEvaluation {
  readonly schema: typeof GLTF_OBJECT_SCENE_EVALUATION_SCHEMA;
  readonly sceneFingerprint: string;
  readonly segments: readonly GltfObjectSceneEvaluationSegment[];
}

export type CompiledGltfObjectSceneEvaluationControl = GltfObjectSceneEvaluationControl & Readonly<{
  nodeId: string;
  primitiveRef: string | null;
}>;

export interface CompiledGltfObjectSceneEvaluationSegment {
  readonly id: string;
  readonly fromCheckpointId: string;
  readonly toCheckpointId: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly controls: readonly CompiledGltfObjectSceneEvaluationControl[];
  readonly fingerprint: string;
}

export interface GltfObjectSceneEvaluationPlan {
  readonly schema: typeof GLTF_OBJECT_SCENE_EVALUATION_PLAN_SCHEMA;
  readonly evaluation: GltfObjectSceneEvaluation;
  readonly evaluationSha256: string;
  readonly objectFingerprint: string;
  readonly storyFingerprint: string;
  readonly sceneFingerprint: string;
  readonly segments: readonly CompiledGltfObjectSceneEvaluationSegment[];
  readonly budget: Readonly<{
    segmentCount: number;
    transformPolicyCount: number;
    materialPolicyCount: number;
    controlPolicyCount: number;
    planBytes: number;
    caps: typeof GLTF_OBJECT_SCENE_EVALUATION_CAPS;
  }>;
  readonly evidence: Readonly<{
    completeOrderedSegmentPolicies: true;
    exactCheckpointIdentityPreserved: true;
    explicitTransformInterpolation: true;
    explicitMaterialSwitchTimes: true;
    degreeSpaceRotationPreserved: true;
    hierarchyBoundsAndCameraReevaluated: true;
    compilerMintedRuntimeAuthority: true;
    scriptsAccepted: false;
    physicsFieldsAccepted: false;
    rendererInvoked: false;
    packageRead: false;
    packageWritten: false;
  }>;
  readonly fingerprint: string;
}

export interface GltfObjectSceneFrame {
  readonly schema: typeof GLTF_OBJECT_SCENE_FRAME_SCHEMA;
  readonly evaluationFingerprint: string;
  readonly sceneFingerprint: string;
  readonly atUs: number;
  readonly checkpointId: string | null;
  readonly segmentId: string | null;
  readonly segmentProgress: number | null;
  readonly scene: GltfObjectSceneCheckpoint;
  readonly fingerprint: string;
}

export type GltfObjectSceneFrameResult = Readonly<{
  ok: true;
  frame: GltfObjectSceneFrame;
}> | Readonly<{
  ok: false;
  message: string;
}>;
