import { writeFile } from "node:fs/promises";
import { acquireDerivedOutputPublication, canonicalJsonSha256, createPreviewReceipt, defaultLocalMotionJobGovernor, type LocalMotionJobEvidence, type LocalMotionJobGovernor, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import {
  checkGpuParametricTracePreviewStaticFreshness,
  compileGpuParametricTracePreviewFramePlan,
  compileGpuParametricTracePreviewStaticPlan,
  readGpuParametricTracePreviewUpload,
  GPU_PARAMETRIC_TRACE_PREVIEW_FRAME_SCHEMA,
  GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI,
  GPU_PARAMETRIC_TRACE_VERTEX_ABI,
  type GpuParametricTracePreviewDrawerFrame,
  type GpuParametricTracePreviewFailure,
  type GpuParametricTracePreviewFramePlan,
  type GpuParametricTracePreviewStaticPlan,
  type GpuParametricTracePreviewUpload,
} from "@shellx-motion/core/internal/parametric-trace-preview";
import { DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, type GpuFrameRenderSession } from "../gpu-frame-renderer";
import { createGpuFrameRenderSession } from "../gpu-frame-renderer";
import { gpuLoadedPackageInputHashes } from "../gpu-loaded-input-hashes";
import { encodeGpuPng } from "../gpu-png";
import { resolveGpuPreviewOutputPath } from "../gpu-preview-output";
import { prepareGpuSceneResources, type PreparedGpuSceneResources } from "../gpu-scene-resources";
import type { GpuPageSessionResourceMetrics } from "../gpu-page-session-resources";
import type { GpuRuntimeEvidence } from "../gpu-runtime-types";

export const GPU_PARAMETRIC_TRACE_PREVIEW_RECEIPT_SCHEMA = "shellx-motion/gpu-parametric-trace-preview-receipt@1" as const;
export interface GpuParametricTracePreviewOptions {
  atUs: number;
  outDir: string;
  descriptor: unknown;
  outputPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  callerId?: string;
  jobId?: string;
  now?: () => string;
}
export interface GpuParametricTracePreviewCleanup { closed: true; runtimeResources: GpuPageSessionResourceMetrics | null; fingerprint: string }
interface GpuParametricTracePreviewPackageSnapshot { packageId: string; manifestFingerprint: string; documentFingerprint: string; inputHashes: Readonly<Record<string, string>> }
type GpuParametricTracePreviewPrecommitFailure = { ok: false; error: { code: string; message: string } };
type GpuParametricTracePreviewPrecommitResult = { ok: true } | GpuParametricTracePreviewPrecommitFailure;
export interface GpuParametricTracePreviewEvidence {
  schema: typeof GPU_PARAMETRIC_TRACE_PREVIEW_RECEIPT_SCHEMA;
  traceSourceSha256: string;
  tracePlanFingerprint: string;
  staticWrapperFingerprint: string;
  frameWrapperFingerprint: string;
  atUs: number;
  vertexAbi: typeof GPU_PARAMETRIC_TRACE_VERTEX_ABI;
  topologyAbi: typeof GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI;
  drawerWindows: readonly { drawerId: string; windowFingerprint: string; sampleSliceSha256: string; vertexBufferSha256: string; topologyFingerprint: string }[];
  budgetFingerprint: string;
  outputSha256: string;
  cleanupFingerprint: string;
  fingerprint: string;
}
export type GpuParametricTracePreviewResult =
  | { ok: true; receipt: OperationReceipt; frame: { path: string; sha256: string; width: number; height: number; atUs: number; gpu: GpuRuntimeEvidence; resources: LocalMotionJobEvidence } }
  | { ok: false; error: { code: string; message: string }; resources?: LocalMotionJobEvidence };
type TraceDrawResult = Awaited<ReturnType<GpuFrameRenderSession["render"]>>;
export interface GpuParametricTracePreviewTestSeams {
  governor?: LocalMotionJobGovernor;
  openRuntime?: typeof createGpuFrameRenderSession;
  prepareResourcesForTest?: (pkg: MotionPackage) => Promise<PreparedGpuSceneResources>;
  resolveOutputPathForTest?: typeof resolveGpuPreviewOutputPath;
  /** Source-proof seam only: the Browser side receives Core-issued packed bytes and may only upload/draw them. */
  drawTraceForTest?: (input: { runtime: GpuFrameRenderSession; upload: GpuParametricTracePreviewUpload; timeoutMs: number; signal: AbortSignal }) => Promise<TraceDrawResult>;
}

/**
 * Deliberately unexported Browser source vertical. Production has no trace pipeline yet, so a
 * host must inject the fake/runtime draw seam; the normal GPU preview route is untouched.
 */
export async function renderGpuParametricTracePreview(pkg: MotionPackage, options: GpuParametricTracePreviewOptions, seams: GpuParametricTracePreviewTestSeams = {}): Promise<GpuParametricTracePreviewResult> {
  const governor = seams.governor ?? defaultLocalMotionJobGovernor;
  const cancelled = () => options.signal?.aborted === true;
  let runtime: GpuFrameRenderSession | undefined;
  let cleanup: GpuParametricTracePreviewCleanup | undefined;
  try {
    if (cancelled()) return cancelledResult();
    if (!seams.drawTraceForTest) return { ok: false, error: { code: "gpu_trace_runtime_unavailable", message: "GPU parametric trace preview has no installed trace upload/draw runtime; this source-only seam refuses before resources." } };
    if (pkg.manifest.assets.length > 0) return { ok: false, error: { code: "gpu_resource_refused", message: "GPU parametric trace preview refuses package resources before renderer allocation." } };
    const packageSnapshot = capturePackageSnapshot(pkg);
    const staticResult = compileGpuParametricTracePreviewStaticPlan(pkg.motion, options.descriptor);
    if (!staticResult.ok) return failure(staticResult.failure);
    const checkPrecommit = (): GpuParametricTracePreviewPrecommitResult => {
      if (cancelled()) return { ok: false, error: { code: "gpu_cancelled", message: "GPU parametric trace preview was cancelled before irreversible output publication." } };
      const freshness = checkPackageSnapshot(pkg, packageSnapshot, staticResult.plan);
      return freshness.ok ? { ok: true } : { ok: false, error: freshness.failure };
    };
    const afterStatic = checkPrecommit();
    if (!afterStatic.ok) return { ok: false, error: afterStatic.error };
    const frameResult = compileGpuParametricTracePreviewFramePlan(pkg.motion, staticResult.plan, options.atUs);
    if (!frameResult.ok) return failure(frameResult.failure);
    const afterFrame = checkPrecommit();
    if (!afterFrame.ok) return { ok: false, error: afterFrame.error };
    const prepared = await (seams.prepareResourcesForTest ?? prepareGpuSceneResources)(pkg);
    const afterResources = checkPrecommit();
    if (!afterResources.ok) return { ok: false, error: afterResources.error };
    const outputPath = await (seams.resolveOutputPathForTest ?? resolveGpuPreviewOutputPath)(pkg, { atMs: options.atUs / 1_000, outDir: options.outDir, ...(options.outputPath ? { outputPath: options.outputPath } : {}) });
    const afterOutputPath = checkPrecommit();
    if (!afterOutputPath.ok) return { ok: false, error: afterOutputPath.error };
    const governed = await governor.run({ lane: "gpu", operation: "gpu.parametric-trace.preview", scratchRoot: options.outDir, signal: options.signal, ...(options.callerId ? { callerId: options.callerId } : {}), ...(options.jobId ? { jobId: options.jobId } : {}) }, async ({ signal, watchProcess }) => {
      if (signal.aborted) return { ok: false as const, failure: { code: "gpu_cancelled", message: "GPU parametric trace preview was cancelled before runtime allocation." } };
      const beforeRuntime = checkPrecommit();
      if (!beforeRuntime.ok) return { ok: false as const, failure: beforeRuntime.error };
      const opened = await (seams.openRuntime ?? createGpuFrameRenderSession)(prepared.sessionImages, prepared.sessionFonts);
      if (!opened.ok) return opened;
      runtime = opened.session;
      if (signal.aborted) return { ok: false as const, failure: { code: "gpu_cancelled", message: "GPU parametric trace preview was cancelled after runtime allocation." } };
      const beforeDraw = checkPrecommit();
      if (!beforeDraw.ok) return { ok: false as const, failure: beforeDraw.error };
      watchProcess(runtime.browserProcess.pid);
      const uploaded = readGpuParametricTracePreviewUpload(staticResult.plan, frameResult.plan);
      const drawn = await seams.drawTraceForTest!({ runtime, upload: uploaded, timeoutMs: options.timeoutMs ?? DEFAULT_GPU_FRAME_OPERATION_TIMEOUT_MS, signal });
      if (signal.aborted) return { ok: false as const, failure: { code: "gpu_cancelled", message: "GPU parametric trace preview was cancelled before output publication." } };
      if (!drawn.ok) return drawn;
      const afterDraw = checkPrecommit();
      return afterDraw.ok ? drawn : { ok: false as const, failure: afterDraw.error };
    });
    if (!governed.value.ok) return { ok: false, error: governed.value.failure, resources: governed.evidence };
    const afterDraw = checkPrecommit();
    if (!afterDraw.ok) return { ok: false, error: afterDraw.error, resources: governed.evidence };
    const png = encodeGpuPng({ rgba: governed.value.frame.rgba, width: governed.value.frame.width, height: governed.value.frame.height });
    const runtimeToClose = runtime;
    runtime = undefined;
    cleanup = await closeRuntime(runtimeToClose);
    const beforePublication = checkPrecommit();
    if (!beforePublication.ok) return { ok: false, error: beforePublication.error, resources: governed.evidence };
    const publication = await publishTracePng(outputPath, png, checkPrecommit);
    if (!publication.ok) return { ok: false, error: publication.error, resources: governed.evidence };
    const sha256 = publication.sha256;
    const evidence = traceEvidence(staticResult.plan, frameResult.plan, sha256, cleanup);
    const receipt = createGpuParametricTracePreviewReceipt(packageSnapshot, prepared, options, outputPath, sha256, governed.value.frame.width, governed.value.frame.height, governed.value.frame.evidence, governed.evidence, evidence, cleanup);
    return { ok: true, receipt, frame: { path: outputPath, sha256, width: governed.value.frame.width, height: governed.value.frame.height, atUs: options.atUs, gpu: governed.value.frame.evidence, resources: governed.evidence } };
  } catch (error) {
    return { ok: false, error: { code: cancelled() ? "gpu_cancelled" : "gpu_execution_refused", message: error instanceof Error ? error.message : "GPU parametric trace preview refused." } };
  } finally {
    if (runtime) await closeRuntime(runtime).catch(() => undefined);
  }
}

/** Checks serialization shape and self-hash only; Core issuance still requires live WeakMap wrappers. */
export function verifyGpuParametricTracePreviewEvidence(value: unknown): GpuParametricTracePreviewEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GPU parametric trace preview evidence must be an object.");
  const record = value as Record<string, unknown>;
  const keys = ["atUs", "budgetFingerprint", "cleanupFingerprint", "drawerWindows", "fingerprint", "frameWrapperFingerprint", "outputSha256", "schema", "staticWrapperFingerprint", "topologyAbi", "tracePlanFingerprint", "traceSourceSha256", "vertexAbi"];
  if (!sameKeys(record, keys) || record.schema !== GPU_PARAMETRIC_TRACE_PREVIEW_RECEIPT_SCHEMA || record.vertexAbi !== GPU_PARAMETRIC_TRACE_VERTEX_ABI || record.topologyAbi !== GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI || !Number.isSafeInteger(record.atUs) || (record.atUs as number) < 0 || !validHashes(record, ["traceSourceSha256", "tracePlanFingerprint", "staticWrapperFingerprint", "frameWrapperFingerprint", "budgetFingerprint", "outputSha256", "cleanupFingerprint", "fingerprint"]) || !Array.isArray(record.drawerWindows) || record.drawerWindows.some((drawer) => !drawer || typeof drawer !== "object" || Array.isArray(drawer) || !sameKeys(drawer as Record<string, unknown>, ["drawerId", "sampleSliceSha256", "topologyFingerprint", "vertexBufferSha256", "windowFingerprint"]) || typeof (drawer as Record<string, unknown>).drawerId !== "string" || !validHashes(drawer as Record<string, unknown>, ["windowFingerprint", "sampleSliceSha256", "vertexBufferSha256", "topologyFingerprint"]))) throw new Error("GPU parametric trace preview evidence has an invalid structural schema or ABI.");
  const { fingerprint, ...payload } = record as unknown as GpuParametricTracePreviewEvidence;
  if (typeof fingerprint !== "string" || canonicalJsonSha256(payload) !== fingerprint) throw new Error("GPU parametric trace preview evidence fingerprint does not match its payload.");
  return Object.freeze({ ...payload, fingerprint });
}

