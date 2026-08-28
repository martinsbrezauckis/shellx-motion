import { createHash } from "node:crypto";
import { assertLocalMotionFrameBudget, canonicalJsonSha256, defaultLocalMotionJobGovernor, type LocalMotionJobEvidence, type MotionPackage } from "@shellx-motion/core";
import {
  checkCheckpointStoryboardRetainedTracePreviewStaticFreshness,
  compileCheckpointStoryboardRetainedTracePreviewFramePlan,
  compileCheckpointStoryboardRetainedTracePreviewStaticPlan,
  readCheckpointStoryboardRetainedTracePreviewUpload,
  type CheckpointStoryboardRetainedTracePreviewFailure,
  type CheckpointStoryboardRetainedTracePreviewFramePlan,
  type CheckpointStoryboardRetainedTracePreviewStaticPlan,
  type CheckpointStoryboardRetainedTracePreviewUpload,
} from "@shellx-motion/core/internal/checkpoint-storyboard-retained-trace-preview";
import { createCheckpointStoryboardRetainedTraceRenderSession, DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS } from "./gpu-frame-renderer";
import { encodeGpuPng } from "./gpu-png";
import { GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_BACKGROUND, GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS, GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_UPLOAD_BYTES, GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_VERTICES, GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_VERTEX_STRIDE_BYTES } from "./gpu-page-checkpoint-storyboard-retained-trace";
import type { GpuPageSessionResourceMetrics } from "./gpu-page-session-resources";
import type { GpuRuntimeEvidence } from "./gpu-runtime-types";
import { assertNoStructuralPrivatePublication, resolveRendererPrivateOutputPublication } from "./private-output-publication";

export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_EVIDENCE_SCHEMA = "shellx-motion/checkpoint-storyboard-retained-trace-preview-evidence@1" as const;

/**
 * Renderer-only B7 entry. Debug binds a Core-minted private publication to this exact options
 * object; Browser receives no structural output or scratch-path authority.
 */
export interface CheckpointStoryboardRetainedTracePreviewOptions {
  /** Opaque exact C6B7a plan. The Core B7 wrapper, not Browser, parses or admits it. */
  readonly retainedTracePlan: unknown;
  readonly atUs: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly callerId?: string;
  readonly jobId?: string;
}

export interface CheckpointStoryboardRetainedTracePreviewCleanup {
  readonly closed: true;
  readonly traceBuffers: { readonly sampleBufferDestroyed: true; readonly rasterControlBufferDestroyed: true; readonly targetDestroyed: true; readonly readbackBufferDestroyed: true };
  readonly runtimeResources: GpuPageSessionResourceMetrics | null;
  readonly fingerprint: string;
}

export interface CheckpointStoryboardRetainedTracePreviewEvidence {
  readonly schema: typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_EVIDENCE_SCHEMA;
  readonly retainedTracePlanFingerprint: string;
  readonly staticWrapperFingerprint: string;
  readonly frameWrapperFingerprint: string;
  readonly atUs: number;
  readonly vertexAbi: "shellx-motion/gpu-parametric-trace-vertices@2";
  readonly sampleTopology: "line-strip/sequential-sample@1";
  readonly rasterPrimitive: "triangle-list";
  readonly rasterMapping: "motion-top-left-pixel-xy-to-ndc@1";
  readonly rasterTessellation: "square-cap-or-endpoint-width-segment-quad@1";
  readonly sampleCount: number;
  readonly rasterVertexInvocations: number;
  readonly maxRasterVertexInvocations: typeof GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS;
  readonly uploadBytes: number;
  readonly uploadSha256: string;
  readonly staticRasterizationFingerprint: string;
  readonly frameRasterizationFingerprint: string;
  readonly outputSha256: string;
  readonly outputByteLength: number;
  readonly background: typeof GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_BACKGROUND;
  readonly cleanupFingerprint: string;
  readonly fingerprint: string;
}

export type CheckpointStoryboardRetainedTracePreviewResult =
  | {
    ok: true;
    output: { sha256: string; byteLength: number; width: number; height: number; atUs: number; background: typeof GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_BACKGROUND };
    gpu: GpuRuntimeEvidence;
    resources: LocalMotionJobEvidence;
    cleanup: CheckpointStoryboardRetainedTracePreviewCleanup;
    evidence: CheckpointStoryboardRetainedTracePreviewEvidence;
  }
  | { ok: false; error: { code: string; message: string }; resources?: LocalMotionJobEvidence };

