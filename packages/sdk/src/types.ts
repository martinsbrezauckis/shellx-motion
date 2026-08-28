/** Public, transport-neutral ShellX Motion SDK protocol types. */
import type { AttestedArtifactHandle, AttestedArtifactHandleReference, JobState } from "@shellx-motion/core";
import type {
  MotionSdkTrackingApplyRequest, MotionSdkTrackingApplyResponse, MotionSdkTrackingDetachRequest,
  MotionSdkTrackingDetachResponse, MotionSdkTrackingInspectRequest, MotionSdkTrackingInspectResponse,
  MotionSdkTrackingRequestRequest, MotionSdkTrackingRequestResponse, MotionSdkTrackingVerifyRequest,
  MotionSdkTrackingVerifyResponse,
} from "./tracking-types.js";
import type {
  MotionSdkKeyingApplyRequest, MotionSdkKeyingInspectRequest, MotionSdkKeyingInspectResponse,
  MotionSdkKeyingMutationResponse, MotionSdkKeyingRemoveRequest, MotionSdkRotoRemoveRequest,
  MotionSdkRotoTrackingDetachRequest, MotionSdkRotoUpsertRequest,
} from "./keying-types.js";
import type { MotionSdkTimelineEditRequest, MotionSdkTimelineEditResponse } from "./timeline-edit-types.js";
import type { MotionSdkPackageIdentity } from "./package-types.js";
import type { MotionSdkTemplateParameterSchema, MotionSdkValidateRequest, MotionSdkValidateResponse } from "./validation-types.js";
import type {
  MotionSdkCompositingInspectRequest,
  MotionSdkCompositingInspectResponse,
  MotionSdkCompositingMutationResponse,
  MotionSdkCompositingRemoveRequest,
  MotionSdkCompositingSetRequest,
} from "./compositing-types.js";
import type { MotionSdkRevisionTransactionPlanRequest, MotionSdkRevisionTransactionPlanResponse, MotionSdkRevisionTransactionRequest, MotionSdkRevisionTransactionResponse } from "./revision-transaction-types.js";
import type { MotionSdkAttestedReuse, MotionSdkGpuPostRenderReuseIdentity } from "./render-reuse-types.js";
import type { MotionSdkPreviewRequest, MotionSdkPreviewResponse } from "./sdk-preview-types.js";

export type * from "./tracking-types.js";
export type * from "./keying-types.js";
export type * from "./timeline-edit-types.js";
export type * from "./package-types.js";
export type * from "./authoring-types.js";
export type * from "./validation-types.js";
export type * from "./revision-transaction-types.js";
export type { MotionSdkPreviewRequest, MotionSdkPreviewResponse } from "./sdk-preview-types.js";
export const MOTION_SDK_SCHEMA = "shellx-motion/sdk@1" as const;

export type MotionSdkOperation = keyof MotionSdkRequestMap;
/** Alias of the authored contract's state union (schemas/job-status.json); see docs/public/JOB_STATUS.md. */
export type MotionSdkJobState = JobState;

export interface MotionSdkCompileRequest {
  script: unknown;
  outDir: string;
  createdAt?: string;
}

export interface MotionSdkRenderRequest {
  packageRoot: string;
  outputPath: string;
  preset: string;
  artifactRoot?: string;
  receiptsRoot?: string;
  /** Strict GPU is raw-RGBA FFmpeg final-video delivery, direct or durably segmented; it never falls back. */
  frameLane?: "browser" | "native" | "gpu";
  workflowPath?: string;
  qualityManifestPath?: string;
  /** Retain materialized final-video PNG frames; omitted means temporary frames only when required. */
  keepFrames?: boolean;
  /** Closed durable final delivery selector; storage is derived from outputPath. */
  segmented?: { segmentFrames: number; resume?: boolean };
  reuseAttested?: MotionSdkAttestedReuse;
  idempotencyKey?: string;
  cutHandoff?: { target: "shellx-cut"; mode: "rendered_media" };
}

/** Streamed-final coordinator request; use `render()` for materialized compatibility paths. */
export interface MotionSdkCoordinatedRenderRequest {
  /** Supply a stable id when reconnecting clients need to query this run before it completes. */
  jobId?: string;
  packageRoot: string;
  outputPath: string;
  preset: string;
  receiptsRoot?: string;
  /** Strict GPU is direct or durably segmented raw-RGBA FFmpeg final video; it never falls back or reuses old producer evidence. */
  frameLane?: "browser" | "native" | "gpu";
  /** Closed durable final delivery selector, including governed GPU final jobs; storage is derived from outputPath. */
  segmented?: { segmentFrames: number; resume?: boolean };
}

export interface MotionSdkStatusRequest {
  receiptsRoot: string;
  jobId?: string;
}

export interface MotionSdkCancelRequest {
  receiptsRoot: string;
  jobId: string;
  reason?: string;
}

