/** C6C B7 private resolver. Debug/MCP owns host authority and the signed durable retained-trace link. */
import { lstat } from "node:fs/promises";
import { canonicalJson, canonicalJsonSha256, isPublicationCommitUncertain } from "@shellx-motion/core";
import { withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { materializeCheckpointStoryboardRetainedTrace, prepareCheckpointStoryboardRetainedTraceMaterialization, reopenCheckpointStoryboardRetainedTraceMaterializationOutput } from "./checkpoint-storyboard-retained-trace-materialize-private/checkpoint-storyboard-retained-trace-materialize-private.js";
import { reopenCheckpointStoryboardRetainedTracePreviewInput, type CheckpointStoryboardRetainedTracePreviewInput } from "./checkpoint-storyboard-retained-trace-materialize-private/checkpoint-storyboard-retained-trace-materialize-output-private.js";
import { readC6B7bReceipt, type C6B7bExactBase } from "./checkpoint-storyboard-retained-trace-materialize-private/checkpoint-storyboard-retained-trace-materialize-receipt-private.js";
import { assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore, checkpointStoryboardRetainedTraceResolutionOutputHandle, checkedCheckpointStoryboardRetainedTraceResolutionAuthority, withCheckpointStoryboardRetainedTraceResolutionAuthority, withCheckpointStoryboardRetainedTraceResolutionOutputAuthority, type CheckpointStoryboardRetainedTraceResolutionAuthority } from "./checkpoint-storyboard-retained-trace-resolution-authority.js";
import { createRetainedTraceAbandon, createRetainedTraceBinding, createRetainedTraceCowStart, createRetainedTraceDetach, createRetainedTraceIntent, publishRetainedTraceAbandon, publishRetainedTraceBinding, publishRetainedTraceCowStart, publishRetainedTraceDetach, publishRetainedTraceIntent, publishRetainedTraceStateHead, readRetainedTraceBinding, readRetainedTraceCowStart, readRetainedTraceIntent, readRetainedTraceResolutionState, retainedTraceStateHead, type RetainedTraceBinding, type RetainedTraceIntent, type RetainedTracePlanIdentity } from "./checkpoint-storyboard-retained-trace-resolution-journal.js";
import { assertNoLegacyMaterializationEvidence } from "./checkpoint-storyboard-materialization-bindings.js";
import { assertNoBehaviorResolutionEvidence } from "./checkpoint-storyboard-behavior-resolution-journal.js";
import { assertNoRelationResolutionEvidence } from "./checkpoint-storyboard-relation-resolution-journal.js";
import { assertNoRelationActionResolutionEvidence } from "./checkpoint-storyboard-relation-action-resolution-journal.js";
import { assertNoLifecycleResolutionEvidence } from "./checkpoint-storyboard-lifecycle-resolution-journal.js";
import { assertNoGeometryMorphResolutionEvidence } from "./checkpoint-storyboard-geometry-morph-resolution-journal.js";
import { checkedAuthority, withLineageLock } from "./checkpoint-storyboard-record-store-authority.js";
import { readImmutableRecordRoot, readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import { CheckpointStoryboardRecordStoreError, sameIdentity, storeError, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

type FaultPhase = "while-lineage-lock-held" | "after-intent-before-state-head" | "after-intent" | "after-cow-start-before-state-head" | "after-cow-start" | "before-c6b7b" | "after-c6b7b-commit" | "after-binding" | "after-bound-state-head-rename" | "after-detach" | "after-detached-state-head-rename" | "after-abandon";
type FaultHooks = Partial<Record<FaultPhase, () => void | Promise<void>>>;
const hooks = new WeakMap<CheckpointStoryboardRetainedTraceResolutionAuthority, FaultHooks>();

/** Test-only seam; it is intentionally absent from command registry and public exports. */
export function setCheckpointStoryboardRetainedTraceResolutionFaultHooksForTest(authority: CheckpointStoryboardRetainedTraceResolutionAuthority, value: FaultHooks | undefined): void { checkedCheckpointStoryboardRetainedTraceResolutionAuthority(authority); if (value) hooks.set(authority, Object.freeze({ ...value })); else hooks.delete(authority); }
async function fault(authority: CheckpointStoryboardRetainedTraceResolutionAuthority, phase: FaultPhase): Promise<void> { await hooks.get(authority)?.[phase]?.(); }

export interface CheckpointStoryboardRetainedTraceResolutionResult { readonly identity: CheckpointStoryboardRecordIdentity; readonly binding: { readonly state: "bound" | "detached"; readonly active: 0 | 1; readonly bindingId: string; readonly outputHandle: string; readonly receiptFingerprint: string }; readonly renderer: { readonly invoked: false; readonly pixels: false; readonly gpuAbi: "none"; readonly upload: "none" }; readonly replayed: boolean; }

export interface CheckpointStoryboardRetainedTraceActivePreviewContext {
  readonly store: ReturnType<typeof checkedAuthority>;
  readonly root: CheckpointStoryboardRecordIdentity;
  readonly binding: RetainedTraceBinding;
  readonly input: CheckpointStoryboardRetainedTracePreviewInput;
  /** Reopens the signed binding and the complete installed output while the lineage lock remains held. */
  readonly revalidate: () => Promise<void>;
}

/**
 * The B7 preview seam owns the same lineage lock as resolve/detach. It exposes no source or output
 * path and can reopen a valid binding after source loss.
 */
export async function withCheckpointStoryboardRetainedTraceActivePreviewInput<T>(
  authority: CheckpointStoryboardRetainedTraceResolutionAuthority,
  identity: CheckpointStoryboardRecordIdentity,
  run: (context: CheckpointStoryboardRetainedTraceActivePreviewContext) => Promise<T>,
): Promise<T> {
  let callbackStarted = false;
  try {
    return await withCheckpointStoryboardRetainedTraceResolutionOutputAuthority(authority, async (host) => {
      const store = checkedAuthority(host.store), root = await readImmutableRecordRoot(store, identity);
      return await withLineageLock(store, root.id, async () => {
        const open = async (): Promise<{ binding: RetainedTraceBinding; input: CheckpointStoryboardRetainedTracePreviewInput }> => {
          const record = await readStoredRecordUnlocked(store, identity);
          assertB7Record(record);
          assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore(authority, host.store);
          await assertForeignPartitionEvidenceAbsent(store, identity);
          const state = await readRetainedTraceResolutionState(store, identity, root, { requireHead: true });
          if (state.state !== "bound" || state.active !== 1 || !state.bindingId) {
            throw storeError("preview_binding_not_active", "Checkpoint storyboard retained-trace preview requires one active resolved B7 binding.");
          }
          const binding = await readRetainedTraceBinding(store, identity);
          if (!binding || binding.id !== state.bindingId || !sameIdentity(binding.root, root)) {
            throw storeError("preview_binding_not_active", "Checkpoint storyboard retained-trace preview binding no longer matches its active signed state.");
          }
          const outputHandle = checkpointStoryboardRetainedTraceResolutionOutputHandle(authority, identity);
          await verifyBinding(host, binding, identity, outputHandle);
          const input = await reopenCheckpointStoryboardRetainedTracePreviewInput(host);
          if (input.receiptFingerprint !== binding.receiptFingerprint
            || canonicalJson(input.installed) !== canonicalJson(binding.output.expected)
            || canonicalJson(input.installed) !== canonicalJson(binding.output.reopened)
            || canonicalJson(input.installed.sidecar) !== canonicalJson(binding.sidecar)
            || input.plan.fingerprint !== binding.plan.planFingerprint
            || input.plan.lowererProfile.fingerprint !== binding.plan.profileFingerprint
            || input.plan.projection.trace.fingerprint !== binding.plan.tracePlanFingerprint
            || input.plan.projection.trace.sourceSha256 !== binding.plan.traceSourceSha256
            || input.plan.projection.trace.evidence.scheduleSha256 !== binding.plan.scheduleSha256) {
            throw storeError("materialization_binding_conflict", "Checkpoint storyboard retained-trace preview input no longer matches its exact active B7 binding.");
          }
          return Object.freeze({ binding, input });
        };
        const opened = await open();
        const expected = canonicalJson(opened);
        callbackStarted = true;
        return await run(Object.freeze({
          store,
          root,
          binding: opened.binding,
          input: opened.input,
          revalidate: async () => {
            if (canonicalJson(await open()) !== expected) {
              throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace binding or installed output changed during preview execution.");
            }
          },
        }));
      });
    });
  } catch (error) {
    if (callbackStarted) throw error;
    if (error instanceof CheckpointStoryboardRecordStoreError) throw error;
    throw storeError("preview_publication_uncertain", "Checkpoint storyboard retained-trace preview input did not reopen exactly.");
  }
}

export async function resolveCheckpointStoryboardRetainedTraceStoredRecord(authority: CheckpointStoryboardRetainedTraceResolutionAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardRetainedTraceResolutionResult> {
  try { return await withCheckpointStoryboardRetainedTraceResolutionOutputAuthority(authority, async (host) => {
    const store = checkedAuthority(host.store), root = await readImmutableRecordRoot(store, identity);
    return await withLineageLock(store, root.id, async () => {
      const record = await readStoredRecordUnlocked(store, identity); assertB7Record(record); assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore(authority, host.store); await assertForeignPartitionEvidenceAbsent(store, identity);
      const outputHandle = checkpointStoryboardRetainedTraceResolutionOutputHandle(authority, identity); const state = await readRetainedTraceResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true }); await fault(authority, "while-lineage-lock-held");
      if (state.state === "abandoned") throw storeError("materialization_binding_conflict", "Checkpoint storyboard retained-trace resolution was terminally abandoned after a proved no-install outcome.");
      if (state.state === "detached") throw storeError("materialization_detached", "Checkpoint storyboard retained-trace resolution has terminally detached its link and cannot resolve again.");
      if (state.state === "bound") return await replayBound(store, host, identity, root, state.bindingId!, outputHandle);
      const prior = await readRetainedTraceIntent(store, identity);
      if (prior) {
        const recovered = await recognizeInstalledOutput(host, record.identity, prior.expectedBase, prior.plan);
        if (recovered) return await publishAndReopen(store, host, authority, identity, root, prior, recovered, outputHandle, true);
        if (await outputExists(host.outputPackageRoot) || await readRetainedTraceCowStart(store, identity)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard retained-trace resolution retains an occupied or COW-uncertain output for exact recovery and will not repeat COW.");
      } else if (await outputExists(host.outputPackageRoot)) {
        throw storeError("materialization_binding_uncertain", "Checkpoint storyboard retained-trace output is occupied without a durable intent and was retained without replacement.");
      }
      return await withCheckpointStoryboardRetainedTraceResolutionAuthority(authority, async (sourceHost) => {
        const c6bHost = { sourcePackageRoot: sourceHost.sourcePackageRoot, outputPackageRoot: sourceHost.outputPackageRoot, packageWorkspaceRoot: sourceHost.packageWorkspaceRoot, packageWorkspaceAuthority: sourceHost.packageWorkspaceAuthority };
        // B7b canonicalizes source and absent output, including intermediate aliases, before
        // it mints approval or C6C publishes a durable output intent.
        const prepared = await prepareCheckpointStoryboardRetainedTraceMaterialization(c6bHost, record.storyboard), plan = planIdentity(prepared), intent = createRetainedTraceIntent({ identity, root, plan, expectedBase: prepared.expected, outputHandle });
        if (prior && canonicalJson(prior) !== canonicalJson(intent)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard retained-trace intent conflicts with exact host-selected C6B7 facts.");
        if (!prior) { await publishRetainedTraceIntent(store, intent); await fault(authority, "after-intent-before-state-head"); await publishRetainedTraceStateHead(store, retainedTraceStateHead(identity, root, "preparing", 0, { intent: ref(intent) })); await fault(authority, "after-intent"); }
        if (await outputExists(sourceHost.outputPackageRoot)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard retained-trace output appeared after intent publication and was retained without replacement.");
        const start = createRetainedTraceCowStart({ identity, root, intent: ref(intent) }); await publishRetainedTraceCowStart(store, start); await fault(authority, "after-cow-start-before-state-head"); await publishRetainedTraceStateHead(store, retainedTraceStateHead(identity, root, "preparing", 0, { intent: ref(intent), cowStart: ref(start) })); await fault(authority, "after-cow-start");
        try { await fault(authority, "before-c6b7b"); await materializeCheckpointStoryboardRetainedTrace(c6bHost, prepared.approval, { schema: "shellx-motion/private-checkpoint-storyboard-retained-trace-materialization-request@1", expected: prepared.expected }); }
        catch (error) {
          const recovered = await recognizeInstalledOutput(sourceHost, record.identity, prepared.expected, plan);
          if (recovered) return await publishAndReopen(store, sourceHost, authority, identity, root, intent, recovered, outputHandle, true);
          if (isPublicationCommitUncertain(error) || await outputExists(sourceHost.outputPackageRoot)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard retained-trace publication may have committed; output was retained for exact recovery.");
          const abandon = createRetainedTraceAbandon({ identity, root, intent: ref(intent), reason: "proven-no-install" }); await publishRetainedTraceAbandon(store, abandon); await fault(authority, "after-abandon"); await publishRetainedTraceStateHead(store, retainedTraceStateHead(identity, root, "abandoned", 0, { intent: ref(intent), cowStart: ref(start), abandon: ref(abandon) }));
          throw storeError("materialization_binding_conflict", "Checkpoint storyboard retained-trace COW refused before a recognized output was installed.");
        }
        await fault(authority, "after-c6b7b-commit");
        const installed = await recognizeInstalledOutput(sourceHost, record.identity, prepared.expected, plan);
        if (!installed) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard retained-trace COW completed without an exact output reopen; output was retained.");
        return await publishAndReopen(store, sourceHost, authority, identity, root, intent, installed, outputHandle, false);
      });
    });
  }); } catch (error) { throw sanitized(error); }
}

export async function detachCheckpointStoryboardRetainedTraceStoredRecord(authority: CheckpointStoryboardRetainedTraceResolutionAuthority, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardRetainedTraceResolutionResult> {
  try { return await withCheckpointStoryboardRetainedTraceResolutionOutputAuthority(authority, async (host) => {
    const store = checkedAuthority(host.store), root = await readImmutableRecordRoot(store, identity);
    return await withLineageLock(store, root.id, async () => {
      const record = await readStoredRecordUnlocked(store, identity); assertB7Record(record); assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore(authority, host.store); await assertForeignPartitionEvidenceAbsent(store, identity);
      const outputHandle = checkpointStoryboardRetainedTraceResolutionOutputHandle(authority, identity); let state = await readRetainedTraceResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true });
      if (state.state === "unbound" || state.state === "abandoned") throw storeError("materialization_not_bound", "Checkpoint storyboard retained-trace record has no bound output to detach.");
      if (state.state === "preparing") {
        const intent = await readRetainedTraceIntent(store, identity), start = await readRetainedTraceCowStart(store, identity);
        if (intent) {
          const recovered = await recognizeInstalledOutput(host, record.identity, intent.expectedBase, intent.plan);
          if (recovered) { await publishAndReopen(store, host, authority, identity, root, intent, recovered, outputHandle, true); state = await readRetainedTraceResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true }); }
        }
        if (state.state === "preparing" && intent && !start && !(await outputExists(host.outputPackageRoot))) {
          const abandon = createRetainedTraceAbandon({ identity, root, intent: ref(intent), reason: "no-cow-start" }); await publishRetainedTraceAbandon(store, abandon); await publishRetainedTraceStateHead(store, retainedTraceStateHead(identity, root, "abandoned", 0, { intent: ref(intent), abandon: ref(abandon) }));
          throw storeError("materialization_not_bound", "Checkpoint storyboard retained-trace intent was abandoned before COW start; no output was deleted.");
        }
        if (state.state === "preparing") throw storeError("materialization_binding_uncertain", "Checkpoint storyboard retained-trace resolution is COW-uncertain; output was retained and cannot be detached yet.");
      }
      const binding = await readRetainedTraceBinding(store, identity);
      if (!binding) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace state lost immutable binding.");
      if (state.state === "detached") { await verifyBinding(host, binding, identity, outputHandle); return result(identity, binding, "detached", true); }
      await verifyBinding(host, binding, identity, outputHandle);
      // Detach retires only the durable link: it never deletes or rewrites the output package.
      const detach = createRetainedTraceDetach({ identity, root, binding: ref(binding) }); await publishRetainedTraceDetach(store, detach); await fault(authority, "after-detach");
      const intent = await readRetainedTraceIntent(store, identity), start = await readRetainedTraceCowStart(store, identity);
      if (!intent || !start) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace detach lost required intent or COW start.");
      await publishRetainedTraceStateHead(store, retainedTraceStateHead(identity, root, "detached", 0, { intent: ref(intent), cowStart: ref(start), binding: ref(binding), detach: ref(detach) }), async () => await fault(authority, "after-detached-state-head-rename"));
      const final = await readRetainedTraceResolutionState(store, identity, root, { requireHead: true, allowForwardRecovery: true });
      if (final.state !== "detached" || final.bindingId !== binding.id) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard retained-trace detach publication could not be reopened exactly.");
      return result(identity, binding, "detached", false);
    });
  }); } catch (error) { throw sanitized(error); }
}

function assertB7Record(record: Awaited<ReturnType<typeof readStoredRecordUnlocked>>): void {
  if (record.archive.terminal) throw storeError("lineage_archived", "Checkpoint storyboard lineage is terminally archived.");
  if (record.target.state === "tombstoned") throw storeError("record_tombstoned", "A tombstoned checkpoint storyboard record cannot resolve retained traces.");
  if (record.admission.profile !== "c6b7-retained-trace@1") throw storeError("materialization_profile_refused", "C6C B7 retained-trace resolution accepts only a sealed C6B7 retained-trace profile record.");
}

async function assertForeignPartitionEvidenceAbsent(store: ReturnType<typeof checkedAuthority>, identity: CheckpointStoryboardRecordIdentity): Promise<void> {
  await assertNoLegacyMaterializationEvidence(store, identity);
  await assertNoBehaviorResolutionEvidence(store, identity);
  await assertNoRelationResolutionEvidence(store, identity);
  await assertNoRelationActionResolutionEvidence(store, identity);
  await assertNoLifecycleResolutionEvidence(store, identity);
  await assertNoGeometryMorphResolutionEvidence(store, identity);
}

function planIdentity(prepared: Awaited<ReturnType<typeof prepareCheckpointStoryboardRetainedTraceMaterialization>>): RetainedTracePlanIdentity {
  const { expected, plan } = prepared;
  const sealed = plan as B7Plan;
  return Object.freeze({
    planFingerprint: expected.planFingerprint,
    profileFingerprint: expected.profileFingerprint,
    storyboardId: expected.storyboardId,
    storyboardSha256: expected.storyboardSha256,
    storyboardRevision: expected.storyboardRevision,
    sourceLayerId: expected.sourceLayerId,
    sourceLayerIndex: expected.sourceLayerIndex,
    staticOpacity: expected.staticOpacity,
    traceSourceSha256: expected.traceSourceSha256,
    tracePlanFingerprint: expected.tracePlanFingerprint,
    scheduleSha256: expected.scheduleSha256,
    sidecarCanonicalSha256: canonicalJsonSha256(sealed),
    packageId: expected.source.packageId,
    manifestRawSha256: expected.source.manifestRawSha256,
    manifestCanonicalSha256: expected.source.manifestCanonicalSha256,
    motionRawSha256: expected.source.motionRawSha256,
    motionCanonicalSha256: expected.source.motionCanonicalSha256,
  });
}

function ref(value: { readonly id: string; readonly sha256: string }) { return Object.freeze({ id: value.id, sha256: value.sha256 }); }
type Recognized = Readonly<{ output: Awaited<ReturnType<typeof reopenCheckpointStoryboardRetainedTraceMaterializationOutput>>; receipt: Awaited<ReturnType<typeof readC6B7bReceipt>>; plan: RetainedTracePlanIdentity }>;

type B7Plan = { readonly fingerprint: string; readonly lowererProfile: { readonly fingerprint: string }; readonly storyboard: { readonly id: string; readonly sha256: string; readonly revision: number }; readonly objectLayerBinding: { readonly layerId: string; readonly layerIndex: 0; readonly staticOpacity: number }; readonly projection: { readonly trace: { readonly sourceSha256: string; readonly fingerprint: string; readonly evidence: { readonly scheduleSha256: string } } } };

/** Reopen both the B7b receipt/output and its complete inventory; source authority is deliberately absent. */
async function recognizeInstalledOutput(host: { readonly outputPackageRoot: string; readonly packageWorkspaceRoot: string; readonly packageWorkspaceAuthority: Parameters<typeof reopenCheckpointStoryboardRetainedTraceMaterializationOutput>[0]["packageWorkspaceAuthority"] }, identity: CheckpointStoryboardRecordIdentity, expected: C6B7bExactBase, plan: RetainedTracePlanIdentity): Promise<Recognized | null> {
  try {
    const { output, receipt } = await withTrustedWorkspaceAnchor(host.packageWorkspaceAuthority, async () => Object.freeze({
      output: await reopenCheckpointStoryboardRetainedTraceMaterializationOutput(host),
      receipt: await readC6B7bReceipt(host.outputPackageRoot),
    }));
    const approvedPlan = receipt.approval.plan as B7Plan, base = receipt.approval.base;
    if (
      canonicalJson(base) !== canonicalJson(expected)
      || !samePlanIdentity(plan, approvedPlan) || !samePlanIdentity(plan, output)
      || receipt.approval.storyboard.id !== identity.id || receipt.approval.storyboard.sha256 !== identity.sha256 || receipt.approval.storyboard.revision !== identity.revision
      || receipt.output.package.packageId !== output.package.id || receipt.output.package.manifestRawSha256 !== output.package.manifestRawSha256 || receipt.output.package.manifestCanonicalSha256 !== output.package.manifestCanonicalSha256 || receipt.output.package.motionRawSha256 !== output.package.motionRawSha256 || receipt.output.package.motionCanonicalSha256 !== output.package.motionCanonicalSha256
      || receipt.output.sidecar.canonicalSha256 !== plan.sidecarCanonicalSha256 || receipt.output.changed.count !== 2 || receipt.output.changed.motionAndManifest !== "unchanged"
      || receipt.transaction.cow !== "closed-inventory-finalize-after-edit" || receipt.transaction.installed !== true || receipt.transaction.exclusiveArtifacts !== true || receipt.transaction.workspaceCleanup !== "not-attested"
      || receipt.renderer.invoked !== false || receipt.renderer.pixels !== false || receipt.renderer.gpuAbi !== "none" || receipt.renderer.upload !== "none"
      || output.renderer.invoked !== false || output.renderer.pixels !== false || output.renderer.gpuAbi !== "none" || output.renderer.upload !== "none"
    ) return null;
    return Object.freeze({ output, receipt, plan });
  } catch { return null; }
}

function samePlanIdentity(plan: RetainedTracePlanIdentity, value: B7Plan | Awaited<ReturnType<typeof reopenCheckpointStoryboardRetainedTraceMaterializationOutput>>): boolean {
  if ("lowererProfile" in value) return plan.planFingerprint === value.fingerprint && plan.profileFingerprint === value.lowererProfile.fingerprint && plan.storyboardId === value.storyboard.id && plan.storyboardSha256 === value.storyboard.sha256 && plan.storyboardRevision === value.storyboard.revision && plan.sourceLayerId === value.objectLayerBinding.layerId && plan.sourceLayerIndex === value.objectLayerBinding.layerIndex && plan.staticOpacity === value.objectLayerBinding.staticOpacity && plan.traceSourceSha256 === value.projection.trace.sourceSha256 && plan.tracePlanFingerprint === value.projection.trace.fingerprint && plan.scheduleSha256 === value.projection.trace.evidence.scheduleSha256;
  return plan.planFingerprint === value.planFingerprint && plan.profileFingerprint === value.profileFingerprint && plan.tracePlanFingerprint === value.tracePlanFingerprint && plan.packageId === value.package.id && plan.manifestRawSha256 === value.package.manifestRawSha256 && plan.manifestCanonicalSha256 === value.package.manifestCanonicalSha256 && plan.motionRawSha256 === value.package.motionRawSha256 && plan.motionCanonicalSha256 === value.package.motionCanonicalSha256;
}

async function publishAndReopen(store: ReturnType<typeof checkedAuthority>, host: Parameters<typeof recognizeInstalledOutput>[0], authority: CheckpointStoryboardRetainedTraceResolutionAuthority, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, intent: RetainedTraceIntent, recognized: Recognized, outputHandle: string, replayed: boolean): Promise<CheckpointStoryboardRetainedTraceResolutionResult> {
  const start = await readRetainedTraceCowStart(store, identity);
  if (!start || !sameIdentity(start.identity, identity) || !sameIdentity(start.root, root) || start.intent.id !== intent.id || start.intent.sha256 !== intent.sha256) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace binding lost durable COW-start evidence.");
  const binding = createRetainedTraceBinding({ identity, root, intent: ref(intent), plan: recognized.plan, source: Object.freeze({ expected: recognized.receipt.approval.base, reopened: recognized.receipt.approval.base }), output: Object.freeze({ expected: recognized.output, reopened: recognized.output }), sidecar: recognized.receipt.output.sidecar, receiptFingerprint: recognized.receipt.fingerprint, outputHandle });
  await publishRetainedTraceBinding(store, binding); await fault(authority, "after-binding");
  await publishRetainedTraceStateHead(store, retainedTraceStateHead(identity, root, "bound", 1, { intent: ref(intent), cowStart: ref(start), binding: ref(binding) }), async () => await fault(authority, "after-bound-state-head-rename"));
  const reopened = await readRetainedTraceBinding(store, identity);
  if (!reopened || canonicalJson(reopened) !== canonicalJson(binding)) throw storeError("materialization_binding_uncertain", "Checkpoint storyboard retained-trace binding publication could not be reopened exactly.");
  await verifyBinding(host, reopened, identity, outputHandle);
  return result(identity, reopened, "bound", replayed);
}

async function replayBound(store: ReturnType<typeof checkedAuthority>, host: Parameters<typeof recognizeInstalledOutput>[0], identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, bindingId: string, outputHandle: string): Promise<CheckpointStoryboardRetainedTraceResolutionResult> {
  const binding = await readRetainedTraceBinding(store, identity);
  if (!binding || binding.id !== bindingId || !sameIdentity(binding.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard bound retained-trace state does not match immutable binding.");
  await verifyBinding(host, binding, identity, outputHandle);
  return result(identity, binding, "bound", true);
}

async function verifyBinding(host: Parameters<typeof recognizeInstalledOutput>[0], binding: RetainedTraceBinding, identity: CheckpointStoryboardRecordIdentity, outputHandle: string): Promise<void> {
  if (binding.outputHandle !== outputHandle) throw storeError("materialization_binding_conflict", "Checkpoint storyboard retained-trace binding belongs to a different authority-store output handle.");
  const recognized = await recognizeInstalledOutput(host, identity, binding.source.expected, binding.plan);
  if (!recognized) throw storeError("materialization_binding_conflict", "Checkpoint storyboard retained-trace binding no longer reopens its complete B7b base, sidecar, full output inventory, receipt, and renderer identity.");
  const { output, receipt } = recognized;
  if (!recognized || receipt.fingerprint !== binding.receiptFingerprint || canonicalJson(output) !== canonicalJson(binding.output.expected) || canonicalJson(output) !== canonicalJson(binding.output.reopened) || canonicalJson(output.sidecar) !== canonicalJson(binding.sidecar) || canonicalJson(receipt.output.sidecar) !== canonicalJson(binding.sidecar) || canonicalJson(receipt.approval.base) !== canonicalJson(binding.source.expected) || canonicalJson(receipt.approval.base) !== canonicalJson(binding.source.reopened)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard retained-trace binding no longer reopens its complete B7b base, sidecar, full output inventory, receipt, and renderer identity.");
}

function result(identity: CheckpointStoryboardRecordIdentity, binding: RetainedTraceBinding, state: "bound" | "detached", replayed: boolean): CheckpointStoryboardRetainedTraceResolutionResult {
  return Object.freeze({ identity, binding: Object.freeze({ state, active: state === "bound" ? 1 as const : 0 as const, bindingId: binding.id, outputHandle: binding.outputHandle, receiptFingerprint: binding.receiptFingerprint }), renderer: Object.freeze({ invoked: false as const, pixels: false as const, gpuAbi: "none" as const, upload: "none" as const }), replayed });
}

async function outputExists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return false;
    throw storeError("materialization_binding_uncertain", "Checkpoint storyboard retained-trace output could not be safely classified as absent and was not recreated.");
  }
}

function sanitized(error: unknown): never {
  if (error instanceof CheckpointStoryboardRecordStoreError) throw error;
  throw storeError("materialization_binding_uncertain", "Checkpoint storyboard retained-trace resolution did not complete exact host/package verification; output was retained and no path evidence was returned.");
}