type PackageSnapshot = { packageId: string; manifestFingerprint: string; motionFingerprint: string };
type FixedCoreUpload = {
  sampleCount: number;
  rasterVertexInvocations: number;
  staticRasterization: {
    mapping: "motion-top-left-pixel-xy-to-ndc@1";
    tessellation: "square-cap-or-endpoint-width-segment-quad@1";
    primitive: "triangle-list";
    fingerprint: string;
  };
  frameRasterizationFingerprint: string;
  vertexBytes: Uint8Array;
  uploadSha256: string;
};
type RetainedTraceRuntime = Extract<Awaited<ReturnType<typeof createCheckpointStoryboardRetainedTraceRenderSession>>, { ok: true }>['session'];

export async function renderCheckpointStoryboardRetainedTracePreview(
  pkg: MotionPackage,
  options: CheckpointStoryboardRetainedTracePreviewOptions,
): Promise<CheckpointStoryboardRetainedTracePreviewResult> {
  const cancelled = () => options.signal?.aborted === true;
  let runtime: RetainedTraceRuntime | undefined;
  try {
    try {
      assertNoStructuralPrivatePublication(options);
    } catch (error) {
      return fail("gpu_private_output_publication_refused", error instanceof Error ? error.message : "Checkpoint storyboard retained-trace preview private output publication is not renderer-minted.");
    }
    const privateOutputPublication = resolveRendererPrivateOutputPublication(options);
    if (!privateOutputPublication) return fail("gpu_private_output_publication_refused", "Checkpoint storyboard retained-trace preview requires one Debug-bound Core private output publication before resource admission.");
    // Reject unserviceable documents before the shared governor, a Chromium session, or any GPU work.
    assertLocalMotionFrameBudget({ width: pkg.motion.width, height: pkg.motion.height });
    if (cancelled()) return cancelledResult("before Core B7 admission");
    if (pkg.manifest.assets.length !== 0 || pkg.motion.assets.length !== 0) return fail("gpu_resource_refused", "Checkpoint storyboard retained-trace preview refuses package resources before renderer allocation.");
    const snapshot = capturePackageSnapshot(pkg);
    const staticResult = compileCheckpointStoryboardRetainedTracePreviewStaticPlan(pkg.motion, options.retainedTracePlan);
    if (!staticResult.ok) return failure(staticResult.failure);
    const preflight = checkPrecommit(pkg, snapshot, staticResult.plan, options.signal);
    if (!preflight.ok) return preflight;
    const frameResult = compileCheckpointStoryboardRetainedTracePreviewFramePlan(pkg.motion, staticResult.plan, options.atUs);
    if (!frameResult.ok) return failure(frameResult.failure);
    const upload = readFixedCoreUpload(staticResult.plan, frameResult.plan);
    const afterFrame = checkPrecommit(pkg, snapshot, staticResult.plan, options.signal);
    if (!afterFrame.ok) return afterFrame;
    const governed = await defaultLocalMotionJobGovernor.run({
      lane: "gpu",
      operation: "gpu.checkpoint-storyboard.retained-trace.preview",
      scratchRoot: privateOutputPublication.rootPath,
      signal: options.signal,
      ...(options.callerId ? { callerId: options.callerId } : {}),
      ...(options.jobId ? { jobId: options.jobId } : {}),
    }, async ({ signal, watchProcess }) => {
      if (signal.aborted) return { ok: false as const, failure: cancellationFailure("before runtime allocation") };
      const fresh = checkPrecommit(pkg, snapshot, staticResult.plan, options.signal);
      if (!fresh.ok) return { ok: false as const, failure: fresh.error };
      const opened = await createCheckpointStoryboardRetainedTraceRenderSession();
      if (!opened.ok) return opened;
      runtime = opened.session;
      watchProcess(runtime.browserProcess.pid);
      if (signal.aborted) return { ok: false as const, failure: cancellationFailure("after runtime allocation") };
      const beforeDraw = checkPrecommit(pkg, snapshot, staticResult.plan, options.signal);
      if (!beforeDraw.ok) return { ok: false as const, failure: beforeDraw.error };
      const drawn = await runtime.renderCheckpointStoryboardRetainedTrace({ width: pkg.motion.width, height: pkg.motion.height, sampleCount: upload.sampleCount, rasterVertexInvocations: upload.rasterVertexInvocations, vertexBytes: upload.vertexBytes }, { timeoutMs: options.timeoutMs ?? DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, signal });
      if (!drawn.ok) return drawn;
      if (signal.aborted) return { ok: false as const, failure: cancellationFailure("after isolated trace draw") };
      const afterDraw = checkPrecommit(pkg, snapshot, staticResult.plan, options.signal);
      return afterDraw.ok ? drawn : { ok: false as const, failure: afterDraw.error };
    });
    if (!governed.value.ok) return { ok: false, error: governed.value.failure, resources: governed.evidence };
    if (governed.value.frame.width !== pkg.motion.width || governed.value.frame.height !== pkg.motion.height) return { ok: false, error: { code: "gpu_execution_refused", message: "Checkpoint storyboard retained-trace runtime returned dimensions different from the exact Motion authority." }, resources: governed.evidence };
    const afterGoverned = checkPrecommit(pkg, snapshot, staticResult.plan, options.signal);
    if (!afterGoverned.ok) return { ...afterGoverned, resources: governed.evidence };
    const runtimeToClose = runtime;
    runtime = undefined;
    const cleanup = await closeRuntime(runtimeToClose, governed.value.cleanup);
    const beforeStaging = checkPrecommit(pkg, snapshot, staticResult.plan, options.signal);
    if (!beforeStaging.ok) return { ...beforeStaging, resources: governed.evidence };
    const png = encodeGpuPng({ rgba: governed.value.frame.rgba, width: governed.value.frame.width, height: governed.value.frame.height });
    const beforeWrite = checkPrecommit(pkg, snapshot, staticResult.plan, options.signal);
    if (!beforeWrite.ok) return { ...beforeWrite, resources: governed.evidence };
    // The Debug-bound Core publication owns the identity-checked private stage and exact cap.
    const output = assertPrivateOutputEvidence(await privateOutputPublication.writePrivateFile(png, {
      label: "Checkpoint storyboard retained-trace staged preview PNG",
      maxBytes: 64 * 1024 * 1024,
    }), png);
    const afterWrite = checkPrecommit(pkg, snapshot, staticResult.plan, options.signal);
    if (!afterWrite.ok) {
      // The host owns the private stage; its publication recovery verifies or abandons it.
      return { ...afterWrite, resources: governed.evidence };
    }
    const evidence = createEvidence(options, staticResult.plan, frameResult.plan, upload, output, cleanup);
    return {
      ok: true,
      output: { ...output, width: governed.value.frame.width, height: governed.value.frame.height, atUs: options.atUs, background: GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_BACKGROUND },
      gpu: governed.value.frame.evidence,
      resources: governed.evidence,
      cleanup,
      evidence,
    };
  } catch (error) {
    return { ok: false, error: { code: cancelled() ? "gpu_cancelled" : "gpu_execution_refused", message: error instanceof Error ? error.message : "Checkpoint storyboard retained-trace preview refused." } };
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
  }
}

