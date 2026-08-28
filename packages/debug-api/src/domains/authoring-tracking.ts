/** Persisted, copy-on-write tracking analysis and stabilization commands. */
import { analyzeTrackingMedia, MAX_TRACKING_MEDIA_BYTES, type AnalyzeTrackingMediaInput } from "@shellx-motion/analysis-tracking";
import {
  applyTrackingStabilization,
  assertTrackingAnalysisLifecycle,
  compileTrackingStabilization,
  createTrackingOperationReceipt,
  detachTrackingStabilization,
  hashFile,
  hashPackageFile,
  loadMotionPackage,
  loadSchema,
  readTrackingStabilizationAttachment,
  resolvePackageAsset,
  validateDocument,
  verifyTrackingStabilization,
  type MotionPackage,
  type OperationReceipt,
  type ReceiptArtifact,
  type TrackingAnalysis,
  type TrackingAnalysisLifecycle,
  type TrackingAnalysisSettings,
  type TrackingTransformModel,
} from "@shellx-motion/core";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, nonNegativeIntegerArg, objectArg, recordArg, stringArg } from "./args.js";
import { commitMotionDocumentEdit, commitPackageEdit } from "./package-edit-transaction.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export interface TrackingAuthoringServices { authoringInputRoots?: string[]; authoringOutputRoots?: string[];
  receiptsRoot?: string;
  scratchRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  trackingAnalyzer?: (input: AnalyzeTrackingMediaInput) => ReturnType<typeof analyzeTrackingMedia>;
  isUnsafePackageOutputDirectory?: (packageRoot: string, outputRoot: string) => Promise<boolean>;
  isEmptyOrAbsentDirectory?: (path: string) => Promise<boolean>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchTrackingAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TrackingAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (command === "motion.analysis.tracking.request") return requestTracking(args, services);
  if (command === "motion.analysis.tracking.inspect") return inspectTracking(args, services);
  if (command === "motion.analysis.tracking.apply") return applyTracking(args, services);
  if (command === "motion.analysis.tracking.detach") return detachTracking(args, services);
  if (command === "motion.analysis.tracking.verify") return verifyTracking(args, services);
  return null;
}

