/** Shipping-private C6C-B7 retained-trace preview authority over an exact compiled B7a plan. */

import { canonicalJsonSha256 } from "../../canonical-json";
import {
  checkGpuParametricTracePreviewStaticFreshness,
  compileGpuParametricTracePreviewFramePlan,
  compileGpuParametricTracePreviewStaticPlanFromCompiledTrace,
  readGpuParametricTracePreviewUpload,
  GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES,
  type GpuParametricTracePreviewFramePlan,
  type GpuParametricTracePreviewStaticPlan,
} from "../../gpu-parametric-trace-preview";
import type { MotionDocument } from "../../types";
import { freeze } from "./checkpoint-storyboard-data";
import { fingerprintMotion, readAdmittedInput } from "./checkpoint-storyboard-retained-trace-preview-admission";
import {
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_FRAME_SCHEMA,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_STATIC_SCHEMA,
  createFrameRasterizationEvidence,
  createStaticRasterizationEvidence,
  matchesRasterizationEvidence,
  type CheckpointStoryboardRetainedTracePreviewFailure,
  type CheckpointStoryboardRetainedTracePreviewFramePlan,
  type CheckpointStoryboardRetainedTracePreviewFrameResult,
  type CheckpointStoryboardRetainedTracePreviewFreshnessResult,
  type CheckpointStoryboardRetainedTracePreviewStaticPlan,
  type CheckpointStoryboardRetainedTracePreviewStaticResult,
  type CheckpointStoryboardRetainedTracePreviewUpload,
  type CheckpointStoryboardRetainedTraceRasterizationFrameEvidence,
} from "./checkpoint-storyboard-retained-trace-preview-raster";

export {
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_SAMPLES,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_FRAME_SCHEMA,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_STATIC_SCHEMA,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_MAPPING,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_PRIMITIVE,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_SAMPLE_Z,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_SOURCE,
  CHECKPOINT_STORYBOARD_RETAINED_TRACE_RASTER_TESSELLATION,
} from "./checkpoint-storyboard-retained-trace-preview-raster";
export type {
  CheckpointStoryboardRetainedTracePreviewFailure,
  CheckpointStoryboardRetainedTracePreviewFramePlan,
  CheckpointStoryboardRetainedTracePreviewFrameResult,
  CheckpointStoryboardRetainedTracePreviewFreshnessResult,
  CheckpointStoryboardRetainedTracePreviewStaticPlan,
  CheckpointStoryboardRetainedTracePreviewStaticResult,
  CheckpointStoryboardRetainedTracePreviewUpload,
  CheckpointStoryboardRetainedTraceRasterizationFrameEvidence,
  CheckpointStoryboardRetainedTraceRasterizationStaticEvidence,
} from "./checkpoint-storyboard-retained-trace-preview-raster";

type StaticState = {
  readonly documentFingerprint: string;
  readonly retainedTracePlanFingerprint: string;
  readonly schedule: readonly number[];
  readonly raw: GpuParametricTracePreviewStaticPlan;
};
type FrameState = { readonly issuingStaticPlan: object; readonly raw: GpuParametricTracePreviewFramePlan };
const staticStates = new WeakMap<object, StaticState>();
const frameStates = new WeakMap<object, FrameState>();

/**
 * Creates a renderer-readable static wrapper only from the exact C6B7a plan and its exact Motion
 * document. This is deliberately not a descriptor compiler or a public Core-root operation.
 */
export function compileCheckpointStoryboardRetainedTracePreviewStaticPlan(
  motion: MotionDocument,
  retainedTracePlan: unknown,
): CheckpointStoryboardRetainedTracePreviewStaticResult {
  try {
    const admitted = readAdmittedInput(motion, retainedTracePlan);
    const raw = compileGpuParametricTracePreviewStaticPlanFromCompiledTrace(admitted.motion, admitted.trace);
    if (!raw.ok) return raw;
    const rasterization = createStaticRasterizationEvidence();
    const payload = {
      schema: CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_STATIC_SCHEMA,
      documentFingerprint: admitted.documentFingerprint,
      retainedTracePlanFingerprint: admitted.retainedTracePlanFingerprint,
      traceSourceSha256: raw.plan.traceSourceSha256,
      tracePlanFingerprint: raw.plan.tracePlanFingerprint,
      scheduleSha256: raw.plan.scheduleSha256,
      vertexAbi: raw.plan.vertexAbi,
      signalInterpolation: raw.plan.signalInterpolation,
      colourMapping: raw.plan.colourMapping,
      widthEncoding: raw.plan.widthEncoding,
      topologyAbi: raw.plan.topologyAbi,
      rasterization,
    };
    const plan = freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
    staticStates.set(plan, {
      documentFingerprint: admitted.documentFingerprint,
      retainedTracePlanFingerprint: admitted.retainedTracePlanFingerprint,
      schedule: admitted.trace.schedule,
      raw: raw.plan,
    });
    return { ok: true, plan };
  } catch (error) {
    return fail("gpu_unsupported_feature", error instanceof Error ? error.message : "CheckpointStoryboard retained-trace preview static admission refused.");
  }
}

