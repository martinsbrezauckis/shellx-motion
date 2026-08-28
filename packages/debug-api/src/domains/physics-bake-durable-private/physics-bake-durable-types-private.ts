import type { TrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import type {
  PhysicsBakeRapierBodyState,
  PhysicsBakeRapierBodyStateObservation,
  PhysicsBakeRapierContactObservation,
} from "../physics-bake-rapier-private/physics-bake-rapier-types-private.js";

export const PHYSICS_BAKE_DURABLE_MANIFEST_SCHEMA = "shellx-motion/private-physics-bake-durable-manifest@1" as const;
export const PHYSICS_BAKE_DURABLE_RECEIPT_SCHEMA = "shellx-motion/private-physics-bake-durable-receipt@1" as const;
export const PHYSICS_BAKE_DURABLE_CODEC = "shellx-motion/physics-bake-lossless-f32le@1" as const;
export const PHYSICS_BAKE_DURABLE_CAPS = Object.freeze({ bodyStatesPerSegment: 4_096, contactEventsPerSegment: 16_384, segments: 512, segmentBytes: 16 * 1024 * 1024, sourceObservationBytes: 128 * 1024 * 1024, manifestBytes: 2 * 1024 * 1024, receiptBytes: 1024 * 1024 });

export interface PhysicsBakeDurableSegmentBase {
  readonly index: number;
  readonly path: string;
  readonly observationId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly sampleStart: number;
  readonly sampleCount: number;
  readonly firstStep: number;
  readonly lastStep: number;
}

export interface PhysicsBakeDurableBodySegment extends PhysicsBakeDurableSegmentBase {
  readonly kind: "body-state";
  readonly bodyCount: number;
  readonly stateCount: number;
}

export interface PhysicsBakeDurableContactSegment extends PhysicsBakeDurableSegmentBase {
  readonly kind: "contact-events";
  readonly eventCount: number;
}

export type PhysicsBakeDurableSegment = PhysicsBakeDurableBodySegment | PhysicsBakeDurableContactSegment;

export interface PhysicsBakeDurableBodyObservation {
  readonly id: string;
  readonly sampleEverySteps: number;
  readonly bodyIds: readonly string[];
  readonly sourceSha256: string;
  readonly sampleCount: number;
  readonly stateCount: number;
  readonly segmentPaths: readonly string[];
}

export interface PhysicsBakeDurableContactObservation {
  readonly id: string;
  readonly sampleEverySteps: number;
  readonly events: readonly Readonly<{ id: string; bodyA: string; bodyB: string; phases: readonly ("start" | "stop")[] }>[];
  readonly sourceSha256: string;
  readonly sampleCount: number;
  readonly eventCount: number;
  readonly segmentPaths: readonly string[];
}

export interface PhysicsBakeDurableManifest {
  readonly schema: typeof PHYSICS_BAKE_DURABLE_MANIFEST_SCHEMA;
  readonly source: Readonly<{
    planFingerprint: string;
    recipeSha256: string;
    resultFingerprint: string;
    providerPackage: string;
    providerVersion: string;
    observationsSha256: string;
    snapshotSha256: string;
  }>;
  readonly schedule: Readonly<{ startUs: number; endUs: number; stepsPerSecond: number; stepCount: number }>;
  readonly primaryBodyObservationId: string;
  readonly finalStates: readonly PhysicsBakeRapierBodyState[];
  readonly finalStateSha256: string;
  readonly bodyObservations: readonly PhysicsBakeDurableBodyObservation[];
  readonly contactObservations: readonly PhysicsBakeDurableContactObservation[];
  readonly segments: readonly PhysicsBakeDurableSegment[];
  readonly compression: Readonly<{
    codec: typeof PHYSICS_BAKE_DURABLE_CODEC;
    sourceObservationBytes: number;
    segmentBytes: number;
    savedBytes: number;
    ratioPartsPerMillion: number;
    lossless: true;
    idsStoredOnce: true;
    samplesSimplified: false;
    valuesQuantized: false;
    caps: typeof PHYSICS_BAKE_DURABLE_CAPS;
  }>;
  readonly evidence: Readonly<{ rendererNeutral: true; packageRead: false; packageWritten: false; rendererInvoked: false; pixels: false }>;
  readonly fingerprint: string;
}

export interface PhysicsBakeDurableReceipt {
  readonly schema: typeof PHYSICS_BAKE_DURABLE_RECEIPT_SCHEMA;
  readonly source: PhysicsBakeDurableManifest["source"];
  readonly artifact: Readonly<{
    manifestSha256: string;
    manifestBytes: number;
    manifestFingerprint: string;
    segmentInventorySha256: string;
    segmentCount: number;
    segmentBytes: number;
    inventoryContractSha256: string;
    expectedEntryCount: number;
  }>;
  readonly compression: PhysicsBakeDurableManifest["compression"];
  readonly publication: Readonly<{ absentOnly: true; privateStage: true; closedInventory: true; atomicDirectoryInstall: true; partialResume: false; workspaceCleanup: "not-attested" }>;
  readonly evidence: Readonly<{ providerSelectedByHost: true; callerSubmittedProviderResult: false; rendererInvoked: false; pixels: false }>;
  readonly fingerprint: string;
}

export interface PhysicsBakeDurableReopenHost {
  readonly outputRoot: string;
  readonly workspaceRoot: string;
  readonly workspaceAuthority: TrustedWorkspaceAnchor;
}
export interface PhysicsBakeDurableHost extends PhysicsBakeDurableReopenHost {
  readonly requireAbsentOutput: true;
}

export interface PhysicsBakeDurableOptions { readonly signal?: AbortSignal }
export interface PhysicsBakeDurableResult { readonly outputRoot: string; readonly manifest: PhysicsBakeDurableManifest; readonly receipt: PhysicsBakeDurableReceipt; readonly workspaceCleanup: "not-attested" }
export interface PhysicsBakeDurableReopenResult {
  readonly manifest: PhysicsBakeDurableManifest;
  readonly receipt: PhysicsBakeDurableReceipt;
  readonly bodyStateObservations: readonly PhysicsBakeRapierBodyStateObservation[];
  readonly contactObservations: readonly PhysicsBakeRapierContactObservation[];
}

export interface PhysicsBakeDurablePrepared {
  readonly manifest: PhysicsBakeDurableManifest;
  readonly segments: readonly Readonly<{ descriptor: PhysicsBakeDurableSegment; bytes: Buffer }>[];
  readonly bodyStateObservations: readonly PhysicsBakeRapierBodyStateObservation[];
  readonly contactObservations: readonly PhysicsBakeRapierContactObservation[];
}