async function requestTracking(args: unknown, services: TrackingAuthoringServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const analysisId = safeIdArg(args, "analysisId");
  const assetId = safeIdArg(args, "assetId");
  const mode = enumArg(args, "mode", ["point", "planar"] as const);
  const model = enumArg(args, "model", ["translation", "similarity", "homography"] as const);
  const reference = trackingReferenceArg(args);
  const settings = trackingSettingsArg(args);
  const createdAt = stringArg(args, "createdAt") ?? undefined;
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  if (!packageRoot) return invalidArgs("motion.analysis.tracking.request requires packageRoot.");
  if (!outDir) return invalidArgs("motion.analysis.tracking.request requires outDir.");
  if (!analysisId) return invalidArgs("motion.analysis.tracking.request requires a safe analysisId.");
  if (!assetId) return invalidArgs("motion.analysis.tracking.request requires a safe assetId.");
  if (!mode) return invalidArgs("motion.analysis.tracking.request mode must be point or planar.");
  if (!model) return invalidArgs("motion.analysis.tracking.request model must be translation, similarity, or homography.");
  if (!reference) return invalidArgs("motion.analysis.tracking.request requires a finite reference with bounds and points.");
  if (!settings) return invalidArgs("motion.analysis.tracking.request requires bounded finite settings.");
  const unavailable = mutationCapabilities(services, receiptsRoot, true);
  if (unavailable) return unavailable;

  try {
    const pkg = await services.packageLoader!(packageRoot);
    const outputRoot = resolve(outDir);
    const outputError = await packageOutputError("motion.analysis.tracking.request", pkg, outputRoot, services);
    if (outputError) return outputError;
    const media = packageVideoAsset(pkg, assetId);
    const existingLifecycle = await readTrackingLifecycle(pkg, analysisId, true);
    const analyzed = await services.trackingAnalyzer!({
      id: analysisId,
      assetId,
      sourcePath: media.path,
      inputRoot: pkg.root,
      mode,
      model,
      reference,
      settings,
      scratchRoot: services.scratchRoot ?? resolve(".scratch", "tracking-analysis"),
      packageId: pkg.manifest.id,
      ...(createdAt ? { createdAt } : {}),
      ...(existingLifecycle ? { existingLifecycle } : {}),
    });
    if (!analyzed.ok && (!analyzed.lifecycle || !analyzed.receipt)) {
      return commandFailure(analyzed.error.code, analyzed.error.message);
    }
    if (!analyzed.lifecycle || !analyzed.receipt) throw new Error("Tracking analyzer returned an incomplete result.");
    const lifecycle = analyzed.lifecycle;
    assertTrackingAnalysisLifecycle(lifecycle);
    const lifecyclePath = resolvePackageAsset({ root: outputRoot }, trackingLifecycleRef(analysisId));
    const receiptPath = resolvePackageAsset({ root: outputRoot }, `receipts/tracking-${analysisId}-request.receipt.json`);
    const artifacts: ReceiptArtifact[] = [
      { role: "motion_package", path: outputRoot, status: "available", primary: true },
      { role: "tracking_lifecycle", path: lifecyclePath, status: "available", mediaType: "application/json" },
      { role: "tracking_receipt", path: receiptPath, status: "available", mediaType: "application/json" },
    ];
    const receipt: OperationReceipt = {
      ...analyzed.receipt,
      output: {
        packageRoot: outputRoot,
        lifecyclePath,
        analysis: lifecycle.lastGood,
        lifecycle,
        resources: analyzed.resources,
      },
      artifacts,
    };
    const installed = await commitTrackingArtifact({
      pkg,
      outputRoot,
      mediaAssetRef: media.assetRef,
      lifecycle,
      receipt,
      receiptPath,
      receiptsRoot,
      services,
    });
    const response = {
      packageId: pkg.manifest.id,
      packageRoot: outputRoot,
      lifecyclePath,
      receiptPath,
      ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
      lifecycle,
      analysis: lifecycle.lastGood,
      resources: analyzed.resources,
      receipt,
    };
    if (!analyzed.ok) {
      return {
        ok: false,
        error: analyzed.error,
        result: response,
        receiptId: receipt.id,
        visibleState: trackingVisibleState("analysis.tracking.request", response),
        warnings: receipt.warnings,
      };
    }
    return {
      ok: true,
      result: { ok: true, ...response },
      receiptId: receipt.id,
      visibleState: trackingVisibleState("analysis.tracking.request", response),
      warnings: receipt.warnings,
    };
  } catch (error) {
    return commandFailure("tracking_request_failed", error);
  }
}

async function inspectTracking(args: unknown, services: TrackingAuthoringServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const analysisId = safeIdArg(args, "analysisId");
  if (!packageRoot) return invalidArgs("motion.analysis.tracking.inspect requires packageRoot.");
  if (!analysisId) return invalidArgs("motion.analysis.tracking.inspect requires a safe analysisId.");
  if (!services.packageLoader) return capabilityUnavailable("Tracking package inspection is unavailable.");
  try {
    const pkg = await services.packageLoader(packageRoot);
    const lifecycle = await readTrackingLifecycle(pkg, analysisId, false);
    const source = await inspectPersistedSource(pkg, lifecycle.requestedSource.assetId, lifecycle.requestedSource.sha256, lifecycle.requestedSource.byteLength);
    const current = source.current;
    const receipt = createTrackingOperationReceipt({
      operation: "analysis.tracking.inspect",
      packageId: pkg.manifest.id,
      lifecycle,
      status: current ? undefined : "warning",
      output: { lifecycle, source },
      warnings: current ? [] : ["The package-local source bytes no longer match the persisted tracking identity."],
    });
    const result = {
      packageId: pkg.manifest.id,
      packageRoot: pkg.root,
      lifecyclePath: resolvePackageAsset(pkg, trackingLifecycleRef(analysisId)),
      lifecycle,
      source,
      current,
      receipt,
    };
    return {
      ok: true,
      result,
      visibleState: trackingVisibleState("analysis.tracking.inspect", result),
      warnings: receipt.warnings,
    };
  } catch (error) {
    return commandFailure("tracking_inspect_failed", error);
  }
}

