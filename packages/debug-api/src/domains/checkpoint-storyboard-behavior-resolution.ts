/** C6C B2 private resolver.  It deliberately has no Core, SDK, Actions, CLI, connector, or
 * renderer export: Debug owns the host authority and this durable link only. */
import { lstat } from "node:fs/promises";
import { canonicalJson, isPublicationCommitUncertain } from "@shellx-motion/core";
import { materializeCheckpointStoryboardBehavior, prepareCheckpointStoryboardBehaviorMaterialization, reopenCheckpointStoryboardBehaviorMaterializationOutput } from "./checkpoint-storyboard-behavior-materialize-private/checkpoint-storyboard-behavior-materialize-private.js";
import { readC6B2Receipt, type C6B2ExactBase } from "./checkpoint-storyboard-behavior-materialize-private/checkpoint-storyboard-behavior-materialize-receipt-private.js";
import { assertCheckpointStoryboardBehaviorResolutionAuthorityStore, checkpointStoryboardBehaviorResolutionOutputHandle, checkedCheckpointStoryboardBehaviorResolutionAuthority, withCheckpointStoryboardBehaviorResolutionAuthority, withCheckpointStoryboardBehaviorResolutionOutputAuthority, type CheckpointStoryboardBehaviorResolutionAuthority } from "./checkpoint-storyboard-behavior-resolution-authority.js";
import { behaviorStateHead, createBehaviorAbandon, createBehaviorBinding, createBehaviorCowStart, createBehaviorDetach, createBehaviorIntent, publishBehaviorAbandon, publishBehaviorBinding, publishBehaviorCowStart, publishBehaviorDetach, publishBehaviorIntent, publishBehaviorStateHead, readBehaviorBinding, readBehaviorCowStart, readBehaviorIntent, readBehaviorResolutionState, type BehaviorBinding, type BehaviorIntent, type BehaviorPlanIdentity } from "./checkpoint-storyboard-behavior-resolution-journal.js";
import { assertNoLegacyMaterializationEvidence } from "./checkpoint-storyboard-materialization-bindings.js";
import { assertNoRelationResolutionEvidence } from "./checkpoint-storyboard-relation-resolution-journal.js";
import { assertNoRelationActionResolutionEvidence } from "./checkpoint-storyboard-relation-action-resolution-journal.js";
import { assertNoLifecycleResolutionEvidence } from "./checkpoint-storyboard-lifecycle-resolution-journal.js";
import { assertNoGeometryMorphResolutionEvidence } from "./checkpoint-storyboard-geometry-morph-resolution-journal.js";
import { assertNoRetainedTraceResolutionEvidence } from "./checkpoint-storyboard-retained-trace-resolution-journal.js";
import { checkedAuthority, withLineageLock } from "./checkpoint-storyboard-record-store-authority.js";
import { readImmutableRecordRoot, readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import { CheckpointStoryboardRecordStoreError, sameIdentity, storeError, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

type BehaviorResolutionFaultPhase = "while-lineage-lock-held" | "after-intent-before-state-head" | "after-intent" | "after-cow-start-before-state-head" | "after-cow-start" | "before-c6b2" | "after-c6b2-commit" | "after-binding" | "after-bound-state-head-rename" | "after-detach" | "after-detached-state-head-rename" | "after-abandon";
type BehaviorResolutionFaultHooks = Partial<Record<BehaviorResolutionFaultPhase, () => void | Promise<void>>>;
const hooks = new WeakMap<CheckpointStoryboardBehaviorResolutionAuthority, BehaviorResolutionFaultHooks>();
/** Test-only private seam. It is intentionally absent from the Debug command registry. */
export function setCheckpointStoryboardBehaviorResolutionFaultHooksForTest(authority: CheckpointStoryboardBehaviorResolutionAuthority, value: BehaviorResolutionFaultHooks | undefined): void {
  checkedCheckpointStoryboardBehaviorResolutionAuthority(authority);
  if (value) hooks.set(authority, Object.freeze({ ...value })); else hooks.delete(authority);
}
async function fault(authority: CheckpointStoryboardBehaviorResolutionAuthority, phase: BehaviorResolutionFaultPhase): Promise<void> { await hooks.get(authority)?.[phase]?.(); }

export interface CheckpointStoryboardBehaviorResolutionResult {
  readonly identity: CheckpointStoryboardRecordIdentity;
  readonly binding: { readonly state: "bound" | "detached"; readonly active: 0 | 1; readonly bindingId: string; readonly outputHandle: string; readonly receiptFingerprint: string };
  readonly renderer: { readonly invoked: false; readonly pixels: false };
  readonly replayed: boolean;
}

export async function resolveCheckpointStoryboardBehaviorStoredRecord(authority: CheckpointStoryboardBehaviorResolutionAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardBehaviorResolutionResult> {
  try { return await withCheckpointStoryboardBehaviorResolutionOutputAuthority(authority, async (host) => {
    const store = checkedAuthority(host.store); const root = await readImmutableRecordRoot(store, identity);
    return await withLineageLock(store, root.id, async () => {
      const record = await readStoredRecordUnlocked(store, identity);
      assertB2Record(record);
      assertCheckpointStoryboardBehaviorResolutionAuthorityStore(authority, host.store);
      await assertLegacyB1Unbound(store, identity);
      const outputHandle = checkpointStoryboardBehaviorResolutionOutputHandle(authority, identity);
      let state = await readBehaviorResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true });
      await fault(authority, "while-lineage-lock-held");
      if (state.state === "abandoned") throw storeError("materialization_binding_conflict", "Checkpoint storyboard behavior resolution was terminally abandoned after a proved no-install outcome.");
      if (state.state === "detached") throw storeError("materialization_detached", "Checkpoint storyboard behavior resolution has terminally detached its link and cannot resolve again.");
      if (state.state === "bound") return await replayBound(store, host, identity, root, state.bindingId!, outputHandle);

      const prior = await readBehaviorIntent(store, identity);
      if (prior) {
        const recovered = await recognizeInstalledOutput(host, record.identity, prior.expectedBase, prior.plan);
        if (recovered) return await publishAndReopen(store, host, authority, identity, root, prior, recovered, outputHandle, true);
        if (await outputExists(host.outputPackageRoot) || await readBehaviorCowStart(store, identity)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard behavior resolution retains an occupied or COW-uncertain output for exact recovery and will not repeat COW.");
      } else if (await outputExists(host.outputPackageRoot)) {
        throw storeError("materialization_binding_uncertain", "Checkpoint storyboard behavior output is already occupied without a durable intent and was retained without replacement.");
      }

      // Only a fresh resolve needs a source reopen. Recovery/replay above intentionally does not
      // let a drifted source hide an installed output.
      return await withCheckpointStoryboardBehaviorResolutionAuthority(authority, async (sourceHost) => {
        const c6bHost = { sourcePackageRoot: sourceHost.sourcePackageRoot, outputPackageRoot: sourceHost.outputPackageRoot, packageWorkspaceRoot: sourceHost.packageWorkspaceRoot, packageWorkspaceAuthority: sourceHost.packageWorkspaceAuthority, requireAbsentOutput: true as const };
        assertOneSameIdBinding(record.storyboard.objectCatalog, sourceHost.objectLayerBinding);
        const prepared = await prepareCheckpointStoryboardBehaviorMaterialization(c6bHost, record.storyboard, [sourceHost.objectLayerBinding]);
        const plan: BehaviorPlanIdentity = Object.freeze({ planFingerprint: prepared.plan.fingerprint, profileFingerprint: prepared.plan.lowererProfile.fingerprint, storeSha256: prepared.plan.projection.storeSha256 });
        const intent = createBehaviorIntent({ identity, root, plan, expectedBase: prepared.expected, outputHandle });
        if (prior && canonicalJson(prior) !== canonicalJson(intent)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard behavior intent conflicts with exact host-selected C6B2 facts.");
        if (!prior) {
          await publishBehaviorIntent(store, intent);
          await fault(authority, "after-intent-before-state-head");
          await publishBehaviorStateHead(store, behaviorStateHead(identity, root, "preparing", 0, { intent: ref(intent) }));
          await fault(authority, "after-intent");
        }
        if (await outputExists(sourceHost.outputPackageRoot)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard behavior output appeared after intent publication and was retained without replacement.");
        const cowStart = createBehaviorCowStart({ identity, root, intent: ref(intent) });
        await publishBehaviorCowStart(store, cowStart);
        await fault(authority, "after-cow-start-before-state-head");
        await publishBehaviorStateHead(store, behaviorStateHead(identity, root, "preparing", 0, { intent: ref(intent), cowStart: ref(cowStart) }));
        await fault(authority, "after-cow-start");
        try {
          await fault(authority, "before-c6b2");
          await materializeCheckpointStoryboardBehavior(c6bHost, prepared.approval, { schema: "shellx-motion/private-checkpoint-storyboard-behavior-materialization-request@1", expected: prepared.expected });
        } catch (error) {
          const afterFailure = await recognizeInstalledOutput(sourceHost, record.identity, prepared.expected, plan);
          if (afterFailure) return await publishAndReopen(store, sourceHost, authority, identity, root, intent, afterFailure, outputHandle, true);
          if (isPublicationCommitUncertain(error) || await outputExists(sourceHost.outputPackageRoot)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard behavior publication may have committed; its output was retained for exact recovery.");
          const abandon = createBehaviorAbandon({ identity, root, intent: ref(intent), reason: "proven-no-install" });
          await publishBehaviorAbandon(store, abandon);
          await fault(authority, "after-abandon");
          await publishBehaviorStateHead(store, behaviorStateHead(identity, root, "abandoned", 0, { intent: ref(intent), cowStart: ref(cowStart), abandon: ref(abandon) }));
          throw storeError("materialization_binding_conflict", "Checkpoint storyboard behavior COW refused before a recognized output was installed.");
        }
        await fault(authority, "after-c6b2-commit");
        const installed = await recognizeInstalledOutput(sourceHost, record.identity, prepared.expected, plan);
        if (!installed) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard behavior COW completed without an exact output reopen; output was retained.");
        return await publishAndReopen(store, sourceHost, authority, identity, root, intent, installed, outputHandle, false);
      });
    });
  }); } catch (error) { throw sanitized(error); }
}

export async function detachCheckpointStoryboardBehaviorStoredRecord(authority: CheckpointStoryboardBehaviorResolutionAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardBehaviorResolutionResult> {
  try { return await withCheckpointStoryboardBehaviorResolutionOutputAuthority(authority, async (host) => {
    const store = checkedAuthority(host.store); const root = await readImmutableRecordRoot(store, identity);
    return await withLineageLock(store, root.id, async () => {
      const record = await readStoredRecordUnlocked(store, identity);
      assertB2Record(record);
      assertCheckpointStoryboardBehaviorResolutionAuthorityStore(authority, host.store);
      await assertLegacyB1Unbound(store, identity);
      const outputHandle = checkpointStoryboardBehaviorResolutionOutputHandle(authority, identity);
      let state = await readBehaviorResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true });
      if (state.state === "unbound" || state.state === "abandoned") throw storeError("materialization_not_bound", "Checkpoint storyboard behavior record has no bound output to detach.");
      if (state.state === "preparing") {
        const intent = await readBehaviorIntent(store, identity), start = await readBehaviorCowStart(store, identity);
        if (intent) {
          // Recovery prioritizes an exact installed-output reopen; a receipt merely contributes
          // full base facts after that reopen, never a presence-only proof.
          const recovered = await recognizeInstalledOutput(host, record.identity, intent.expectedBase, intent.plan);
          if (recovered) {
            await publishAndReopen(store, host, authority, identity, root, intent, recovered, outputHandle, true);
            state = await readBehaviorResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true });
          }
        }
        if (state.state === "preparing" && intent && !start && !(await outputExists(host.outputPackageRoot))) {
          const abandon = createBehaviorAbandon({ identity, root, intent: ref(intent), reason: "no-cow-start" });
          await publishBehaviorAbandon(store, abandon);
          await publishBehaviorStateHead(store, behaviorStateHead(identity, root, "abandoned", 0, { intent: ref(intent), abandon: ref(abandon) }));
          throw storeError("materialization_not_bound", "Checkpoint storyboard behavior intent was abandoned before COW start; no output was deleted.");
        }
        if (state.state === "preparing") throw storeError("materialization_binding_uncertain", "Checkpoint storyboard behavior resolution is COW-uncertain; its output was retained and cannot be detached yet.");
      }
      const binding = await readBehaviorBinding(store, identity);
      if (!binding) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior state lost its immutable binding.");
      if (state.state === "detached") {
        await verifyBinding(host, binding, identity, outputHandle);
        return result(identity, binding, "detached", true);
      }
      await verifyBinding(host, binding, identity, outputHandle);
      const detach = createBehaviorDetach({ identity, root, binding: ref(binding) });
      await publishBehaviorDetach(store, detach);
      await fault(authority, "after-detach");
      const intent = await readBehaviorIntent(store, identity), start = await readBehaviorCowStart(store, identity);
      if (!intent || !start) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior detach lost its required durable intent or COW start.");
      await publishBehaviorStateHead(store, behaviorStateHead(identity, root, "detached", 0, { intent: ref(intent), cowStart: ref(start), binding: ref(binding), detach: ref(detach) }), async () => await fault(authority, "after-detached-state-head-rename"));
      const final = await readBehaviorResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true });
      if (final.state !== "detached" || final.bindingId !== binding.id) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard behavior detach publication could not be reopened exactly.");
      // There is intentionally no deletion of host output. Detach retires only this link.
      return result(identity, binding, "detached", false);
    });
  }); } catch (error) { throw sanitized(error); }
}

