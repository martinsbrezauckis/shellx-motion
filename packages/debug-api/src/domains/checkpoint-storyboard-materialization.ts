/** Durable B1a binding around the already accepted private C6B scalar/spatial COW. */
import { lstat } from "node:fs/promises";
import { canonicalJson, isPublicationCommitUncertain } from "@shellx-motion/core";
import { readC6B1bReceipt, type C6B1bExactBase, type CheckpointStoryboardScalarSpatialMaterializationReceipt } from "./checkpoint-storyboard-scalar-spatial-materialize-receipt-private.js";
import {
  materializeCheckpointStoryboardScalarSpatial,
  prepareCheckpointStoryboardScalarSpatialMaterialization,
  reopenCheckpointStoryboardScalarSpatialMaterializationOutput,
} from "./checkpoint-storyboard-scalar-spatial-materialize-private.js";
import {
  checkpointStoryboardOutputHandle, checkedCheckpointStoryboardMaterializationAuthority,
  withCheckpointStoryboardMaterializationOutputAuthority, type CheckpointStoryboardMaterializationAuthority,
} from "./checkpoint-storyboard-materialization-authority.js";
import {
  createMaterializationBinding, createMaterializationDetach, createMaterializationIntent,
  createMaterializationAbandon, createMaterializationCowStart, publishMaterializationAbandon, publishMaterializationBinding, publishMaterializationCowStart, publishMaterializationDetach, publishMaterializationIntent, publishMaterializationStateHead,
  readMaterializationAbandon, readMaterializationBinding, readMaterializationBindingState, readMaterializationCowStart, readMaterializationIntent,
} from "./checkpoint-storyboard-materialization-bindings.js";
import { checkedAuthority, withLineageLock } from "./checkpoint-storyboard-record-store-authority.js";
import { readImmutableRecordRoot, readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import { CheckpointStoryboardRecordStoreError, type CheckpointStoryboardMaterializationBindingFile, type CheckpointStoryboardRecordIdentity, storeError } from "./checkpoint-storyboard-record-store-types.js";
import { assertNoBehaviorResolutionEvidence } from "./checkpoint-storyboard-behavior-resolution-journal.js";
import { assertNoRelationResolutionEvidence } from "./checkpoint-storyboard-relation-resolution-journal.js";
import { assertNoRelationActionResolutionEvidence } from "./checkpoint-storyboard-relation-action-resolution-journal.js";
import { assertNoLifecycleResolutionEvidence } from "./checkpoint-storyboard-lifecycle-resolution-journal.js";
import { assertNoGeometryMorphResolutionEvidence } from "./checkpoint-storyboard-geometry-morph-resolution-journal.js";
import { assertNoRetainedTraceResolutionEvidence } from "./checkpoint-storyboard-retained-trace-resolution-journal.js";

/** Private deterministic fault seam: it is not in the Debug registry/index and is keyed only by
 * the opaque host authority, never command input or durable journal data. */
type MaterializationFaultPhase = "while-lineage-lock-held" | "after-intent" | "after-cow-start" | "before-c6b" | "after-c6b-commit" | "after-binding" | "after-abandon" | "after-detach" | "after-bound-state-head-rename" | "after-detached-state-head-rename";
type MaterializationFaultHooks = Partial<Record<MaterializationFaultPhase, () => void | Promise<void>>>;
const testFaultHooks = new WeakMap<CheckpointStoryboardMaterializationAuthority, MaterializationFaultHooks>();
export function setCheckpointStoryboardMaterializationFaultHooksForTest(authority: CheckpointStoryboardMaterializationAuthority, hooks: MaterializationFaultHooks | undefined): void {
  checkedCheckpointStoryboardMaterializationAuthority(authority);
  if (hooks) testFaultHooks.set(authority, Object.freeze({ ...hooks }));
  else testFaultHooks.delete(authority);
}
async function testFault(authority: CheckpointStoryboardMaterializationAuthority, phase: MaterializationFaultPhase): Promise<void> { await testFaultHooks.get(authority)?.[phase]?.(); }

export interface CheckpointStoryboardMaterializationResult {
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly binding: { readonly state: "bound"; readonly active: 1; readonly bindingId: string; readonly outputHandle: string; readonly receiptFingerprint: string };
  readonly renderer: { readonly invoked: false };
  readonly replayed: boolean;
}
export interface CheckpointStoryboardDetachResult {
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly binding: { readonly state: "detached"; readonly active: 0; readonly bindingId: string; readonly outputHandle: string };
  readonly renderer: { readonly invoked: false };
  readonly replayed: boolean;
}

export async function materializeCheckpointStoryboardStoredRecord(authority: CheckpointStoryboardMaterializationAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardMaterializationResult> {
  try { return await withCheckpointStoryboardMaterializationOutputAuthority(authority, async (host) => {
    const store = checkedAuthority(host.store); const root = await readImmutableRecordRoot(store, identity);
    return await withLineageLock(store, root.id, async () => {
      const record = await readStoredRecordUnlocked(store, identity);
      assertMaterializableRecord(record);
      await assertB1PartitionResidueAbsent(store, identity);
      const outputHandle = checkpointStoryboardOutputHandle(authority, identity);
      let state = await readMaterializationBindingState(store, identity, root);
      await testFault(authority, "while-lineage-lock-held");
      if (state.state === "abandoned" || await readMaterializationAbandon(store, identity)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard materialization was terminally abandoned after a proven no-install outcome and cannot be rebound.");
      if (state.state === "detached") throw storeError("materialization_detached", "Checkpoint storyboard materialization has been terminally detached and cannot be rebound.");
      const c6bHost = { sourcePackageRoot: host.sourcePackageRoot, outputPackageRoot: host.outputPackageRoot, packageWorkspaceRoot: host.packageWorkspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority, requireAbsentOutput: true as const };
      if (state.state === "bound") return await replayBound(store, c6bHost, identity, root, state.bindingId!, outputHandle);

      if (!record.storyboard.capabilityRequirements.includes("renderer.browser")) throw storeError("materialization_profile_refused", "C6C B1a materialization requires the renderer.browser profile; native-only records remain valid lifecycle records.");
      const priorIntent = await readMaterializationIntent(store, identity);
      // Recovery begins from durable intent, not a freshly observed source. A source may have
      // drifted after COW committed but before its binding was linked.
      if (priorIntent) {
        const recovered = await recognizeOutput(c6bHost, record.identity, priorIntent.expectedBase, priorIntent.plan);
        if (recovered) return await publishAndReopenBinding(store, identity, root, priorIntent, recovered, outputHandle, true, authority);
        if (await outputExists(host.outputPackageRoot) || await readMaterializationCowStart(store, identity)) {
          throw storeError("materialization_binding_uncertain", "Checkpoint storyboard has a durable COW phase or retained output without an exact reopened binding; it will not be materialized again.");
        }
      } else if (await outputExists(host.outputPackageRoot)) {
        throw storeError("materialization_binding_uncertain", "Checkpoint storyboard output is already occupied without a durable intent; it was retained and will not be replaced.");
      }
      const bindings = materializationBindings(record.storyboard.objectCatalog, host.objectLayerBindings);
      const prepared = await prepareCheckpointStoryboardScalarSpatialMaterialization(c6bHost, record.storyboard, bindings);
      const plan = { c6b1aPlanFingerprint: prepared.plan.fingerprint, c6b1aLowererProfileFingerprint: prepared.plan.lowererProfile.fingerprint, c6b1bMaterializerProfileFingerprint: prepared.projection.materializerProfile.fingerprint, c6b1bProjectionFingerprint: prepared.projection.fingerprint } as const;
      const intent = createMaterializationIntent({ identity, root, plan, expectedBase: prepared.expected, outputHandle });
      if (priorIntent && canonicalJson(priorIntent) !== canonicalJson(intent)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard materialization intent conflicts with the exact host-selected C6B facts.");
      if (!priorIntent) {
        await publishMaterializationIntent(store, intent);
        await publishMaterializationStateHead(store, Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-materialization-state@1", identity, root, state: "preparing" as const, active: 0 as const, intent: { id: intent.id, sha256: intent.sha256 } }));
        await testFault(authority, "after-intent");
      }
      if (await outputExists(host.outputPackageRoot)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard output appeared after intent publication; it was retained and will not be replaced.");
      const cowStart = createMaterializationCowStart({ identity, root, intent: { id: intent.id, sha256: intent.sha256 } });
      await publishMaterializationCowStart(store, cowStart);
      // The required state head records the exact COW start before the existing C6B materializer
      // is allowed to touch the output. A missing/tampered start can therefore never authorize a
      // second COW on retry.
      await publishMaterializationStateHead(store, Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-materialization-state@1", identity, root, state: "preparing" as const, active: 0 as const, intent: { id: intent.id, sha256: intent.sha256 }, cowStart: { id: cowStart.id, sha256: cowStart.sha256 } }));
      await testFault(authority, "after-cow-start");

      let receipt: CheckpointStoryboardScalarSpatialMaterializationReceipt;
      try {
        await testFault(authority, "before-c6b");
        receipt = (await materializeCheckpointStoryboardScalarSpatial(c6bHost, prepared.approval, { schema: "shellx-motion/private-checkpoint-storyboard-scalar-spatial-materialization-request@1", expected: prepared.expected })).receipt;
      } catch (error) {
        const afterFailure = await recognizeOutput(c6bHost, record.identity, prepared.expected, plan);
        if (afterFailure) return await publishAndReopenBinding(store, identity, root, intent, afterFailure, outputHandle, true, authority);
        if (isPublicationCommitUncertain(error)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard C6B publication reported a possibly committed output; it was retained for exact recovery.");
        if (await outputExists(host.outputPackageRoot)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard C6B copy-on-write may have committed; its output was retained for exact recovery.");
        const abandon = createMaterializationAbandon({ identity, root, intent: { id: intent.id, sha256: intent.sha256 }, reason: "proven-no-install" });
        await publishMaterializationAbandon(store, abandon);
        await testFault(authority, "after-abandon");
        await publishMaterializationStateHead(store, Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-materialization-state@1", identity, root, state: "abandoned" as const, active: 0 as const, intent: { id: intent.id, sha256: intent.sha256 }, cowStart: { id: cowStart.id, sha256: cowStart.sha256 }, abandon: { id: abandon.id, sha256: abandon.sha256 } }));
        throw storeError("materialization_binding_conflict", "Checkpoint storyboard C6B preparation or copy-on-write refused before a recognized output was created.");
      }
      await testFault(authority, "after-c6b-commit");
      const recognized = await recognizeReceipt(c6bHost, receipt, record.identity, prepared.expected, plan);
      return await publishAndReopenBinding(store, identity, root, intent, recognized, outputHandle, false, authority);
    });
  }); } catch (error) { throw sanitizedMaterializationError(error); }
}

export async function detachCheckpointStoryboardStoredRecord(authority: CheckpointStoryboardMaterializationAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardDetachResult> {
  try { return await withCheckpointStoryboardMaterializationOutputAuthority(authority, async (host) => {
    const store = checkedAuthority(host.store); const root = await readImmutableRecordRoot(store, identity);
    return await withLineageLock(store, root.id, async () => {
      const record = await readStoredRecordUnlocked(store, identity);
      assertMaterializableRecord(record);
      await assertB1PartitionResidueAbsent(store, identity);
      let state = await readMaterializationBindingState(store, identity, root);
      if (state.state === "unbound" || state.state === "abandoned") throw storeError("materialization_not_bound", "Checkpoint storyboard record has no materialization binding to detach.");
      if (state.state === "preparing") {
        const intent = await readMaterializationIntent(store, identity), start = await readMaterializationCowStart(store, identity);
        if (intent) {
          const recovered = await recognizeOutput({ sourcePackageRoot: host.sourcePackageRoot, outputPackageRoot: host.outputPackageRoot, packageWorkspaceRoot: host.packageWorkspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority }, record.identity, intent.expectedBase, intent.plan);
          if (recovered) {
            await publishAndReopenBinding(store, identity, root, intent, recovered, checkpointStoryboardOutputHandle(authority, identity), true, authority);
            state = await readMaterializationBindingState(store, identity, root);
          }
        }
        if (state.state === "preparing" && intent && !start && !(await outputExists(host.outputPackageRoot))) {
          const abandon = createMaterializationAbandon({ identity, root, intent: { id: intent.id, sha256: intent.sha256 }, reason: "no-cow-start" });
          await publishMaterializationAbandon(store, abandon);
          await publishMaterializationStateHead(store, Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-materialization-state@1", identity, root, state: "abandoned" as const, active: 0 as const, intent: { id: intent.id, sha256: intent.sha256 }, abandon: { id: abandon.id, sha256: abandon.sha256 } }));
          throw storeError("materialization_not_bound", "Checkpoint storyboard intent was terminally abandoned before COW start; no output was deleted.");
        }
        if (state.state === "preparing") throw storeError("materialization_binding_uncertain", "Checkpoint storyboard materialization is intent-only or COW-uncertain; its output was retained for exact recovery.");
      }
      const binding = await readMaterializationBinding(store, identity);
      if (!binding) throw storeError("store_integrity_failed", "Checkpoint storyboard binding state lost its immutable binding record.");
      if (state.state === "detached") return Object.freeze({ identity, binding: { state: "detached" as const, active: 0 as const, bindingId: binding.id, outputHandle: binding.outputHandle }, renderer: Object.freeze({ invoked: false as const }), replayed: true });
      await verifyCheckpointStoryboardStoredBindingUnlocked({ sourcePackageRoot: host.sourcePackageRoot, outputPackageRoot: host.outputPackageRoot, packageWorkspaceRoot: host.packageWorkspaceRoot, packageWorkspaceAuthority: host.packageWorkspaceAuthority }, binding);
      const detach = createMaterializationDetach({ identity, root, binding: { id: binding.id, sha256: binding.sha256 } });
      await publishMaterializationDetach(store, detach);
      await testFault(authority, "after-detach");
      const intent = await readMaterializationIntent(store, identity);
      const cowStart = await readMaterializationCowStart(store, identity);
      if (!intent || !cowStart || cowStart.intent.id !== intent.id || cowStart.intent.sha256 !== intent.sha256) throw storeError("store_integrity_failed", "Checkpoint storyboard detach lost its required immutable COW phase evidence.");
      await publishMaterializationStateHead(store, Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-materialization-state@1", identity, root, state: "detached" as const, active: 0 as const, intent: { id: intent.id, sha256: intent.sha256 }, cowStart: { id: cowStart.id, sha256: cowStart.sha256 }, binding: { id: binding.id, sha256: binding.sha256 }, detach: { id: detach.id, sha256: detach.sha256 } }), async () => await testFault(authority, "after-detached-state-head-rename"));
      const final = await readMaterializationBindingState(store, identity, root);
      if (final.state !== "detached" || final.bindingId !== binding.id) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard detach publication could not be reopened exactly.");
      // Deliberately no output deletion: detachment only retires link authority.
      return Object.freeze({ identity, binding: { state: "detached" as const, active: 0 as const, bindingId: binding.id, outputHandle: binding.outputHandle }, renderer: Object.freeze({ invoked: false as const }), replayed: false });
    });
  }); } catch (error) { throw sanitizedMaterializationError(error); }
}

function assertMaterializableRecord(record: Awaited<ReturnType<typeof readStoredRecordUnlocked>>): void {
  if (record.admission.profile !== undefined) throw storeError("materialization_profile_refused", "C6C B1a materialization refuses sealed non-B1 records before journal, output, or renderer work.");
  if (record.archive.terminal) throw storeError("lineage_archived", "Checkpoint storyboard lineage is terminally archived.");
  if (record.target.state === "tombstoned") throw storeError("record_tombstoned", "A tombstoned checkpoint storyboard record cannot be materialized.");
}
async function assertB1PartitionResidueAbsent(store: ReturnType<typeof checkedAuthority>, identity: CheckpointStoryboardRecordIdentity): Promise<void> {
  await assertNoBehaviorResolutionEvidence(store, identity);
  await assertNoRelationResolutionEvidence(store, identity);
  await assertNoRelationActionResolutionEvidence(store, identity);
  await assertNoLifecycleResolutionEvidence(store, identity);
  await assertNoGeometryMorphResolutionEvidence(store, identity);
  await assertNoRetainedTraceResolutionEvidence(store, identity);
}
function materializationBindings(catalog: readonly { readonly objectId: string }[], configured: readonly { readonly objectId: string; readonly layerId: string }[] | undefined) {
  const resolved = configured ?? catalog.map((entry) => ({ objectId: entry.objectId, layerId: entry.objectId }));
  if (resolved.length !== catalog.length || new Set(resolved.map((entry) => entry.objectId)).size !== resolved.length || catalog.some((entry) => !resolved.some((binding) => binding.objectId === entry.objectId))) throw storeError("materialization_authority_refused", "Checkpoint storyboard host authority does not provide one exact private binding for every record object.");
  return resolved;
}
async function replayBound(store: ReturnType<typeof checkedAuthority>, c6bHost: Parameters<typeof reopenCheckpointStoryboardScalarSpatialMaterializationOutput>[0], identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, bindingId: string, outputHandle: string): Promise<CheckpointStoryboardMaterializationResult> {
  const binding = await readMaterializationBinding(store, identity);
  if (!binding || binding.id !== bindingId || binding.outputHandle !== outputHandle || !sameIdentity(binding.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard bound state does not match its immutable binding record.");
  await verifyCheckpointStoryboardStoredBindingUnlocked(c6bHost, binding);
  return Object.freeze({ identity, binding: { state: "bound" as const, active: 1 as const, bindingId: binding.id, outputHandle, receiptFingerprint: binding.c6b1bReceiptFingerprint }, renderer: Object.freeze({ invoked: false as const }), replayed: true });
}
async function publishAndReopenBinding(store: ReturnType<typeof checkedAuthority>, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, intent: ReturnType<typeof createMaterializationIntent>, recognized: RecognizedOutput, outputHandle: string, replayed: boolean, faultAuthority?: CheckpointStoryboardMaterializationAuthority): Promise<CheckpointStoryboardMaterializationResult> {
  const cowStart = await readMaterializationCowStart(store, identity);
  if (!cowStart || !sameIdentity(cowStart.identity, identity) || !sameIdentity(cowStart.root, root) || cowStart.intent.id !== intent.id || cowStart.intent.sha256 !== intent.sha256) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard binding lost its required durable COW start evidence.");
  }
  const binding = createMaterializationBinding({ identity, root, intent: { id: intent.id, sha256: intent.sha256 }, plan: recognized.plan, source: { expected: recognized.receipt.base.expected, reopened: recognized.receipt.base.reopened }, output: { expected: recognized.receipt.output, reopened: recognized.receipt.output }, c6b1bReceiptFingerprint: recognized.receipt.fingerprint, outputHandle });
  await publishMaterializationBinding(store, binding);
  if (faultAuthority) await testFault(faultAuthority, "after-binding");
  await publishMaterializationStateHead(store, Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-materialization-state@1", identity, root, state: "bound" as const, active: 1 as const, intent: { id: intent.id, sha256: intent.sha256 }, cowStart: { id: cowStart.id, sha256: cowStart.sha256 }, binding: { id: binding.id, sha256: binding.sha256 } }), faultAuthority ? async () => await testFault(faultAuthority, "after-bound-state-head-rename") : undefined);
  const reopened = await readMaterializationBinding(store, identity);
  if (!reopened || canonicalJson(reopened) !== canonicalJson(binding)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard binding publication could not be reopened exactly.");
  await verifyCheckpointStoryboardStoredBindingUnlocked(recognized.c6bHost, reopened);
  return Object.freeze({ identity, binding: { state: "bound" as const, active: 1 as const, bindingId: reopened.id, outputHandle, receiptFingerprint: reopened.c6b1bReceiptFingerprint }, renderer: Object.freeze({ invoked: false as const }), replayed });
}
type RecognizedOutput = { readonly c6bHost: Parameters<typeof reopenCheckpointStoryboardScalarSpatialMaterializationOutput>[0]; readonly receipt: CheckpointStoryboardScalarSpatialMaterializationReceipt; readonly plan: { readonly c6b1aPlanFingerprint: string; readonly c6b1aLowererProfileFingerprint: string; readonly c6b1bMaterializerProfileFingerprint: string; readonly c6b1bProjectionFingerprint: string } };
async function recognizeOutput(c6bHost: Parameters<typeof reopenCheckpointStoryboardScalarSpatialMaterializationOutput>[0], identity: CheckpointStoryboardRecordIdentity, expected: C6B1bExactBase, plan: RecognizedOutput["plan"]): Promise<RecognizedOutput | null> { try { return await recognizeReceipt(c6bHost, await readC6B1bReceipt(c6bHost.outputPackageRoot), identity, expected, plan); } catch { return null; } }
async function recognizeReceipt(c6bHost: Parameters<typeof reopenCheckpointStoryboardScalarSpatialMaterializationOutput>[0], receipt: CheckpointStoryboardScalarSpatialMaterializationReceipt, identity: CheckpointStoryboardRecordIdentity, expected: C6B1bExactBase, plan: RecognizedOutput["plan"]): Promise<RecognizedOutput> {
  if (receipt.renderer.invoked !== false || receipt.approval.storyboard.id !== identity.id || receipt.approval.storyboard.sha256 !== identity.sha256 || receipt.approval.storyboard.revision !== identity.revision || receipt.approval.c6aPlanFingerprint !== plan.c6b1aPlanFingerprint || receipt.approval.c6aLowererProfileFingerprint !== plan.c6b1aLowererProfileFingerprint || receipt.approval.c6b1bProfileFingerprint !== plan.c6b1bMaterializerProfileFingerprint || receipt.approval.c6b1bProjectionFingerprint !== plan.c6b1bProjectionFingerprint || canonicalJson(receipt.base.expected) !== canonicalJson(expected) || canonicalJson(receipt.base.reopened) !== canonicalJson(expected)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard C6B receipt does not bind the exact record and approved C6B facts.");
  // The C6B receipt reader checks its canonical bytes.  This second full reopen is the B1a
  // recognition point; no path leaves this function.
  const reopened = await reopenCheckpointStoryboardScalarSpatialMaterializationOutput(c6bHost, receipt);
  if (canonicalJson(reopened) !== canonicalJson(receipt)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard C6B receipt changed during output reopen.");
  return Object.freeze({ c6bHost, receipt: reopened, plan });
}
/**
 * Reopen only the stored C6B output/receipt binding.  Callers that already own the root lineage
 * lock use this unlocked primitive; it deliberately neither reads the B1a source nor starts a
 * COW/materialization operation.
 */
export async function verifyCheckpointStoryboardStoredBindingUnlocked(c6bHost: Parameters<typeof reopenCheckpointStoryboardScalarSpatialMaterializationOutput>[0], binding: CheckpointStoryboardMaterializationBindingFile): Promise<CheckpointStoryboardScalarSpatialMaterializationReceipt> {
  const receipt = await reopenCheckpointStoryboardScalarSpatialMaterializationOutput(c6bHost, await readC6B1bReceipt(c6bHost.outputPackageRoot));
  if (receipt.fingerprint !== binding.c6b1bReceiptFingerprint || canonicalJson(receipt.base.expected) !== canonicalJson(binding.source.expected) || canonicalJson(receipt.base.reopened) !== canonicalJson(binding.source.reopened) || canonicalJson(receipt.output) !== canonicalJson(binding.output.expected) || canonicalJson(receipt.output) !== canonicalJson(binding.output.reopened)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard stored binding no longer recognizes the exact C6B output and receipt.");
  return receipt;
}
async function outputExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return false;
    throw storeError("materialization_binding_uncertain", "Checkpoint storyboard output could not be safely classified as absent; it was not recreated.");
  }
}
function sameIdentity(left: CheckpointStoryboardRecordIdentity, right: CheckpointStoryboardRecordIdentity): boolean { return left.id === right.id && left.sha256 === right.sha256 && left.revision === right.revision; }
function sanitizedMaterializationError(error: unknown): never {
  if (error instanceof CheckpointStoryboardRecordStoreError) throw error;
  // Package and filesystem messages can include host-selected paths. Public Debug responses never
  // repeat them; callers receive only a conservative, recovery-safe typed outcome.
  throw storeError("materialization_binding_uncertain", "Checkpoint storyboard materialization host/package verification did not complete exactly; no output was deleted or recreated.");
}
