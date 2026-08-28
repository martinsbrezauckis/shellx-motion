/** Fixed B7 raster evidence and opaque wrapper types for the shipping-private preview facade. */
import { canonicalJsonSha256 } from "../../canonical-json";
import {
  GPU_PARAMETRIC_TRACE_COLOUR_MAPPING,
  GPU_PARAMETRIC_TRACE_SIGNAL_INTERPOLATION,
  GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI,
  GPU_PARAMETRIC_TRACE_VERTEX_ABI,
  GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES,
  GPU_PARAMETRIC_TRACE_WIDTH_ENCODING,
  type GpuParametricTracePreviewFailure,
  type GpuParametricTracePreviewFramePlan,
} from "../../gpu-parametric-trace-preview";
import { freeze } from "./checkpoint-storyboard-data";

export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_STATIC_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-retained-trace-preview-static@1" as const;
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_FRAME_SCHEMA =
  "shellx-motion/private-checkpoint-storyboard-retained-trace-preview-frame@1" as const;
/** B7 samples use Motion's top-left pixel space, never clip-space coordinates. */
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_MAPPING = "motion-top-left-pixel-xy-to-ndc@1" as const;
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_SAMPLE_Z = "ignore-packed-sample-z@1" as const;
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_SOURCE = "fixed-20-byte-raw-u32-storage@1" as const;
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_TESSELLATION = "square-cap-or-endpoint-width-segment-quad@1" as const;
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_PRIMITIVE = "triangle-list" as const;
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_SAMPLES = 64;
export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS = 378;

export type CheckpointStoryboardRetainedTracePreviewFailure = GpuParametricTracePreviewFailure;
export interface CheckpointStoryboardRetainedTraceRasterizationStaticEvidence {
  readonly mapping: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_MAPPING;
  readonly sampleZ: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_SAMPLE_Z;
  readonly source: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_SOURCE;
  readonly tessellation: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_TESSELLATION;
  readonly primitive: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_PRIMITIVE;
  readonly sampleStrideBytes: typeof GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES;
  readonly maxSamples: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_SAMPLES;
  readonly maxRasterVertexInvocations: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS;
  readonly fingerprint: string;
}
export interface CheckpointStoryboardRetainedTraceRasterizationFrameEvidence {
  readonly staticRasterizationFingerprint: string;
  readonly sampleCount: number;
  readonly sampleUploadBytes: number;
  readonly rasterVertexCount: number;
  readonly drawVertexInvocations: number;
  readonly maxRasterVertexInvocations: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS;
  readonly fingerprint: string;
}
export interface CheckpointStoryboardRetainedTracePreviewStaticPlan {
  readonly schema: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_STATIC_SCHEMA;
  readonly documentFingerprint: string;
  readonly retainedTracePlanFingerprint: string;
  readonly traceSourceSha256: string;
  readonly tracePlanFingerprint: string;
  readonly scheduleSha256: string;
  readonly vertexAbi: typeof GPU_PARAMETRIC_TRACE_VERTEX_ABI;
  readonly signalInterpolation: typeof GPU_PARAMETRIC_TRACE_SIGNAL_INTERPOLATION;
  readonly colourMapping: typeof GPU_PARAMETRIC_TRACE_COLOUR_MAPPING;
  readonly widthEncoding: typeof GPU_PARAMETRIC_TRACE_WIDTH_ENCODING;
  readonly topologyAbi: typeof GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI;
  readonly rasterization: CheckpointStoryboardRetainedTraceRasterizationStaticEvidence;
  readonly fingerprint: string;
}
export interface CheckpointStoryboardRetainedTracePreviewFramePlan {
  readonly schema: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_FRAME_SCHEMA;
  readonly staticFingerprint: string;
  readonly retainedTracePlanFingerprint: string;
  readonly atUs: number;
  readonly vertexAbi: typeof GPU_PARAMETRIC_TRACE_VERTEX_ABI;
  readonly topologyAbi: typeof GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI;
  readonly drawers: GpuParametricTracePreviewFramePlan["drawers"];
  readonly budget: GpuParametricTracePreviewFramePlan["budget"];
  readonly rasterization: CheckpointStoryboardRetainedTraceRasterizationFrameEvidence;
  readonly fingerprint: string;
}
export type CheckpointStoryboardRetainedTracePreviewStaticResult =
  | { ok: true; plan: CheckpointStoryboardRetainedTracePreviewStaticPlan }
  | { ok: false; failure: CheckpointStoryboardRetainedTracePreviewFailure };
