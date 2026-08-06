import type {
  MotionProceduralGraph,
  MotionProceduralPropertyRef,
  MotionProceduralRelationship,
  MotionProceduralValidationResult,
} from "@shellx-motion/core";
import type { MotionSdkPackageIdentity, MotionSdkPersistedReceipt } from "./package-types.js";

export type MotionSdkProceduralOperation =
  | "procedural.relationship.set"
  | "procedural.relationship.enabled.set"
  | "procedural.relationship.bake"
  | "procedural.relationship.detach";

export interface MotionSdkProceduralRelationshipSummary {
  id: string;
  enabled: boolean;
  target: MotionProceduralPropertyRef;
  sources: MotionProceduralPropertyRef[];
  audioEnvelopeIds: string[];
  nodeCount: number;
  outputNodeId: string;
}

export interface MotionSdkProceduralState {
  graph: MotionProceduralGraph | null;
  relationships: MotionSdkProceduralRelationshipSummary[];
  validation: MotionProceduralValidationResult | null;
  fingerprint: string | null;
  evaluation: { atMs: number; values: Record<string, number> } | null;
}

export interface MotionSdkProceduralInspectRequest {
  packageRoot: string;
  atMs?: number;
}

interface MotionSdkProceduralMutationRequest {
  packageRoot: string;
  outDir: string;
  receiptsRoot?: string;
  createdBy?: string;
}

export interface MotionSdkProceduralSetRequest extends MotionSdkProceduralMutationRequest {
  relationship: MotionProceduralRelationship;
}

export interface MotionSdkProceduralEnabledRequest extends MotionSdkProceduralMutationRequest {
  relationshipId: string;
  enabled: boolean;
}

export interface MotionSdkProceduralBakeRequest extends MotionSdkProceduralMutationRequest {
  relationshipIds?: string[];
  startMs?: number;
  endMs?: number;
  sampleEveryFrames?: number;
}

export interface MotionSdkProceduralDetachRequest extends MotionSdkProceduralMutationRequest {
  relationshipId: string;
}

export interface MotionSdkProceduralInspectResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  state: MotionSdkProceduralState;
  warnings: string[];
}

export interface MotionSdkProceduralBakeEvidence {
  relationshipIds: string[];
  sampleCount: number;
  keyframeCount: number;
  fingerprint: string;
}

export interface MotionSdkProceduralMutationResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  operation: MotionSdkProceduralOperation;
  changedPaths: string[];
  state: MotionSdkProceduralState;
  bake?: MotionSdkProceduralBakeEvidence;
  receipt: MotionSdkPersistedReceipt<MotionSdkProceduralOperation>;
  receiptPath: string;
  warnings: string[];
}

declare module "./types.js" {
  interface MotionSdkRequestMap {
    proceduralInspect: MotionSdkProceduralInspectRequest;
    proceduralSet: MotionSdkProceduralSetRequest;
    proceduralSetEnabled: MotionSdkProceduralEnabledRequest;
    proceduralBake: MotionSdkProceduralBakeRequest;
    proceduralDetach: MotionSdkProceduralDetachRequest;
  }

  interface MotionSdkResponseMap {
    proceduralInspect: MotionSdkProceduralInspectResponse;
    proceduralSet: MotionSdkProceduralMutationResponse;
    proceduralSetEnabled: MotionSdkProceduralMutationResponse;
    proceduralBake: MotionSdkProceduralMutationResponse;
    proceduralDetach: MotionSdkProceduralMutationResponse;
  }

  interface MotionSdkClient {
    proceduralInspect(input: MotionSdkProceduralInspectRequest): Promise<MotionSdkResult<MotionSdkProceduralInspectResponse>>;
    proceduralSet(input: MotionSdkProceduralSetRequest): Promise<MotionSdkResult<MotionSdkProceduralMutationResponse>>;
    proceduralSetEnabled(input: MotionSdkProceduralEnabledRequest): Promise<MotionSdkResult<MotionSdkProceduralMutationResponse>>;
    proceduralBake(input: MotionSdkProceduralBakeRequest): Promise<MotionSdkResult<MotionSdkProceduralMutationResponse>>;
    proceduralDetach(input: MotionSdkProceduralDetachRequest): Promise<MotionSdkResult<MotionSdkProceduralMutationResponse>>;
  }
}
