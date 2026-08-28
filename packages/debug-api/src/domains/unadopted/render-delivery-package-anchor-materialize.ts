/** Private Debug-host C5B3 COW materialization of a freshly rederived provider-anchor B2 plan. */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalJsonSha256,
  compileMotionDocumentCompositing,
  hashBuffer,
  loadMotionPackage,
  loadSchema,
  readBoundedStableFile,
  renderLanesFor,
  requiredLoadedPackageDocumentHashes,
  resolvePackageAsset,
  unrenderablePackageRefusal,
  validateDocument,
  validateMotionProceduralGraph,
  validateMotionRelations,
  writeVerifiedBoundedFile,
  type MotionDocument,
  type MotionPackage,
} from "@shellx-motion/core";
import { validateMotionBehaviors } from "@shellx-motion/core/internal/render-delivery-source";
import { commitPackageEdit, PackageEditTransactionError, writeJson } from "../package-edit-transaction.js";
import {
  planImportedRenderDeliveryAnchorKeyframes,
  type RenderDeliveryAnchorKeyframeIntentPlan,
  type RenderDeliveryAnchorKeyframeIntentRequest,
} from "./render-delivery-package-anchor-bake-plan.js";
import { readRenderDeliveryAnchorKeyframeIntentRequest } from "./render-delivery-package-anchor-bake-request.js";
import {
  assertRenderDeliveryAnchorKeyframeMaterializationReceipt,
  createRenderDeliveryAnchorKeyframeMaterializationReceipt,
  serializedRenderDeliveryAnchorKeyframeMaterializationReceipt,
  type RenderDeliveryAnchorKeyframeMaterializationReceipt,
} from "./render-delivery-package-anchor-materialize-receipt.js";
import { type PackageIdentity } from "./render-delivery-package-import-receipt.js";
import { withRenderDeliveryPackageWorkspaceAuthority, type RenderDeliveryPackageWorkspaceHost } from "./render-delivery-package-workspace.js";

const REQUEST_SCHEMA = "shellx-motion/render-delivery-anchor-keyframe-materialization-request/v1" as const;
const RECEIPT_PATH = "receipts/render-delivery-anchor-keyframe-materialization.v1.json";
const MAX_RECEIPT_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RenderDeliveryAnchorKeyframeMaterializationHost extends RenderDeliveryPackageWorkspaceHost {
  /** Host-selected private COW output. It is not retained in the durable receipt. */
  readonly outputPackageRoot: string;
}

export interface RenderDeliveryAnchorKeyframeMaterializationServices {
  /** Cancellation is honored through the last non-mutating beforeCommit checkpoint only. */
  readonly signal?: AbortSignal;
  /** Test-only gate after the fresh B2 plan, before current source reopening. */
  readonly afterPlan?: () => Promise<void>;
  /** Test-only gate inside the final non-mutating beforeCommit checkpoint. */
  readonly beforeCommit?: () => Promise<void>;
}

export interface RenderDeliveryAnchorKeyframeMaterializationResult {
  /** Non-durable host result; this location is intentionally absent from the package receipt. */
  readonly packageRoot: string;
  readonly receipt: RenderDeliveryAnchorKeyframeMaterializationReceipt;
  readonly workspaceCleanup: "completed";
}

interface MaterializationRequest {
  readonly expected: Pick<PackageIdentity, "packageId" | "manifestSha256" | "motionSha256">;
  readonly request: RenderDeliveryAnchorKeyframeIntentRequest;
}

interface StagedResult {
  readonly receipt: RenderDeliveryAnchorKeyframeMaterializationReceipt;
  readonly persistedMotion: MotionDocument;
  readonly outputPackage: PackageIdentity;
}

/**
 * Materializes no caller-supplied plan. The only accepted intent is descriptor-read first, then
 * B2 is reopened under the exact workspace authority immediately before this COW transaction.
 */
