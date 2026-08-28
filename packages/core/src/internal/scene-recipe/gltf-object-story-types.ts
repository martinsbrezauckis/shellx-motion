import type { GltfObjectPlan } from "./gltf-object-plan-types";

export const GLTF_OBJECT_STORY_SCHEMA = "shellx-motion/gltf-object-story@1" as const;
export const GLTF_OBJECT_STORY_PLAN_SCHEMA = "shellx-motion/private-gltf-object-story-plan@1" as const;

export const GLTF_OBJECT_STORY_CAPS = Object.freeze({
  materials: 32,
  controls: 32,
  checkpoints: 16,
  stateSamples: 512,
  planBytes: 2 * 1024 * 1024,
});

export interface GltfObjectStoryMaterial {
  readonly id: string;
  readonly kind: "basic";
  readonly baseColor: string;
  readonly emissive: number;
}

export type GltfObjectStoryControl = Readonly<{
  id: string;
  kind: "transform";
  roleId: string;
}> | Readonly<{
  id: string;
  kind: "material";
  roleId: string;
  primitiveRef: string;
}>;

export type GltfObjectStoryState = Readonly<{
  controlId: string;
  value: Readonly<{
    translation: readonly [number, number, number];
    rotationDeg: readonly [number, number, number];
    scale: number;
  }>;
}> | Readonly<{
  controlId: string;
  value: Readonly<{ materialRef: string }>;
}>;

export interface GltfObjectStoryCheckpoint {
  readonly id: string;
  readonly atUs: number;
  readonly states: readonly GltfObjectStoryState[];
}

export interface GltfObjectStory {
  readonly schema: typeof GLTF_OBJECT_STORY_SCHEMA;
  readonly objectFingerprint: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly materials: readonly GltfObjectStoryMaterial[];
  readonly controls: readonly GltfObjectStoryControl[];
  readonly checkpoints: readonly GltfObjectStoryCheckpoint[];
}

export type CompiledGltfObjectStoryControl = GltfObjectStoryControl & Readonly<{ nodeId: string }>;

export type CompiledGltfObjectStoryState = GltfObjectStoryState & Readonly<{
  nodeId: string;
  primitiveRef: string | null;
}>;

export interface CompiledGltfObjectStoryCheckpoint {
  readonly id: string;
  readonly atUs: number;
  readonly states: readonly CompiledGltfObjectStoryState[];
  readonly stateSha256: string;
}

export interface GltfObjectStoryPlan {
  readonly schema: typeof GLTF_OBJECT_STORY_PLAN_SCHEMA;
  readonly objectFingerprint: string;
  readonly objectTopologyFingerprint: string;
  readonly story: GltfObjectStory;
  readonly storySha256: string;
  readonly materials: readonly GltfObjectStoryMaterial[];
  readonly controls: readonly CompiledGltfObjectStoryControl[];
  readonly checkpoints: readonly CompiledGltfObjectStoryCheckpoint[];
  readonly budget: Readonly<{
    materialCount: number;
    transformControlCount: number;
    materialControlCount: number;
    checkpointCount: number;
    stateSampleCount: number;
    planBytes: number;
    caps: typeof GLTF_OBJECT_STORY_CAPS;
  }>;
  readonly evidence: Readonly<{
    exactCheckpointStates: true;
    explicitRoleAddressing: true;
    wrapperTransformsOnly: true;
    materialSlotsExplicit: true;
    importedTopologyImmutable: true;
    importedGeometryImmutable: true;
    objectFingerprintBound: true;
    rendererInvoked: false;
    packageRead: false;
    packageWritten: false;
  }>;
  readonly fingerprint: string;
}

export type GltfObjectPlanForStory = Pick<GltfObjectPlan, "schema" | "fingerprint" | "rootNodeIds" | "resources" | "nodes" | "roles" | "evidence">;
