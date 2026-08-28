import type { MotionScene3DMeshGeometry } from "../../scene-3d-types";
import type { GltfSourceFormat } from "../../gltf-types";

export const GLTF_OBJECT_DECLARATION_SCHEMA = "shellx-motion/gltf-object-declaration@1" as const;
export const GLTF_OBJECT_PLAN_SCHEMA = "shellx-motion/private-gltf-object-plan@1" as const;

export const GLTF_OBJECT_PLAN_CAPS = Object.freeze({
  roles: 32,
  selectedNodes: 64,
  primitiveResources: 32,
  primitiveInstances: 256,
  planBytes: 2 * 1024 * 1024,
});

export interface GltfObjectRoleDeclaration {
  readonly roleId: string;
  readonly nodeIndex: number;
  readonly expectedNodeName: string | null;
}

export interface GltfObjectDeclaration {
  readonly schema: typeof GLTF_OBJECT_DECLARATION_SCHEMA;
  readonly assetId: string;
  readonly sourceSha256: string;
  readonly roles: readonly GltfObjectRoleDeclaration[];
}

export type GltfObjectLocalTransform = Readonly<{
  kind: "trs";
  translation: readonly [number, number, number];
  rotation: readonly [number, number, number, number];
  scale: readonly [number, number, number];
}> | Readonly<{
  kind: "matrix";
  matrix: readonly number[];
}>;

export interface GltfObjectPrimitiveResource {
  readonly id: string;
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly materialIndex: number | null;
  readonly geometry: MotionScene3DMeshGeometry;
  readonly geometrySha256: string;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly byteLength: number;
}

export interface GltfObjectNode {
  readonly id: string;
  readonly nodeIndex: number;
  readonly name: string | null;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
  readonly primitiveRefs: readonly string[];
  readonly localTransform: GltfObjectLocalTransform;
  readonly localTransformSha256: string;
}

export interface GltfObjectRoleBinding extends GltfObjectRoleDeclaration {
  readonly nodeId: string;
  readonly nodePath: readonly string[];
}

export interface GltfObjectPlan {
  readonly schema: typeof GLTF_OBJECT_PLAN_SCHEMA;
  readonly declaration: GltfObjectDeclaration;
  readonly source: Readonly<{
    format: GltfSourceFormat;
    sha256: string;
    jsonSha256: string;
    bufferSha256: readonly string[];
    byteLength: number;
  }>;
  readonly sceneIndex: number;
  readonly rootNodeIds: readonly string[];
  readonly resources: Readonly<{
    primitives: readonly GltfObjectPrimitiveResource[];
    fingerprint: string;
  }>;
  readonly nodes: readonly GltfObjectNode[];
  readonly roles: readonly GltfObjectRoleBinding[];
  readonly budget: Readonly<{
    nodeCount: number;
    meshNodeCount: number;
    primitiveResourceCount: number;
    primitiveInstanceCount: number;
    reusedPrimitiveInstanceCount: number;
    uniqueGeometryBytes: number;
    expandedGeometryBytes: number;
    planBytes: number;
    caps: typeof GLTF_OBJECT_PLAN_CAPS;
  }>;
  readonly evidence: Readonly<{
    selectedSceneHierarchyPreserved: true;
    stableIndexNodeIds: true;
    localTransformsPreserved: true;
    sharedMeshResources: true;
    explicitSemanticRoles: true;
    sourceHashBound: true;
    materialSlotsIndexedOnly: true;
    rendererInvoked: false;
    packageRead: false;
    packageWritten: false;
    animationAccepted: false;
    skinAccepted: false;
    cameraAccepted: false;
    extensionsAccepted: false;
  }>;
  readonly fingerprint: string;
}
