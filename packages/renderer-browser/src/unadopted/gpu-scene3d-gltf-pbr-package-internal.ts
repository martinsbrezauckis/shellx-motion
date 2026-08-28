import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { OutputDirectoryTransaction, canonicalJson, canonicalJsonSha256, type OperationReceipt } from "@shellx-motion/core";
import { prepareScene3dGltfMaterialRenderPlanFromAuthenticatedPackage, validateScene3dGltfMaterialRenderCleanup } from "@shellx-motion/core/internal/scene3d-gltf-material";
import { GPU_ADAPTER_REQUEST_OPTIONS, openGpuRuntime, type GpuRuntimeSession } from "../gpu-browser-runtime";
import { GpuFrameAbortError, GpuFrameTimeoutError, raceGpuFrameOperation } from "../gpu-frame-renderer-operation";
import { finalizeGpuFrameReadback } from "../gpu-frame-readback-output";
import { encodeGpuPng } from "../gpu-png";
import { GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG } from "../gpu-page-scene3d-gltf-pbr-contract";
import { closeWebGpuPageSessionScene3dGltfPbr, openWebGpuPageSessionScene3dGltfPbr } from "../gpu-page-scene3d-gltf-pbr-session";
import { prepareGpuScene3dGltfPbrMaterialPage, readGpuScene3dGltfPbrMaterialPage, releaseGpuScene3dGltfPbrMaterialPage, renderGpuScene3dGltfPbrMaterialPage } from "../gpu-scene3d-gltf-pbr-material-route";
import type { GpuRuntimeFailure } from "../gpu-runtime-types";

export const GPU_SCENE3D_GLTF_PBR_PACKAGE_INTERNAL_SCHEMA = "shellx-motion/browser-scene3d-gltf-pbr-package-internal@1" as const;
const GPU_SCENE3D_GLTF_PBR_PACKAGE_OPERATION_TIMEOUT_MS = 30_000;

export interface GpuScene3dGltfPbrPackageInternalInput {
  readonly schema: typeof GPU_SCENE3D_GLTF_PBR_PACKAGE_INTERNAL_SCHEMA;
  readonly packageRoot: string;
  /** New local directory only; this route never replaces an existing result. */
  readonly outputDirectory: string;
  readonly signal?: AbortSignal;
}
export type GpuScene3dGltfPbrPackageInternalResult =
  | { readonly ok: true; readonly packageId: string; readonly outputDirectory: string; readonly pngSha256: string; readonly receipt: OperationReceipt }
  | { readonly ok: false; readonly failure: GpuRuntimeFailure };

/**
 * Internal-only vertical PBR proof: reopen the authenticated sidecar, render exactly one frame,
 * read it back, terminal-release the page, then atomically publish a PNG and bound receipt.
 * It is deliberately absent from renderer public exports and Debug/import dispatch.
 */