function traceEvidence(staticPlan: GpuParametricTracePreviewStaticPlan, framePlan: GpuParametricTracePreviewFramePlan, outputSha256: string, cleanup: GpuParametricTracePreviewCleanup): GpuParametricTracePreviewEvidence {
  if (framePlan.schema !== GPU_PARAMETRIC_TRACE_PREVIEW_FRAME_SCHEMA || framePlan.staticFingerprint !== staticPlan.fingerprint || staticPlan.topologyAbi !== GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI || framePlan.topologyAbi !== GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI) throw new Error("GPU parametric trace preview receipt does not match the rendered Core wrappers.");
  const payload = {
    schema: GPU_PARAMETRIC_TRACE_PREVIEW_RECEIPT_SCHEMA,
    traceSourceSha256: staticPlan.traceSourceSha256,
    tracePlanFingerprint: staticPlan.tracePlanFingerprint,
    staticWrapperFingerprint: staticPlan.fingerprint,
    frameWrapperFingerprint: framePlan.fingerprint,
    atUs: framePlan.atUs,
    vertexAbi: GPU_PARAMETRIC_TRACE_VERTEX_ABI,
    topologyAbi: GPU_PARAMETRIC_TRACE_TOPOLOGY_ABI,
    drawerWindows: framePlan.drawers.map(drawerEvidence),
    budgetFingerprint: framePlan.budget.fingerprint,
    outputSha256,
    cleanupFingerprint: cleanup.fingerprint,
  };
  return Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) });
}

