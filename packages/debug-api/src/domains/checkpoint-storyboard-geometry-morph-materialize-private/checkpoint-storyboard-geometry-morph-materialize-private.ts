/** Private C6B6b exact-base COW adapter. It registers no Debug command or public surface. */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  canonicalJsonSha256, compareCodeUnits, compileMotionDocumentCompositing, hashBuffer, loadSchema, validateDocument,
  validateMotionProceduralGraph, validateMotionRelationActions, validateMotionRelations, type MotionDocument, type MotionShapeGeometryKeyframes,
} from "@shellx-motion/core";
import {
  admitCheckpointStoryboardGeometryMorphRecordProfile,
  compileCheckpointStoryboardGeometryMorphProfilePlan,
  readCheckpointStoryboardGeometryMorphProfileRequest,
} from "@shellx-motion/core/internal/checkpoint-storyboard-geometry-morph-profile";
import { validateMotionBehaviors } from "@shellx-motion/core/internal/motion-behavior-validation";
import { commitPackageEdit, PackageEditTransactionError, writeJson } from "../package-edit-transaction.js";
import { samePackageEditTreeSnapshot, snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { canonicalC6B6bHost, withC6B6bWorkspaceAuthority } from "./checkpoint-storyboard-geometry-morph-materialize-authority-private.js";
import {
  c6B6bPreservedLeaves, c6B6bSame, closedC6B6bInventory, observeC6B6bPackage,
  type CheckpointStoryboardGeometryMorphMaterializationHost,
} from "./checkpoint-storyboard-geometry-morph-materialize-facts-private.js";
import { reopenCheckpointStoryboardGeometryMorphMaterializationOutput } from "./checkpoint-storyboard-geometry-morph-materialize-output-private.js";
import {
  bindC6B6bExactBase, C6B6B_RECEIPT_PATH, createC6B6bReceipt, readC6B6bExactBase, readC6B6bReceipt,
  writeC6B6bReceipt, type C6B6bExactBase, type C6B6bPlanEvidence, type CheckpointStoryboardGeometryMorphMaterializationReceipt,
} from "./checkpoint-storyboard-geometry-morph-materialize-receipt-private.js";

const REQUEST_SCHEMA = "shellx-motion/private-checkpoint-storyboard-geometry-morph-materialization-request@1" as const;
const approvalBrand: unique symbol = Symbol("checkpoint-storyboard-geometry-morph-materialization-approval");
const approvals = new WeakMap<CheckpointStoryboardGeometryMorphMaterializationApproval, ApprovedFacts>();

export type { CheckpointStoryboardGeometryMorphMaterializationHost } from "./checkpoint-storyboard-geometry-morph-materialize-facts-private.js";
export type { CheckpointStoryboardGeometryMorphMaterializationReceipt } from "./checkpoint-storyboard-geometry-morph-materialize-receipt-private.js";
export { reopenCheckpointStoryboardGeometryMorphMaterializationOutput } from "./checkpoint-storyboard-geometry-morph-materialize-output-private.js";
export type { CheckpointStoryboardGeometryMorphMaterializationInstalledOutput, CheckpointStoryboardGeometryMorphMaterializationOutputHost } from "./checkpoint-storyboard-geometry-morph-materialize-output-private.js";
export interface CheckpointStoryboardGeometryMorphMaterializationApproval { readonly [approvalBrand]: "c6b6b-approved"; }
export interface CheckpointStoryboardGeometryMorphMaterializationPreparation { readonly approval: CheckpointStoryboardGeometryMorphMaterializationApproval; readonly expected: C6B6bExactBase; readonly plan: C6B6bPlanEvidence; }
export interface CheckpointStoryboardGeometryMorphMaterializationResult { readonly packageRoot: string; readonly receipt: CheckpointStoryboardGeometryMorphMaterializationReceipt; readonly workspaceCleanup: "not-attested"; }

type GeometryPlan = C6B6bPlanEvidence;
interface ApprovedFacts { readonly storyboard: unknown; readonly plan: GeometryPlan; readonly expected: C6B6bExactBase; }
interface Staged { readonly source: C6B6bExactBase; readonly output: C6B6bExactBase; readonly receipt: CheckpointStoryboardGeometryMorphMaterializationReceipt; readonly snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>; }

/** Reopens the actual package, seals an exact B6a plan, and mints non-serializable host approval. */
export async function prepareCheckpointStoryboardGeometryMorphMaterialization(host: CheckpointStoryboardGeometryMorphMaterializationHost, storyboard: unknown): Promise<CheckpointStoryboardGeometryMorphMaterializationPreparation> {
  return await withC6B6bWorkspaceAuthority(host, async (roots) => {
    const canonical = canonicalC6B6bHost(host, roots), source = await observeC6B6bPackage(roots.sourceRoot, canonical);
    await assertSourceMotion(source.pkg.motion); assertReceiptAbsent(source.snapshot);
    const admitted = admitCheckpointStoryboardGeometryMorphRecordProfile(storyboard);
    const accepted = readCheckpointStoryboardGeometryMorphProfileRequest(requestFor(source, admitted));
    const plan = compileCheckpointStoryboardGeometryMorphProfilePlan(requestFor(source, accepted.storyboard));
    const expected = exactBase(source, plan); assertPlanBase(plan, expected);
    const approval = Object.freeze({ [approvalBrand]: "c6b6b-approved" as const });
    approvals.set(approval, Object.freeze({ storyboard: accepted.storyboard, plan, expected }));
    return Object.freeze({ approval, expected, plan });
  });
}

/** COW accepts only a host-minted approval and exact descriptor echo; all inputs are rederived. */
export async function materializeCheckpointStoryboardGeometryMorph(host: CheckpointStoryboardGeometryMorphMaterializationHost, approval: CheckpointStoryboardGeometryMorphMaterializationApproval, value: unknown): Promise<CheckpointStoryboardGeometryMorphMaterializationResult> {
  const expected = readRequest(value), approved = readApproval(approval);
  return await withC6B6bWorkspaceAuthority(host, async (roots) => {
    const canonical = canonicalC6B6bHost(host, roots), source = await observeC6B6bPackage(roots.sourceRoot, canonical);
    const plan = await rederive(approved, source), exact = exactBase(source, plan);
    assertExact(expected, exact); assertExact(approved.expected, exact); assertReceiptAbsent(source.snapshot);
    const transaction = await commitPackageEdit<Staged, void>({
      sourceRoot: roots.sourceRoot, outputRoot: roots.outputRoot, requireAbsentOutput: true,
      closedInventory: "finalize-after-edit-with-empty-directories",
      edit: async (stagedRoot) => await editStaged(stagedRoot, canonical, source, approved, plan, exact),
      validate: async (stagedRoot, staged) => await assertStaged(stagedRoot, canonical, staged),
      beforeCommit: async () => {
        const current = await observeC6B6bPackage(roots.sourceRoot, canonical);
        assertReceiptAbsent(current.snapshot); assertExact(exact, exactBase(current, await rederive(approved, current)));
      },
      // PackageEdit classifies a post-rename observation failure as retained uncertainty, without rollback.
      afterCommit: async (outputRoot, staged) => await assertStaged(outputRoot, canonical, staged),
    });
    return Object.freeze({ packageRoot: transaction.outputRoot, receipt: transaction.editResult.receipt, workspaceCleanup: "not-attested" as const });
  });
}

async function editStaged(root: string, host: CheckpointStoryboardGeometryMorphMaterializationHost, source: Awaited<ReturnType<typeof observeC6B6bPackage>>, approved: ApprovedFacts, plan: GeometryPlan, exact: C6B6bExactBase): Promise<Staged> {
  const staged = await observeC6B6bPackage(root, host), stagedPlan = await rederive(approved, staged);
  assertReceiptAbsent(staged.snapshot); assertExact(exact, exactBase(staged, stagedPlan));
  if (!c6B6bSame(plan, stagedPlan)) throw new PackageEditTransactionError("source_changed", "C6B6b staged plan changed after source planning.");
  const persisted = await preparePersistedMotion(staged.pkg.motion, stagedPlan);
  await writeJson(join(root, staged.pkg.manifest.motion), persisted);
  const edited = await observeC6B6bPackage(root, host), output = outputExactBase(edited, plan, exact);
  if (edited.base.packageId !== exact.packageId || edited.base.manifestRawSha256 !== exact.manifestRawSha256 || edited.base.motionRawSha256 !== serializedMotionSha256(persisted) || edited.base.motionCanonicalSha256 !== output.outputCanonicalMotionSha256) throw new PackageEditTransactionError("copy_mismatch", "C6B6b staged package identity differs from the validated geometry write.");
  assertGeometryOnly(staged.pkg.motion, edited.pkg.motion, plan); await assertCompleteMotion(edited.pkg.motion);
  await mkdir(join(root, "receipts"), { recursive: true, mode: 0o700 });
  const preReceiptInventory = await closedC6B6bInventory(root, host);
  const receipt = createC6B6bReceipt(plan, approved.storyboard, exact, output, edited.pkg.manifest.motion, preReceiptInventory, c6B6bPreservedLeaves(source.snapshot, edited.pkg.manifest.motion), "not-attested");
  await writeC6B6bReceipt(root, receipt);
  const snapshot = await snapshotPackageEditTree(root); assertPreservedLeaves(source.snapshot, snapshot, edited.pkg.manifest.motion);
  return { source: exact, output, receipt, snapshot };
}

async function rederive(approved: ApprovedFacts, facts: Awaited<ReturnType<typeof observeC6B6bPackage>>): Promise<GeometryPlan> {
  try {
    await assertSourceMotion(facts.pkg.motion); assertReceiptAbsent(facts.snapshot);
    const plan = compileCheckpointStoryboardGeometryMorphProfilePlan(requestFor(facts, approved.storyboard));
    if (!c6B6bSame(plan, approved.plan)) throw new Error("plan differs from host-minted approval");
    return plan;
  } catch (error) { throw new PackageEditTransactionError("source_changed", `C6B6b source no longer rederives the approved plan: ${message(error)}`); }
}

function requestFor(facts: Awaited<ReturnType<typeof observeC6B6bPackage>>, storyboard: unknown) {
  const catalog = (storyboard as { readonly objectCatalog?: unknown }).objectCatalog;
  if (!Array.isArray(catalog) || catalog.length !== 1 || !catalog[0] || typeof catalog[0] !== "object" || typeof (catalog[0] as { objectId?: unknown }).objectId !== "string") throw new PackageEditTransactionError("source_changed", "C6B6b approved storyboard has no exact geometry object binding.");
  const objectId = (catalog[0] as { readonly objectId: string }).objectId;
  return { schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-profile-request@1", storyboard, base: { packageId: facts.pkg.manifest.id, manifest: facts.pkg.manifest, motion: facts.pkg.motion, persistedMotionSha256: facts.base.motionRawSha256 }, objectLayerBindings: [{ objectId, layerId: objectId }] };
}
function exactBase(facts: Awaited<ReturnType<typeof observeC6B6bPackage>>, plan: GeometryPlan): C6B6bExactBase { return bindC6B6bExactBase(facts.base, plan, canonicalJsonSha256(projectedMotion(facts.pkg.motion, plan))); }
function outputExactBase(facts: Awaited<ReturnType<typeof observeC6B6bPackage>>, plan: GeometryPlan, source: C6B6bExactBase): C6B6bExactBase { return bindC6B6bExactBase(facts.base, plan, source.outputCanonicalMotionSha256); }
function projectedMotion(source: MotionDocument, plan: GeometryPlan): MotionDocument { return applyGeometry(source, plan); }
function assertPlanBase(plan: GeometryPlan, base: C6B6bExactBase): void {
  if (plan.base.package.id !== base.packageId || plan.base.manifest.sha256 !== base.manifestCanonicalSha256 || plan.base.canonicalMotion.sha256 !== base.motionCanonicalSha256 || plan.base.persistedMotion.sha256 !== base.motionRawSha256 || plan.fingerprint !== base.planFingerprint || plan.lowererProfile.fingerprint !== base.profileFingerprint || plan.storyboard.id !== base.storyboardId || plan.storyboard.sha256 !== base.storyboardSha256 || plan.storyboard.revision !== base.storyboardRevision || base.sourceLayerId !== plan.objectLayerBinding.layerId || base.sourceLayerIndex !== plan.objectLayerBinding.layerIndex || base.sourceGeometrySha256 !== plan.projection.staticGeometry.sha256 || base.sourceGeometryKeyframes !== "absent" || base.materializedGeometryKeyframesSha256 !== canonicalJsonSha256(plan.projection.geometryKeyframes)) throw new PackageEditTransactionError("source_changed", "C6B6b exact base or geometry plan identity differs from its projection.");
}
function assertExact(expected: C6B6bExactBase, observed: C6B6bExactBase): void { if (!c6B6bSame(expected, observed)) throw new PackageEditTransactionError("source_changed", "C6B6b exact base, raw bytes, canonical identities, inventory, or approved geometry projection changed."); }

async function preparePersistedMotion(source: MotionDocument, plan: GeometryPlan): Promise<MotionDocument> {
  await assertSourceMotion(source);
  const next = applyGeometry(source, plan); assertGeometryOnly(source, next, plan); await assertCompleteMotion(next);
  const persisted = compileMotionDocumentCompositing(next);
  assertGeometryOnly(source, persisted, plan);
  if (canonicalJsonSha256(compileMotionDocumentCompositing(persisted)) !== canonicalJsonSha256(persisted)) throw new PackageEditTransactionError("copy_mismatch", "C6B6b compositing compilation is not idempotent.");
  await assertCompleteMotion(persisted); return persisted;
}
function applyGeometry(source: MotionDocument, plan: GeometryPlan): MotionDocument {
  const next = structuredClone(source) as MotionDocument, layer = next.layers[plan.objectLayerBinding.layerIndex] as (MotionDocument["layers"][number] & { geometryKeyframes?: unknown }) | undefined;
  if (!layer || layer.id !== plan.objectLayerBinding.layerId || layer.id !== plan.objectLayerBinding.objectId || Object.hasOwn(layer, "geometryKeyframes")) throw new PackageEditTransactionError("source_changed", "C6B6b exact geometry layer binding or absent authority changed after planning.");
  layer.geometryKeyframes = structuredClone(plan.projection.geometryKeyframes) as unknown as MotionShapeGeometryKeyframes; return next;
}
function assertGeometryOnly(source: MotionDocument, output: MotionDocument, plan: GeometryPlan): void {
  const index = plan.objectLayerBinding.layerIndex, sourceLayer = source.layers[index] as unknown as Record<string, unknown> | undefined, outputLayer = output.layers[index] as unknown as Record<string, unknown> | undefined;
  const { layers: sourceLayers, ...sourceRest } = source, { layers: outputLayers, ...outputRest } = output;
  if (!sourceLayer || !outputLayer || sourceLayers.length !== outputLayers.length || !c6B6bSame(sourceRest, outputRest) || sourceLayers.some((layer, at) => at !== index && !c6B6bSame(layer, outputLayers[at])) || sourceLayers.some((layer, at) => layer.id !== outputLayers[at]?.id || layer.startMs !== outputLayers[at]?.startMs || layer.durationMs !== outputLayers[at]?.durationMs)) throw new PackageEditTransactionError("copy_mismatch", "C6B6b materialization changed Motion outside the exact geometry-keyframe field.");
  const sourceWithoutField = { ...sourceLayer }, { geometryKeyframes: outputKeyframes, ...outputWithoutField } = outputLayer;
  delete sourceWithoutField.geometryKeyframes;
  if (Object.hasOwn(sourceLayer, "geometryKeyframes") || !Object.hasOwn(outputLayer, "geometryKeyframes") || !c6B6bSame(sourceWithoutField, outputWithoutField) || canonicalJsonSha256(sourceLayer.geometry) !== plan.projection.staticGeometry.sha256 || canonicalJsonSha256(outputLayer.geometry) !== plan.projection.staticGeometry.sha256 || !c6B6bSame(outputKeyframes, plan.projection.geometryKeyframes)) throw new PackageEditTransactionError("copy_mismatch", "C6B6b output does not retain static geometry and the exact two-snapshot plan sequence.");
}
async function assertCompleteMotion(motion: MotionDocument): Promise<void> {
  const validation = await validateDocument(await loadSchema("motion"), motion), procedural = motion.relationships ? validateMotionProceduralGraph(motion.relationships, motion) : { ok: true }, behaviors = validateMotionBehaviors(motion.behaviors, motion), relations = validateMotionRelations(motion.relations, motion), actions = Object.hasOwn(motion, "relationActions") ? validateMotionRelationActions(motion.relationActions) : { ok: true };
  if (!validation.ok || !procedural.ok || !behaviors.ok || !relations.ok || !actions.ok) throw new PackageEditTransactionError("copy_mismatch", "C6B6b materialization produced an invalid Motion authority graph.");
}
async function assertSourceMotion(motion: MotionDocument): Promise<void> { await assertCompleteMotion(motion); if (canonicalJsonSha256(compileMotionDocumentCompositing(motion)) !== canonicalJsonSha256(motion)) throw new PackageEditTransactionError("source_changed", "C6B6b source compositing compilation is not idempotent."); }

async function assertStaged(root: string, host: CheckpointStoryboardGeometryMorphMaterializationHost, staged: Staged): Promise<void> {
  const reopened = await observeC6B6bPackage(root, host);
  if (reopened.base.packageId !== staged.output.packageId || reopened.base.manifestRawSha256 !== staged.output.manifestRawSha256 || reopened.base.motionRawSha256 !== staged.output.motionRawSha256 || reopened.base.motionCanonicalSha256 !== staged.output.motionCanonicalSha256 || !samePackageEditTreeSnapshot(reopened.snapshot, staged.snapshot)) throw new PackageEditTransactionError("copy_mismatch", "C6B6b reopened output differs from its staged exact inventory.");
  await assertCompleteMotion(reopened.pkg.motion); if (canonicalJsonSha256(compileMotionDocumentCompositing(reopened.pkg.motion)) !== canonicalJsonSha256(reopened.pkg.motion)) throw new PackageEditTransactionError("copy_mismatch", "C6B6b reopened compositing compilation is not idempotent.");
  if (!c6B6bSame(await readC6B6bReceipt(root), staged.receipt)) throw new PackageEditTransactionError("copy_mismatch", "C6B6b receipt differs after reopen.");
  const output = await reopenCheckpointStoryboardGeometryMorphMaterializationOutput({ outputPackageRoot: root, packageWorkspaceRoot: host.packageWorkspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority });
  if ((output as { readonly plan?: { readonly fingerprint?: unknown }; readonly profile?: { readonly fingerprint?: unknown } }).plan?.fingerprint !== staged.output.planFingerprint || (output as { readonly profile?: { readonly fingerprint?: unknown } }).profile?.fingerprint !== staged.output.profileFingerprint) throw new PackageEditTransactionError("copy_mismatch", "C6B6b output-only reopen does not reprove the accepted geometry plan.");
}
function assertReceiptAbsent(snapshot: Awaited<ReturnType<typeof snapshotPackageEditTree>>): void { if (snapshot.entries.has(C6B6B_RECEIPT_PATH)) throw new PackageEditTransactionError("source_changed", "C6B6b fixed materialization receipt already exists."); }
function assertPreservedLeaves(source: Awaited<ReturnType<typeof snapshotPackageEditTree>>, output: Awaited<ReturnType<typeof snapshotPackageEditTree>>, motionPath: string): void { const files = (snapshot: typeof source) => [...snapshot.entries].filter(([path, value]) => value.startsWith("file:") && path !== motionPath && path !== C6B6B_RECEIPT_PATH).sort(([left], [right]) => compareCodeUnits(left, right)); if (!c6B6bSame(files(source), files(output))) throw new PackageEditTransactionError("copy_mismatch", "C6B6b output changed a preserved package leaf."); }
function readApproval(value: unknown): ApprovedFacts { if (!value || typeof value !== "object") throw new Error("C6B6b materialization approval is invalid."); const facts = approvals.get(value as CheckpointStoryboardGeometryMorphMaterializationApproval); if (!facts) throw new Error("C6B6b materialization approval is not host-minted."); return facts; }
function readRequest(value: unknown): C6B6bExactBase {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("C6B6b materialization request is invalid.");
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.length !== 2 || !keys.includes("schema") || !keys.includes("expected") || Object.getOwnPropertySymbols(value).length !== 0) throw new Error("C6B6b materialization request is invalid.");
  const schema = descriptors.schema, expected = descriptors.expected;
  if (!schema || !expected || !schema.enumerable || !expected.enumerable || !("value" in schema) || !("value" in expected) || schema.value !== REQUEST_SCHEMA) throw new Error("C6B6b materialization request is invalid.");
  return readC6B6bExactBase(expected.value);
}
function serializedMotionSha256(motion: MotionDocument): string { return hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8")); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