export async function renderScene3dGltfPbrPackageInternal(input: GpuScene3dGltfPbrPackageInternalInput): Promise<GpuScene3dGltfPbrPackageInternalResult> {
  let transaction: OutputDirectoryTransaction | undefined;
  let runtime: GpuRuntimeSession | undefined;
  let pageClosed = false, resourcesActive = false, succeeded = false;
  try {
    if (!validInput(input)) return fail("gpu_resource_refused", "The package-internal glTF PBR route requires an exact bounded local request.");
    if (input.signal?.aborted) return fail("gpu_cancelled", "The package-internal glTF PBR route was cancelled before package reopen.");
    let plan = await prepareScene3dGltfMaterialRenderPlanFromAuthenticatedPackage(input.packageRoot);
    const identity = capturePlanIdentity(plan);
    try { await assertScene3dGltfPbrOutputDisjoint(input.packageRoot, input.outputDirectory); }
    catch (error) { return fail("gpu_resource_refused", error instanceof Error ? error.message : "The package-internal glTF PBR output path is unsafe."); }
    transaction = await OutputDirectoryTransaction.create(input.outputDirectory, { requireAbsent: true });
    if (input.signal?.aborted) return fail("gpu_cancelled", "The package-internal glTF PBR route was cancelled before Browser launch.");
    const opened = await openGpuRuntime(); if (!opened.ok) return opened;
    runtime = opened.session;
    const initialized = await bounded(runtime.page.evaluate(openWebGpuPageSessionScene3dGltfPbr, GPU_ADAPTER_REQUEST_OPTIONS), input.signal).catch(() => ({ ok: false as const, failure: { code: "gpu_render_failed" as const, message: "The isolated glTF PBR page could not initialize." } }));
    if (!initialized.ok) return initialized;
    const assessed = await bounded(runtime.assessRender(initialized.runtime), input.signal); if (!assessed.ok) return assessed;
    const prepared = await bounded(prepareGpuScene3dGltfPbrMaterialPage(runtime.page, plan, input.signal), input.signal);
    // The page input contains base64 copies only. Drop the verified decoded Buffer snapshots now.
    plan = undefined as never;
    if (!prepared.ok) return { ok: false, failure: prepared.failure };
    resourcesActive = true;
    const frameStartedAtNs = process.hrtime.bigint();
    const rendered = await bounded(renderGpuScene3dGltfPbrMaterialPage(runtime.page, prepared.input, input.signal), input.signal);
    if (!rendered.ok) { resourcesActive = false; return { ok: false, failure: rendered.failure }; }
    const readback = await bounded(readGpuScene3dGltfPbrMaterialPage(runtime.page, prepared.input, input.signal), input.signal);
    if (!readback.ok) { resourcesActive = false; return { ok: false, failure: readback.failure }; }
    const pageCleanup = await bounded(releaseGpuScene3dGltfPbrMaterialPage(runtime.page, "terminal")); resourcesActive = false;
    const cleanup = validateCleanup(identity, pageCleanup);
    await closePbrPage(runtime); pageClosed = true;
    const frame = finalizeGpuFrameReadback({ paddedBase64: readback.paddedBase64, width: readback.width, height: readback.height, bytesPerRow: readback.bytesPerRow, evidence: assessed.evidence, textFit: [], frameStartedAtNs });
    const png = encodeGpuPng({ rgba: frame.rgba, width: frame.width, height: frame.height });
    const pngSha256 = sha256(png), receipt = receiptFor(identity, pngSha256, frame, readback.evidence, rendered.metrics, pageCleanup!, cleanup, assessed.evidence);
    const framePath = join(transaction.stagingPath, "frame.png"), receiptPath = join(transaction.stagingPath, "receipt.json"), receiptBytes = Buffer.from(canonicalJson(receipt), "utf8");
    await transaction.assertCurrent();
    await writeFile(framePath, png, { mode: 0o600 }); await writeFile(receiptPath, receiptBytes, { mode: 0o600 });
    const stagedPng = await readFile(framePath), stagedReceipt = await readFile(receiptPath);
    if (sha256(stagedPng) !== pngSha256 || !stagedReceipt.equals(receiptBytes)) throw new Error("The private glTF PBR output stage changed before publication.");
    await transaction.assertCurrent();
    await transaction.commit(); await transaction.assertPublishedCurrent(); succeeded = true;
    return { ok: true, packageId: identity.packageId, outputDirectory: transaction.outputPath, pngSha256, receipt };
  } catch (error) {
    if (error instanceof GpuFrameAbortError || input.signal?.aborted) return fail("gpu_cancelled", "The package-internal glTF PBR route was cancelled and its page resources were terminally released.");
    if (error instanceof GpuFrameTimeoutError) return fail("gpu_render_failed", "The package-internal glTF PBR route exceeded its fixed 30000ms operation budget.");
    return fail("gpu_render_failed", error instanceof Error ? `The package-internal glTF PBR route failed closed: ${error.message.slice(0, 384)}` : "The package-internal glTF PBR route failed closed.");
  } finally {
    if (runtime && resourcesActive) await bounded(releaseGpuScene3dGltfPbrMaterialPage(runtime.page, input.signal?.aborted ? "cancelled" : "terminal")).catch(() => null);
    if (runtime && !pageClosed) await bounded(closePbrPage(runtime)).catch(() => undefined);
    if (transaction && !succeeded) await transaction.abort();
  }
}

