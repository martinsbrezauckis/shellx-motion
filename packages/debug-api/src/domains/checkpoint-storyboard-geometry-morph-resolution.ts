/** C6C B6a private resolver. Debug/MCP owns host authority and the signed durable geometry-morph link. */
import { lstat } from "node:fs/promises";
import { canonicalJson, canonicalJsonSha256, isPublicationCommitUncertain } from "@shellx-motion/core";
import { materializeCheckpointStoryboardGeometryMorph, prepareCheckpointStoryboardGeometryMorphMaterialization, reopenCheckpointStoryboardGeometryMorphMaterializationOutput } from "./checkpoint-storyboard-geometry-morph-materialize-private/checkpoint-storyboard-geometry-morph-materialize-private.js";
import { readC6B6bReceipt, type C6B6bExactBase } from "./checkpoint-storyboard-geometry-morph-materialize-private/checkpoint-storyboard-geometry-morph-materialize-receipt-private.js";
import { assertCheckpointStoryboardGeometryMorphResolutionAuthorityStore, checkpointStoryboardGeometryMorphResolutionOutputHandle, checkedCheckpointStoryboardGeometryMorphResolutionAuthority, withCheckpointStoryboardGeometryMorphResolutionAuthority, withCheckpointStoryboardGeometryMorphResolutionOutputAuthority, type CheckpointStoryboardGeometryMorphResolutionAuthority } from "./checkpoint-storyboard-geometry-morph-resolution-authority.js";
import { createGeometryMorphAbandon, createGeometryMorphBinding, createGeometryMorphCowStart, createGeometryMorphDetach, createGeometryMorphIntent, publishGeometryMorphAbandon, publishGeometryMorphBinding, publishGeometryMorphCowStart, publishGeometryMorphDetach, publishGeometryMorphIntent, publishGeometryMorphStateHead, readGeometryMorphBinding, readGeometryMorphCowStart, readGeometryMorphIntent, readGeometryMorphResolutionState, geometryMorphStateHead, type GeometryMorphBinding, type GeometryMorphIntent, type GeometryMorphPlanIdentity } from "./checkpoint-storyboard-geometry-morph-resolution-journal.js";
import { assertNoLegacyMaterializationEvidence } from "./checkpoint-storyboard-materialization-bindings.js";
import { assertNoBehaviorResolutionEvidence } from "./checkpoint-storyboard-behavior-resolution-journal.js";
import { assertNoRelationResolutionEvidence } from "./checkpoint-storyboard-relation-resolution-journal.js";
import { assertNoRelationActionResolutionEvidence } from "./checkpoint-storyboard-relation-action-resolution-journal.js";
import { assertNoLifecycleResolutionEvidence } from "./checkpoint-storyboard-lifecycle-resolution-journal.js";
import { assertNoRetainedTraceResolutionEvidence } from "./checkpoint-storyboard-retained-trace-resolution-journal.js";
import { checkedAuthority, withLineageLock } from "./checkpoint-storyboard-record-store-authority.js";
import { readImmutableRecordRoot, readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import { CheckpointStoryboardRecordStoreError, sameIdentity, storeError, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

type FaultPhase = "while-lineage-lock-held" | "after-intent-before-state-head" | "after-intent" | "after-cow-start-before-state-head" | "after-cow-start" | "before-c6b6b" | "after-c6b6b-commit" | "after-binding" | "after-bound-state-head-rename" | "after-detach" | "after-detached-state-head-rename" | "after-abandon";
type FaultHooks = Partial<Record<FaultPhase, () => void | Promise<void>>>;
const hooks = new WeakMap<CheckpointStoryboardGeometryMorphResolutionAuthority, FaultHooks>();

/** Test-only seam; it is intentionally absent from command registry and public exports. */
export function setCheckpointStoryboardGeometryMorphResolutionFaultHooksForTest(authority: CheckpointStoryboardGeometryMorphResolutionAuthority, value: FaultHooks | undefined): void { checkedCheckpointStoryboardGeometryMorphResolutionAuthority(authority); if (value) hooks.set(authority, Object.freeze({ ...value })); else hooks.delete(authority); }
async function fault(authority: CheckpointStoryboardGeometryMorphResolutionAuthority, phase: FaultPhase): Promise<void> { await hooks.get(authority)?.[phase]?.(); }

export interface CheckpointStoryboardGeometryMorphResolutionResult { readonly identity: CheckpointStoryboardRecordIdentity; readonly binding: { readonly state: "bound" | "detached"; readonly active: 0 | 1; readonly bindingId: string; readonly outputHandle: string; readonly receiptFingerprint: string }; readonly renderer: { readonly invoked: false; readonly pixels: false }; readonly replayed: boolean; }

export async function resolveCheckpointStoryboardGeometryMorphStoredRecord(authority: CheckpointStoryboardGeometryMorphResolutionAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardGeometryMorphResolutionResult> {
  try { return await withCheckpointStoryboardGeometryMorphResolutionOutputAuthority(authority, async (host) => {
    const store = checkedAuthority(host.store), root = await readImmutableRecordRoot(store, identity);
    return await withLineageLock(store, root.id, async () => {
      const record = await readStoredRecordUnlocked(store, identity); assertB6Record(record); assertCheckpointStoryboardGeometryMorphResolutionAuthorityStore(authority, host.store); await assertForeignPartitionEvidenceAbsent(store, identity);
      const outputHandle = checkpointStoryboardGeometryMorphResolutionOutputHandle(authority, identity); const state = await readGeometryMorphResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true }); await fault(authority, "while-lineage-lock-held");
      if (state.state === "abandoned") throw storeError("materialization_binding_conflict", "Checkpoint storyboard geometry-morph resolution was terminally abandoned after a proved no-install outcome.");
      if (state.state === "detached") throw storeError("materialization_detached", "Checkpoint storyboard geometry-morph resolution has terminally detached its link and cannot resolve again.");
      if (state.state === "bound") return await replayBound(store, host, identity, root, state.bindingId!, outputHandle);
      const prior = await readGeometryMorphIntent(store, identity);
      if (prior) {
        const recovered = await recognizeInstalledOutput(host, record.identity, prior.expectedBase, prior.plan);
        if (recovered) return await publishAndReopen(store, host, authority, identity, root, prior, recovered, outputHandle, true);
        if (await outputExists(host.outputPackageRoot) || await readGeometryMorphCowStart(store, identity)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard geometry-morph resolution retains an occupied or COW-uncertain output for exact recovery and will not repeat COW.");
      } else if (await outputExists(host.outputPackageRoot)) {
        throw storeError("materialization_binding_uncertain", "Checkpoint storyboard geometry-morph output is occupied without a durable intent and was retained without replacement.");
      }
      return await withCheckpointStoryboardGeometryMorphResolutionAuthority(authority, async (sourceHost) => {
        const c6bHost = { sourcePackageRoot: sourceHost.sourcePackageRoot, outputPackageRoot: sourceHost.outputPackageRoot, packageWorkspaceRoot: sourceHost.packageWorkspaceRoot, packageWorkspaceAuthority: sourceHost.packageWorkspaceAuthority };
        // B6b canonicalizes source and absent output, including intermediate aliases, before
        // it mints approval or B6a publishes a durable output intent.
        const prepared = await prepareCheckpointStoryboardGeometryMorphMaterialization(c6bHost, record.storyboard), plan = planIdentity(prepared), intent = createGeometryMorphIntent({ identity, root, plan, expectedBase: prepared.expected, outputHandle });
        if (prior && canonicalJson(prior) !== canonicalJson(intent)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard geometry-morph intent conflicts with exact host-selected C6B6 facts.");
        if (!prior) { await publishGeometryMorphIntent(store, intent); await fault(authority, "after-intent-before-state-head"); await publishGeometryMorphStateHead(store, geometryMorphStateHead(identity, root, "preparing", 0, { intent: ref(intent) })); await fault(authority, "after-intent"); }
        if (await outputExists(sourceHost.outputPackageRoot)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard geometry-morph output appeared after intent publication and was retained without replacement.");
        const start = createGeometryMorphCowStart({ identity, root, intent: ref(intent) }); await publishGeometryMorphCowStart(store, start); await fault(authority, "after-cow-start-before-state-head"); await publishGeometryMorphStateHead(store, geometryMorphStateHead(identity, root, "preparing", 0, { intent: ref(intent), cowStart: ref(start) })); await fault(authority, "after-cow-start");
        try { await fault(authority, "before-c6b6b"); await materializeCheckpointStoryboardGeometryMorph(c6bHost, prepared.approval, { schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-materialization-request@1", expected: prepared.expected }); }
        catch (error) {
          const recovered = await recognizeInstalledOutput(sourceHost, record.identity, prepared.expected, plan);
          if (recovered) return await publishAndReopen(store, sourceHost, authority, identity, root, intent, recovered, outputHandle, true);
          if (isPublicationCommitUncertain(error) || await outputExists(sourceHost.outputPackageRoot)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard geometry-morph publication may have committed; output was retained for exact recovery.");
          const abandon = createGeometryMorphAbandon({ identity, root, intent: ref(intent), reason: "proven-no-install" }); await publishGeometryMorphAbandon(store, abandon); await fault(authority, "after-abandon"); await publishGeometryMorphStateHead(store, geometryMorphStateHead(identity, root, "abandoned", 0, { intent: ref(intent), cowStart: ref(start), abandon: ref(abandon) }));
          throw storeError("materialization_binding_conflict", "Checkpoint storyboard geometry-morph COW refused before a recognized output was installed.");
        }
        await fault(authority, "after-c6b6b-commit");
        const installed = await recognizeInstalledOutput(sourceHost, record.identity, prepared.expected, plan);
        if (!installed) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard geometry-morph COW completed without an exact output reopen; output was retained.");
        return await publishAndReopen(store, sourceHost, authority, identity, root, intent, installed, outputHandle, false);
      });
    });
  }); } catch (error) { throw sanitized(error); }
}

export async function detachCheckpointStoryboardGeometryMorphStoredRecord(authority: CheckpointStoryboardGeometryMorphResolutionAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardGeometryMorphResolutionResult> {
  try { return await withCheckpointStoryboardGeometryMorphResolutionOutputAuthority(authority, async (host) => {
    const store = checkedAuthority(host.store), root = await readImmutableRecordRoot(store, identity);
    return await withLineageLock(store, root.id, async () => {
      const record = await readStoredRecordUnlocked(store, identity); assertB6Record(record); assertCheckpointStoryboardGeometryMorphResolutionAuthorityStore(authority, host.store); await assertForeignPartitionEvidenceAbsent(store, identity);
      const outputHandle = checkpointStoryboardGeometryMorphResolutionOutputHandle(authority, identity); let state = await readGeometryMorphResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true });
      if (state.state === "unbound" || state.state === "abandoned") throw storeError("materialization_not_bound", "Checkpoint storyboard geometry-morph record has no bound output to detach.");
      if (state.state === "preparing") {
        const intent = await readGeometryMorphIntent(store, identity), start = await readGeometryMorphCowStart(store, identity);
        if (intent) {
          const recovered = await recognizeInstalledOutput(host, record.identity, intent.expectedBase, intent.plan);
          if (recovered) { await publishAndReopen(store, host, authority, identity, root, intent, recovered, outputHandle, true); state = await readGeometryMorphResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true }); }
        }
        if (state.state === "preparing" && intent && !start && !(await outputExists(host.outputPackageRoot))) {
          const abandon = createGeometryMorphAbandon({ identity, root, intent: ref(intent), reason: "no-cow-start" }); await publishGeometryMorphAbandon(store, abandon); await publishGeometryMorphStateHead(store, geometryMorphStateHead(identity, root, "abandoned", 0, { intent: ref(intent), abandon: ref(abandon) }));
          throw storeError("materialization_not_bound", "Checkpoint storyboard geometry-morph intent was abandoned before COW start; no output was deleted.");
        }
        if (state.state === "preparing") throw storeError("materialization_binding_uncertain", "Checkpoint storyboard geometry-morph resolution is COW-uncertain; output was retained and cannot be detached yet.");
      }
      const binding = await readGeometryMorphBinding(store, identity);
      if (!binding) throw storeError("store_integrity_failed", "Checkpoint storyboard geometry-morph state lost immutable binding.");
      if (state.state === "detached") { await verifyBinding(host, binding, identity, outputHandle); return result(identity, binding, "detached", true); }
      await verifyBinding(host, binding, identity, outputHandle);
      // Detach retires only the durable link: it never deletes or rewrites the output package.
      const detach = createGeometryMorphDetach({ identity, root, binding: ref(binding) }); await publishGeometryMorphDetach(store, detach); await fault(authority, "after-detach");
      const intent = await readGeometryMorphIntent(store, identity), start = await readGeometryMorphCowStart(store, identity);
      if (!intent || !start) throw storeError("store_integrity_failed", "Checkpoint storyboard geometry-morph detach lost required intent or COW start.");
      await publishGeometryMorphStateHead(store, geometryMorphStateHead(identity, root, "detached", 0, { intent: ref(intent), cowStart: ref(start), binding: ref(binding), detach: ref(detach) }), async () => await fault(authority, "after-detached-state-head-rename"));
      const final = await readGeometryMorphResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true });
      if (final.state !== "detached" || final.bindingId !== binding.id) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard geometry-morph detach publication could not be reopened exactly.");
      return result(identity, binding, "detached", false);
    });
  }); } catch (error) { throw sanitized(error); }
}

function assertB6Record(record: Awaited<ReturnType<typeof readStoredRecordUnlocked>>): void {
  if (record.archive.terminal) throw storeError("lineage_archived", "Checkpoint storyboard lineage is terminally archived.");
  if (record.target.state === "tombstoned") throw storeError("record_tombstoned", "A tombstoned checkpoint storyboard record cannot resolve geometry morphs.");
  if (record.admission.profile !== "c6b6-geometry-morph@1") throw storeError("materialization_profile_refused", "C6C B6 geometry-morph resolution accepts only a sealed C6B6 geometry-morph profile record.");
}

async function assertForeignPartitionEvidenceAbsent(store: ReturnType<typeof checkedAuthority>, identity: CheckpointStoryboardRecordIdentity): Promise<void> {
  await assertNoLegacyMaterializationEvidence(store, identity);
  await assertNoBehaviorResolutionEvidence(store, identity);
  await assertNoRelationResolutionEvidence(store, identity);
  await assertNoRelationActionResolutionEvidence(store, identity);
  await assertNoLifecycleResolutionEvidence(store, identity);
  await assertNoRetainedTraceResolutionEvidence(store, identity);
}

function planIdentity(prepared: Awaited<ReturnType<typeof prepareCheckpointStoryboardGeometryMorphMaterialization>>): GeometryMorphPlanIdentity {
  const { expected, plan } = prepared;
  return Object.freeze({
    planFingerprint: expected.planFingerprint,
    profileFingerprint: expected.profileFingerprint,
    storyboardId: expected.storyboardId,
    storyboardSha256: expected.storyboardSha256,
    storyboardRevision: expected.storyboardRevision,
    sourceLayerId: expected.sourceLayerId,
    sourceLayerIndex: plan.objectLayerBinding.layerIndex,
    staticGeometrySha256: expected.sourceGeometrySha256,
    sourceGeometryKeyframes: expected.sourceGeometryKeyframes,
    materializedGeometryKeyframesSha256: expected.materializedGeometryKeyframesSha256,
    endpointSequenceSha256: canonicalJsonSha256(plan.projection.endpoints),
    topologySha256: canonicalJsonSha256(plan.projection.topology),
    areaProofSha256: canonicalJsonSha256(plan.projection.areaProof),
    outputCanonicalMotionSha256: expected.outputCanonicalMotionSha256,
  });
}

function ref(value: { readonly id: string; readonly sha256: string }) { return Object.freeze({ id: value.id, sha256: value.sha256 }); }
type Recognized = Readonly<{ output: Awaited<ReturnType<typeof reopenCheckpointStoryboardGeometryMorphMaterializationOutput>>; receipt: Awaited<ReturnType<typeof readC6B6bReceipt>>; plan: GeometryMorphPlanIdentity }>;

/** Reopen both the B6b receipt/output and its complete inventory; source authority is deliberately absent. */
async function recognizeInstalledOutput(host: { readonly outputPackageRoot: string; readonly packageWorkspaceRoot: string; readonly packageWorkspaceAuthority: Parameters<typeof reopenCheckpointStoryboardGeometryMorphMaterializationOutput>[0]["packageWorkspaceAuthority"] }, identity: CheckpointStoryboardRecordIdentity, expected: C6B6bExactBase, plan: GeometryMorphPlanIdentity): Promise<Recognized | null> {
  try {
    const output = await reopenCheckpointStoryboardGeometryMorphMaterializationOutput(host), receipt = await readC6B6bReceipt(host.outputPackageRoot);
    const projection = receipt.approval.projection, approvedPlan = receipt.approval.plan;
    if (
      output.storyboard.id !== identity.id || output.storyboard.sha256 !== identity.sha256 || output.storyboard.revision !== identity.revision
      || !samePlanIdentity(plan, output)
      || output.receipt.fingerprint !== receipt.fingerprint
      || canonicalJson(receipt.base.expected) !== canonicalJson(expected) || canonicalJson(receipt.base.reopened) !== canonicalJson(expected)
      || receipt.approval.storyboard.id !== identity.id || receipt.approval.storyboard.sha256 !== identity.sha256 || receipt.approval.storyboard.revision !== identity.revision
      || approvedPlan.fingerprint !== plan.planFingerprint || approvedPlan.lowererProfile.fingerprint !== plan.profileFingerprint
      || approvedPlan.storyboard.id !== plan.storyboardId || approvedPlan.storyboard.sha256 !== plan.storyboardSha256 || approvedPlan.storyboard.revision !== plan.storyboardRevision
      || approvedPlan.objectLayerBinding.layerId !== plan.sourceLayerId || approvedPlan.objectLayerBinding.objectId !== plan.sourceLayerId || approvedPlan.objectLayerBinding.layerIndex !== plan.sourceLayerIndex
      || approvedPlan.projection.staticGeometry.sha256 !== plan.staticGeometrySha256 || canonicalJsonSha256(approvedPlan.projection.geometryKeyframes) !== plan.materializedGeometryKeyframesSha256
      || canonicalJsonSha256(approvedPlan.projection.endpoints) !== plan.endpointSequenceSha256 || canonicalJsonSha256(approvedPlan.projection.topology) !== plan.topologySha256 || canonicalJsonSha256(approvedPlan.projection.areaProof) !== plan.areaProofSha256
      || projection.sourceLayerId !== plan.sourceLayerId || projection.sourceLayerIndex !== plan.sourceLayerIndex || projection.sourceGeometrySha256 !== plan.staticGeometrySha256 || projection.sourceGeometryKeyframes !== "absent" || projection.materializedGeometryKeyframesSha256 !== plan.materializedGeometryKeyframesSha256 || projection.endpointSequenceSha256 !== plan.endpointSequenceSha256 || projection.topologySha256 !== plan.topologySha256 || projection.areaProofSha256 !== plan.areaProofSha256
      || receipt.output.packageId !== output.package.id || receipt.output.manifestRawSha256 !== output.package.manifest.rawSha256 || receipt.output.manifestCanonicalSha256 !== output.package.manifest.canonicalSha256 || receipt.output.motionRawSha256 !== output.package.motion.rawSha256 || receipt.output.canonicalMotionSha256 !== output.package.motion.canonicalSha256 || canonicalJson(receipt.output.nonReceiptInventory) !== canonicalJson(output.package.nonReceiptInventory) || canonicalJson(receipt.output.preservedLeaves) !== canonicalJson(output.package.preservedLeaves)
      || receipt.output.canonicalMotionSha256 !== plan.outputCanonicalMotionSha256 || receipt.output.changed.count !== 2 || receipt.output.changed.motionPropertyPathCount !== 1 || receipt.output.changed.motionPropertyPaths[0] !== "/layers/0/geometryKeyframes"
      || receipt.transaction.cow !== "closed-inventory-finalize-after-edit" || receipt.transaction.installed !== true || receipt.transaction.exclusiveReceipt !== true || receipt.transaction.workspaceCleanup !== "not-attested" || receipt.renderer.invoked !== false || receipt.renderer.pixels !== false
      || output.materialization.renderer.invoked !== false || output.materialization.renderer.pixels !== false
    ) return null;
    return Object.freeze({ output, receipt, plan });
  } catch { return null; }
}

function samePlanIdentity(plan: GeometryMorphPlanIdentity, output: Awaited<ReturnType<typeof reopenCheckpointStoryboardGeometryMorphMaterializationOutput>>): boolean {
  return plan.planFingerprint === output.plan.fingerprint
    && plan.profileFingerprint === output.profile.fingerprint
    && plan.storyboardId === output.storyboard.id
    && plan.storyboardSha256 === output.storyboard.sha256
    && plan.storyboardRevision === output.storyboard.revision
    && plan.sourceLayerId === output.geometry.layerId
    && plan.sourceLayerIndex === output.geometry.layerIndex
    && plan.staticGeometrySha256 === output.geometry.staticGeometrySha256
    && plan.materializedGeometryKeyframesSha256 === output.geometry.geometryKeyframesSha256
    && output.geometry.endpointSha256.length === 2
    && plan.outputCanonicalMotionSha256 === output.package.motion.canonicalSha256
    && output.materialization.changedMotionRoot === "layers"
    && output.materialization.changedLeafCount === 2
    && output.materialization.renderer.invoked === false
    && output.materialization.renderer.pixels === false;
}

async function publishAndReopen(store: ReturnType<typeof checkedAuthority>, host: Parameters<typeof recognizeInstalledOutput>[0], authority: CheckpointStoryboardGeometryMorphResolutionAuthority, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, intent: GeometryMorphIntent, recognized: Recognized, outputHandle: string, replayed: boolean): Promise<CheckpointStoryboardGeometryMorphResolutionResult> {
  const start = await readGeometryMorphCowStart(store, identity);
  if (!start || !sameIdentity(start.identity, identity) || !sameIdentity(start.root, root) || start.intent.id !== intent.id || start.intent.sha256 !== intent.sha256) throw storeError("store_integrity_failed", "Checkpoint storyboard geometry-morph binding lost durable COW-start evidence.");
  const binding = createGeometryMorphBinding({ identity, root, intent: ref(intent), plan: recognized.plan, source: Object.freeze({ expected: recognized.receipt.base.expected, reopened: recognized.receipt.base.reopened }), output: Object.freeze({ expected: recognized.output, reopened: recognized.output }), receiptFingerprint: recognized.receipt.fingerprint, outputHandle });
  await publishGeometryMorphBinding(store, binding); await fault(authority, "after-binding");
  await publishGeometryMorphStateHead(store, geometryMorphStateHead(identity, root, "bound", 1, { intent: ref(intent), cowStart: ref(start), binding: ref(binding) }), async () => await fault(authority, "after-bound-state-head-rename"));
  const reopened = await readGeometryMorphBinding(store, identity);
  if (!reopened || canonicalJson(reopened) !== canonicalJson(binding)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard geometry-morph binding publication could not be reopened exactly.");
  await verifyBinding(host, reopened, identity, outputHandle);
  return result(identity, reopened, "bound", replayed);
}

async function replayBound(store: ReturnType<typeof checkedAuthority>, host: Parameters<typeof recognizeInstalledOutput>[0], identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, bindingId: string, outputHandle: string): Promise<CheckpointStoryboardGeometryMorphResolutionResult> {
  const binding = await readGeometryMorphBinding(store, identity);
  if (!binding || binding.id !== bindingId || !sameIdentity(binding.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard bound geometry-morph state does not match immutable binding.");
  await verifyBinding(host, binding, identity, outputHandle);
  return result(identity, binding, "bound", true);
}

async function verifyBinding(host: Parameters<typeof recognizeInstalledOutput>[0], binding: GeometryMorphBinding, identity: CheckpointStoryboardRecordIdentity, outputHandle: string): Promise<void> {
  if (binding.outputHandle !== outputHandle) throw storeError("materialization_binding_conflict", "Checkpoint storyboard geometry-morph binding belongs to a different authority-store output handle.");
  const output = await reopenCheckpointStoryboardGeometryMorphMaterializationOutput(host), receipt = await readC6B6bReceipt(host.outputPackageRoot), recognized = await recognizeInstalledOutput(host, identity, binding.source.expected, binding.plan);
  if (!recognized || output.receipt.fingerprint !== binding.receiptFingerprint || receipt.fingerprint !== binding.receiptFingerprint || canonicalJson(output) !== canonicalJson(binding.output.expected) || canonicalJson(output) !== canonicalJson(binding.output.reopened) || canonicalJson(receipt.base.expected) !== canonicalJson(binding.source.expected) || canonicalJson(receipt.base.reopened) !== canonicalJson(binding.source.reopened)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard geometry-morph binding no longer reopens its complete B6b base, output, receipt, geometry projection, inventories, and renderer identity.");
}

function result(identity: CheckpointStoryboardRecordIdentity, binding: GeometryMorphBinding, state: "bound" | "detached", replayed: boolean): CheckpointStoryboardGeometryMorphResolutionResult {
  return Object.freeze({ identity, binding: Object.freeze({ state, active: state === "bound" ? 1 as const : 0 as const, bindingId: binding.id, outputHandle: binding.outputHandle, receiptFingerprint: binding.receiptFingerprint }), renderer: Object.freeze({ invoked: false as const, pixels: false as const }), replayed });
}

async function outputExists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return false;
    throw storeError("materialization_binding_uncertain", "Checkpoint storyboard geometry-morph output could not be safely classified as absent and was not recreated.");
  }
}

function sanitized(error: unknown): never {
  if (error instanceof CheckpointStoryboardRecordStoreError) throw error;
  throw storeError("materialization_binding_uncertain", "Checkpoint storyboard geometry-morph resolution did not complete exact host/package verification; output was retained and no path evidence was returned.");
}
