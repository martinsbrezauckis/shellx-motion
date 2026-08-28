import type {
  CompiledSceneMaterialResource,
  GltfObjectRetainedRenderBinding,
  GltfObjectRetainedRenderFrameUpload,
  GltfObjectRetainedRenderGeometry,
  GltfObjectRetainedRenderStaticUpload,
  SceneRecipe,
} from "@shellx-motion/core/internal/scene-recipe";
import type { PhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-types-private.js";

export const PHYSICS_VISUAL_PRESENTATION_SCHEMA = "shellx-motion/physics-visual-presentation@1" as const;
export const PHYSICS_VISUAL_PRESENTATION_STATIC_SCHEMA = "shellx-motion/private-physics-visual-presentation-static@1" as const;
export const PHYSICS_VISUAL_PRESENTATION_FRAME_SCHEMA = "shellx-motion/private-physics-visual-presentation-frame@1" as const;

export const PHYSICS_VISUAL_PRESENTATION_CAPS = Object.freeze({
  width: 1_920,
  height: 1_080,
  staticCollisionBindings: 64,
  constraintBindings: 8,
  presentationBindings: 16,
  transparentPresentations: 1,
  segmentLength: 20_000,
  geometryResources: 32,
  materialResources: 32,
  instanceSlots: 256,
  vertexBytes: 16 * 1024 * 1024,
  indexBytes: 16 * 1024 * 1024,
  retainedGpuBytes: 64 * 1024 * 1024,
  staticPlanBytes: 4 * 1024 * 1024,
  framePlanBytes: 512 * 1024,
});

export interface PhysicsVisualPresentationStaticCollisionBinding {
  readonly bodyId: string;
  readonly geometryRef: string;
  readonly materialRef: string;
}

export interface PhysicsVisualPresentationConstraintBinding {
  readonly constraintId: string;
  readonly geometryRef: string;
  readonly materialRef: string;
}

export interface PhysicsVisualPresentationFixedBinding {
  readonly id: string;
  readonly geometryRef: string;
  readonly materialRef: string;
  readonly opacity: number;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

export interface PhysicsVisualPresentationRecipe {
  readonly schema: typeof PHYSICS_VISUAL_PRESENTATION_SCHEMA;
  readonly retainedStaticFingerprint: string;
  readonly physicsPlanFingerprint: string;
  readonly additionalResources: SceneRecipe["resources"];
  readonly staticCollisionBindings: readonly PhysicsVisualPresentationStaticCollisionBinding[];
  readonly constraintBindings: readonly PhysicsVisualPresentationConstraintBinding[];
  readonly presentationBindings: readonly PhysicsVisualPresentationFixedBinding[];
}

export type PhysicsVisualPresentationSlotKind = "dynamic" | "static-collision" | "constraint-display" | "presentation";

export interface PhysicsVisualPresentationStaticPlan {
  readonly schema: typeof PHYSICS_VISUAL_PRESENTATION_STATIC_SCHEMA;
  readonly recipe: PhysicsVisualPresentationRecipe;
  readonly recipeSha256: string;
  readonly source: Readonly<{
    retainedStaticFingerprint: string;
    visualBindingFingerprint: string;
    physicsPlanFingerprint: string;
    physicsRecipeSha256: string;
    retainedResourceFingerprint: string;
  }>;
  readonly resourceFingerprint: string;
  readonly bindingFingerprint: string;
  readonly geometries: readonly GltfObjectRetainedRenderGeometry[];
  readonly materials: readonly CompiledSceneMaterialResource[];
  readonly instanceSlots: readonly Readonly<{
    instanceId: string;
    primitiveRef: string;
    materialRef: string;
    kind: PhysicsVisualPresentationSlotKind;
    sourceId: string;
    renderMode?: "alpha";
  }>[];
  readonly presentation: PhysicsVisualRetainedStaticPlan["presentation"];
  readonly budget: Readonly<{
    geometryResourceCount: number;
    materialResourceCount: number;
    instanceSlotCount: number;
    staticCollisionBindingCount: number;
    constraintBindingCount: number;
    presentationBindingCount: number;
    transparentPresentationCount: number;
    reusedInstanceCount: number;
    vertexBufferBytes: number;
    indexBufferBytes: number;
    uniformBufferBytes: number;
    renderTargetBytes: number;
    depthTargetBytes: number;
    readbackBufferBytes: number;
    retainedGpuBytes: number;
    staticPlanBytes: number;
    caps: typeof PHYSICS_VISUAL_PRESENTATION_CAPS;
  }>;
  readonly evidence: Readonly<{
    exactC7b4bDynamicFrames: true;
    exactRevalidatedC7b1Physics: true;
    explicitStaticCollisionVisuals: true;
    constraintDisplaysArePresentationOnly: true;
    fixedPresentationsAffectNoPhysics: true;
    singleFinalAlphaSlot: true;
    stableInstanceUniformSlots: true;
    perFrameGpuAllocations: 0;
    rendererInvoked: false;
    pixels: false;
    packageRead: false;
    packageWritten: false;
    video: false;
  }>;
  readonly fingerprint: string;
}

export interface PhysicsVisualPresentationFramePlan {
  readonly schema: typeof PHYSICS_VISUAL_PRESENTATION_FRAME_SCHEMA;
  readonly staticFingerprint: string;
  readonly visualBindingFingerprint: string;
  readonly sourceRetainedFrameFingerprint: string;
  readonly sourcePhysicsFrameFingerprint: string;
  readonly frameIndex: number;
  readonly terminal: boolean;
  readonly time: Readonly<{ startUs: number; offsetNumeratorUs: number; denominator: number }>;
  readonly viewport: Readonly<{ width: number; height: number }>;
  readonly background: readonly [number, number, number, number];
  readonly viewProjection: readonly number[];
  readonly lighting: Readonly<{ direction: readonly [number, number, number]; color: readonly [number, number, number, number]; ambient: number; intensity: number }>;
  readonly bindings: readonly GltfObjectRetainedRenderBinding[];
  readonly constraintSegments: readonly Readonly<{ constraintId: string; start: readonly [number, number, number]; end: readonly [number, number, number]; length: number }>[];
  readonly evidence: Readonly<{ rendererInvoked: false; pixels: false; perFrameGpuAllocations: 0 }>;
  readonly fingerprint: string;
}

export type PhysicsVisualPresentationStaticUpload = GltfObjectRetainedRenderStaticUpload;
export type PhysicsVisualPresentationFrameUpload = GltfObjectRetainedRenderFrameUpload;