/** Selects one exact B7 schedule member, including the final document endpoint, before allocation. */
export function compileCheckpointStoryboardRetainedTracePreviewFramePlan(
  motion: MotionDocument,
  staticPlan: CheckpointStoryboardRetainedTracePreviewStaticPlan,
  atUs: number,
): CheckpointStoryboardRetainedTracePreviewFrameResult {
  const state = staticStates.get(staticPlan as unknown as object);
  if (!state) return fail("gpu_resource_refused", "CheckpointStoryboard retained-trace preview requires an exact Core-issued static execution wrapper.");
  if (!Number.isSafeInteger(atUs) || !exactScheduleMember(state.schedule, atUs)) {
    return fail("gpu_invalid_time", "CheckpointStoryboard retained-trace preview atUs must be a safe integer exact B7 schedule member, including the document endpoint.");
  }
  let documentFingerprint: string;
  try { documentFingerprint = fingerprintMotion(motion); }
  catch { return fail("gpu_resource_refused", "CheckpointStoryboard retained-trace preview requires an exact readable Motion authority."); }
  if (documentFingerprint !== state.documentFingerprint) return fail("gpu_resource_refused", "CheckpointStoryboard retained-trace preview static execution wrapper is stale for this Motion authority.");
  const raw = compileGpuParametricTracePreviewFramePlan(motion, state.raw, atUs);
  if (!raw.ok) return raw;
  if (raw.plan.drawers.length !== 1 || raw.plan.drawers[0]?.mode !== "line" || raw.plan.drawers[0]?.topology.primitive !== "line-strip" || raw.plan.drawers[0]?.topology.bufferBinding.strideBytes !== GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES) {
    return fail("gpu_unsupported_feature", "CheckpointStoryboard retained-trace preview refuses a widened non-line or non-fixed-stride GPU plan.");
  }
  let rasterization: CheckpointStoryboardRetainedTraceRasterizationFrameEvidence;
  try {
    rasterization = createFrameRasterizationEvidence(staticPlan.rasterization, raw.plan.drawers[0]!);
  } catch (error) {
    return fail("gpu_resource_refused", error instanceof Error ? error.message : "CheckpointStoryboard retained-trace preview rasterization budget is invalid.");
  }
  const payload = {
    schema: CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_FRAME_SCHEMA,
    staticFingerprint: staticPlan.fingerprint,
    retainedTracePlanFingerprint: state.retainedTracePlanFingerprint,
    atUs,
    vertexAbi: raw.plan.vertexAbi,
    topologyAbi: raw.plan.topologyAbi,
    drawers: raw.plan.drawers,
    budget: raw.plan.budget,
    rasterization,
  } as const;
  const plan = freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
  frameStates.set(plan, { issuingStaticPlan: staticPlan as unknown as object, raw: raw.plan });
  return { ok: true, plan };
}

/** Rechecks the nonserializable issuer and exact Motion document after a renderer async boundary. */
export function checkCheckpointStoryboardRetainedTracePreviewStaticFreshness(
  motion: MotionDocument,
  staticPlan: CheckpointStoryboardRetainedTracePreviewStaticPlan,
): CheckpointStoryboardRetainedTracePreviewFreshnessResult {
  const state = staticStates.get(staticPlan as unknown as object);
  if (!state) return fail("gpu_resource_refused", "CheckpointStoryboard retained-trace preview requires an exact Core-issued static execution wrapper.");
  try {
    if (state.documentFingerprint !== fingerprintMotion(motion)) return fail("gpu_resource_refused", "CheckpointStoryboard retained-trace preview static execution wrapper is stale for this Motion authority.");
  } catch {
    return fail("gpu_resource_refused", "CheckpointStoryboard retained-trace preview requires an exact readable Motion authority.");
  }
  return checkGpuParametricTracePreviewStaticFreshness(motion, state.raw);
}

/** Returns only a defensive copy of the fixed 20-byte packed line-strip upload. */
export function readCheckpointStoryboardRetainedTracePreviewUpload(
  staticPlan: CheckpointStoryboardRetainedTracePreviewStaticPlan,
  framePlan: CheckpointStoryboardRetainedTracePreviewFramePlan,
): CheckpointStoryboardRetainedTracePreviewUpload {
  const staticState = staticStates.get(staticPlan as unknown as object);
  const frameState = frameStates.get(framePlan as unknown as object);
  if (!staticState || !frameState || frameState.issuingStaticPlan !== staticPlan || framePlan.staticFingerprint !== staticPlan.fingerprint || framePlan.retainedTracePlanFingerprint !== staticState.retainedTracePlanFingerprint) {
    throw new Error("CheckpointStoryboard retained-trace preview requires matching exact Core-issued static and frame execution wrappers.");
  }
  const upload = readGpuParametricTracePreviewUpload(staticState.raw, frameState.raw);
  if (
    upload.drawers.length !== 1
    || upload.drawers[0]?.vertexBytes.byteLength !== framePlan.drawers[0]?.vertexByteLength
    || framePlan.drawers[0]?.topology.primitive !== "line-strip"
    || framePlan.drawers[0]?.topology.bufferBinding.strideBytes !== GPU_PARAMETRIC_TRACE_VERTEX_STRIDE_BYTES
    || !matchesRasterizationEvidence(staticPlan.rasterization, framePlan.rasterization, framePlan.drawers[0]!)
  ) {
    throw new Error("CheckpointStoryboard retained-trace preview upload does not match its fixed B7 line-strip ABI.");
  }
  return Object.freeze({ frame: framePlan, drawers: Object.freeze(upload.drawers.map((drawer) => Object.freeze({ drawerId: drawer.drawerId, vertexBytes: Uint8Array.from(drawer.vertexBytes) }))) });
}

function exactScheduleMember(schedule: readonly number[], atUs: number): boolean { return schedule.includes(atUs); }
function fail(code: CheckpointStoryboardRetainedTracePreviewFailure["code"], message: string): { ok: false; failure: CheckpointStoryboardRetainedTracePreviewFailure } { return { ok: false, failure: { code, message } }; }
