import type { GltfObjectPrimitiveResource } from "./gltf-object-plan-types";
import type { GltfObjectStoryMaterial } from "./gltf-object-story-types";

export const GLTF_OBJECT_SCENE_SCHEMA = "shellx-motion/gltf-object-scene@1" as const;
export const GLTF_OBJECT_SCENE_PLAN_SCHEMA = "shellx-motion/private-gltf-object-scene-plan@1" as const;

export const GLTF_OBJECT_SCENE_CAPS = Object.freeze({
  nodeStateSamples: 1_024,
  primitiveInstanceSamples: 4_096,
  transformedBoundsCorners: 32_768,
  matrixComponentMagnitude: 1_000_000,
  boundsCoordinateMagnitude: 1_000_000,
  cameraDistance: 100_000_000,
  planBytes: 4 * 1024 * 1024,
});

export type GltfObjectSceneVec3 = readonly [number, number, number];

export interface GltfObjectSceneAssembly {
  readonly schema: typeof GLTF_OBJECT_SCENE_SCHEMA;
  readonly id: string;
  readonly objectFingerprint: string;
  readonly storyFingerprint: string;
  readonly camera: Readonly<{
    viewDirection: GltfObjectSceneVec3;
    fovDeg: number;
    padding: number;
  }>;
}

export interface GltfObjectSceneBounds {
  readonly min: GltfObjectSceneVec3;
  readonly max: GltfObjectSceneVec3;
  readonly center: GltfObjectSceneVec3;
  readonly radius: number;
}

export interface GltfObjectSceneCamera {
  readonly position: GltfObjectSceneVec3;
  readonly target: GltfObjectSceneVec3;
  readonly viewDirection: GltfObjectSceneVec3;
  readonly fovDeg: number;
  readonly near: number;
  readonly far: number;
  readonly padding: number;
}

export interface GltfObjectSceneNodeState {
  readonly nodeId: string;
  readonly localMatrix: readonly number[];
  readonly localMatrixSha256: string;
  readonly worldMatrix: readonly number[];
  readonly worldMatrixSha256: string;
}

export type GltfObjectSceneMaterialAssignment = Readonly<{
  kind: "source";
  materialIndex: number | null;
}> | Readonly<{
  kind: "story";
  materialRef: string;
}>;

export interface GltfObjectScenePrimitiveInstance {
  readonly id: string;
  readonly nodeId: string;
  readonly primitiveRef: string;
  readonly material: GltfObjectSceneMaterialAssignment;
}

export interface GltfObjectSceneCheckpoint {
  readonly id: string;
  readonly atUs: number;
  readonly nodeStates: readonly GltfObjectSceneNodeState[];
  readonly primitiveInstances: readonly GltfObjectScenePrimitiveInstance[];
  readonly bounds: GltfObjectSceneBounds;
  readonly camera: GltfObjectSceneCamera;
  readonly stateSha256: string;
  readonly fingerprint: string;
}

export interface GltfObjectScenePlan {
  readonly schema: typeof GLTF_OBJECT_SCENE_PLAN_SCHEMA;
  readonly assembly: GltfObjectSceneAssembly;
  readonly assemblySha256: string;
  readonly objectFingerprint: string;
  readonly storyFingerprint: string;
  readonly objectTopologyFingerprint: string;
  readonly resources: Readonly<{
    primitives: readonly GltfObjectPrimitiveResource[];
    fingerprint: string;
  }>;
  readonly materials: readonly GltfObjectStoryMaterial[];
  readonly checkpoints: readonly GltfObjectSceneCheckpoint[];
  readonly budget: Readonly<{
    nodeCount: number;
    primitiveResourceCount: number;
    primitiveInstanceCount: number;
    checkpointCount: number;
    nodeStateSampleCount: number;
    primitiveInstanceSampleCount: number;
    transformedBoundsCornerCount: number;
    planBytes: number;
    caps: typeof GLTF_OBJECT_SCENE_CAPS;
  }>;
  readonly evidence: Readonly<{
    commonDirectedScene: true;
    exactCheckpointComposition: true;
    importedLocalThenWrapper: true;
    parentWorldComposition: true;
    sharedGeometryResources: true;
    exactPrimitiveMaterialAssignment: true;
    aggregateTransformedBounds: true;
    boundedCameraFraming: true;
    importedTopologyImmutable: true;
    objectAndStoryFingerprintsBound: true;
    interpolationPerformed: false;
    physicsFieldsAccepted: false;
    rendererInvoked: false;
    packageRead: false;
    packageWritten: false;
  }>;
  readonly fingerprint: string;
}