async function applyTracking(args: unknown, services: TrackingAuthoringServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const analysisId = safeIdArg(args, "analysisId");
  const layerId = safeIdArg(args, "layerId");
  const segmentIndex = nonNegativeIntegerArg(args, "segmentIndex");
  const includeLowConfidence = booleanArg(args, "includeLowConfidence") ?? false;
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  if (!packageRoot) return invalidArgs("motion.analysis.tracking.apply requires packageRoot.");
  if (!outDir) return invalidArgs("motion.analysis.tracking.apply requires outDir.");
  if (!analysisId) return invalidArgs("motion.analysis.tracking.apply requires a safe analysisId.");
  if (!layerId) return invalidArgs("motion.analysis.tracking.apply requires a safe layerId.");
  if (segmentIndex === false) return invalidArgs("motion.analysis.tracking.apply segmentIndex must be a non-negative integer.");
  const unavailable = mutationCapabilities(services, receiptsRoot, false);
  if (unavailable) return unavailable;
  try {
    const pkg = await services.packageLoader!(packageRoot);
    const outputRoot = resolve(outDir);
    const outputError = await packageOutputError("motion.analysis.tracking.apply", pkg, outputRoot, services);
    if (outputError) return outputError;
    const lifecycle = await readTrackingLifecycle(pkg, analysisId, false);
    if (!lifecycle.lastGood) throw new Error("Tracking lifecycle has no last-good analysis to apply.");
    const source = await inspectPersistedSource(pkg, lifecycle.lastGood.source.assetId, lifecycle.lastGood.source.sha256, lifecycle.lastGood.source.byteLength);
    if (!source.current) throw new Error("Tracking analysis source bytes are stale; rerun analysis before apply.");
    const targetLayer = pkg.motion.layers.find((layer) => layer.id === layerId);
    if (!targetLayer) throw new Error(`Tracking stabilization target layer does not exist: ${layerId}.`);
    const transform = targetLayer.transform ?? {};
    const baseTransform = {
      x: finiteOr(transform.x, 0),
      y: finiteOr(transform.y, 0),
      scale: finiteOr(transform.scale, 1),
      rotation: finiteOr(transform.rotation, 0),
    };
    const plan = compileTrackingStabilization({
      analysis: lifecycle.lastGood,
      targetLayerId: layerId,
      baseTransform,
      includeLowConfidence,
    });
    const applied = applyTrackingStabilization({
      motion: pkg.motion,
      plan,
      ...(typeof segmentIndex === "number" ? { segmentIndex } : {}),
    });
    const validation = await validateDocument(await loadSchema("motion"), applied.motion);
    if (!validation.ok) throw new Error(`Stabilized Motion document failed validation: ${validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
    const receiptPath = join(outputRoot, "receipts", `tracking-${analysisId}-apply.receipt.json`);
    const artifacts: ReceiptArtifact[] = [
      { role: "motion_package", path: outputRoot, status: "available", primary: true },
      { role: "tracking_lifecycle", path: resolvePackageAsset({ root: outputRoot }, trackingLifecycleRef(analysisId)), status: "available", mediaType: "application/json" },
      { role: "tracking_receipt", path: receiptPath, status: "available", mediaType: "application/json" },
    ];
    const warnings = [
      ...plan.warnings,
      ...(["failed", "cancelled"].includes(lifecycle.state) ? ["Applied the preserved last-good analysis from a lifecycle whose latest rerun did not complete."] : []),
    ];
    const receipt = await mutationReceipt({
      operation: "analysis.tracking.apply",
      pkg,
      lifecycle,
      status: plan.status === "partial" ? "warning" : "passed",
      warnings,
      output: { packageRoot: outputRoot, lifecyclePath: artifacts[1].path, layerId, plan, changedPaths: applied.changedPaths, attachment: applied.attachment, validation },
      artifacts,
    });
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg, outputRoot,
      authoringInputRoots: services.authoringInputRoots, authoringOutputRoots: services.authoringOutputRoots,
      patchedMotion: applied.motion,
      receipt,
      receiptFileName: `tracking-${analysisId}-apply.receipt.json`,
      ...(receiptsRoot ? { receiptsRoot, writeHostReceipt: services.writeReceipt! } : {}),
    });
    const result = {
      packageId: pkg.manifest.id,
      packageRoot: outputRoot,
      motionPath: installed.motionPath,
      receiptPath: installed.receiptPath,
      ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
      layerId,
      plan,
      attachment: applied.attachment,
      changedPaths: applied.changedPaths,
      validation,
      receipt,
    };
    return { ok: true, result, receiptId: receipt.id, visibleState: trackingVisibleState("analysis.tracking.apply", result), warnings: receipt.warnings };
  } catch (error) {
    return commandFailure("tracking_apply_failed", error);
  }
}

async function detachTracking(args: unknown, services: TrackingAuthoringServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir") ?? stringArg(args, "packageDir");
  const layerId = safeIdArg(args, "layerId");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  if (!packageRoot) return invalidArgs("motion.analysis.tracking.detach requires packageRoot.");
  if (!outDir) return invalidArgs("motion.analysis.tracking.detach requires outDir.");
  if (!layerId) return invalidArgs("motion.analysis.tracking.detach requires a safe layerId.");
  const unavailable = mutationCapabilities(services, receiptsRoot, false);
  if (unavailable) return unavailable;
  try {
    const pkg = await services.packageLoader!(packageRoot);
    const outputRoot = resolve(outDir);
    const outputError = await packageOutputError("motion.analysis.tracking.detach", pkg, outputRoot, services);
    if (outputError) return outputError;
    const layer = pkg.motion.layers.find((candidate) => candidate.id === layerId);
    if (!layer) throw new Error(`Tracking stabilization target layer does not exist: ${layerId}.`);
    const attachment = readTrackingStabilizationAttachment(layer);
    if (!attachment) throw new Error(`Tracking stabilization is not attached to layer: ${layerId}.`);
    const lifecycle = await readTrackingLifecycle(pkg, attachment.analysisId, false);
    const detached = detachTrackingStabilization({ motion: pkg.motion, layerId });
    const validation = await validateDocument(await loadSchema("motion"), detached.motion);
    if (!validation.ok) throw new Error(`Detached Motion document failed validation: ${validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
    const receiptPath = join(outputRoot, "receipts", `tracking-${attachment.analysisId}-detach.receipt.json`);
    const artifacts: ReceiptArtifact[] = [
      { role: "motion_package", path: outputRoot, status: "available", primary: true },
      { role: "tracking_lifecycle", path: resolvePackageAsset({ root: outputRoot }, trackingLifecycleRef(attachment.analysisId)), status: "available", mediaType: "application/json" },
      { role: "tracking_receipt", path: receiptPath, status: "available", mediaType: "application/json" },
    ];
    const receipt = await mutationReceipt({
      operation: "analysis.tracking.detach",
      pkg,
      lifecycle,
      status: "passed",
      warnings: [],
      output: { packageRoot: outputRoot, layerId, analysisId: attachment.analysisId, changedPaths: detached.changedPaths, restoredPreviousKeyframes: true, validation },
      artifacts,
    });
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg, outputRoot,
      authoringInputRoots: services.authoringInputRoots, authoringOutputRoots: services.authoringOutputRoots,
      patchedMotion: detached.motion,
      receipt,
      receiptFileName: `tracking-${attachment.analysisId}-detach.receipt.json`,
      ...(receiptsRoot ? { receiptsRoot, writeHostReceipt: services.writeReceipt! } : {}),
    });
    const result = {
      packageId: pkg.manifest.id,
      packageRoot: outputRoot,
      motionPath: installed.motionPath,
      receiptPath: installed.receiptPath,
      ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
      layerId,
      analysisId: attachment.analysisId,
      changedPaths: detached.changedPaths,
      restoredPreviousKeyframes: true,
      validation,
      receipt,
    };
    return { ok: true, result, receiptId: receipt.id, visibleState: trackingVisibleState("analysis.tracking.detach", result), warnings: receipt.warnings };
  } catch (error) {
    return commandFailure("tracking_detach_failed", error);
  }
}

