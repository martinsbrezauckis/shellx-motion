import type { GltfObjectSceneFrame } from "./gltf-object-scene-evaluation-types";

export const GLTF_OBJECT_RETAINED_RENDER_SCHEMA = "shellx-motion/gltf-object-retained-render@1" as const;
export const GLTF_OBJECT_RETAINED_RENDER_STATIC_SCHEMA = "shellx-motion/private-gltf-object-retained-render-static@1" as const;
export const GLTF_OBJECT_RETAINED_RENDER_FRAME_SCHEMA = "shellx-motion/private-gltf-object-retained-render-frame@1" as const;

export const GLTF_OBJECT_RETAINED_RENDER_CAPS = Object.freeze({
  width: 1_920,
  height: 1_080,
  geometryResources: 32,
  instanceSlots: 256,
  vertexBytes: 16 * 1024 * 1024,
  indexBytes: 16 * 1024 * 1024,
  staticPlanBytes: 4 * 1024 * 1024,
});

export interface GltfObjectRetainedRenderSourceMaterial {
  readonly materialIndex: number | null;
  readonly baseColor: string;
  readonly emissive: number;
}

export interface GltfObjectRetainedRenderRecipe {
  readonly schema: typeof GLTF_OBJECT_RETAINED_RENDER_SCHEMA;
  readonly evaluationFingerprint: string;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly backgroundColor: string;
  readonly lighting: Readonly<{
    direction: readonly [number, number, number];
    color: string;
    ambient: number;
    intensity: number;
  }>;
  readonly sourceMaterials: readonly GltfObjectRetainedRenderSourceMaterial[];
}

export interface GltfObjectRetainedRenderGeometry {
  readonly id: string;
  readonly geometrySha256: string;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly vertices: readonly number[];
  readonly indices: readonly number[];
  readonly vertexBufferSha256: string;
  readonly indexBufferSha256: string;
  readonly vertexBufferBytes: number;
  readonly indexBufferBytes: number;
}

export interface GltfObjectRetainedRenderStaticPlan {
  readonly schema: typeof GLTF_OBJECT_RETAINED_RENDER_STATIC_SCHEMA;
  readonly recipe: GltfObjectRetainedRenderRecipe;
  readonly evaluationFingerprint: string;
  readonly objectFingerprint: string;
  readonly sceneFingerprint: string;
  readonly geometries: readonly GltfObjectRetainedRenderGeometry[];
  readonly instanceSlots: readonly Readonly<{ instanceId: string; primitiveRef: string }>[];
  readonly budget: Readonly<{
    geometryResourceCount: number;
    instanceSlotCount: number;
    reusedInstanceCount: number;
    vertexBufferBytes: number;
    indexBufferBytes: number;
    uniformBufferBytes: number;
    renderTargetBytes: number;
    depthTargetBytes: number;
    readbackBufferBytes: number;
    retainedGpuBytes: number;
    staticPlanBytes: number;
    caps: typeof GLTF_OBJECT_RETAINED_RENDER_CAPS;
  }>;
  readonly evidence: Readonly<{
    sharedGeometryRetainedOnce: true;
    stableInstanceUniformSlots: true;
    exactEvaluatedFramesOnly: true;
    perFrameGpuAllocations: 0;
    explicitTerminalReleaseRequired: true;
    rendererInvoked: false;
    packageRead: false;
    packageWritten: false;
    physicsInvoked: false;
  }>;
  readonly fingerprint: string;
}

export interface GltfObjectRetainedRenderBinding {
  readonly instanceId: string;
  readonly primitiveRef: string;
  readonly modelMatrix: readonly number[];
  readonly color: readonly [number, number, number, number];
  readonly emissive: number;
}

export interface GltfObjectRetainedRenderFramePlan {
  readonly schema: typeof GLTF_OBJECT_RETAINED_RENDER_FRAME_SCHEMA;
  readonly staticFingerprint: string;
  readonly evaluationFingerprint: string;
  readonly sourceFrameFingerprint: string;
  readonly atUs: number;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly background: readonly [number, number, number, number];
  readonly viewProjection: readonly number[];
  readonly lighting: Readonly<{
    direction: readonly [number, number, number];
    color: readonly [number, number, number, number];
    ambient: number;
    intensity: number;
  }>;
  readonly bindings: readonly GltfObjectRetainedRenderBinding[];
  readonly fingerprint: string;
}

export interface GltfObjectRetainedRenderStaticUpload {
  readonly schema: "shellx-motion/private-gltf-object-retained-render-static-upload@1";
  readonly staticFingerprint: string;
  readonly width: number;
  readonly height: number;
  readonly geometries: readonly Readonly<{
    id: string;
    vertexCount: number;
    indexCount: number;
    vertexBufferSha256: string;
    indexBufferSha256: string;
    vertexBufferBytes: number;
    indexBufferBytes: number;
    verticesBase64: string;
    indicesBase64: string;
  }>[];
  readonly instanceSlots: readonly Readonly<{ instanceId: string; primitiveRef: string; renderMode?: "alpha" }>[];
  readonly budget: GltfObjectRetainedRenderStaticPlan["budget"];
}

export interface GltfObjectRetainedRenderFrameUpload extends Omit<GltfObjectRetainedRenderFramePlan, "schema"> {
  readonly schema: "shellx-motion/private-gltf-object-retained-render-frame-upload@1";
}

export type GltfObjectRetainedRenderFrameSource = GltfObjectSceneFrame;