function capturePackageSnapshot(pkg: MotionPackage): GpuParametricTracePreviewPackageSnapshot {
  return Object.freeze({ packageId: pkg.manifest.id, manifestFingerprint: canonicalJsonSha256(pkg.manifest), documentFingerprint: canonicalJsonSha256(pkg.motion), inputHashes: Object.freeze({ ...gpuLoadedPackageInputHashes(pkg) }) });
}
function checkPackageSnapshot(pkg: MotionPackage, snapshot: GpuParametricTracePreviewPackageSnapshot, staticPlan: GpuParametricTracePreviewStaticPlan): { ok: true } | { ok: false; failure: GpuParametricTracePreviewFailure } {
  const freshness = checkGpuParametricTracePreviewStaticFreshness(pkg.motion, staticPlan);
  if (!freshness.ok) return freshness;
  if (snapshot.packageId !== pkg.manifest.id || snapshot.manifestFingerprint !== canonicalJsonSha256(pkg.manifest) || snapshot.documentFingerprint !== canonicalJsonSha256(pkg.motion)) return { ok: false, failure: { code: "gpu_resource_refused", message: "GPU parametric trace preview package snapshot is stale after an asynchronous boundary." } };
  return { ok: true };
}
function createGpuParametricTracePreviewReceipt(snapshot: GpuParametricTracePreviewPackageSnapshot, prepared: PreparedGpuSceneResources, options: GpuParametricTracePreviewOptions, outputPath: string, sha256: string, width: number, height: number, gpu: GpuRuntimeEvidence, resources: LocalMotionJobEvidence, evidence: GpuParametricTracePreviewEvidence, cleanup: GpuParametricTracePreviewCleanup): OperationReceipt {
  const receipt = createPreviewReceipt({ id: `receipt_gpu_trace_${sha256.slice(0, 16)}`, packageId: snapshot.packageId, lane: "gpu", inputHashes: { ...snapshot.inputHashes, ...prepared.inputHashes, "gpu-trace-source": evidence.traceSourceSha256, "gpu-trace-plan": evidence.tracePlanFingerprint, "gpu-trace-static": evidence.staticWrapperFingerprint, "gpu-trace-frame": evidence.frameWrapperFingerprint, "gpu-trace-topology": canonicalJsonSha256({ topologyAbi: evidence.topologyAbi, drawers: evidence.drawerWindows.map(({ drawerId, topologyFingerprint }) => ({ drawerId, topologyFingerprint })) }), "gpu-trace-budget": evidence.budgetFingerprint }, outputFrame: { path: outputPath, sha256, width, height, atMs: options.atUs / 1_000 }, warnings: [] });
  receipt.operation = "preview.gpu.parametric-trace.frame";
  receipt.createdAt = options.now?.() ?? receipt.createdAt;
  receipt.artifacts = [{ role: "preview_frame", path: outputPath, status: "available", mediaType: "image/png", primary: true }];
  receipt.output = { ...(receipt.output as Record<string, unknown>), gpu, resources, gpuParametricTrace: verifyGpuParametricTracePreviewEvidence(evidence), gpuParametricTraceCleanup: cleanup };
  return receipt;
}