async function verifyTracking(args: unknown, services: TrackingAuthoringServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const layerId = safeIdArg(args, "layerId");
  const requestedAnalysisId = stringArg(args, "analysisId") ?? undefined;
  if (!packageRoot) return invalidArgs("motion.analysis.tracking.verify requires packageRoot.");
  if (!layerId) return invalidArgs("motion.analysis.tracking.verify requires a safe layerId.");
  if (requestedAnalysisId !== undefined && !SAFE_ID.test(requestedAnalysisId)) return invalidArgs("motion.analysis.tracking.verify analysisId must be safe.");
  if (!services.packageLoader) return capabilityUnavailable("Tracking package verification is unavailable.");
  try {
    const pkg = await services.packageLoader(packageRoot);
    const layer = pkg.motion.layers.find((candidate) => candidate.id === layerId);
    const attachment = layer ? readTrackingStabilizationAttachment(layer) : null;
    const analysisId = requestedAnalysisId ?? attachment?.analysisId;
    let lifecycle: TrackingAnalysisLifecycle | undefined;
    let source: Awaited<ReturnType<typeof inspectPersistedSource>> | undefined;
    if (analysisId) {
      lifecycle = await readTrackingLifecycle(pkg, analysisId, false);
      const identity = lifecycle.lastGood?.source ?? lifecycle.requestedSource;
      source = await inspectPersistedSource(pkg, identity.assetId, identity.sha256, identity.byteLength);
    }
    const core = verifyTrackingStabilization({
      motion: pkg.motion,
      layerId,
      ...(analysisId ? { analysisId } : {}),
      ...(lifecycle?.lastGood ? { sourceSha256: lifecycle.lastGood.source.sha256 } : {}),
    });
    const reasons = [...core.reasons, ...(source && !source.current ? ["source_file_changed"] : [])];
    const verification = { ...core, current: core.current && (source?.current ?? true), reasons };
    const receipt = lifecycle ? createTrackingOperationReceipt({
      operation: "analysis.tracking.verify",
      packageId: pkg.manifest.id,
      lifecycle,
      status: verification.current ? "passed" : "warning",
      output: { verification, source },
      warnings: verification.current ? [] : [`Tracking verification is not current: ${reasons.join(", ") || "unknown"}.`],
    }) : undefined;
    const result = { packageId: pkg.manifest.id, packageRoot: pkg.root, verification, ...(lifecycle ? { lifecycle } : {}), ...(source ? { source } : {}), ...(receipt ? { receipt } : {}) };
    return { ok: true, result, visibleState: trackingVisibleState("analysis.tracking.verify", result), warnings: receipt?.warnings ?? [] };
  } catch (error) {
    return commandFailure("tracking_verify_failed", error);
  }
}