function capturePlanIdentity(plan: Awaited<ReturnType<typeof prepareScene3dGltfMaterialRenderPlanFromAuthenticatedPackage>>) {
  const declaration = plan.staticPlan.sidecar.declaration;
  if (plan.framePlan.renderer.status !== "package-internal" || plan.framePlan.renderer.route !== "browser.scene3d-gltf-pbr-package-internal@1") throw new Error("The authenticated sidecar has no package-internal PBR renderer route.");
  return Object.freeze({ packageId: declaration.packageId, sourceSha256: plan.staticPlan.source.sha256, sidecarSha256: declaration.sidecarSha256, sidecarReceiptSha256: declaration.receiptSha256, declarationSha256: canonicalJsonSha256(declaration), staticFingerprint: plan.staticPlan.fingerprint, frameFingerprint: plan.framePlan.fingerprint, cleanup: plan.framePlan.cleanup, peakGpuResourceBytes: plan.staticPlan.budget.peakGpuResourceBytes });
}

function validateCleanup(identity: ReturnType<typeof capturePlanIdentity>, pageCleanup: Awaited<ReturnType<typeof releaseGpuScene3dGltfPbrMaterialPage>>) {
  if (!pageCleanup?.hadResources || pageCleanup.destroyedTextures !== identity.cleanup.textureResourceIds.length || pageCleanup.destroyedVertexBuffers !== identity.cleanup.primitiveIds.length || pageCleanup.destroyedIndexBuffers !== identity.cleanup.primitiveIds.length || pageCleanup.destroyedUniformBuffers !== identity.cleanup.primitiveIds.length || pageCleanup.destroyedRenderTargets !== 2 || pageCleanup.releasedGpuResourceBytes !== identity.cleanup.gpuResourceBytes || pageCleanup.remainingGpuResourceBytes !== 0) throw new Error("The fixed glTF PBR page did not prove terminal resource release.");
  const base = { schema: "shellx-motion/scene3d-gltf-material-render-cleanup@1" as const, frameFingerprint: identity.frameFingerprint, destroyedTextureResourceIds: identity.cleanup.textureResourceIds, destroyedVertexBufferPrimitiveIds: identity.cleanup.primitiveIds, destroyedIndexBufferPrimitiveIds: identity.cleanup.primitiveIds, destroyedUniformBufferPrimitiveIds: identity.cleanup.primitiveIds, destroyedRenderTargetIds: identity.cleanup.renderTargetIds, releasedCpuSnapshotBytes: identity.cleanup.cpuSnapshotBytes, remainingGpuResourceBytes: 0 as const };
  return validateScene3dGltfMaterialRenderCleanup({ framePlan: { fingerprint: identity.frameFingerprint, cleanup: identity.cleanup } } as never, { ...base, fingerprint: canonicalJsonSha256(base) });
}

function receiptFor(identity: ReturnType<typeof capturePlanIdentity>, pngSha256: string, frame: { sha256: string; width: number; height: number; readback?: unknown }, readback: unknown, resources: unknown, pageCleanup: unknown, cleanup: unknown, runtime: unknown): OperationReceipt {
  return verifyScene3dGltfPbrPackageInternalReceipt({ schema: "shellx-motion/receipt@1", id: `receipt_scene3d_gltf_pbr_${pngSha256.slice(0, 16)}`, operation: "renderer.browser.scene3d-gltf-pbr-package-internal", status: "passed", packageId: identity.packageId, inputHashes: { "gltf-source": identity.sourceSha256, "gltf-sidecar": identity.sidecarSha256, "gltf-sidecar-receipt": identity.sidecarReceiptSha256, "gltf-declaration": identity.declarationSha256, "pbr-static-plan": identity.staticFingerprint, "pbr-frame-plan": identity.frameFingerprint, "pbr-page-catalog": GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG.sha256, "pbr-raw-rgba-frame": frame.sha256 }, createdAt: new Date().toISOString(), lane: "gpu", output: { schema: "shellx-motion/scene3d-gltf-pbr-package-output@1", path: "frame.png", sha256: pngSha256, rawRgbaSha256: frame.sha256, width: frame.width, height: frame.height, packageId: identity.packageId, pbrCatalogSha256: GPU_PAGE_SCENE3D_GLTF_PBR_CATALOG.sha256, staticFingerprint: identity.staticFingerprint, frameFingerprint: identity.frameFingerprint, peakGpuResourceBytes: identity.peakGpuResourceBytes, readback: frame.readback, pageReadback: readback, resources, pageCleanup, cleanup, runtime }, warnings: [] });
}