function drawerEvidence(drawer: GpuParametricTracePreviewDrawerFrame) { return Object.freeze({ drawerId: drawer.drawerId, windowFingerprint: drawer.window.fingerprint, sampleSliceSha256: drawer.sampleSliceSha256, vertexBufferSha256: drawer.vertexBufferSha256, topologyFingerprint: drawer.topology.fingerprint }); }
/** The irreversible commit point is invoking publishFile; cancellation is honored only before it begins. */
async function publishTracePng(outputPath: string, png: Buffer, checkPrecommit: () => GpuParametricTracePreviewPrecommitResult): Promise<{ ok: true; sha256: string } | GpuParametricTracePreviewPrecommitFailure> {
  const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
  let admission = checkPrecommit();
  if (!admission.ok) { await publication.abort(); return admission; }
  try {
    await writeFile(publication.stagingPath, png);
    admission = checkPrecommit();
    if (!admission.ok) { await publication.abort(); return admission; }
    const evidence = await publication.verifyFile();
    admission = checkPrecommit();
    if (!admission.ok) { await publication.abort(); return admission; }
    await publication.publishFile(evidence); // Commit begins here; an abort racing this await cannot report cancellation.
    return { ok: true, sha256: evidence.sha256 };
  } catch (error) {
    await publication.abort().catch(() => undefined);
    throw error;
  }
}
async function closeRuntime(runtime: GpuFrameRenderSession | undefined): Promise<GpuParametricTracePreviewCleanup> { if (!runtime) throw new Error("GPU parametric trace runtime was unavailable for cleanup."); const selected = runtime; await selected.close(); const runtimeResources = selected.resourceMetrics ? await selected.resourceMetrics().catch(() => null) : null; const payload = { closed: true as const, runtimeResources }; return Object.freeze({ ...payload, fingerprint: canonicalJsonSha256(payload) }); }
function failure(value: GpuParametricTracePreviewFailure): GpuParametricTracePreviewResult { return { ok: false, error: value }; }
function cancelledResult(): GpuParametricTracePreviewResult { return { ok: false, error: { code: "gpu_cancelled", message: "GPU parametric trace preview was cancelled before resource preparation or output publication." } }; }
function sameKeys(record: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(record).sort(); return keys.length === expected.length && keys.every((key, index) => key === expected[index]); }
function validHashes(record: Record<string, unknown>, keys: readonly string[]): boolean { return keys.every((key) => typeof record[key] === "string" && /^[a-f0-9]{64}$/.test(record[key] as string)); }