async function commitTrackingArtifact(input: {
  pkg: MotionPackage;
  outputRoot: string;
  mediaAssetRef: string;
  lifecycle: TrackingAnalysisLifecycle;
  receipt: OperationReceipt;
  receiptPath: string;
  receiptsRoot?: string;
  services: TrackingAuthoringServices;
}): Promise<{ hostReceiptPath?: string }> {
  const receiptRef = `receipts/${input.receiptPath.split(/[\\/]/).at(-1)!}`;
  const transaction = await commitPackageEdit({
    sourceRoot: input.pkg.root,
    outputRoot: input.outputRoot,
    edit: async (stagedRoot) => {
      const stagedPkg = await loadMotionPackage(stagedRoot);
      if (stagedPkg.manifest.id !== input.pkg.manifest.id || stagedPkg.motion.id !== input.pkg.motion.id) {
        throw new Error("Tracking package identity changed before artifact commit.");
      }
      const stagedMedia = packageVideoAsset(stagedPkg, input.lifecycle.requestedSource.assetId);
      if (stagedMedia.assetRef !== input.mediaAssetRef || await hashFile(stagedMedia.path) !== input.lifecycle.requestedSource.sha256) {
        throw new Error("Tracking media source changed before artifact commit.");
      }
      await writeJson(resolvePackageAsset({ root: stagedRoot }, trackingLifecycleRef(input.lifecycle.id)), input.lifecycle);
      await writeJson(resolvePackageAsset({ root: stagedRoot }, receiptRef), input.receipt);
    },
    validate: async (stagedRoot) => {
      const persisted = JSON.parse(await readFile(resolvePackageAsset({ root: stagedRoot }, trackingLifecycleRef(input.lifecycle.id)), "utf8"));
      assertTrackingAnalysisLifecycle(persisted);
      if (JSON.stringify(persisted) !== JSON.stringify(input.lifecycle)) throw new Error("Persisted tracking lifecycle differs from the analyzed lifecycle.");
    },
    afterCommit: async () => input.receiptsRoot && input.services.writeReceipt
      ? input.services.writeReceipt(input.receiptsRoot, input.receipt)
      : undefined,
  });
  return transaction.afterCommitResult ? { hostReceiptPath: transaction.afterCommitResult } : {};
}