export interface MotionSdkCompileResponse {
  packageRoot: string;
  package: MotionSdkPackageIdentity;
  receiptPath: string;
  warnings: string[];
}

export type MotionSdkArtifactIdentity = Pick<
  AttestedArtifactHandle,
  "schema" | "id" | "packageId" | "motionId" | "operationHash" | "preset" | "mediaType" | "byteLength" | "sha256" | "createdAt" | "packageLineage"
>;

export interface MotionSdkRenderResponse {
  jobId: string;
  state: MotionSdkJobState;
  packageId: string;
  motionId: string;
  preset: string;
  outputPath?: string;
  receiptId?: string;
  artifact?: MotionSdkArtifactIdentity;
  /** Present only after the local host validates a completed direct GPU receipt plus its retained artifact; segmented GPU receipts retain their own transport evidence. */
  gpuPostRenderReuse?: MotionSdkGpuPostRenderReuseIdentity;
  /** Present only when the request explicitly retained materialized final-video PNG frames. */
  frames?: { dir: string; count: number };
  artifactReference?: AttestedArtifactHandleReference;
  cutHandoff?: {
    schema: "shellx-motion/cut-handoff@1";
    target: "shellx-cut";
    mode: "rendered_media";
    path: string;
    sha256: string;
    packageId: string;
    motionId: string;
    artifactHandleId: string;
  };
  warnings: string[];
}

export interface MotionSdkJob {
  jobId: string;
  state: MotionSdkJobState;
  packageId: string;
  operation: "render.final" | "render.batch" | "render.retry";
  outputPath?: string;
  receiptId: string;
  retryCount: number;
  warnings: string[];
}

export interface MotionSdkStatusResponse {
  jobs: MotionSdkJob[];
  stateCounts: Partial<Record<MotionSdkJobState, number>>;
  warnings: string[];
}

export interface MotionSdkCancelResponse {
  targetJobId: string;
  /** The live state at acknowledgement time. It is never forged to cancelled while work unwinds. */
  state: MotionSdkJobState;
  cancelRequested: true;
  warnings: string[];
}

export interface MotionSdkRequestMap {
  validate: MotionSdkValidateRequest;
  compile: MotionSdkCompileRequest;
  preview: MotionSdkPreviewRequest;
  render: MotionSdkRenderRequest;
  status: MotionSdkStatusRequest;
  cancel: MotionSdkCancelRequest;
  timelineEdit: MotionSdkTimelineEditRequest;
  revisionTransactionPlan: MotionSdkRevisionTransactionPlanRequest;
  revisionTransaction: MotionSdkRevisionTransactionRequest;
  trackingRequest: MotionSdkTrackingRequestRequest;
  trackingInspect: MotionSdkTrackingInspectRequest;
  trackingApply: MotionSdkTrackingApplyRequest;
  trackingDetach: MotionSdkTrackingDetachRequest;
  trackingVerify: MotionSdkTrackingVerifyRequest;
  keyingInspect: MotionSdkKeyingInspectRequest;
  keyingApply: MotionSdkKeyingApplyRequest;
  keyingRemove: MotionSdkKeyingRemoveRequest;
  rotoUpsert: MotionSdkRotoUpsertRequest;
  rotoTrackingDetach: MotionSdkRotoTrackingDetachRequest;
  rotoRemove: MotionSdkRotoRemoveRequest;
  compositingInspect: MotionSdkCompositingInspectRequest;
  compositingSet: MotionSdkCompositingSetRequest;
  compositingRemove: MotionSdkCompositingRemoveRequest;
}

export interface MotionSdkResponseMap {
  validate: MotionSdkValidateResponse;
  compile: MotionSdkCompileResponse;
  preview: MotionSdkPreviewResponse;
  render: MotionSdkRenderResponse;
  status: MotionSdkStatusResponse;
  cancel: MotionSdkCancelResponse;
  timelineEdit: MotionSdkTimelineEditResponse;
  revisionTransactionPlan: MotionSdkRevisionTransactionPlanResponse;
  revisionTransaction: MotionSdkRevisionTransactionResponse;
  trackingRequest: MotionSdkTrackingRequestResponse;
  trackingInspect: MotionSdkTrackingInspectResponse;
  trackingApply: MotionSdkTrackingApplyResponse;
  trackingDetach: MotionSdkTrackingDetachResponse;
  trackingVerify: MotionSdkTrackingVerifyResponse;
  keyingInspect: MotionSdkKeyingInspectResponse;
  keyingApply: MotionSdkKeyingMutationResponse;
  keyingRemove: MotionSdkKeyingMutationResponse;
  rotoUpsert: MotionSdkKeyingMutationResponse;
  rotoTrackingDetach: MotionSdkKeyingMutationResponse;
  rotoRemove: MotionSdkKeyingMutationResponse;
  compositingInspect: MotionSdkCompositingInspectResponse;
  compositingSet: MotionSdkCompositingMutationResponse;
  compositingRemove: MotionSdkCompositingMutationResponse;
}