export async function materializeImportedRenderDeliveryAnchorKeyframes(
  host: RenderDeliveryAnchorKeyframeMaterializationHost,
  value: unknown,
  services: RenderDeliveryAnchorKeyframeMaterializationServices = {},
): Promise<RenderDeliveryAnchorKeyframeMaterializationResult> {
  assertNotAborted(services.signal);
  const materialization = readMaterializationRequest(value);
  return await withMaterializationWorkspaceAuthority(host, async () => {
    assertNotAborted(services.signal);
    const plan = await planImportedRenderDeliveryAnchorKeyframes(host, materialization.request);
    assertNotAborted(services.signal);
    await services.afterPlan?.();
    assertNotAborted(services.signal);

    const source = await loadMotionPackage(host.sourcePackageRoot);
    assertNotAborted(services.signal);
    const sourceIdentity = await currentPackageIdentity(source, services.signal);
    assertExactBase(materialization, plan, sourceIdentity);
    const persistedMotion = await preparedPersistedMotion(source.motion, plan, services.signal);
    assertNotAborted(services.signal);

    const transaction = await commitPackageEdit<StagedResult, void>({
      sourceRoot: source.root,
      outputRoot: host.outputPackageRoot,
      requireAbsentOutput: true,
      edit: async (stagedRoot) => {
        assertNotAborted(services.signal);
        const stagedPlan = await planImportedRenderDeliveryAnchorKeyframes({ ...host, sourcePackageRoot: stagedRoot }, materialization.request);
        assertNotAborted(services.signal);
        if (stagedPlan.fingerprint !== plan.fingerprint) {
          throw new PackageEditTransactionError("source_changed", "Provider-anchor materialization source evidence changed after plan derivation.");
        }
        const stagedSource = await loadMotionPackage(stagedRoot);
        assertNotAborted(services.signal);
        const stagedSourceIdentity = await currentPackageIdentity(stagedSource, services.signal);
        if (!samePackageIdentity(stagedSourceIdentity, sourceIdentity)) {
          throw new PackageEditTransactionError("source_changed", "Provider-anchor materialization source changed before staged editing.");
        }
        await writeJson(join(stagedRoot, stagedSource.manifest.motion), persistedMotion);
        assertNotAborted(services.signal);
        const stagedOutput = await loadMotionPackage(stagedRoot);
        assertNotAborted(services.signal);
        const outputPackage = await currentPackageIdentity(stagedOutput, services.signal);
        if (outputPackage.packageId !== sourceIdentity.packageId || outputPackage.manifestSha256 !== sourceIdentity.manifestSha256
          || outputPackage.assetInventorySha256 !== sourceIdentity.assetInventorySha256 || outputPackage.motionSha256 !== serializedMotionSha256(persistedMotion)) {
          throw new PackageEditTransactionError("copy_mismatch", "Staged provider-anchor materialization did not preserve exact package output facts.");
        }
        await assertCompleteMotion(stagedOutput.motion, services.signal);
        const receipt = createRenderDeliveryAnchorKeyframeMaterializationReceipt({
          expectedBase: materialization.expected,
          sourcePackage: sourceIdentity,
          request: materialization.request,
          plan,
          outputPackage,
          canonicalMotionFingerprint: canonicalJsonSha256(persistedMotion),
          renderTruth: renderTruth(stagedOutput.motion),
        });
        await writeExclusiveReceipt(stagedRoot, receipt, services.signal);
        return { receipt, persistedMotion, outputPackage };
      },
      validate: async (stagedRoot, staged) => {
        assertNotAborted(services.signal);
        await assertStagedMaterialization(stagedRoot, sourceIdentity, staged, services.signal);
      },
      beforeCommit: async () => {
        assertNotAborted(services.signal);
        await services.beforeCommit?.();
        assertNotAborted(services.signal);
        const current = await reopenCurrentPackageIdentity(host.sourcePackageRoot, services.signal);
        if (!samePackageIdentity(current, sourceIdentity)) {
          throw new PackageEditTransactionError("source_changed", "Provider-anchor materialization source changed before output claim.");
        }
        assertNotAborted(services.signal);
      },
      afterCommit: async (outputRoot, staged) => {
        await assertStagedMaterialization(outputRoot, sourceIdentity, staged, undefined);
      },
    });
    return Object.freeze({ packageRoot: transaction.outputRoot, receipt: transaction.editResult.receipt, workspaceCleanup: "completed" as const });
  });
}