async function mutationReceipt(input: {
  operation: "analysis.tracking.apply" | "analysis.tracking.detach";
  pkg: MotionPackage;
  lifecycle: TrackingAnalysisLifecycle;
  status: OperationReceipt["status"];
  warnings: string[];
  output: unknown;
  artifacts: ReceiptArtifact[];
}): Promise<OperationReceipt> {
  const base = createTrackingOperationReceipt({
    operation: input.operation,
    packageId: input.pkg.manifest.id,
    lifecycle: input.lifecycle,
    status: input.status,
    warnings: input.warnings,
    output: input.output,
  });
  return {
    ...base,
    inputHashes: {
      ...base.inputHashes,
      "manifest.json": await hashPackageFile(resolvePackageAsset(input.pkg, "manifest.json")),
      [input.pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(input.pkg, input.pkg.manifest.motion)),
      [trackingLifecycleRef(input.lifecycle.id)]: await hashPackageFile(resolvePackageAsset(input.pkg, trackingLifecycleRef(input.lifecycle.id))),
    },
    artifacts: input.artifacts,
  };
}

async function readTrackingLifecycle(pkg: MotionPackage, analysisId: string, optional: true): Promise<TrackingAnalysisLifecycle | undefined>;
async function readTrackingLifecycle(pkg: MotionPackage, analysisId: string, optional: false): Promise<TrackingAnalysisLifecycle>;
async function readTrackingLifecycle(pkg: MotionPackage, analysisId: string, optional: boolean): Promise<TrackingAnalysisLifecycle | undefined> {
  const path = resolvePackageAsset(pkg, trackingLifecycleRef(analysisId));
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (optional && isMissing(error)) return undefined;
    throw error;
  }
  assertTrackingAnalysisLifecycle(value);
  if (value.id !== analysisId) throw new Error("Tracking lifecycle id does not match its artifact path.");
  return value;
}

function packageVideoAsset(pkg: MotionPackage, assetId: string): { assetRef: string; path: string } {
  const asset = pkg.motion.assets.map(objectArg).find((candidate) => candidate?.id === assetId);
  if (!asset) throw new Error(`Tracking source asset does not exist: ${assetId}.`);
  const kind = typeof asset.kind === "string" ? asset.kind : asset.type;
  if (kind !== "video") throw new Error(`Tracking source asset must be video: ${assetId}.`);
  const source = objectArg(asset.source);
  const assetRef = typeof source?.path === "string" ? source.path : null;
  if (!assetRef || !pkg.manifest.assets.includes(assetRef)) {
    throw new Error(`Tracking source asset must reference a manifest-declared package file: ${assetId}.`);
  }
  return { assetRef, path: resolvePackageAsset(pkg, assetRef) };
}

async function inspectPersistedSource(pkg: MotionPackage, assetId: string, expectedSha256: string, expectedByteLength: number): Promise<{
  assetId: string;
  assetRef: string;
  sha256: string | null;
  byteLength: number;
  current: boolean;
}> {
  const asset = packageVideoAsset(pkg, assetId);
  const stat = await lstat(asset.path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Tracking source must remain a regular non-symlink package file.");
  if (stat.size < 1 || stat.size > MAX_TRACKING_MEDIA_BYTES) throw new Error(`Tracking source must contain 1..${MAX_TRACKING_MEDIA_BYTES} bytes.`);
  if (stat.size !== expectedByteLength) {
    return { assetId, assetRef: asset.assetRef, sha256: null, byteLength: stat.size, current: false };
  }
  const sha256 = await hashFile(asset.path);
  const after = await lstat(asset.path);
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
    throw new Error("Tracking source changed while its persisted identity was inspected.");
  }
  return { assetId, assetRef: asset.assetRef, sha256, byteLength: after.size, current: sha256 === expectedSha256 };
}

