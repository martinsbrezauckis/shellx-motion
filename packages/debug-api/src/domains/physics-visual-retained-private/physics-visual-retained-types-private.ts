import type {
  GltfObjectRetainedRenderFrameUpload,
  GltfObjectRetainedRenderGeometry,
  GltfObjectRetainedRenderStaticUpload,
  RetainedMeshCamera,
} from "@shellx-motion/core/internal/scene-recipe";

export const PHYSICS_VISUAL_RETAINED_SCHEMA = "shellx-motion/physics-visual-retained-render@1" as const;
export const PHYSICS_VISUAL_RETAINED_STATIC_SCHEMA = "shellx-motion/private-physics-visual-retained-static@1" as const;
export const PHYSICS_VISUAL_RETAINED_FRAME_SCHEMA = "shellx-motion/private-physics-visual-retained-frame@1" as const;

export const PHYSICS_VISUAL_RETAINED_CAPS = Object.freeze({
  width: 1_920,
  height: 1_080,
  geometryResources: 32,
  instanceSlots: 256,
  vertexBytes: 16 * 1024 * 1024,
  indexBytes: 16 * 1024 * 1024,
  retainedGpuBytes: 64 * 1024 * 1024,
  staticPlanBytes: 4 * 1024 * 1024,
  framePlanBytes: 512 * 1024,
});

export interface PhysicsVisualRetainedRecipe {
  readonly schema: typeof PHYSICS_VISUAL_RETAINED_SCHEMA;
  readonly visualBindingFingerprint: string;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly backgroundColor: string;
  readonly camera: RetainedMeshCamera;
  readonly lighting: Readonly<{
    direction: readonly [number, number, number];
    color: string;
    ambient: number;
    intensity: number;
  }>;
}

export interface PhysicsVisualRetainedStaticPlan {
  readonly schema: typeof PHYSICS_VISUAL_RETAINED_STATIC_SCHEMA;
  readonly recipe: PhysicsVisualRetainedRecipe;
  readonly recipeSha256: string;
  readonly source: Readonly<{
    visualBindingFingerprint: string;
    physicsPlanFingerprint: string;
    durableManifestFingerprint: string;
    visualResourceFingerprint: string;
    compiledResourceFingerprint: string;
  }>;
  readonly geometries: readonly GltfObjectRetainedRenderGeometry[];
  readonly instanceSlots: readonly Readonly<{ instanceId: string; primitiveRef: string; materialRef: string }>[];
  readonly presentation: Readonly<{
    background: readonly [number, number, number, number];
    viewProjection: readonly number[];
    lighting: Readonly<{ direction: readonly [number, number, number]; color: readonly [number, number, number, number]; ambient: number; intensity: number }>;
  }>;
  readonly budget: Readonly<{
    geometryResourceCount: number;
    materialResourceCount: number;
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
    caps: typeof PHYSICS_VISUAL_RETAINED_CAPS;
  }>;
  readonly evidence: Readonly<{
    exactC7b4aFramesOnly: true;
    sharedC7aGeometryCompiler: true;
    sharedRetainedIndexedMeshKernel: true;
    stableInstanceUniformSlots: true;
    perFrameGpuAllocations: 0;
    explicitTerminalReleaseRequired: true;
    rendererInvoked: false;
    pixels: false;
    packageRead: false;
    packageWritten: false;
    video: false;
  }>;
  readonly fingerprint: string;
}

export interface PhysicsVisualRetainedFramePlan {
  readonly schema: typeof PHYSICS_VISUAL_RETAINED_FRAME_SCHEMA;
  readonly staticFingerprint: string;
  readonly visualBindingFingerprint: string;
  readonly sourceFrameFingerprint: string;
  readonly frameIndex: number;
  readonly terminal: boolean;
  readonly time: Readonly<{ startUs: number; offsetNumeratorUs: number; denominator: number }>;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly background: readonly [number, number, number, number];
  readonly viewProjection: readonly number[];
  readonly lighting: Readonly<{ direction: readonly [number, number, number]; color: readonly [number, number, number, number]; ambient: number; intensity: number }>;
  readonly bindings: readonly Readonly<{ instanceId: string; primitiveRef: string; modelMatrix: readonly number[]; color: readonly [number, number, number, number]; emissive: number }>[];
  readonly evidence: Readonly<{ rendererInvoked: false; pixels: false; perFrameGpuAllocations: 0 }>;
  readonly fingerprint: string;
}

export type PhysicsVisualRetainedStaticUpload = GltfObjectRetainedRenderStaticUpload;
export type PhysicsVisualRetainedFrameUpload = GltfObjectRetainedRenderFrameUpload;