function readMaterializationRequest(value: unknown): MaterializationRequest {
  const root = dataObject(value, "Provider-anchor materialization request");
  // This descriptor/cap read is intentionally before root enumeration, so a 17-or-larger map
  // refuses before any package loader/output topology can be touched.
  const request = readRenderDeliveryAnchorKeyframeIntentRequest(dataDescriptor(root, "request", "Provider-anchor materialization request").value);
  exactKeys(root, ["schema", "expected", "request"], "Provider-anchor materialization request");
  if (dataDescriptor(root, "schema", "Provider-anchor materialization request").value !== REQUEST_SCHEMA) {
    throw new Error("Provider-anchor materialization request has an invalid schema.");
  }
  const expected = dataObject(dataDescriptor(root, "expected", "Provider-anchor materialization request").value, "Provider-anchor materialization expected base");
  exactKeys(expected, ["packageId", "manifestSha256", "motionSha256"], "Provider-anchor materialization expected base");
  const packageId = dataDescriptor(expected, "packageId", "Provider-anchor materialization expected base").value;
  const manifestSha256 = dataDescriptor(expected, "manifestSha256", "Provider-anchor materialization expected base").value;
  const motionSha256 = dataDescriptor(expected, "motionSha256", "Provider-anchor materialization expected base").value;
  if (typeof packageId !== "string" || packageId.length === 0 || packageId.length > 128 || !hash(manifestSha256) || !hash(motionSha256)) {
    throw new Error("Provider-anchor materialization expected base is invalid.");
  }
  return { expected: { packageId, manifestSha256, motionSha256 }, request };
}

async function preparedPersistedMotion(source: MotionDocument, plan: RenderDeliveryAnchorKeyframeIntentPlan, signal: AbortSignal | undefined): Promise<MotionDocument> {
  const candidate = applyExactPlan(source, plan);
  await assertCompleteMotion(candidate, signal);
  const persisted = compileMotionDocumentCompositing(candidate);
  if (canonicalJsonSha256(compileMotionDocumentCompositing(persisted)) !== canonicalJsonSha256(persisted)) {
    throw new PackageEditTransactionError("copy_mismatch", "Provider-anchor materialization compositing is not idempotent.");
  }
  await assertCompleteMotion(persisted, signal);
  return persisted;
}

function applyExactPlan(source: MotionDocument, plan: RenderDeliveryAnchorKeyframeIntentPlan): MotionDocument {
  const expectedPaths = plan.mappings.flatMap((mapping) => [
    `/layers/${mapping.target.layerIndex}/keyframes/transform.x`,
    `/layers/${mapping.target.layerIndex}/keyframes/transform.y`,
  ]);
  if (plan.counts.mappings !== plan.mappings.length || plan.counts.samples !== plan.timing.derivedAtMs.length * plan.mappings.length
    || plan.counts.keyframeWrites !== plan.counts.samples * 2 || !exactDataEqual(expectedPaths, plan.changedPathIntents)) {
    throw new PackageEditTransactionError("copy_mismatch", "Provider-anchor materialization plan paths or counts are not exact.");
  }
  const next = structuredClone(source);
  for (const mapping of plan.mappings) {
    const layer = next.layers[mapping.target.layerIndex];
    if (!layer || layer.id !== mapping.target.layerId || Object.hasOwn(layer.keyframes ?? {}, "transform.x") || Object.hasOwn(layer.keyframes ?? {}, "transform.y")) {
      throw new PackageEditTransactionError("source_changed", "Provider-anchor materialization target transform authority changed after planning.");
    }
    assertExactKeyframes(mapping.keyframes.x, plan.timing.derivedAtMs, "x");
    assertExactKeyframes(mapping.keyframes.y, plan.timing.derivedAtMs, "y");
    next.layers[mapping.target.layerIndex] = {
      ...layer,
      keyframes: { ...(layer.keyframes ?? {}), "transform.x": mapping.keyframes.x.map(copyFrame), "transform.y": mapping.keyframes.y.map(copyFrame) },
    };
  }
  return next;
}

function assertExactKeyframes(frames: readonly { readonly atMs: number; readonly value: number; readonly easing: "linear" }[], times: readonly number[], axis: string): void {
  if (frames.length !== times.length || frames.some((frame, index) => frame.atMs !== times[index] || frame.easing !== "linear" || !Number.isFinite(frame.value))) {
    throw new PackageEditTransactionError("copy_mismatch", `Provider-anchor materialization ${axis} keyframes differ from the exact plan.`);
  }
}
function copyFrame(frame: { readonly atMs: number; readonly value: number; readonly easing: "linear" }) { return { atMs: frame.atMs, value: frame.value, easing: "linear" as const }; }

