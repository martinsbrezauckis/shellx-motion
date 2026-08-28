import type { PhysicsBakeAdmissionPlan, PhysicsBakeQuaternion, PhysicsBakeVec3 } from "@shellx-motion/core/internal/scene-recipe";

export const PHYSICS_BAKE_RAPIER_RESULT_SCHEMA = "shellx-motion/private-physics-bake-rapier-result@1" as const;
export const PHYSICS_BAKE_RAPIER_PACKAGE = "@dimforge/rapier3d-deterministic-compat" as const;
export const PHYSICS_BAKE_RAPIER_VERSION = "0.20.0" as const;

export interface PhysicsBakeRapierBodyState {
  readonly bodyId: string;
  readonly position: PhysicsBakeVec3;
  readonly rotation: PhysicsBakeQuaternion;
  readonly linearVelocity: PhysicsBakeVec3;
  readonly angularVelocity: PhysicsBakeVec3;
}

export interface PhysicsBakeRapierBodyStateObservation {
  readonly id: string;
  readonly sampleEverySteps: number;
  readonly samples: readonly Readonly<{
    step: number;
    states: readonly PhysicsBakeRapierBodyState[];
  }>[];
}

export interface PhysicsBakeRapierContactEvent {
  readonly eventId: string;
  readonly bodyA: string;
  readonly bodyB: string;
  readonly phase: "start" | "stop";
  readonly step: number;
}

export interface PhysicsBakeRapierContactObservation {
  readonly id: string;
  readonly sampleEverySteps: number;
  readonly samples: readonly Readonly<{
    step: number;
    events: readonly PhysicsBakeRapierContactEvent[];
  }>[];
}

export interface PhysicsBakeRapierResult {
  readonly schema: typeof PHYSICS_BAKE_RAPIER_RESULT_SCHEMA;
  readonly admission: Readonly<{
    planFingerprint: string;
    recipeSha256: string;
  }>;
  readonly provider: Readonly<{
    package: typeof PHYSICS_BAKE_RAPIER_PACKAGE;
    expectedVersion: typeof PHYSICS_BAKE_RAPIER_VERSION;
    reportedVersion: typeof PHYSICS_BAKE_RAPIER_VERSION;
    flavor: "deterministic-compat";
    runtime: "embedded-wasm";
  }>;
  readonly schedule: PhysicsBakeAdmissionPlan["schedule"];
  readonly finalStates: readonly PhysicsBakeRapierBodyState[];
  readonly finalStateSha256: string;
  readonly bodyStateObservations: readonly PhysicsBakeRapierBodyStateObservation[];
  readonly contactObservations: readonly PhysicsBakeRapierContactObservation[];
  readonly observationsSha256: string;
  readonly snapshot: Readonly<{
    step: number;
    byteLength: number;
    sha256: string;
    resumedFinalStateSha256: string;
    matchesUninterrupted: true;
  }>;
  readonly lifecycle: Readonly<{
    worldsCreated: number;
    worldsFreed: number;
    eventQueuesCreated: number;
    eventQueuesFreed: number;
    activeWorldsAfter: 0;
    activeEventQueuesAfter: 0;
  }>;
  readonly evidence: Readonly<{
    providerSelectedByHost: true;
    recipeSelectedProvider: false;
    exactPinnedVersion: true;
    fixedStep: true;
    stableBodyOrder: true;
    canonicalEventOrder: true;
    providerRandomnessUsed: false;
    snapshotResumeMatched: true;
    motionPackageRead: false;
    motionPackageWritten: false;
    rendererInvoked: false;
    pixels: false;
  }>;
  readonly fingerprint: string;
}

export interface PhysicsBakeRapierOptions {
  readonly signal?: AbortSignal;
}

export interface PhysicsBakeRapierResourceState {
  readonly activeWorlds: number;
  readonly activeEventQueues: number;
  readonly totalWorldsCreated: number;
  readonly totalWorldsFreed: number;
  readonly totalEventQueuesCreated: number;
  readonly totalEventQueuesFreed: number;
}