/** Debug binds this self-hashed source evidence into its own host-governed receipt. */
export function verifyCheckpointStoryboardRetainedTracePreviewEvidence(value: unknown): CheckpointStoryboardRetainedTracePreviewEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Checkpoint storyboard retained-trace preview evidence must be an object.");
  const record = value as Record<string, unknown>;
  const keys = ["atUs", "background", "cleanupFingerprint", "fingerprint", "frameRasterizationFingerprint", "frameWrapperFingerprint", "maxRasterVertexInvocations", "outputByteLength", "outputSha256", "rasterMapping", "rasterPrimitive", "rasterTessellation", "rasterVertexInvocations", "retainedTracePlanFingerprint", "sampleCount", "sampleTopology", "schema", "staticRasterizationFingerprint", "staticWrapperFingerprint", "uploadBytes", "uploadSha256", "vertexAbi"];
  const sampleCount = record.sampleCount as number;
  const expectedRasterVertexInvocations = typeof sampleCount === "number" && sampleCount === 1 ? 6 : typeof sampleCount === "number" ? (sampleCount - 1) * 6 : -1;
  if (!sameKeys(record, keys) || record.schema !== CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_EVIDENCE_SCHEMA || record.background !== GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_BACKGROUND || record.vertexAbi !== "shellx-motion/gpu-parametric-trace-vertices@2" || record.sampleTopology !== "line-strip/sequential-sample@1" || record.rasterPrimitive !== "triangle-list" || record.rasterMapping !== "motion-top-left-pixel-xy-to-ndc@1" || record.rasterTessellation !== "square-cap-or-endpoint-width-segment-quad@1" || !Number.isSafeInteger(record.atUs) || (record.atUs as number) < 0 || !Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_VERTICES || !Number.isSafeInteger(record.rasterVertexInvocations) || record.rasterVertexInvocations !== expectedRasterVertexInvocations || (record.rasterVertexInvocations as number) > GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS || record.maxRasterVertexInvocations !== GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS || record.uploadBytes !== sampleCount * GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_VERTEX_STRIDE_BYTES || (record.uploadBytes as number) > GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_UPLOAD_BYTES || !Number.isSafeInteger(record.outputByteLength) || (record.outputByteLength as number) < 1 || !validHashes(record, ["retainedTracePlanFingerprint", "staticWrapperFingerprint", "frameWrapperFingerprint", "staticRasterizationFingerprint", "frameRasterizationFingerprint", "uploadSha256", "outputSha256", "cleanupFingerprint", "fingerprint"])) throw new Error("Checkpoint storyboard retained-trace preview evidence has an invalid fixed B7 shape.");
  const { fingerprint, ...payload } = record as unknown as CheckpointStoryboardRetainedTracePreviewEvidence;
  if (typeof fingerprint !== "string" || canonicalJsonSha256(payload) !== fingerprint) throw new Error("Checkpoint storyboard retained-trace preview evidence fingerprint does not match its payload.");
  return Object.freeze({ ...payload, fingerprint });
}

