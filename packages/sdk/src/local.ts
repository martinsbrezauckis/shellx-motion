/** Real in-process SDK adapter over Core, scripted compilation, and capability-gated Debug API operations. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { convertScriptedFramesToMotionPackage, writeScriptedMotionPackage } from "@shellx-motion/adapters-script";
import {
  attestArtifactReceipt,
  assertTrackingAnalysisLifecycle,
  compileTrackingStabilization,
  createAttestedArtifactHandle,
  hashFile,
  JOB_STATES,
  loadMotionPackage,
  restoreMotionDocumentCompositing,
  resolvePackageAsset,
  unrenderablePackageRefusal,
  verifyAttestedArtifactHandle,
  writeAttestedArtifactHandle,
  type MotionPackage,
  type OperationReceipt,
  type TrackingAnalysisLifecycle,
  type TrackingStabilizationPlan
} from "@shellx-motion/core";
import { dispatchDebugCommand, MOTION_ENGINE_VERSION, type BrowserFrameRenderer, type MotionDebugContext, type MotionDebugResult, type ReceiptActor, type ReceiptActorKind } from "@shellx-motion/debug-api";
import { readMotionExportPreset, resolveMotionExportPreset, type FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { createMotionSdk } from "./client";
import { localDebugContext } from "./local-debug-context";
import { createLocalAuthoringOperations } from "./local-authoring";
import { ensureSdkCutHandoff } from "./local-cut-handoff";
import {
  assertRenderPackageLineage,
  loadStableRenderPackage,
  readCachedRenderArtifact,
  renderReceiptInputHashes,
} from "./local-render-lineage";
import { localResult, LocalMotionSdkError } from "./local-result";
import { verifyPersistedReceipt } from "./local-receipt";
import { normalizeSpatialTimelineEdit } from "./spatial-timeline-normalize";
import { timelineEditReceiptOperation } from "./timeline-receipt";
import { createTemplateParameterSchema } from "./template";
import { createMotionSdkHandlerTransport } from "./transport";
import type {
  MotionSdkCancelResponse,
  MotionSdkClient,
  MotionSdkCompileResponse,
  MotionSdkJob,
  MotionSdkJobState,
  MotionSdkPreviewResponse,
  MotionSdkRenderResponse,
  MotionSdkStatusResponse,
  MotionSdkTimelineEdit,
  MotionSdkTimelineEditRequest,
  MotionSdkTimelineEditResponse,
  MotionSdkTrackingApplyRequest,
  MotionSdkTrackingApplyResponse,
  MotionSdkTrackingDetachRequest,
  MotionSdkTrackingDetachResponse,
  MotionSdkTrackingInspectRequest,
  MotionSdkTrackingInspectResponse,
  MotionSdkTrackingLifecycleSummary,
  MotionSdkTrackingReceiptSummary,
  MotionSdkTrackingRequestRequest,
  MotionSdkTrackingRequestResponse,
  MotionSdkTrackingSegmentSummary,
  MotionSdkTrackingSourceInspection,
  MotionSdkTrackingVerifyRequest,
  MotionSdkTrackingVerifyResponse,
  MotionSdkTransport,
  MotionSdkValidateResponse
} from "./types";
export interface LocalMotionSdkOptions {
  ffmpegRunner?: FfmpegRunner;
  browserFrameRenderer?: BrowserFrameRenderer;
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
  /**
   * Receipt and scratch roots the EMBEDDING HOST declares, threaded into every dispatch this SDK
   * makes. Left unset by an ordinary in-process host, which is the caller and needs no boundary.
   * Set by the loopback debug server, whose `/sdk` route is a boundary — see
   * `sdk-local-options.ts` in `@shellx-motion/debug-server` for why the two differ.
   */
  receiptsRoot?: string;
  scratchRoot?: string;
  /**
   * Identity of the host embedding this local SDK, recorded as the receipt actor so the engine-room
   * History can attribute in-process operations. Defaults to kind "host", label "sdk". The transport
   * is always "sdk" (an in-process call, no wire hop) and cannot be overridden here.
   */
  actor?: { kind?: ReceiptActorKind; label?: string };
}

export interface LocalMotionSdkCapabilities {
  schema: "shellx-motion/local-sdk-capabilities@1";
  contractVersion: 1;
  /**
   * The engine version this SDK is part of — `MOTION_ENGINE_VERSION`, which is generated from the
   * workspace manifests. It is deliberately the same string `/health`, `/debug/contracts` and the
   * MCP `serverInfo` report: a host that compares the in-process SDK against a loopback server
   * must never see two different versions for one engine. Not an independent SDK version number.
   */
  sdkVersion: string;
  operations: string[];
}

export interface LocalMotionSdkClient extends MotionSdkClient {
  capabilities(): Promise<LocalMotionSdkCapabilities>;
}

const LOCAL_MOTION_SDK_OPERATIONS = [
  "validate", "compile", "preview", "render", "status", "cancel", "timelineEdit",
  "trackingRequest", "trackingInspect", "trackingApply", "trackingDetach", "trackingVerify",
  "keyingInspect", "keyingApply", "keyingRemove", "rotoUpsert", "rotoTrackingDetach", "rotoRemove",
  "compositingInspect", "compositingSet", "compositingRemove", "gltfImport",
  "proceduralInspect", "proceduralSet", "proceduralSetEnabled", "proceduralBake", "proceduralDetach",
] as const;

export function createLocalMotionSdk(options: LocalMotionSdkOptions = {}): LocalMotionSdkClient {
  const client = createMotionSdk(createLocalMotionSdkTransport(options));
  return {
    ...client,
    capabilities: async () => ({
      schema: "shellx-motion/local-sdk-capabilities@1",
      contractVersion: 1,
      sdkVersion: MOTION_ENGINE_VERSION,
      operations: [...LOCAL_MOTION_SDK_OPERATIONS],
    }),
  };
}

export function createLocalMotionSdkTransport(options: LocalMotionSdkOptions = {}): MotionSdkTransport {
  const { keying, compositing, gltf, procedural } = createLocalAuthoringOperations({
    executeDebug: (command, args, tier) => dispatchDebugCommand(command, args, localDebugContext(tier, options)),
    packageIdentity,
  });
  return createMotionSdkHandlerTransport({
    validate: async (input) => localResult(() => validatePackage(input.packageRoot)),
    compile: async (input) => localResult(() => compilePackage(input)),
    preview: async (input) => localResult(() => previewPackage(input, options)),
    render: async (input, request) => localResult(() => renderPackage(input, request.cacheKey, options)),
    status: async (input) => localResult(() => renderStatus(input.receiptsRoot, input.jobId, options)),
    cancel: async (input) => localResult(() => cancelRender(input.receiptsRoot, input.jobId, input.reason, options)),
    timelineEdit: async (input) => localResult(() => timelineEditPackage(input, options)),
    trackingRequest: async (input) => localResult(() => trackingRequestPackage(input, options)),
    trackingInspect: async (input) => localResult(() => trackingInspectPackage(input, options)),
    trackingApply: async (input) => localResult(() => trackingApplyPackage(input, options)),
    trackingDetach: async (input) => localResult(() => trackingDetachPackage(input, options)),
    trackingVerify: async (input) => localResult(() => trackingVerifyPackage(input, options)),
    keyingInspect: async (input) => localResult(() => keying.inspect(input)),
    keyingApply: async (input) => localResult(() => keying.apply(input)),
    keyingRemove: async (input) => localResult(() => keying.removeKey(input)),
    rotoUpsert: async (input) => localResult(() => keying.upsertRoto(input)),
    rotoTrackingDetach: async (input) => localResult(() => keying.detachRotoTracking(input)),
    rotoRemove: async (input) => localResult(() => keying.removeRoto(input)),
    compositingInspect: async (input) => localResult(() => compositing.inspect(input)),
    compositingSet: async (input) => localResult(() => compositing.set(input)),
    compositingRemove: async (input) => localResult(() => compositing.remove(input)),
    gltfImport: async (input) => localResult(() => gltf.import(input)),
    proceduralInspect: async (input) => localResult(() => procedural.inspect(input)),
    proceduralSet: async (input) => localResult(() => procedural.set(input)),
    proceduralSetEnabled: async (input) => localResult(() => procedural.setEnabled(input)),
    proceduralBake: async (input) => localResult(() => procedural.bake(input)),
    proceduralDetach: async (input) => localResult(() => procedural.detach(input))
  });
}