function assertB2Record(record: Awaited<ReturnType<typeof readStoredRecordUnlocked>>): void {
  if (record.archive.terminal) throw storeError("lineage_archived", "Checkpoint storyboard lineage is terminally archived.");
  if (record.target.state === "tombstoned") throw storeError("record_tombstoned", "A tombstoned checkpoint storyboard record cannot resolve behavior.");
  if (record.admission.profile !== "c6b2-behavior@1") throw storeError("materialization_profile_refused", "C6C B2 behavior resolution accepts only a sealed C6B2 behavior profile record.");
}
async function assertLegacyB1Unbound(store: ReturnType<typeof checkedAuthority>, identity: CheckpointStoryboardRecordIdentity): Promise<void> {
  await assertNoLegacyMaterializationEvidence(store, identity);
  await assertNoRelationResolutionEvidence(store, identity);
  await assertNoRelationActionResolutionEvidence(store, identity);
  await assertNoLifecycleResolutionEvidence(store, identity);
  await assertNoGeometryMorphResolutionEvidence(store, identity);
  await assertNoRetainedTraceResolutionEvidence(store, identity);
}
function assertOneSameIdBinding(catalog: readonly { readonly objectId: string }[], binding: { readonly objectId: string; readonly layerId: string }): void {
  if (catalog.length !== 1 || binding.objectId !== catalog[0]!.objectId || binding.layerId !== catalog[0]!.objectId) throw storeError("materialization_authority_refused", "Checkpoint storyboard behavior resolution requires exactly one host-owned same-ID object/layer binding.");
}
function ref(value: { readonly id: string; readonly sha256: string }) { return Object.freeze({ id: value.id, sha256: value.sha256 }); }
type Recognized = Readonly<{ output: Awaited<ReturnType<typeof reopenCheckpointStoryboardBehaviorMaterializationOutput>>; receipt: Awaited<ReturnType<typeof readC6B2Receipt>>; plan: BehaviorPlanIdentity }>;
async function recognizeInstalledOutput(host: { readonly outputPackageRoot: string; readonly packageWorkspaceRoot: string; readonly packageWorkspaceAuthority: Parameters<typeof reopenCheckpointStoryboardBehaviorMaterializationOutput>[0]["packageWorkspaceAuthority"] }, identity: CheckpointStoryboardRecordIdentity, expected: C6B2ExactBase, plan: BehaviorPlanIdentity): Promise<Recognized | null> {
  try {
    const output = await reopenCheckpointStoryboardBehaviorMaterializationOutput(host);
    // Output reopening establishes the installed-package evidence before the raw receipt is read
    // for source exact-base facts retained in the private binding.
    const receipt = await readC6B2Receipt(host.outputPackageRoot);
    if (output.storyboard.id !== identity.id || output.storyboard.sha256 !== identity.sha256 || output.storyboard.revision !== identity.revision || output.plan.fingerprint !== plan.planFingerprint || output.profile.fingerprint !== plan.profileFingerprint || output.behaviorStore.sha256 !== plan.storeSha256 || output.receipt.fingerprint !== receipt.fingerprint || canonicalJson(receipt.base.expected) !== canonicalJson(expected) || canonicalJson(receipt.base.reopened) !== canonicalJson(expected) || receipt.approval.storeSha256 !== plan.storeSha256 || receipt.renderer.invoked !== false || receipt.renderer.pixels !== false) return null;
    return Object.freeze({ output, receipt, plan });
  } catch { return null; }
}
async function publishAndReopen(store: ReturnType<typeof checkedAuthority>, host: Parameters<typeof recognizeInstalledOutput>[0], authority: CheckpointStoryboardBehaviorResolutionAuthority, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, intent: BehaviorIntent, recognized: Recognized, outputHandle: string, replayed: boolean): Promise<CheckpointStoryboardBehaviorResolutionResult> {
  const start = await readBehaviorCowStart(store, identity);
  if (!start || !sameIdentity(start.identity, identity) || !sameIdentity(start.root, root) || start.intent.id !== intent.id || start.intent.sha256 !== intent.sha256) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior binding lost its durable COW start evidence.");
  const binding = createBehaviorBinding({ identity, root, intent: ref(intent), plan: recognized.plan, source: Object.freeze({ expected: recognized.receipt.base.expected, reopened: recognized.receipt.base.reopened }), output: Object.freeze({ expected: recognized.output, reopened: recognized.output }), receiptFingerprint: recognized.receipt.fingerprint, outputHandle });
  await publishBehaviorBinding(store, binding);
  await fault(authority, "after-binding");
  await publishBehaviorStateHead(store, behaviorStateHead(identity, root, "bound", 1, { intent: ref(intent), cowStart: ref(start), binding: ref(binding) }), async () => await fault(authority, "after-bound-state-head-rename"));
  const reopened = await readBehaviorBinding(store, identity);
  if (!reopened || canonicalJson(reopened) !== canonicalJson(binding)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard behavior binding publication could not be reopened exactly.");
  await verifyBinding(host, reopened, identity, outputHandle);
  return result(identity, reopened, "bound", replayed);
}
async function replayBound(store: ReturnType<typeof checkedAuthority>, host: Parameters<typeof recognizeInstalledOutput>[0], identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, bindingId: string, outputHandle: string): Promise<CheckpointStoryboardBehaviorResolutionResult> {
  const binding = await readBehaviorBinding(store, identity);
  if (!binding || binding.id !== bindingId || !sameIdentity(binding.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard bound behavior state does not match its immutable binding.");
  await verifyBinding(host, binding, identity, outputHandle);
  return result(identity, binding, "bound", true);
}
async function verifyBinding(host: Parameters<typeof recognizeInstalledOutput>[0], binding: BehaviorBinding, identity: CheckpointStoryboardRecordIdentity, outputHandle: string): Promise<void> {
  if (binding.outputHandle !== outputHandle) throw storeError("materialization_binding_conflict", "Checkpoint storyboard behavior binding belongs to a different exact authority-store output handle.");
  const output = await reopenCheckpointStoryboardBehaviorMaterializationOutput(host);
  const receipt = await readC6B2Receipt(host.outputPackageRoot);
  if (output.receipt.fingerprint !== binding.receiptFingerprint || receipt.fingerprint !== binding.receiptFingerprint || output.storyboard.id !== identity.id || output.storyboard.sha256 !== identity.sha256 || output.storyboard.revision !== identity.revision || output.plan.fingerprint !== binding.plan.planFingerprint || output.profile.fingerprint !== binding.plan.profileFingerprint || output.behaviorStore.sha256 !== binding.plan.storeSha256 || canonicalJson(receipt.base.expected) !== canonicalJson(binding.source.expected) || canonicalJson(receipt.base.reopened) !== canonicalJson(binding.source.reopened) || canonicalJson(output) !== canonicalJson(binding.output.expected) || canonicalJson(output) !== canonicalJson(binding.output.reopened)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard behavior binding no longer reopens the full source-independent installed output identity.");
}
function result(identity: CheckpointStoryboardRecordIdentity, binding: BehaviorBinding, state: "bound" | "detached", replayed: boolean): CheckpointStoryboardBehaviorResolutionResult { return Object.freeze({ identity, binding: Object.freeze({ state, active: state === "bound" ? 1 as const : 0 as const, bindingId: binding.id, outputHandle: binding.outputHandle, receiptFingerprint: binding.receiptFingerprint }), renderer: Object.freeze({ invoked: false as const, pixels: false as const }), replayed }); }
async function outputExists(file: string): Promise<boolean> { try { await lstat(file); return true; } catch (error) { if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return false; throw storeError("materialization_binding_uncertain", "Checkpoint storyboard behavior output could not be safely classified as absent and was not recreated."); } }
function sanitized(error: unknown): never { if (error instanceof CheckpointStoryboardRecordStoreError) throw error; throw storeError("materialization_binding_uncertain", "Checkpoint storyboard behavior resolution did not complete exact host/package verification; output was retained and no path evidence was returned."); }