async function assertCompleteMotion(motion: MotionDocument, signal: AbortSignal | undefined): Promise<void> {
  const schema = await loadSchema("motion");
  assertNotAborted(signal);
  const validation = await validateDocument(schema, motion);
  assertNotAborted(signal);
  if (!validation.ok) throw new PackageEditTransactionError("copy_mismatch", "Provider-anchor materialization produced an invalid Motion document.");
  const procedural = motion.relationships ? validateMotionProceduralGraph(motion.relationships, motion) : { ok: true };
  const behaviors = validateMotionBehaviors(motion.behaviors, motion);
  const relations = validateMotionRelations(motion.relations, motion);
  if (!procedural.ok || !behaviors.ok || !relations.ok) {
    throw new PackageEditTransactionError("copy_mismatch", "Provider-anchor materialization produced an invalid Motion authority graph.");
  }
}

async function assertStagedMaterialization(
  root: string,
  sourceIdentity: PackageIdentity,
  staged: StagedResult,
  signal: AbortSignal | undefined,
): Promise<void> {
  const reopened = await loadMotionPackage(root);
  assertNotAborted(signal);
  const identity = await currentPackageIdentity(reopened, signal);
  if (!samePackageIdentity(identity, staged.outputPackage) || identity.motionSha256 !== serializedMotionSha256(staged.persistedMotion)) {
    throw new PackageEditTransactionError("copy_mismatch", "Reopened provider-anchor materialization differs from staged output facts.");
  }
  if (identity.packageId !== sourceIdentity.packageId || identity.manifestSha256 !== sourceIdentity.manifestSha256
    || identity.assetInventorySha256 !== sourceIdentity.assetInventorySha256) {
    throw new PackageEditTransactionError("copy_mismatch", "Reopened provider-anchor materialization changed source package identity fields.");
  }
  await assertCompleteMotion(reopened.motion, signal);
  if (canonicalJsonSha256(compileMotionDocumentCompositing(reopened.motion)) !== canonicalJsonSha256(reopened.motion)) {
    throw new PackageEditTransactionError("copy_mismatch", "Reopened provider-anchor materialization compositing is not idempotent.");
  }
  const receipt = await readReceipt(root, signal);
  if (serializedRenderDeliveryAnchorKeyframeMaterializationReceipt(receipt) !== serializedRenderDeliveryAnchorKeyframeMaterializationReceipt(staged.receipt)) {
    throw new PackageEditTransactionError("copy_mismatch", "Reopened provider-anchor materialization receipt differs from its staged evidence.");
  }
  if (!samePackageIdentity(receipt.output.package, identity) || receipt.output.persistedMotionSha256 !== identity.motionSha256
    || receipt.output.canonicalMotionFingerprint !== canonicalJsonSha256(staged.persistedMotion)
    || !samePackageIdentity(receipt.source.package, sourceIdentity) || !exactDataEqual(receipt.output.renderTruth, renderTruth(reopened.motion))) {
    throw new PackageEditTransactionError("copy_mismatch", "Reopened provider-anchor materialization receipt does not bind exact package facts.");
  }
}

async function writeExclusiveReceipt(root: string, receipt: RenderDeliveryAnchorKeyframeMaterializationReceipt, signal: AbortSignal | undefined): Promise<void> {
  const bytes = Buffer.from(serializedRenderDeliveryAnchorKeyframeMaterializationReceipt(receipt), "utf8");
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw new PackageEditTransactionError("package_limit_exceeded", "Provider-anchor materialization receipt exceeds its bounded size.");
  await writeVerifiedBoundedFile(join(root, RECEIPT_PATH), bytes, {
    label: "Provider-anchor materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root,
  });
  assertNotAborted(signal);
  await readReceipt(root, signal);
}

async function readReceipt(root: string, signal: AbortSignal | undefined): Promise<RenderDeliveryAnchorKeyframeMaterializationReceipt> {
  const file = await readBoundedStableFile(join(root, RECEIPT_PATH), {
    label: "Provider-anchor materialization receipt", maxBytes: MAX_RECEIPT_BYTES, withinRoot: root, requireSingleLink: true,
  });
  assertNotAborted(signal);
  let parsed: unknown;
  try { parsed = JSON.parse(file.bytes.toString("utf8")); }
  catch { throw new PackageEditTransactionError("copy_mismatch", "Provider-anchor materialization receipt is not valid JSON."); }
  assertRenderDeliveryAnchorKeyframeMaterializationReceipt(parsed);
  if (file.bytes.toString("utf8") !== serializedRenderDeliveryAnchorKeyframeMaterializationReceipt(parsed)) {
    throw new PackageEditTransactionError("copy_mismatch", "Provider-anchor materialization receipt is not canonical.");
  }
  return parsed;
}