/**
 * Structural + renderability check for a package, the SDK half of `motion.package.validate`.
 *
 * The renderability verdict is core's `unrenderablePackageRefusal` — the same function the Debug
 * API/MCP command calls, not a copy of its logic. Before this, the SDK answered `valid` for a
 * package the MCP surface refused as `package_unrenderable`, so one product told an agent two
 * different things about one directory depending on which door it knocked on.
 *
 * @param packageRoot directory holding manifest.json and motion.json.
 * @returns package identity (and template parameter schema when the package carries a template).
 * @throws {LocalMotionSdkError} `package_unrenderable` when no lane can draw a visible layer's type;
 *         `detail` carries the same correction and offending-layer list the MCP answer carries.
 */
async function validatePackage(packageRoot: string): Promise<MotionSdkValidateResponse> {
  const pkg = await loadMotionPackage(packageRoot);
  restoreMotionDocumentCompositing(pkg.motion);
  const refusal = unrenderablePackageRefusal(pkg.motion);
  if (refusal) {
    throw new LocalMotionSdkError(refusal.code, refusal.message, false, {
      suggestedAction: refusal.suggestedAction,
      unrenderableLayers: refusal.layers
    });
  }
  return {
    package: await packageIdentity(pkg),
    ...(pkg.template ? { template: createTemplateParameterSchema(pkg.template.id, pkg.template.params) } : {}),
    warnings: []
  };
}

