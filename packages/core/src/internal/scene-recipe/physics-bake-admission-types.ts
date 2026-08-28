export const PHYSICS_BAKE_SCHEMA = "shellx-motion/physics-bake@1" as const;
export const PHYSICS_BAKE_ADMISSION_PLAN_SCHEMA = "shellx-motion/private-physics-bake-admission-plan@1" as const;

export const PHYSICS_BAKE_ADMISSION_CAPS = Object.freeze({
  materials: 32,
  bodies: 256,
  constraints: 128,
  actions: 512,
  events: 256,
  observations: 256,
  steps: 7_200,
  bodySteps: 1_500_000,
  bodyStateSamples: 200_000,
  contactEventUpperBound: 200_000,
  planBytes: 2 * 1024 * 1024,
});

export type PhysicsBakeVec3 = readonly [number, number, number];
export type PhysicsBakeQuaternion = readonly [number, number, number, number];

export interface PhysicsBakeMaterial {
  readonly id: string;
  readonly friction: number;
  readonly restitution: number;
}

export type PhysicsBakeCollider =
  | Readonly<{ kind: "sphere"; radius: number }>
  | Readonly<{ kind: "box"; size: PhysicsBakeVec3 }>;

interface PhysicsBakeBodyBase {
  readonly id: string;
  readonly collider: PhysicsBakeCollider;
  readonly materialRef: string;
  readonly position: PhysicsBakeVec3;
  readonly rotation: PhysicsBakeQuaternion;
  readonly collisionGroup: number;
  readonly collisionMask: number;
}

export type PhysicsBakeBody =
  | Readonly<PhysicsBakeBodyBase & { kind: "static" }>
  | Readonly<PhysicsBakeBodyBase & {
      kind: "dynamic";
      mass: number;
      linearVelocity: PhysicsBakeVec3;
      angularVelocity: PhysicsBakeVec3;
      ccd: boolean;
    }>;

export interface PhysicsBakeDistanceConstraint {
  readonly id: string;
  readonly kind: "distance";
  readonly bodyA: string;
  readonly bodyB: string | null;
  readonly anchorA: PhysicsBakeVec3;
  readonly anchorB: PhysicsBakeVec3;
  readonly restLength: number;
  readonly stiffness: number;
  readonly damping: number;
}

export type PhysicsBakeAction =
  | Readonly<{ id: string; kind: "impulse"; atStep: number; bodyId: string; vector: PhysicsBakeVec3 }>
  | Readonly<{ id: string; kind: "force"; startStep: number; endStep: number; bodyId: string; vector: PhysicsBakeVec3 }>;

export interface PhysicsBakeCollisionEvent {
  readonly id: string;
  readonly kind: "collision-pair";
  readonly bodyA: string;
  readonly bodyB: string;
  readonly phases: readonly ("start" | "stop")[];
}

export type PhysicsBakeObservation =
  | Readonly<{ id: string; kind: "body-state"; bodyIds: readonly string[]; sampleEverySteps: number }>
  | Readonly<{ id: string; kind: "contact-pairs"; eventIds: readonly string[]; sampleEverySteps: number }>;

export interface PhysicsBakeRecipe {
  readonly schema: typeof PHYSICS_BAKE_SCHEMA;
  readonly id: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly stepsPerSecond: number;
  readonly seed: number;
  readonly units: Readonly<{ length: "meter"; angle: "radian"; time: "second"; upAxis: "y"; forwardAxis: "-z" }>;
  readonly world: Readonly<{ gravity: PhysicsBakeVec3 }>;
  readonly materials: readonly PhysicsBakeMaterial[];
  readonly bodies: readonly PhysicsBakeBody[];
  readonly constraints: readonly PhysicsBakeDistanceConstraint[];
  readonly actions: readonly PhysicsBakeAction[];
  readonly events: readonly PhysicsBakeCollisionEvent[];
  readonly observations: readonly PhysicsBakeObservation[];
}

export interface PhysicsBakeAdmissionPlan {
  readonly schema: typeof PHYSICS_BAKE_ADMISSION_PLAN_SCHEMA;
  readonly recipe: PhysicsBakeRecipe;
  readonly recipeSha256: string;
  readonly schedule: Readonly<{
    startUs: number;
    endUs: number;
    stepsPerSecond: number;
    stepDuration: Readonly<{ numeratorUs: 1_000_000; denominator: number }>;
    stepCount: number;
  }>;
  readonly identities: Readonly<{
    materialOrderSha256: string;
    bodyOrderSha256: string;
    constraintOrderSha256: string;
    actionOrderSha256: string;
    eventOrderSha256: string;
    observationOrderSha256: string;
    fingerprint: string;
  }>;
  readonly budget: Readonly<{
    materialCount: number;
    bodyCount: number;
    dynamicBodyCount: number;
    staticBodyCount: number;
    constraintCount: number;
    actionCount: number;
    eventCount: number;
    observationCount: number;
    stepCount: number;
    bodySteps: number;
    bodyStateSampleCount: number;
    contactEventUpperBound: number;
    planBytes: number;
    caps: typeof PHYSICS_BAKE_ADMISSION_CAPS;
  }>;
  readonly evidence: Readonly<{
    providerNeutral: true;
    providerSelected: false;
    providerInvoked: false;
    exactRationalSchedule: true;
    f32Inputs: true;
    stableOrderedIds: true;
    packageRead: false;
    packageWritten: false;
    rendererInvoked: false;
    pixels: false;
  }>;
  readonly fingerprint: string;
}