export interface MotionSdkTransportRequest<K extends MotionSdkOperation = MotionSdkOperation> {
  schema: typeof MOTION_SDK_SCHEMA;
  operation: K;
  requestId: string;
  cacheKey: string;
  input: MotionSdkRequestMap[K];
}

export type MotionSdkTransportResponse<K extends MotionSdkOperation = MotionSdkOperation> =
  | {
      schema: typeof MOTION_SDK_SCHEMA;
      operation: K;
      requestId: string;
      cacheKey: string;
      ok: true;
      output: MotionSdkResponseMap[K];
    }
  | {
      schema: typeof MOTION_SDK_SCHEMA;
      operation: K;
      requestId: string;
      cacheKey: string;
      ok: false;
      error: MotionSdkError;
      warnings: string[];
    };

export interface MotionSdkError {
  code: string;
  message: string;
  retryable: boolean;
  detail?: unknown;
}

export type MotionSdkResult<T> =
  | { ok: true; output: T; requestId: string; cacheKey: string }
  | { ok: false; error: MotionSdkError; warnings: string[]; requestId: string; cacheKey: string };

export interface MotionSdkTransport {
  execute<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>): Promise<MotionSdkTransportResponse<K>>;
}
export interface MotionSdkClient {
  validate(input: MotionSdkValidateRequest): Promise<MotionSdkResult<MotionSdkValidateResponse>>;
  compile(input: MotionSdkCompileRequest): Promise<MotionSdkResult<MotionSdkCompileResponse>>;
  preview(input: MotionSdkPreviewRequest): Promise<MotionSdkResult<MotionSdkPreviewResponse>>;
  render(input: MotionSdkRenderRequest): Promise<MotionSdkResult<MotionSdkRenderResponse>>;
  status(input: MotionSdkStatusRequest): Promise<MotionSdkResult<MotionSdkStatusResponse>>;
  cancel(input: MotionSdkCancelRequest): Promise<MotionSdkResult<MotionSdkCancelResponse>>;
  timelineEdit(input: MotionSdkTimelineEditRequest): Promise<MotionSdkResult<MotionSdkTimelineEditResponse>>;
  revisionTransactionPlan(input: MotionSdkRevisionTransactionPlanRequest): Promise<MotionSdkResult<MotionSdkRevisionTransactionPlanResponse>>;
  revisionTransaction(input: MotionSdkRevisionTransactionRequest): Promise<MotionSdkResult<MotionSdkRevisionTransactionResponse>>;
  trackingRequest(input: MotionSdkTrackingRequestRequest): Promise<MotionSdkResult<MotionSdkTrackingRequestResponse>>;
  trackingInspect(input: MotionSdkTrackingInspectRequest): Promise<MotionSdkResult<MotionSdkTrackingInspectResponse>>;
  trackingApply(input: MotionSdkTrackingApplyRequest): Promise<MotionSdkResult<MotionSdkTrackingApplyResponse>>;
  trackingDetach(input: MotionSdkTrackingDetachRequest): Promise<MotionSdkResult<MotionSdkTrackingDetachResponse>>;
  trackingVerify(input: MotionSdkTrackingVerifyRequest): Promise<MotionSdkResult<MotionSdkTrackingVerifyResponse>>;
  keyingInspect(input: MotionSdkKeyingInspectRequest): Promise<MotionSdkResult<MotionSdkKeyingInspectResponse>>;
  keyingApply(input: MotionSdkKeyingApplyRequest): Promise<MotionSdkResult<MotionSdkKeyingMutationResponse>>;
  keyingRemove(input: MotionSdkKeyingRemoveRequest): Promise<MotionSdkResult<MotionSdkKeyingMutationResponse>>;
  rotoUpsert(input: MotionSdkRotoUpsertRequest): Promise<MotionSdkResult<MotionSdkKeyingMutationResponse>>;
  rotoTrackingDetach(input: MotionSdkRotoTrackingDetachRequest): Promise<MotionSdkResult<MotionSdkKeyingMutationResponse>>;
  rotoRemove(input: MotionSdkRotoRemoveRequest): Promise<MotionSdkResult<MotionSdkKeyingMutationResponse>>;
  compositingInspect(input: MotionSdkCompositingInspectRequest): Promise<MotionSdkResult<MotionSdkCompositingInspectResponse>>;
  compositingSet(input: MotionSdkCompositingSetRequest): Promise<MotionSdkResult<MotionSdkCompositingMutationResponse>>;
  compositingRemove(input: MotionSdkCompositingRemoveRequest): Promise<MotionSdkResult<MotionSdkCompositingMutationResponse>>;
}