const RECEIPT_INPUT_HASH_KEYS = ["gltf-declaration", "gltf-sidecar", "gltf-sidecar-receipt", "gltf-source", "pbr-frame-plan", "pbr-page-catalog", "pbr-raw-rgba-frame", "pbr-static-plan"] as const;
const RECEIPT_OUTPUT_KEYS = ["cleanup", "frameFingerprint", "height", "packageId", "pageCleanup", "pageReadback", "path", "pbrCatalogSha256", "peakGpuResourceBytes", "rawRgbaSha256", "readback", "resources", "runtime", "schema", "sha256", "staticFingerprint", "width"] as const;
const RECEIPT_KEYS = ["createdAt", "id", "inputHashes", "lane", "operation", "output", "packageId", "schema", "status", "warnings"] as const;

/** Strictly binds the persisted PNG receipt to every admitted fixed-PBR input, including raw frame pixels. */
export function verifyScene3dGltfPbrPackageInternalReceipt(value: unknown): OperationReceipt {
  const receipt = plainRecord(value, "The package-internal glTF PBR receipt");
  if (!sameKeys(receipt, RECEIPT_KEYS) || receipt.schema !== "shellx-motion/receipt@1" || receipt.operation !== "renderer.browser.scene3d-gltf-pbr-package-internal" || receipt.status !== "passed" || receipt.lane !== "gpu" || typeof receipt.packageId !== "string" || !receipt.packageId || !validIsoTime(receipt.createdAt) || !Array.isArray(receipt.warnings) || receipt.warnings.length !== 0) throw new Error("The package-internal glTF PBR receipt schema is invalid.");
  const hashes = plainRecord(receipt.inputHashes, "The package-internal glTF PBR receipt inputHashes");
  if (!sameKeys(hashes, RECEIPT_INPUT_HASH_KEYS) || !Object.values(hashes).every(hash)) throw new Error("The package-internal glTF PBR receipt input hashes are invalid.");
  const output = plainRecord(receipt.output, "The package-internal glTF PBR receipt output");
  if (!sameKeys(output, RECEIPT_OUTPUT_KEYS) || output.schema !== "shellx-motion/scene3d-gltf-pbr-package-output@1" || output.path !== "frame.png" || !hash(output.sha256) || !hash(output.rawRgbaSha256) || output.rawRgbaSha256 !== hashes["pbr-raw-rgba-frame"] || output.packageId !== receipt.packageId || output.pbrCatalogSha256 !== hashes["pbr-page-catalog"] || output.staticFingerprint !== hashes["pbr-static-plan"] || output.frameFingerprint !== hashes["pbr-frame-plan"] || output.width !== 1280 || output.height !== 720 || !positiveSafeInteger(output.peakGpuResourceBytes) || ![output.readback, output.pageReadback, output.resources, output.pageCleanup, output.cleanup, output.runtime].every(isPlainRecord)) throw new Error("The package-internal glTF PBR receipt output does not bind its exact admitted identities.");
  if (receipt.id !== `receipt_scene3d_gltf_pbr_${output.sha256.slice(0, 16)}`) throw new Error("The package-internal glTF PBR receipt ID does not bind its PNG identity.");
  return receipt as unknown as OperationReceipt;
}

/**
 * Refuses package/output overlap before the output transaction can create a parent or staging leaf.
 * Existing symlink aliases are rejected rather than followed, so a lexical outside path cannot
 * become a package descendant after admission.
 */