function capturePackageSnapshot(pkg: MotionPackage): PackageSnapshot {
  return Object.freeze({ packageId: pkg.manifest.id, manifestFingerprint: canonicalJsonSha256(pkg.manifest), motionFingerprint: canonicalJsonSha256(pkg.motion) });
}

function checkPrecommit(pkg: MotionPackage, snapshot: PackageSnapshot, staticPlan: CheckpointStoryboardRetainedTracePreviewStaticPlan, signal: AbortSignal | undefined): { ok: true } | { ok: false; error: { code: string; message: string } } {
  if (signal?.aborted) return { ok: false, error: cancellationFailure("before staged output") };
  const freshness = checkCheckpointStoryboardRetainedTracePreviewStaticFreshness(pkg.motion, staticPlan);
  if (!freshness.ok) return { ok: false, error: freshness.failure };
  if (snapshot.packageId !== pkg.manifest.id || snapshot.manifestFingerprint !== canonicalJsonSha256(pkg.manifest) || snapshot.motionFingerprint !== canonicalJsonSha256(pkg.motion)) return { ok: false, error: { code: "gpu_resource_refused", message: "Checkpoint storyboard retained-trace preview package snapshot is stale after an asynchronous boundary." } };
  return { ok: true };
}

function readFixedCoreUpload(staticPlan: CheckpointStoryboardRetainedTracePreviewStaticPlan, framePlan: CheckpointStoryboardRetainedTracePreviewFramePlan): FixedCoreUpload {
  const upload = readCheckpointStoryboardRetainedTracePreviewUpload(staticPlan, framePlan) as CheckpointStoryboardRetainedTracePreviewUpload;
  const frame = framePlan as unknown as { vertexAbi?: unknown; drawers?: readonly unknown[] };
  const drawer = frame.drawers?.[0] as Record<string, unknown> | undefined;
  const drawerTopology = drawer?.topology as Record<string, unknown> | undefined;
  const drawerWindow = drawer?.window as Record<string, unknown> | undefined;
  const uploadDrawers = (upload as unknown as { drawers?: readonly unknown[] }).drawers;
  const uploadDrawer = uploadDrawers?.[0] as Record<string, unknown> | undefined;
  const vertexBytes = uploadDrawer?.vertexBytes;
  const sampleCount = drawerWindow?.sampleCount;
  const expectedRasterVertexInvocations = typeof sampleCount === "number" && sampleCount === 1 ? 6 : typeof sampleCount === "number" ? (sampleCount - 1) * 6 : -1;
  const staticRasterization = staticPlan.rasterization;
  const frameRasterization = framePlan.rasterization;
  if (upload.frame !== framePlan || frame.vertexAbi !== "shellx-motion/gpu-parametric-trace-vertices@2" || !Array.isArray(frame.drawers) || frame.drawers.length !== 1 || !drawer || !drawerTopology || drawerTopology.primitive !== "line-strip" || drawerTopology.fetch !== "sequential-sample@1" || (drawerTopology.bufferBinding as Record<string, unknown> | undefined)?.strideBytes !== GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_VERTEX_STRIDE_BYTES || drawerTopology.ringVertices !== 0 || drawerTopology.segmentVertexInvocations !== 0 || !Number.isSafeInteger(sampleCount) || (sampleCount as number) < 1 || (sampleCount as number) > GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_VERTICES || drawerWindow?.vertexCount !== sampleCount || drawerTopology.drawVertexInvocations !== sampleCount || !Array.isArray(uploadDrawers) || uploadDrawers.length !== 1 || uploadDrawer?.drawerId !== drawer.drawerId || !(vertexBytes instanceof Uint8Array) || vertexBytes.byteLength !== (sampleCount as number) * GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_VERTEX_STRIDE_BYTES || vertexBytes.byteLength > GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_UPLOAD_BYTES || staticRasterization.mapping !== "motion-top-left-pixel-xy-to-ndc@1" || staticRasterization.sampleZ !== "ignore-packed-sample-z@1" || staticRasterization.source !== "fixed-20-byte-raw-u32-storage@1" || staticRasterization.tessellation !== "square-cap-or-endpoint-width-segment-quad@1" || staticRasterization.primitive !== "triangle-list" || staticRasterization.sampleStrideBytes !== GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_VERTEX_STRIDE_BYTES || staticRasterization.maxSamples !== GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_VERTICES || staticRasterization.maxRasterVertexInvocations !== GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS || !/^[a-f0-9]{64}$/.test(staticRasterization.fingerprint) || frameRasterization.staticRasterizationFingerprint !== staticRasterization.fingerprint || frameRasterization.sampleCount !== sampleCount || frameRasterization.sampleUploadBytes !== vertexBytes.byteLength || frameRasterization.rasterVertexCount !== expectedRasterVertexInvocations || frameRasterization.drawVertexInvocations !== expectedRasterVertexInvocations || frameRasterization.maxRasterVertexInvocations !== GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS || expectedRasterVertexInvocations > GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS || !/^[a-f0-9]{64}$/.test(frameRasterization.fingerprint)) throw new Error("Core B7 retained-trace upload widened its fixed one-drawer raster ABI.");
  const uploadSha256 = createHash("sha256").update(vertexBytes).digest("hex");
  if (drawer.vertexBufferSha256 !== uploadSha256) throw new Error("Core B7 retained-trace upload bytes do not match their issued fingerprint.");
  return Object.freeze({
    sampleCount: sampleCount as number,
    rasterVertexInvocations: expectedRasterVertexInvocations,
    staticRasterization: Object.freeze({ mapping: staticRasterization.mapping, tessellation: staticRasterization.tessellation, primitive: staticRasterization.primitive, fingerprint: staticRasterization.fingerprint }),
    frameRasterizationFingerprint: frameRasterization.fingerprint,
    vertexBytes: Uint8Array.from(vertexBytes),
    uploadSha256,
  });
}