export type CheckpointStoryboardRetainedTracePreviewFrameResult =
  | { ok: true; plan: CheckpointStoryboardRetainedTracePreviewFramePlan }
  | { ok: false; failure: CheckpointStoryboardRetainedTracePreviewFailure };
export type CheckpointStoryboardRetainedTracePreviewFreshnessResult =
  | { ok: true }
  | { ok: false; failure: CheckpointStoryboardRetainedTracePreviewFailure };
export interface CheckpointStoryboardRetainedTracePreviewUpload {
  readonly frame: CheckpointStoryboardRetainedTracePreviewFramePlan;
  readonly drawers: readonly { readonly drawerId: string; readonly vertexBytes: Uint8Array }[];
}

export function createStaticRasterizationEvidence(): CheckpointStoryboardRetainedTraceRasterizationStaticEvidence {
  const payload = {
    mapping: CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_MAPPING,
    sampleZ: CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_SAMPLE_Z,
    source: CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_SOURCE,
    tessellation: CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_TESSELLATION,
    primitive: CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_PRIMITIVE,
    sampleStrideBytes: GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES,
    maxSamples: CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_SAMPLES,
    maxRasterVertexInvocations: CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS,
  } as const;
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export function createFrameRasterizationEvidence(
  staticEvidence: CheckpointStoryboardRetainedTraceRasterizationStaticEvidence,
  drawer: GpuParametricTracePreviewFramePlan["drawers"][number],
): CheckpointStoryboardRetainedTraceRasterizationFrameEvidence {
  const sampleCount = drawer.window.sampleCount;
  const sampleUploadBytes = sampleCount * GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES;
  const rasterVertexCount = rasterVertexCountForSamples(sampleCount);
  if (
    !matchesStaticRasterizationEvidence(staticEvidence)
    || !Number.isSafeInteger(sampleCount)
    || sampleCount < 1
    || sampleCount > CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_SAMPLES
    || drawer.window.vertexCount !== sampleCount
    || drawer.vertexByteLength !== sampleUploadBytes
    || drawer.topology.drawVertexInvocations !== sampleCount
    || rasterVertexCount > CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS
  ) {
    throw new Error("CheckpointStoryboard retained-trace preview rasterization exceeds its exact 64-sample/378-vertex contract.");
  }
  const payload = {
    staticRasterizationFingerprint: staticEvidence.fingerprint,
    sampleCount,
    sampleUploadBytes,
    rasterVertexCount,
    drawVertexInvocations: rasterVertexCount,
    maxRasterVertexInvocations: CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS,
  } as const;
  return freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

export function matchesStaticRasterizationEvidence(value: CheckpointStoryboardRetainedTraceRasterizationStaticEvidence): boolean {
  const { fingerprint, ...payload } = value;
  return value.mapping === CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_MAPPING
    && value.sampleZ === CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_SAMPLE_Z
    && value.source === CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_SOURCE
    && value.tessellation === CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_TESSELLATION
    && value.primitive === CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_PRIMITIVE
    && value.sampleStrideBytes === GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES
    && value.maxSamples === CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_SAMPLES
    && value.maxRasterVertexInvocations === CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS
    && canonicalJsonSha256(payload) === fingerprint;
}

export function matchesRasterizationEvidence(
  staticEvidence: CheckpointStoryboardRetainedTraceRasterizationStaticEvidence,
  frameEvidence: CheckpointStoryboardRetainedTraceRasterizationFrameEvidence,
  drawer: GpuParametricTracePreviewFramePlan["drawers"][number],
): boolean {
  const { fingerprint, ...payload } = frameEvidence;
  const expectedVertices = rasterVertexCountForSamples(drawer.window.sampleCount);
  return matchesStaticRasterizationEvidence(staticEvidence)
    && frameEvidence.staticRasterizationFingerprint === staticEvidence.fingerprint
    && frameEvidence.sampleCount === drawer.window.sampleCount
    && frameEvidence.sampleUploadBytes === drawer.vertexByteLength
    && frameEvidence.rasterVertexCount === expectedVertices
    && frameEvidence.drawVertexInvocations === expectedVertices
    && frameEvidence.maxRasterVertexInvocations === CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS
    && expectedVertices <= CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS
    && canonicalJsonSha256(payload) === fingerprint;
}

function rasterVertexCountForSamples(sampleCount: number): number {
  return sampleCount === 1 ? 6 : (sampleCount - 1) * 6;
}