export async function assertScene3dGltfPbrOutputDisjoint(packageRoot: string, outputDirectory: string): Promise<void> {
  const source = await canonicalExistingDirectory(packageRoot, "The glTF PBR package root");
  const output = await canonicalOutputDestination(outputDirectory);
  if (insideOrEqual(source, output) || insideOrEqual(output, source)) throw new Error("The package-internal glTF PBR output directory must be disjoint from the authenticated package root.");
}

async function canonicalExistingDirectory(path: string, label: string): Promise<string> {
  const resolved = resolve(path), facts = await lstat(resolved).catch((error: NodeJS.ErrnoException) => { throw new Error(`${label} could not be inspected (${error.code ?? "unknown error"}).`); });
  if (!facts.isDirectory() || facts.isSymbolicLink()) throw new Error(`${label} must be an existing non-symlink directory.`);
  const canonical = await realpath(resolved).catch(() => { throw new Error(`${label} could not be canonicalized.`); });
  if (canonical !== resolved) throw new Error(`${label} must not resolve through a symlink.`);
  return canonical;
}

async function canonicalOutputDestination(path: string): Promise<string> {
  const target = resolve(path), root = parse(target).root, parts = target.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!, candidate = join(current, part);
    const facts = await lstat(candidate).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (!facts) return resolve(current, ...parts.slice(index));
    if (facts.isSymbolicLink()) throw new Error("The package-internal glTF PBR output directory must not cross a symlink.");
    if (!facts.isDirectory()) throw new Error("The package-internal glTF PBR output directory has a non-directory ancestor.");
    const canonical = await realpath(candidate).catch(() => { throw new Error("The package-internal glTF PBR output directory could not be canonicalized."); });
    if (canonical !== candidate) throw new Error("The package-internal glTF PBR output directory must not resolve through a symlink.");
    current = candidate;
  }
  return current;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> { if (!isPlainRecord(value)) throw new Error(`${label} must be a plain object.`); return value; }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function positiveSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function validIsoTime(value: unknown): value is string { if (typeof value !== "string") return false; const milliseconds = Date.parse(value); return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value; }
function insideOrEqual(root: string, candidate: string): boolean { const relation = relative(root, candidate); return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation)); }

async function closePbrPage(runtime: { page: { evaluate(value: unknown): Promise<unknown> }; close(): Promise<void> }): Promise<void> {
  let pageFailure: Error | undefined;
  try { const close = await runtime.page.evaluate(closeWebGpuPageSessionScene3dGltfPbr); if (!close || typeof close !== "object" || (close as { deviceDestroyed?: unknown }).deviceDestroyed !== true || (close as { forcedResourceRelease?: unknown }).forcedResourceRelease !== false) pageFailure = new Error("The isolated glTF PBR page did not terminally close after resource release."); }
  catch { pageFailure = new Error("The isolated glTF PBR page could not close its device state."); }
  let runtimeFailure: unknown; try { await runtime.close(); } catch (error) { runtimeFailure = error; }
  if (pageFailure) throw pageFailure; if (runtimeFailure) throw runtimeFailure;
}

function validInput(value: unknown): value is GpuScene3dGltfPbrPackageInternalInput { return !!value && typeof value === "object" && Object.keys(value).every((key) => ["schema", "packageRoot", "outputDirectory", "signal"].includes(key)) && (value as GpuScene3dGltfPbrPackageInternalInput).schema === GPU_SCENE3D_GLTF_PBR_PACKAGE_INTERNAL_SCHEMA && typeof (value as GpuScene3dGltfPbrPackageInternalInput).packageRoot === "string" && (value as GpuScene3dGltfPbrPackageInternalInput).packageRoot.length > 0 && typeof (value as GpuScene3dGltfPbrPackageInternalInput).outputDirectory === "string" && (value as GpuScene3dGltfPbrPackageInternalInput).outputDirectory.length > 0; }
function fail(code: GpuRuntimeFailure["code"], message: string): GpuScene3dGltfPbrPackageInternalResult { return { ok: false, failure: { code, message } }; }
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function bounded<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> { return raceGpuFrameOperation(operation, GPU_SCENE3D_GLTF_PBR_PACKAGE_OPERATION_TIMEOUT_MS, signal); }