async function compilePackage(input: { script: unknown; outDir: string; createdAt?: string }): Promise<MotionSdkCompileResponse> {
  const packageRoot = resolve(input.outDir);
  await assertAbsent(packageRoot, "compile output");
  const parent = dirname(packageRoot);
  await mkdir(parent, { recursive: true });
  const stage = join(parent, `.${basename(packageRoot)}.sdk-stage-${randomUUID()}`);
  try {
    await mkdir(stage, { recursive: false, mode: 0o700 });
    const converted = convertScriptedFramesToMotionPackage(input.script, {
      inputPath: "inline-scripted-video.json",
      ...(input.createdAt ? { createdAt: input.createdAt } : {})
    });
    await writeScriptedMotionPackage(converted, { packageDir: stage });
    await loadMotionPackage(stage);
    await rename(stage, packageRoot);
    const pkg = await loadMotionPackage(packageRoot);
    return {
      packageRoot,
      package: await packageIdentity(pkg),
      receiptPath: join(packageRoot, "receipts", "script-compile.receipt.json"),
      warnings: converted.receipt.warnings
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function previewPackage(
  input: { packageRoot: string; outDir: string; atMs?: number; workflowPath?: string },
  options: LocalMotionSdkOptions
): Promise<MotionSdkPreviewResponse> {
  const pkg = await loadMotionPackage(input.packageRoot);
  const context = localDebugContext("render_motion", options, resolve(input.outDir), [pkg.root, ...(input.workflowPath ? [dirname(resolve(input.workflowPath))] : [])]);
  const debug = await dispatchDebugCommand("motion.preview.frame", {
    packageRoot: pkg.root,
    outDir: resolve(input.outDir),
    ...(input.atMs !== undefined ? { atMs: input.atMs } : {}),
    ...(input.workflowPath ? { workflowPath: resolve(input.workflowPath) } : {})
  }, context);
  const result = successfulDebugResult(debug, "preview");
  const output = record(result.output, "preview output");
  const receipt = operationReceipt(result.receipt, "preview receipt");
  const receiptPath = join(resolve(input.outDir), "receipts", `${safeToken(receipt.id)}.receipt.json`);
  await writeJsonExclusive(receiptPath, receipt);
  return {
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    frame: {
      path: stringField(output, "path"),
      sha256: shaField(output, "sha256"),
      width: positiveNumber(output, "width"),
      height: positiveNumber(output, "height"),
      atMs: nonNegativeNumber(output, "atMs"),
      mediaType: output.format === "jpeg" ? "image/jpeg" : "image/png"
    },
    receiptId: receipt.id,
    receiptPath,
    warnings: receipt.warnings
  };
}

async function renderPackage(
  input: {
    packageRoot: string; outputPath: string; preset: string; artifactRoot?: string; receiptsRoot?: string;
    workflowPath?: string; qualityManifestPath?: string; idempotencyKey?: string;
    cutHandoff?: { target: "shellx-cut"; mode: "rendered_media" };
  },
  sdkCacheKey: string,
  options: LocalMotionSdkOptions
): Promise<MotionSdkRenderResponse> {
  const { pkg, lineage } = await loadStableRenderPackage(input.packageRoot);
  const outputPath = resolve(input.outputPath);
  const artifactRoot = resolve(input.artifactRoot ?? dirname(outputPath));
  const operationHash = input.idempotencyKey ?? sdkCacheKey;
  const preset = readMotionExportPreset(input.preset);
  if (!preset) throw new Error(`Unsupported Motion render preset: ${input.preset}.`);
  const spec = resolveMotionExportPreset(preset);
  if (spec.container === "image-sequence") throw new Error("Local SDK render currently requires a file-producing preset.");
  await assertWritablePathInsideRoot(artifactRoot, outputPath, "render output");
  const receiptsRoot = resolve(input.receiptsRoot ?? join(artifactRoot, ".shellx-motion", "receipts"));
  await assertWritablePathInsideRoot(artifactRoot, join(receiptsRoot, "placeholder"), "render receipts");
  const descriptorPath = join(artifactRoot, ".shellx-motion", "artifacts", `${operationHash}.artifact.json`);
  const cached = await readCachedRenderArtifact({
    root: artifactRoot,
    path: descriptorPath,
    pkg,
    preset: input.preset,
    operationHash,
    sdkCacheKey,
    lineage,
  });
  if (cached) {
    const cutBinding = input.cutHandoff
      ? await ensureSdkCutHandoff({ artifactRoot, descriptorPath, handle: cached, pkg, operationHash })
      : null;
    return {
      jobId: cached.receipts.find((receipt) => receipt.role === "render")?.id ?? cached.id,
      state: "succeeded",
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      preset: input.preset,
      outputPath: join(artifactRoot, cached.rootRelativePath),
      receiptId: cached.receipts.find((receipt) => receipt.role === "render")?.id,
      artifact: cached,
      ...(cutBinding ? { artifactReference: cutBinding.reference, cutHandoff: cutBinding.handoff } : {}),
      warnings: ["Reused attested local render for the matching SDK idempotency key."]
    };
  }
  const scratchRoot = join(artifactRoot, ".shellx-motion", "scratch", operationHash);
  const context = localDebugContext("render_motion", options, scratchRoot, [pkg.root, ...(input.workflowPath ? [dirname(resolve(input.workflowPath))] : []), ...(input.qualityManifestPath ? [dirname(resolve(input.qualityManifestPath))] : [])]);
  const debug = await dispatchDebugCommand("motion.render.final", {
    packageRoot: pkg.root,
    outputPath,
    preset: input.preset,
    framesDir: join(scratchRoot, "frames"),
    ...(input.workflowPath ? { workflowPath: resolve(input.workflowPath) } : {}),
    ...(input.qualityManifestPath ? { qualityManifestPath: resolve(input.qualityManifestPath) } : {})
  }, context);
  const result = successfulDebugResult(debug, "render");
  const rawReceipt = operationReceipt(result.receipt, "render receipt");
  await assertRenderPackageLineage(pkg.root, lineage);
  const receipt: OperationReceipt = { ...rawReceipt, inputHashes: renderReceiptInputHashes(operationHash, lineage) };
  const receiptPath = join(receiptsRoot, `${safeToken(receipt.id)}.receipt.json`);
  await writeJsonExclusive(receiptPath, receipt);
  const attestation = await attestArtifactReceipt(artifactRoot, receiptPath, "render");
  const handle = await createAttestedArtifactHandle({
    root: artifactRoot,
    artifactPath: outputPath,
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    operationHash,
    preset: input.preset,
    mediaType: spec.mimeType,
    receipts: [attestation],
    packageLineage: lineage,
    createdAt: receipt.createdAt,
    probe: false,
    qualityEvidence: { sdkCacheKey }
  });
  await verifyAttestedArtifactHandle(artifactRoot, handle, {
    expected: { packageLineage: lineage },
    requiredReceiptRoles: ["render"],
    probe: false,
  });
  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeAttestedArtifactHandle(descriptorPath, handle);
  const cutBinding = input.cutHandoff
    ? await ensureSdkCutHandoff({ artifactRoot, descriptorPath, handle, pkg, operationHash })
    : null;
  return {
    jobId: receipt.id,
    state: "succeeded",
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    preset: input.preset,
    outputPath,
    receiptId: receipt.id,
    artifact: handle,
    ...(cutBinding ? { artifactReference: cutBinding.reference, cutHandoff: cutBinding.handoff } : {}),
    warnings: receipt.warnings
  };
}

async function renderStatus(receiptsRoot: string, jobId: string | undefined, options: LocalMotionSdkOptions): Promise<MotionSdkStatusResponse> {
  const debug = await dispatchDebugCommand("motion.render.status", { receiptsRoot: resolve(receiptsRoot) }, localDebugContext("read_motion", options));
  const result = successfulDebugResult(debug, "render status");
  const rawJobs = arrayField(result, "jobs");
  const jobs = rawJobs.map(readJob).filter((job): job is MotionSdkJob => Boolean(job));
  const selected = jobId ? jobs.filter((job) => job.jobId === jobId) : jobs;
  if (jobId && selected.length === 0) throw new Error(`Render job not found: ${jobId}.`);
  return { jobs: selected, stateCounts: countStates(selected), warnings: selected.flatMap((job) => job.warnings) };
}

async function cancelRender(receiptsRoot: string, jobId: string, reason: string | undefined, options: LocalMotionSdkOptions): Promise<MotionSdkCancelResponse> {
  const debug = await dispatchDebugCommand("motion.render.cancel", {
    receiptsRoot: resolve(receiptsRoot), receiptId: jobId, ...(reason ? { reason } : {})
  }, localDebugContext("render_motion", options));
  const result = successfulDebugResult(debug, "render cancel");
  return {
    targetJobId: stringField(result, "targetReceiptId"),
    state: "cancelled",
    receiptId: debug.receiptId ?? stringField(record(result.receipt, "cancel receipt"), "id"),
    ...(typeof result.controlReceiptPath === "string" ? { receiptPath: result.controlReceiptPath } : {}),
    warnings: debug.warnings
  };
}
async function timelineEditPackage(input: MotionSdkTimelineEditRequest, options: LocalMotionSdkOptions): Promise<MotionSdkTimelineEditResponse> {
  const request = plainDataRecord(input, "timeline edit input");
  assertOnlyFields(request, ["packageRoot", "outDir", "receiptsRoot", "createdBy", "edit"], "timeline edit input");
  const packageRoot = resolve(boundedStringField(request, "packageRoot", 4096));
  const outDir = resolve(boundedStringField(request, "outDir", 4096));
  const receiptsRoot = optionalBoundedString(request, "receiptsRoot", 4096);
  const createdBy = optionalBoundedString(request, "createdBy", 256);
  const normalized = normalizeTimelineEdit(request.edit);
  const debug = await dispatchDebugCommand(normalized.command, {
    packageRoot,
    outDir,
    ...(receiptsRoot ? { receiptsRoot: resolve(receiptsRoot) } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...normalized.args
  }, localDebugContext("edit_motion", options));
  const result = successfulDebugResult(debug, "timeline edit");
  const resultPackageRoot = resolve(stringField(result, "packageDir"));
  if (resultPackageRoot !== outDir) throw new Error("Timeline edit output package does not match the requested outDir.");
  const receiptPath = resolve(stringField(result, "receiptPath"));
  const receipt = operationReceipt(result.receipt, "timeline edit receipt");
  const expectedOperation = timelineEditReceiptOperation(normalized.edit.kind)!;
  if (receipt.operation !== expectedOperation || receipt.status !== "passed") {
    throw new Error("Timeline edit receipt operation/status does not match the request.");
  }
  const pkg = await loadMotionPackage(resultPackageRoot);
  if (receipt.packageId !== pkg.manifest.id) throw new Error("Timeline edit receipt package identity does not match the reopened package.");
  const receiptSha256 = await verifyPersistedReceipt(resultPackageRoot, receiptPath, receipt, "timeline edit receipt");
  return {
    packageRoot: resultPackageRoot,
    package: await packageIdentity(pkg),
    edit: normalized.edit,
    receipt: {
      schema: "shellx-motion/receipt@1",
      id: receipt.id,
      packageId: receipt.packageId,
      operation: expectedOperation,
      status: "passed",
      path: receiptPath,
      sha256: receiptSha256
    },
    warnings: receipt.warnings
  };
}
async function trackingRequestPackage(input: MotionSdkTrackingRequestRequest, options: LocalMotionSdkOptions): Promise<MotionSdkTrackingRequestResponse> {
  const request = plainDataRecord(input, "tracking request input");
  assertOnlyFields(request, ["packageRoot", "outDir", "analysisId", "assetId", "mode", "model", "reference", "settings", "receiptsRoot", "createdAt"], "tracking request input");
  const packageRoot = resolve(boundedStringField(request, "packageRoot", 4096));
  const outDir = resolve(boundedStringField(request, "outDir", 4096));
  const analysisId = safeIdentifierField(request, "analysisId");
  const assetId = safeIdentifierField(request, "assetId");
  const mode = stringField(request, "mode");
  const model = stringField(request, "model");
  if ((mode !== "point" && mode !== "planar") || !["translation", "similarity", "homography"].includes(model)
    || (mode === "point" && model !== "translation") || (mode === "planar" && model === "translation")) {
    throw new Error("Tracking request mode/model is unsupported.");
  }
  const reference = trackingReferenceInput(request.reference);
  const settings = trackingSettingsInput(request.settings);
  const receiptsRoot = optionalBoundedString(request, "receiptsRoot", 4096);
  const createdAt = optionalBoundedString(request, "createdAt", 128);
  if (createdAt && !Number.isFinite(Date.parse(createdAt))) throw new Error("Tracking request createdAt must be an ISO timestamp.");
  const scratchRoot = join(dirname(outDir), ".shellx-motion-sdk", "tracking-scratch", analysisId);
  let debug: MotionDebugResult;
  try {
    debug = await dispatchDebugCommand("motion.analysis.tracking.request", {
      packageRoot,
      outDir,
      analysisId,
      assetId,
      mode,
      model,
      reference,
      settings,
      ...(receiptsRoot ? { receiptsRoot: resolve(receiptsRoot) } : {}),
      ...(createdAt ? { createdAt } : {}),
    }, localDebugContext("write_local", options, scratchRoot));
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
  const result = trackingDebugResult(debug, "tracking request");
  const resultPackageRoot = resolve(stringField(result, "packageRoot"));
  if (resultPackageRoot !== outDir) throw new Error("Tracking request output package does not match the requested outDir.");
  const pkg = await loadMotionPackage(resultPackageRoot);
  const lifecycle = trackingLifecycleSummary(result.lifecycle);
  if (lifecycle.analysisId !== analysisId) throw new Error("Tracking request lifecycle does not match the requested analysisId.");
  const receiptPath = resolve(stringField(result, "receiptPath"));
  const receipt = await persistedTrackingReceipt(result.receipt, "analysis.tracking.request", pkg, receiptPath);
  return {
    packageRoot: resultPackageRoot,
    package: await packageIdentity(pkg),
    lifecyclePath: resolve(stringField(result, "lifecyclePath")),
    lifecycle,
    receipt,
    receiptPath,
    warnings: receiptWarnings(result.receipt, debug.warnings),
  };
}

async function trackingInspectPackage(input: MotionSdkTrackingInspectRequest, options: LocalMotionSdkOptions): Promise<MotionSdkTrackingInspectResponse> {
  const request = plainDataRecord(input, "tracking inspect input");
  assertOnlyFields(request, ["packageRoot", "analysisId"], "tracking inspect input");
  const packageRoot = resolve(boundedStringField(request, "packageRoot", 4096));
  const analysisId = safeIdentifierField(request, "analysisId");
  const debug = await dispatchDebugCommand("motion.analysis.tracking.inspect", { packageRoot, analysisId }, localDebugContext("read_motion", options));
  const result = successfulDebugResult(debug, "tracking inspect");
  const pkg = await loadMotionPackage(packageRoot);
  const lifecycle = trackingLifecycleSummary(result.lifecycle);
  if (lifecycle.analysisId !== analysisId) throw new Error("Tracking inspect lifecycle does not match the requested analysisId.");
  const source = trackingSourceInspection(result.source);
  const current = result.current === true;
  if (source.current !== current) throw new Error("Tracking inspect source status is inconsistent.");
  const receipt = trackingReceiptSummary(result.receipt, "analysis.tracking.inspect", pkg.manifest.id);
  return {
    packageRoot: pkg.root,
    package: await packageIdentity(pkg),
    lifecyclePath: resolve(stringField(result, "lifecyclePath")),
    lifecycle,
    source,
    current,
    receipt,
    warnings: receiptWarnings(result.receipt, debug.warnings),
  };
}

async function trackingApplyPackage(input: MotionSdkTrackingApplyRequest, options: LocalMotionSdkOptions): Promise<MotionSdkTrackingApplyResponse> {
  const request = plainDataRecord(input, "tracking apply input");
  assertOnlyFields(request, ["packageRoot", "outDir", "analysisId", "layerId", "segmentIndex", "includeLowConfidence", "receiptsRoot"], "tracking apply input");
  const packageRoot = resolve(boundedStringField(request, "packageRoot", 4096));
  const outDir = resolve(boundedStringField(request, "outDir", 4096));
  const analysisId = safeIdentifierField(request, "analysisId");
  const layerId = safeIdentifierField(request, "layerId");
  const segmentIndex = optionalSafeInteger(request, "segmentIndex", 0, 4_095);
  const includeLowConfidence = optionalBoolean(request, "includeLowConfidence");
  const receiptsRoot = optionalBoundedString(request, "receiptsRoot", 4096);
  const debug = await dispatchDebugCommand("motion.analysis.tracking.apply", {
    packageRoot,
    outDir,
    analysisId,
    layerId,
    ...(segmentIndex !== undefined ? { segmentIndex } : {}),
    ...(includeLowConfidence !== undefined ? { includeLowConfidence } : {}),
    ...(receiptsRoot ? { receiptsRoot: resolve(receiptsRoot) } : {}),
  }, localDebugContext("edit_motion", options));
  const result = successfulDebugResult(debug, "tracking apply");
  const resultPackageRoot = resolve(stringField(result, "packageRoot"));
  if (resultPackageRoot !== outDir) throw new Error("Tracking apply output package does not match the requested outDir.");
  const pkg = await loadMotionPackage(resultPackageRoot);
  const plan = trackingPlan(result.plan);
  const attachment = record(result.attachment, "tracking attachment");
  const appliedSegmentIndex = integerField(attachment, "segmentIndex", 0, plan.segments.length - 1);
  const receiptPath = resolve(stringField(result, "receiptPath"));
  const receipt = await persistedTrackingReceipt(result.receipt, "analysis.tracking.apply", pkg, receiptPath);
  if (stringField(result, "layerId") !== layerId || plan.analysisId !== analysisId || plan.targetLayerId !== layerId) {
    throw new Error("Tracking apply result identity does not match the request.");
  }
  return {
    packageRoot: resultPackageRoot,
    package: await packageIdentity(pkg),
    layerId,
    analysisId,
    segment: trackingSegmentSummary(plan, appliedSegmentIndex),
    fidelity: plan.fidelity,
    changedPaths: boundedStringList(result.changedPaths, "tracking changed paths", 32, 512),
    receipt,
    receiptPath,
    warnings: receiptWarnings(result.receipt, debug.warnings),
  };
}

async function trackingDetachPackage(input: MotionSdkTrackingDetachRequest, options: LocalMotionSdkOptions): Promise<MotionSdkTrackingDetachResponse> {
  const request = plainDataRecord(input, "tracking detach input");
  assertOnlyFields(request, ["packageRoot", "outDir", "layerId", "receiptsRoot"], "tracking detach input");
  const packageRoot = resolve(boundedStringField(request, "packageRoot", 4096));
  const outDir = resolve(boundedStringField(request, "outDir", 4096));
  const layerId = safeIdentifierField(request, "layerId");
  const receiptsRoot = optionalBoundedString(request, "receiptsRoot", 4096);
  const debug = await dispatchDebugCommand("motion.analysis.tracking.detach", {
    packageRoot,
    outDir,
    layerId,
    ...(receiptsRoot ? { receiptsRoot: resolve(receiptsRoot) } : {}),
  }, localDebugContext("edit_motion", options));
  const result = successfulDebugResult(debug, "tracking detach");
  const resultPackageRoot = resolve(stringField(result, "packageRoot"));
  if (resultPackageRoot !== outDir) throw new Error("Tracking detach output package does not match the requested outDir.");
  const pkg = await loadMotionPackage(resultPackageRoot);
  const analysisId = safeIdentifierField(result, "analysisId");
  if (stringField(result, "layerId") !== layerId || result.restoredPreviousKeyframes !== true) {
    throw new Error("Tracking detach did not prove exact prior-keyframe restoration.");
  }
  const receiptPath = resolve(stringField(result, "receiptPath"));
  const receipt = await persistedTrackingReceipt(result.receipt, "analysis.tracking.detach", pkg, receiptPath);
  return {
    packageRoot: resultPackageRoot,
    package: await packageIdentity(pkg),
    layerId,
    analysisId,
    restoredPreviousKeyframes: true,
    changedPaths: boundedStringList(result.changedPaths, "tracking changed paths", 32, 512),
    receipt,
    receiptPath,
    warnings: receiptWarnings(result.receipt, debug.warnings),
  };
}

async function trackingVerifyPackage(input: MotionSdkTrackingVerifyRequest, options: LocalMotionSdkOptions): Promise<MotionSdkTrackingVerifyResponse> {
  const request = plainDataRecord(input, "tracking verify input");
  assertOnlyFields(request, ["packageRoot", "layerId", "analysisId"], "tracking verify input");
  const packageRoot = resolve(boundedStringField(request, "packageRoot", 4096));
  const layerId = safeIdentifierField(request, "layerId");
  const analysisId = Object.hasOwn(request, "analysisId") ? safeIdentifierField(request, "analysisId") : undefined;
  const debug = await dispatchDebugCommand("motion.analysis.tracking.verify", {
    packageRoot,
    layerId,
    ...(analysisId ? { analysisId } : {}),
  }, localDebugContext("read_motion", options));
  const result = successfulDebugResult(debug, "tracking verify");
  const pkg = await loadMotionPackage(packageRoot);
  const verification = trackingVerification(result.verification, layerId, analysisId);
  const lifecycle = result.lifecycle === undefined ? undefined : trackingLifecycleSummary(result.lifecycle);
  const source = result.source === undefined ? undefined : trackingSourceInspection(result.source);
  const receipt = result.receipt === undefined ? undefined : trackingReceiptSummary(result.receipt, "analysis.tracking.verify", pkg.manifest.id);
  return {
    packageRoot: pkg.root,
    package: await packageIdentity(pkg),
    verification,
    ...(lifecycle ? { lifecycle } : {}),
    ...(source ? { source } : {}),
    ...(receipt ? { receipt } : {}),
    warnings: receipt ? receiptWarnings(result.receipt, debug.warnings) : [...debug.warnings],
  };
}
function normalizeTimelineEdit(editValue: unknown): {
  command:
    | "motion.timeline.layer.rich.set"
    | "motion.timeline.keyframe.upsert"
    | "motion.timeline.keyframe.delete"
    | "motion.timeline.keyframe.range.delete"
    | "motion.timeline.keyframe.move"
    | "motion.timeline.keyframe.easing.apply"
    | "motion.timeline.keyframe.shift"
    | "motion.timeline.keyframe.scale"
    | "motion.timeline.keyframe.duplicate"
    | "motion.timeline.keyframe.distribute"
    | "motion.timeline.keyframe.reverse"
    | "motion.timeline.keyframe.snap"
    | "motion.timeline.spatial.position.upsert"
    | "motion.timeline.spatial.position.move"
    | "motion.timeline.spatial.position.delete";
  args: Record<string, unknown>;
  edit: MotionSdkTimelineEdit;
} {
  const spatial = normalizeSpatialTimelineEdit(editValue);
  if (spatial) return spatial;
  const edit = plainDataRecord(editValue, "timeline edit");
  const kind = stringField(edit, "kind");
  const allowedFields = kind === "rich.set" ? ["kind", "layerId", "path", "value"]
    : kind === "keyframe.upsert" ? ["kind", "layerId", "target", "atMs", "value", "easing"]
    : kind === "keyframe.delete" ? ["kind", "layerId", "target", "atMs"]
      : kind === "keyframe.range.delete" ? ["kind", "layerId", "target", "startMs", "endMs"]
      : kind === "keyframe.move" ? ["kind", "layerId", "target", "fromMs", "toMs"]
        : kind === "keyframe.easing.apply" ? ["kind", "layerId", "target", "easing", "atMs", "startMs", "endMs"]
          : kind === "keyframe.shift" || kind === "keyframe.duplicate" ? ["kind", "layerId", "target", "deltaMs", "startMs", "endMs"]
            : kind === "keyframe.scale" ? ["kind", "layerId", "target", "scale", "originMs", "startMs", "endMs"]
              : kind === "keyframe.distribute" || kind === "keyframe.reverse" ? ["kind", "layerId", "target", "startMs", "endMs"]
                : kind === "keyframe.snap" ? ["kind", "layerId", "target", "fps", "mode", "startMs", "endMs"] : null;
  if (!allowedFields) throw new Error(`Unsupported timeline edit kind: ${kind}.`);
  assertOnlyFields(edit, allowedFields, "timeline edit");
  const layerId = boundedStringField(edit, "layerId", 128);
  if (kind === "rich.set") {
    const path = boundedStringField(edit, "path", 256);
    const rawValue = edit.value;
    const value = typeof rawValue === "number" && Number.isFinite(rawValue)
      ? rawValue
      : typeof rawValue === "boolean"
        ? rawValue
        : typeof rawValue === "string" && rawValue.trim() && rawValue.length <= 128 ? rawValue.trim() : null;
    if (value === null) throw new Error("Rich control value must be a finite number, boolean, or bounded string.");
    const normalizedEdit: MotionSdkTimelineEdit = { kind, layerId, path, value };
    return { command: "motion.timeline.layer.rich.set", args: { layerId, property: path, value }, edit: normalizedEdit };
  }
  const target = boundedStringField(edit, "target", 128);
  if (kind === "keyframe.upsert") {
    const atMs = nonNegativeNumber(edit, "atMs");
    const rawValue = edit.value;
    const value = typeof rawValue === "number" && Number.isFinite(rawValue)
      ? rawValue
      : typeof rawValue === "string" && rawValue.trim() && rawValue.length <= 128 ? rawValue.trim() : null;
    if (value === null) throw new Error("Timeline keyframe upsert value must be a finite number or bounded string.");
    const easing = optionalBoundedString(edit, "easing", 128);
    const normalizedEdit: MotionSdkTimelineEdit = { kind, layerId, target, atMs, value, ...(easing ? { easing } : {}) };
    return { command: "motion.timeline.keyframe.upsert", args: { layerId, target, atMs, value, ...(easing ? { easing } : {}) }, edit: normalizedEdit };
  }
  if (kind === "keyframe.delete") {
    const atMs = nonNegativeNumber(edit, "atMs");
    const normalizedEdit: MotionSdkTimelineEdit = { kind, layerId, target, atMs };
    return { command: "motion.timeline.keyframe.delete", args: { layerId, target, atMs }, edit: normalizedEdit };
  }
  if (kind === "keyframe.range.delete") {
    const range = timelineEditRange(edit);
    const normalizedEdit: MotionSdkTimelineEdit = { kind, layerId, target, ...range };
    return { command: "motion.timeline.keyframe.range.delete", args: { layerId, target, ...range }, edit: normalizedEdit };
  }
  if (kind === "keyframe.move") {
    const fromMs = nonNegativeNumber(edit, "fromMs");
    const toMs = nonNegativeNumber(edit, "toMs");
    const normalizedEdit: MotionSdkTimelineEdit = { kind, layerId, target, fromMs, toMs };
    return { command: "motion.timeline.keyframe.move", args: { layerId, target, fromMs, toMs }, edit: normalizedEdit };
  }
  if (kind === "keyframe.easing.apply") {
    const easing = boundedStringField(edit, "easing", 128);
    const atMs = optionalNonNegativeNumber(edit, "atMs");
    const range = { ...(atMs !== undefined ? { atMs } : {}), ...timelineEditRange(edit) };
    const normalizedEdit: MotionSdkTimelineEdit = { kind, layerId, target, easing, ...range };
    return { command: "motion.timeline.keyframe.easing.apply", args: { layerId, target, easing, ...range }, edit: normalizedEdit };
  }
  if (kind === "keyframe.shift" || kind === "keyframe.duplicate") {
    const deltaMs = edit.deltaMs;
    if (typeof deltaMs !== "number" || !Number.isFinite(deltaMs) || deltaMs === 0) throw new Error("Timeline keyframe deltaMs must be a finite non-zero number.");
    const range = timelineEditRange(edit);
    const normalizedEdit: MotionSdkTimelineEdit = { kind, layerId, target, deltaMs, ...range };
    return {
      command: kind === "keyframe.shift" ? "motion.timeline.keyframe.shift" : "motion.timeline.keyframe.duplicate",
      args: { layerId, target, deltaMs, ...range },
      edit: normalizedEdit,
    };
  }
  if (kind === "keyframe.scale") {
    const scale = edit.scale;
    if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale === 1) throw new Error("Timeline keyframe scale must be positive and not equal to 1.");
    const originMs = nonNegativeNumber(edit, "originMs");
    const range = timelineEditRange(edit);
    const normalizedEdit: MotionSdkTimelineEdit = { kind, layerId, target, scale, originMs, ...range };
    return { command: "motion.timeline.keyframe.scale", args: { layerId, target, scale, originMs, ...range }, edit: normalizedEdit };
  }
  if (kind === "keyframe.distribute" || kind === "keyframe.reverse") {
    const range = timelineEditRange(edit);
    const normalizedEdit: MotionSdkTimelineEdit = { kind, layerId, target, ...range };
    return {
      command: kind === "keyframe.distribute" ? "motion.timeline.keyframe.distribute" : "motion.timeline.keyframe.reverse",
      args: { layerId, target, ...range },
      edit: normalizedEdit,
    };
  }
  if (kind === "keyframe.snap") {
    const fps = Object.hasOwn(edit, "fps") ? positiveNumber(edit, "fps") : undefined;
    const mode = edit.mode === undefined ? undefined : boundedStringField(edit, "mode", 16);
    if (mode !== undefined && mode !== "nearest" && mode !== "floor" && mode !== "ceil") throw new Error("Timeline keyframe snap mode is unsupported.");
    const range = timelineEditRange(edit);
    const normalizedEdit: MotionSdkTimelineEdit = { kind, layerId, target, ...(fps !== undefined ? { fps } : {}), ...(mode ? { mode } : {}), ...range };
    return { command: "motion.timeline.keyframe.snap", args: { layerId, target, ...(fps !== undefined ? { fps } : {}), ...(mode ? { mode } : {}), ...range }, edit: normalizedEdit };
  }
  throw new Error(`Unsupported timeline edit kind: ${kind}.`);
}
function timelineEditRange(edit: Record<string, unknown>): { startMs?: number; endMs?: number } {
  const startMs = optionalNonNegativeNumber(edit, "startMs");
  const endMs = optionalNonNegativeNumber(edit, "endMs");
  if (startMs !== undefined && endMs !== undefined && startMs > endMs) throw new Error("Timeline edit startMs must not exceed endMs.");
  return { ...(startMs !== undefined ? { startMs } : {}), ...(endMs !== undefined ? { endMs } : {}) };
}
function trackingDebugResult(debug: MotionDebugResult, label: string): Record<string, unknown> {
  if (debug.ok) return record(debug.result, `${label} result`);
  if (debug.result !== undefined) return record(debug.result, `${label} persisted failure result`);
  throw new LocalMotionSdkError(debug.error.code, `${label} failed: ${debug.error.message}`, false);
}

function trackingLifecycleSummary(value: unknown): MotionSdkTrackingLifecycleSummary {
  assertTrackingAnalysisLifecycle(value);
  const lifecycle = value as TrackingAnalysisLifecycle;
  const source = {
    assetId: lifecycle.requestedSource.assetId,
    sha256: lifecycle.requestedSource.sha256,
    byteLength: lifecycle.requestedSource.byteLength,
    width: lifecycle.requestedSource.width,
    height: lifecycle.requestedSource.height,
    durationMs: lifecycle.requestedSource.durationMs,
  };
  let lastGood: MotionSdkTrackingLifecycleSummary["lastGood"];
  if (lifecycle.lastGood) {
    const samples = lifecycle.lastGood.samples;
    const counts = { tracked: 0, lowConfidence: 0, lost: 0, recovered: 0 };
    let confidenceTotal = 0;
    let minConfidence = 1;
    for (const sample of samples) {
      const key = sample.state === "low-confidence" ? "lowConfidence" : sample.state;
      counts[key] += 1;
      confidenceTotal += sample.confidence;
      minConfidence = Math.min(minConfidence, sample.confidence);
    }
    let planStatus: "ready" | "partial" | "unavailable" = "unavailable";
    let fidelity: "exact-similarity" | "approximated-homography" = lifecycle.lastGood.model === "homography"
      ? "approximated-homography" : "exact-similarity";
    let segments: MotionSdkTrackingSegmentSummary[] = [];
    let warnings: string[] = [];
    try {
      const plan = compileTrackingStabilization({ analysis: lifecycle.lastGood, targetLayerId: "sdk-tracking-preview" });
      planStatus = plan.status;
      fidelity = plan.fidelity;
      segments = plan.segments.map((_segment, index) => trackingSegmentSummary(plan, index));
      warnings = [...plan.warnings];
    } catch (error) {
      warnings = [error instanceof Error ? error.message : String(error)];
    }
    lastGood = {
      status: lifecycle.lastGood.status,
      mode: lifecycle.lastGood.mode,
      model: lifecycle.lastGood.model,
      reference: structuredClone(lifecycle.lastGood.reference),
      settings: structuredClone(lifecycle.lastGood.settings),
      samples: {
        total: samples.length,
        tracked: counts.tracked,
        lowConfidence: counts.lowConfidence,
        lost: counts.lost,
        recovered: counts.recovered,
        minConfidence,
        meanConfidence: samples.length > 0 ? confidenceTotal / samples.length : 0,
      },
      spanCount: lifecycle.lastGood.spans.length,
      planStatus,
      fidelity,
      segments,
      warnings,
    };
  }
  return {
    schema: "shellx-motion/tracking-lifecycle-summary@1",
    analysisId: lifecycle.id,
    state: lifecycle.state,
    attempt: lifecycle.attempt,
    updatedAt: lifecycle.updatedAt,
    source,
    ...(lifecycle.failure ? { failure: { ...lifecycle.failure } } : {}),
    ...(lastGood ? { lastGood } : {}),
  };
}

function trackingPlan(value: unknown): TrackingStabilizationPlan {
  const plan = record(value, "tracking stabilization plan");
  if (plan.schema !== "shellx-motion/stabilization-plan@1" || !safeIdentifier(plan.analysisId)
    || !safeIdentifier(plan.targetLayerId) || !sha256String(plan.sourceSha256)
    || (plan.status !== "ready" && plan.status !== "partial")
    || (plan.fidelity !== "exact-similarity" && plan.fidelity !== "approximated-homography")
    || !Array.isArray(plan.segments) || plan.segments.length < 1 || plan.segments.length > 4_096) {
    throw new Error("Tracking stabilization plan is invalid.");
  }
  plan.segments.forEach((_segment, index) => trackingSegmentSummary(plan as unknown as TrackingStabilizationPlan, index));
  return plan as unknown as TrackingStabilizationPlan;
}

function trackingSegmentSummary(plan: TrackingStabilizationPlan, index: number): MotionSdkTrackingSegmentSummary {
  if (!Number.isSafeInteger(index) || index < 0 || index >= plan.segments.length) throw new Error("Tracking segment index is invalid.");
  const segment = plan.segments[index];
  const keyframes = segment?.keyframes?.["transform.x"];
  if (!segment || !Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.endMs < segment.startMs
    || !Array.isArray(keyframes) || keyframes.length < 1 || keyframes.length > 30_000) {
    throw new Error("Tracking segment summary is invalid.");
  }
  return { index, startMs: segment.startMs, endMs: segment.endMs, keyframeCount: keyframes.length };
}

function trackingReceiptSummary(value: unknown, operation: MotionSdkTrackingReceiptSummary["operation"], packageId: string): MotionSdkTrackingReceiptSummary {
  const receipt = operationReceipt(value, "tracking receipt");
  if (receipt.operation !== operation || receipt.packageId !== packageId
    || !["passed", "warning", "failed", "not_run"].includes(receipt.status)) {
    throw new Error("Tracking receipt operation/status/package identity is invalid.");
  }
  return {
    schema: "shellx-motion/receipt@1",
    id: receipt.id,
    packageId: receipt.packageId,
    operation,
    status: receipt.status as MotionSdkTrackingReceiptSummary["status"],
  };
}

async function persistedTrackingReceipt(
  value: unknown,
  operation: MotionSdkTrackingReceiptSummary["operation"],
  pkg: MotionPackage,
  receiptPath: string,
): Promise<MotionSdkTrackingReceiptSummary> {
  const source = operationReceipt(value, "tracking receipt");
  const summary = trackingReceiptSummary(source, operation, pkg.manifest.id);
  const sha256 = await verifyPersistedReceipt(pkg.root, receiptPath, source, "tracking receipt");
  return { ...summary, sha256 };
}

function receiptWarnings(value: unknown, fallback: string[]): string[] {
  return [...operationReceipt(value, "tracking receipt").warnings, ...fallback]
    .filter((warning, index, warnings) => warnings.indexOf(warning) === index)
    .slice(0, 256);
}

function trackingSourceInspection(value: unknown): MotionSdkTrackingSourceInspection {
  const source = record(value, "tracking source inspection");
  const assetId = safeIdentifierField(source, "assetId");
  const assetRef = boundedStringField(source, "assetRef", 4096);
  const sha256 = source.sha256 === null ? null : shaField(source, "sha256");
  const byteLength = nonNegativeNumber(source, "byteLength");
  if (typeof source.current !== "boolean") throw new Error("Tracking source current must be boolean.");
  return { assetId, assetRef, sha256, byteLength, current: source.current };
}

function trackingVerification(value: unknown, layerId: string, requestedAnalysisId: string | undefined): MotionSdkTrackingVerifyResponse["verification"] {
  const verification = record(value, "tracking verification");
  if (typeof verification.attached !== "boolean" || typeof verification.current !== "boolean"
    || safeIdentifierField(verification, "layerId") !== layerId) throw new Error("Tracking verification state is invalid.");
  const analysisId = verification.analysisId === undefined ? undefined : safeIdentifierField(verification, "analysisId");
  if (requestedAnalysisId && analysisId && requestedAnalysisId !== analysisId) {
    throw new Error("Tracking verification analysisId does not match the request.");
  }
  const sourceSha256 = verification.sourceSha256 === undefined ? undefined : shaField(verification, "sourceSha256");
  const segmentIndex = verification.segmentIndex === undefined ? undefined : integerField(verification, "segmentIndex", 0, 30_000);
  return {
    attached: verification.attached,
    current: verification.current,
    layerId,
    ...(analysisId ? { analysisId } : {}),
    ...(sourceSha256 ? { sourceSha256 } : {}),
    ...(segmentIndex !== undefined ? { segmentIndex } : {}),
    mismatchedTargets: boundedStringList(verification.mismatchedTargets, "tracking mismatched targets", 16, 128),
    reasons: boundedStringList(verification.reasons, "tracking verification reasons", 32, 128),
  };
}

function trackingReferenceInput(value: unknown): MotionSdkTrackingRequestRequest["reference"] {
  const reference = plainDataRecord(value, "tracking reference");
  assertOnlyFields(reference, ["atMs", "bounds", "points"], "tracking reference");
  const bounds = plainDataRecord(reference.bounds, "tracking reference bounds");
  assertOnlyFields(bounds, ["x", "y", "width", "height"], "tracking reference bounds");
  const atMs = nonNegativeNumber(reference, "atMs");
  const normalizedBounds = {
    x: nonNegativeNumber(bounds, "x"),
    y: nonNegativeNumber(bounds, "y"),
    width: positiveNumber(bounds, "width"),
    height: positiveNumber(bounds, "height"),
  };
  if (!Array.isArray(reference.points) || reference.points.length < 1 || reference.points.length > 64) {
    throw new Error("Tracking reference must contain 1..64 points.");
  }
  const points = reference.points.map((value, index) => {
    const point = plainDataRecord(value, `tracking reference point ${index}`);
    assertOnlyFields(point, ["x", "y"], `tracking reference point ${index}`);
    return { x: nonNegativeNumber(point, "x"), y: nonNegativeNumber(point, "y") };
  });
  return { atMs, bounds: normalizedBounds, points };
}

function trackingSettingsInput(value: unknown): MotionSdkTrackingRequestRequest["settings"] {
  const settings = plainDataRecord(value, "tracking settings");
  assertOnlyFields(settings, ["startMs", "endMs", "stepMs", "direction", "searchRadiusPx", "pyramidLevels", "maxIterations", "confidenceFloor", "deterministicSeed"], "tracking settings");
  const startMs = nonNegativeNumber(settings, "startMs");
  const endMs = nonNegativeNumber(settings, "endMs");
  const stepMs = positiveNumber(settings, "stepMs");
  const direction = stringField(settings, "direction");
  const searchRadiusPx = positiveNumber(settings, "searchRadiusPx");
  const pyramidLevels = integerField(settings, "pyramidLevels", 1, 16);
  const maxIterations = integerField(settings, "maxIterations", 1, 10_000);
  const confidenceFloor = nonNegativeNumber(settings, "confidenceFloor");
  const deterministicSeed = integerField(settings, "deterministicSeed", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (endMs < startMs || stepMs > 60_000 || searchRadiusPx > 4_096
    || !["forward", "backward", "both"].includes(direction) || confidenceFloor > 1) {
    throw new Error("Tracking settings are outside supported bounds.");
  }
  return {
    startMs,
    endMs,
    stepMs,
    direction: direction as MotionSdkTrackingRequestRequest["settings"]["direction"],
    searchRadiusPx,
    pyramidLevels,
    maxIterations,
    confidenceFloor,
    deterministicSeed,
  };
}

async function packageIdentity(pkg: MotionPackage) {
  const manifestPath = join(pkg.root, "manifest.json");
  const motionPath = resolvePackageAsset(pkg, pkg.manifest.motion);
  return {
    packageId: pkg.manifest.id, motionId: pkg.motion.id, durationMs: pkg.motion.durationMs, fps: pkg.motion.fps,
    width: pkg.motion.width, height: pkg.motion.height,
    manifestSha256: await hashFile(manifestPath), motionSha256: await hashFile(motionPath)
  };
}

function successfulDebugResult(debug: MotionDebugResult, label: string): Record<string, unknown> {
  if (!debug.ok) throw new LocalMotionSdkError(debug.error.code, `${label} failed: ${debug.error.message}`, false);
  return record(debug.result, `${label} result`);
}

function readJob(value: unknown): MotionSdkJob | null {
  const job = record(value, "render job");
  const operation = job.operation;
  if (operation !== "render.final" && operation !== "render.batch" && operation !== "render.retry") return null;
  const control = typeof job.control === "object" && job.control !== null ? job.control as Record<string, unknown> : null;
  return {
    jobId: stringField(job, "receiptId"), state: jobState(job.state), packageId: stringField(job, "packageId"), operation,
    ...(typeof job.outputPath === "string" ? { outputPath: job.outputPath } : {}), receiptId: stringField(job, "receiptId"),
    retryCount: typeof control?.retryAttempt === "number" && Number.isInteger(control.retryAttempt) ? control.retryAttempt : 0,
    warnings: stringArray(job.warnings, "job warnings")
  };
}

function countStates(jobs: MotionSdkJob[]): Partial<Record<MotionSdkJobState, number>> {
  const counts: Partial<Record<MotionSdkJobState, number>> = {};
  for (const job of jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;
  return counts;
}

async function assertWritablePathInsideRoot(root: string, path: string, label: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await mkdir(dirname(path), { recursive: true });
  const [canonicalRoot, canonicalParent] = await Promise.all([realpath(root), realpath(dirname(path))]);
  if (!inside(canonicalRoot, canonicalParent)) throw new Error(`${label} must be inside artifactRoot.`);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`${label} already exists: ${path}`);
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode: 0o600 });
}

function operationReceipt(value: unknown, label: string): OperationReceipt {
  const receipt = record(value, label);
  if (receipt.schema !== "shellx-motion/receipt@1" || typeof receipt.id !== "string" || typeof receipt.operation !== "string"
    || !Array.isArray(receipt.warnings) || !receipt.warnings.every((warning) => typeof warning === "string")) throw new Error(`${label} is invalid.`);
  return receipt as unknown as OperationReceipt;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function plainDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some((descriptor) => !("value" in descriptor))) {
    throw new Error(`${label} must contain only own data properties.`);
  }
  return value as Record<string, unknown>;
}
function assertOnlyFields(record: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} contains unsupported field ${unexpected}.`);
}
function arrayField(record: Record<string, unknown>, key: string): unknown[] { if (!Array.isArray(record[key])) throw new Error(`${key} must be an array.`); return record[key]; }
function stringField(record: Record<string, unknown>, key: string): string { const value = record[key]; if (typeof value !== "string" || !value) throw new Error(`${key} must be a string.`); return value; }
function shaField(record: Record<string, unknown>, key: string): string { const value = stringField(record, key); if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${key} must be SHA-256.`); return value; }
function positiveNumber(record: Record<string, unknown>, key: string): number { const value = record[key]; if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${key} must be positive.`); return value; }
function nonNegativeNumber(record: Record<string, unknown>, key: string): number { const value = record[key]; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${key} must be non-negative.`); return value; }
function optionalNonNegativeNumber(record: Record<string, unknown>, key: string): number | undefined { return Object.hasOwn(record, key) ? nonNegativeNumber(record, key) : undefined; }
function boundedStringField(record: Record<string, unknown>, key: string, max: number): string { const value = stringField(record, key).trim(); if (value.length > max) throw new Error(`${key} is too long.`); return value; }
function optionalBoundedString(record: Record<string, unknown>, key: string, max: number): string | undefined { return Object.hasOwn(record, key) ? boundedStringField(record, key, max) : undefined; }
function stringArray(value: unknown, label: string): string[] { if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${label} must be strings.`); return value; }
function safeIdentifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
function safeIdentifierField(record: Record<string, unknown>, key: string): string { const value = record[key]; if (!safeIdentifier(value)) throw new Error(`${key} must be a safe identifier.`); return value; }
function sha256String(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function integerField(record: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} through ${max}.`);
  return value;
}
function optionalSafeInteger(record: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  return Object.hasOwn(record, key) ? integerField(record, key, min, max) : undefined;
}
function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  if (typeof record[key] !== "boolean") throw new Error(`${key} must be boolean.`);
  return record[key];
}
function boundedStringList(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === "string" && item.length <= maxLength)) {
    throw new Error(`${label} must contain at most ${maxItems} bounded strings.`);
  }
  return [...value];
}
/** Validate a job state against the authored contract rather than a hand-copied list. */
function jobState(value: unknown): MotionSdkJobState {
  if (typeof value === "string" && (JOB_STATES as readonly string[]).includes(value)) return value as MotionSdkJobState;
  throw new Error("render job state is invalid.");
}
function safeToken(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "receipt"; }