async function currentPackageIdentity(pkg: MotionPackage, signal: AbortSignal | undefined): Promise<PackageIdentity> {
  const loaded = requiredLoadedPackageDocumentHashes(pkg, "Provider-anchor materialization");
  const manifest = await readBoundedStableFile(join(pkg.root, "manifest.json"), {
    label: "Provider-anchor materialization manifest", maxBytes: 4 * 1024 * 1024, withinRoot: pkg.root, allowRootAlias: true, requireSingleLink: true,
  });
  assertNotAborted(signal);
  const motion = await readBoundedStableFile(resolvePackageAsset(pkg, pkg.manifest.motion), {
    label: "Provider-anchor materialization Motion", maxBytes: 64 * 1024 * 1024, withinRoot: pkg.root, requireSingleLink: true,
  });
  assertNotAborted(signal);
  if (loaded["manifest.json"] !== manifest.sha256 || loaded[pkg.manifest.motion] !== motion.sha256) {
    throw new PackageEditTransactionError("source_changed", "Provider-anchor materialization package bytes changed while reopened.");
  }
  return { packageId: pkg.manifest.id, manifestSha256: manifest.sha256, motionSha256: motion.sha256, assetInventorySha256: canonicalJsonSha256(pkg.manifest.assets) };
}

async function reopenCurrentPackageIdentity(root: string, signal: AbortSignal | undefined): Promise<PackageIdentity> {
  const reopened = await loadMotionPackage(root);
  assertNotAborted(signal);
  return await currentPackageIdentity(reopened, signal);
}

function assertExactBase(request: MaterializationRequest, plan: RenderDeliveryAnchorKeyframeIntentPlan, actual: PackageIdentity): void {
  const { fingerprint, ...planPayload } = plan;
  if (request.expected.packageId !== actual.packageId || request.expected.manifestSha256 !== actual.manifestSha256 || request.expected.motionSha256 !== actual.motionSha256
    || !samePackageIdentity(plan.inspection.package, actual) || plan.inspection.fingerprint !== request.request.inspectionFingerprint
    || plan.inspection.receiptFingerprint !== request.request.receiptFingerprint || plan.request.fingerprint !== canonicalJsonSha256(request.request)
    || !exactDataEqual(plan.request.mappings, request.request.mappings) || fingerprint !== canonicalJsonSha256(planPayload)) {
    throw new PackageEditTransactionError("source_changed", "Provider-anchor materialization request, plan, and current package bases do not exactly bind.");
  }
}

function renderTruth(motion: MotionDocument) {
  return { lanes: [...renderLanesFor(motion)], unrenderable: unrenderablePackageRefusal(motion) };
}
function samePackageIdentity(left: PackageIdentity, right: PackageIdentity): boolean {
  return left.packageId === right.packageId && left.manifestSha256 === right.manifestSha256 && left.motionSha256 === right.motionSha256 && left.assetInventorySha256 === right.assetInventorySha256;
}
function exactDataEqual(left: unknown, right: unknown): boolean { return canonicalJsonSha256(left) === canonicalJsonSha256(right); }
function serializedMotionSha256(motion: MotionDocument): string { return hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8")); }

async function withMaterializationWorkspaceAuthority<T>(host: RenderDeliveryAnchorKeyframeMaterializationHost, operation: () => Promise<T>): Promise<T> {
  const workspace = resolve(host.packageWorkspaceRoot);
  if (!strictDescendant(workspace, resolve(host.outputPackageRoot))) {
    throw new PackageEditTransactionError("unsafe_output", "Provider-anchor materialization output must be a strict descendant of the host-selected workspace.");
  }
  return await withRenderDeliveryPackageWorkspaceAuthority(host, operation);
}
function strictDescendant(root: string, path: string): boolean { const suffix = relative(root, path); return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); }
function assertNotAborted(signal: AbortSignal | undefined): void { if (signal?.aborted) throw new PackageEditTransactionError("cancelled", "Provider-anchor materialization was cancelled before output commit."); }
function dataObject(value: unknown, label: string): object { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`); return value; }
function dataDescriptor(value: object, key: string, label: string): PropertyDescriptor & { value: unknown } { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`); return descriptor as PropertyDescriptor & { value: unknown }; }
function exactKeys(value: object, required: readonly string[], label: string): void { const keys = Reflect.ownKeys(value); if (keys.length !== required.length || keys.some((key) => typeof key !== "string" || !required.includes(key)) || required.some((key) => !keys.includes(key))) throw new Error(`${label} has an unsupported field.`); }
function hash(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