function createEvidence(options: CheckpointStoryboardRetainedTracePreviewOptions, staticPlan: CheckpointStoryboardRetainedTracePreviewStaticPlan, framePlan: CheckpointStoryboardRetainedTracePreviewFramePlan, upload: FixedCoreUpload, output: Readonly<{ sha256: string; byteLength: number }>, cleanup: CheckpointStoryboardRetainedTracePreviewCleanup): CheckpointStoryboardRetainedTracePreviewEvidence {
  const payload = {
    schema: CHECKPOINT_STORYBOARD_RETAINED_TRACE_PREVIEW_EVIDENCE_SCHEMA,
    retainedTracePlanFingerprint: readFingerprint(options.retainedTracePlan, "C6B7 retained-trace plan"),
    staticWrapperFingerprint: readFingerprint(staticPlan, "Core B7 static wrapper"),
    frameWrapperFingerprint: readFingerprint(framePlan, "Core B7 frame wrapper"),
    atUs: options.atUs,
    vertexAbi: "shellx-motion/gpu-parametric-trace-vertices@2" as const,
    sampleTopology: "line-strip/sequential-sample@1" as const,
    rasterPrimitive: upload.staticRasterization.primitive,
    rasterMapping: upload.staticRasterization.mapping,
    rasterTessellation: upload.staticRasterization.tessellation,
    sampleCount: upload.sampleCount,
    rasterVertexInvocations: upload.rasterVertexInvocations,
    maxRasterVertexInvocations: GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_MAX_RASTER_VERTEX_INVOCATIONS,
    uploadBytes: upload.vertexBytes.byteLength,
    uploadSha256: upload.uploadSha256,
    staticRasterizationFingerprint: upload.staticRasterization.fingerprint,
    frameRasterizationFingerprint: upload.frameRasterizationFingerprint,
    outputSha256: output.sha256,
    outputByteLength: output.byteLength,
    background: GPU_CHECKPOINT_STORYBOARD_RETAINED_TRACE_BACKGROUND,
    cleanupFingerprint: cleanup.fingerprint,
  } as const;
  return Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

async function closeRuntime(runtime: RetainedTraceRuntime | undefined, traceBuffers: CheckpointStoryboardRetainedTracePreviewCleanup["traceBuffers"]): Promise<CheckpointStoryboardRetainedTracePreviewCleanup> {
  if (!runtime) throw new Error("Checkpoint storyboard retained-trace preview did not retain its GPU session for terminal cleanup.");
  await runtime.close();
  const runtimeResources = runtime.resourceMetrics ? await runtime.resourceMetrics().catch(() => null) : null;
  const payload = { closed: true as const, traceBuffers, runtimeResources };
  return Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function assertPrivateOutputEvidence(value: unknown, png: Buffer): Readonly<{ sha256: string; byteLength: number }> {
  const expected = Object.freeze({ sha256: createHash("sha256").update(png).digest("hex"), byteLength: png.byteLength });
  const written = value as { sha256?: unknown; byteLength?: unknown } | null;
  if (!written || typeof written !== "object" || Array.isArray(written)
    || written.sha256 !== expected.sha256
    || written.byteLength !== expected.byteLength) {
    throw new Error("Checkpoint storyboard retained-trace private PNG writer did not return the exact written byte evidence.");
  }
  return Object.freeze({ sha256: written.sha256, byteLength: written.byteLength });
}
function readFingerprint(value: unknown, label: string): string {
  const fingerprint = value && typeof value === "object" ? (value as Record<string, unknown>).fingerprint : undefined;
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error(`${label} lost its exact Core-issued fingerprint.`);
  return fingerprint;
}
function failure(value: CheckpointStoryboardRetainedTracePreviewFailure): CheckpointStoryboardRetainedTracePreviewResult { return { ok: false, error: value }; }
function cancellationFailure(when: string) { return { code: "gpu_cancelled", message: `Checkpoint storyboard retained-trace preview was cancelled ${when}.` }; }
function cancelledResult(when: string): CheckpointStoryboardRetainedTracePreviewResult { return { ok: false, error: cancellationFailure(when) }; }
function fail(code: string, message: string): CheckpointStoryboardRetainedTracePreviewResult { return { ok: false, error: { code, message } }; }
function sameKeys(record: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(record).sort(); return keys.length === expected.length && keys.every((key, index) => key === expected[index]); }
function validHashes(record: Record<string, unknown>, keys: readonly string[]): boolean { return keys.every((key) => typeof record[key] === "string" && /^[a-f0-9]{64}$/.test(record[key] as string)); }
