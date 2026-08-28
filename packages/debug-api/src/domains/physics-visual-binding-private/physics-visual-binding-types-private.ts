import type { SceneRecipe } from "@shellx-motion/core/internal/scene-recipe";
import type { PhysicsBakeDurableReopenHost } from "../physics-bake-durable-private/physics-bake-durable-types-private.js";

export const PHYSICS_VISUAL_BINDING_SCHEMA = "shellx-motion/physics-visual-binding@1" as const;
export const PHYSICS_VISUAL_BINDING_PLAN_SCHEMA = "shellx-motion/private-physics-visual-binding-plan@1" as const;
export const PHYSICS_VISUAL_BINDING_FRAME_SCHEMA = "shellx-motion/private-physics-visual-binding-frame@1" as const;

export const PHYSICS_VISUAL_BINDING_CAPS = Object.freeze({
  bindings: 256,
  renderFrames: 7_200,
  planBytes: 2 * 1024 * 1024,
  frameBytes: 512 * 1024,
});

export interface PhysicsVisualBinding {
  readonly bodyId: string;
  readonly geometryRef: string;
  readonly materialRef: string;
}

export interface PhysicsVisualBindingRecipe {
  readonly schema: typeof PHYSICS_VISUAL_BINDING_SCHEMA;
  readonly physicsPlanFingerprint: string;
  readonly frameRate: number;
  readonly interpolation: Readonly<{ position: "linear"; rotation: "slerp-shortest" }>;
  readonly resources: SceneRecipe["resources"];
  readonly bindings: readonly PhysicsVisualBinding[];
}

export interface PhysicsVisualBindingPlan {
  readonly schema: typeof PHYSICS_VISUAL_BINDING_PLAN_SCHEMA;
  readonly recipe: PhysicsVisualBindingRecipe;
  readonly recipeSha256: string;
  readonly source: Readonly<{
    physicsPlanFingerprint: string;
    physicsRecipeSha256: string;
    durableManifestFingerprint: string;
    durableReceiptFingerprint: string;
    providerResultFingerprint: string;
    bodyObservationId: string;
    bodyObservationSha256: string;
  }>;
  readonly resourceFingerprint: string;
  readonly bindings: readonly PhysicsVisualBinding[];
  readonly schedule: Readonly<{
    startUs: number;
    endUs: number;
    stepsPerSecond: number;
    stepCount: number;
    sampleEverySteps: number;
    frameRate: number;
    renderFrameCount: number;
    terminalFrameIndex: number;
  }>;
  readonly budget: Readonly<{
    geometryResourceCount: number;
    materialResourceCount: number;
    bindingCount: number;
    renderFrameCount: number;
    evaluationFrameCount: number;
    planBytes: number;
    caps: typeof PHYSICS_VISUAL_BINDING_CAPS;
  }>;
  readonly evidence: Readonly<{
    strictArtifactReopen: true;
    allDynamicBodiesBound: true;
    sharedC7aVisualResourceGrammar: true;
    visualCollisionGeometryIndependent: true;
    visualPhysicsMaterialsIndependent: true;
    rationalFrameSchedule: true;
    positionInterpolation: "linear";
    rotationInterpolation: "slerp-shortest";
    packageRead: false;
    packageWritten: false;
    rendererInvoked: false;
    pixels: false;
  }>;
  readonly fingerprint: string;
}

export interface PhysicsVisualFrameBinding extends PhysicsVisualBinding {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
}

export interface PhysicsVisualBindingFrame {
  readonly schema: typeof PHYSICS_VISUAL_BINDING_FRAME_SCHEMA;
  readonly planFingerprint: string;
  readonly durableManifestFingerprint: string;
  readonly frameIndex: number;
  readonly terminal: boolean;
  readonly time: Readonly<{ startUs: number; offsetNumeratorUs: number; denominator: number }>;
  readonly physicsStep: Readonly<{ numerator: number; denominator: number }>;
  readonly sampleRange: Readonly<{
    leftStep: number;
    rightStep: number;
    progressNumerator: number;
    progressDenominator: number;
  }>;
  readonly bindings: readonly PhysicsVisualFrameBinding[];
  readonly evidence: Readonly<{ rendererInvoked: false; pixels: false }>;
  readonly fingerprint: string;
}

export type PhysicsVisualBindingArtifactHost = PhysicsBakeDurableReopenHost;