function trackingLifecycleRef(analysisId: string): string {
  if (!SAFE_ID.test(analysisId)) throw new Error("Tracking analysis id is unsafe.");
  return `analysis/tracking/${analysisId}.lifecycle.json`;
}

function trackingReferenceArg(args: unknown): TrackingAnalysis["reference"] | null {
  const reference = recordArg(args, "reference");
  const bounds = objectArg(reference?.bounds);
  if (!reference || !bounds || !finite(reference.atMs)
    || !finite(bounds.x) || !finite(bounds.y) || !finite(bounds.width) || !finite(bounds.height)
    || !Array.isArray(reference.points)) return null;
  const points = reference.points.map(objectArg);
  if (points.length < 1 || points.length > 64 || points.some((point) => !point || !finite(point.x) || !finite(point.y))) return null;
  return {
    atMs: Number(reference.atMs),
    bounds: { x: Number(bounds.x), y: Number(bounds.y), width: Number(bounds.width), height: Number(bounds.height) },
    points: points.map((point) => ({ x: Number(point!.x), y: Number(point!.y) })),
  };
}

function trackingSettingsArg(args: unknown): TrackingAnalysisSettings | null {
  const value = recordArg(args, "settings");
  if (!value || !finite(value.startMs) || !finite(value.endMs) || !finite(value.stepMs)
    || !finite(value.searchRadiusPx) || !finite(value.pyramidLevels) || !finite(value.maxIterations)
    || !finite(value.confidenceFloor) || !finite(value.deterministicSeed)
    || !["forward", "backward", "both"].includes(String(value.direction))) return null;
  return {
    startMs: Number(value.startMs),
    endMs: Number(value.endMs),
    stepMs: Number(value.stepMs),
    direction: value.direction as TrackingAnalysisSettings["direction"],
    searchRadiusPx: Number(value.searchRadiusPx),
    pyramidLevels: Number(value.pyramidLevels),
    maxIterations: Number(value.maxIterations),
    confidenceFloor: Number(value.confidenceFloor),
    deterministicSeed: Number(value.deterministicSeed),
  };
}

function mutationCapabilities(services: TrackingAuthoringServices, receiptsRoot: string | undefined, needsAnalyzer: boolean): MotionDebugResult | null {
  if (!services.packageLoader || !services.isUnsafePackageOutputDirectory || !services.isEmptyOrAbsentDirectory) {
    return capabilityUnavailable("Atomic tracking package editing is unavailable.");
  }
  if (needsAnalyzer && !services.trackingAnalyzer) return capabilityUnavailable("Contained tracking analysis is unavailable.");
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Tracking receipt persistence is unavailable.");
  return null;
}

async function packageOutputError(command: string, pkg: MotionPackage, outputRoot: string, services: TrackingAuthoringServices): Promise<MotionDebugResult | null> {
  if (await services.isUnsafePackageOutputDirectory!(pkg.root, outputRoot)) return invalidArgs(`${command} outDir must be outside packageRoot.`);
  if (!await services.isEmptyOrAbsentDirectory!(outputRoot)) return invalidArgs(`${command} outDir must be empty or absent before package copy.`);
  return null;
}

function trackingVisibleState(operation: string, result: Record<string, unknown>) {
  return { panel: "tracking", operation, ...result };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeIdArg(args: unknown, key: string): string | null {
  const value = stringArg(args, key);
  return value && SAFE_ID.test(value) ? value : null;
}

function enumArg<T extends string>(args: unknown, key: string, values: readonly T[]): T | null {
  const value = stringArg(args, key);
  return value && values.includes(value as T) ? value as T : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return finite(value) ? value : fallback;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}

function commandFailure(code: string, error: unknown): MotionDebugResult {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}
