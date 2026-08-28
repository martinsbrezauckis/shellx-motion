/** Typed Debug/MCP-only C6C B1 record lifecycle. It owns no package, renderer, or materializer. */
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { readStrictDataRecordEnvelope } from "./timeline-strict-data.js";
import {
  archiveCheckpointStoryboardStoredLineage,
  createCheckpointStoryboardStoredRecord,
  inspectCheckpointStoryboardStoredRecordAuditView,
  readCheckpointStoryboardRecordIdentity,
  tombstoneCheckpointStoryboardStoredRecord,
  type CheckpointStoryboardRecordIdentity,
  type CheckpointStoryboardRecordOperationEvidence,
  type CheckpointStoryboardRecordStoreAuthority,
  type CheckpointStoryboardStoredRecord,
  CheckpointStoryboardRecordStoreError,
} from "./checkpoint-storyboard-record-store.js";
import { sealCheckpointStoryboardRevisionDescriptor, sealUnparentedCheckpointStoryboardDescriptor } from "./checkpoint-storyboard-record-descriptor.js";
import type { CheckpointStoryboardMaterializationBindingState } from "./checkpoint-storyboard-record-store-types.js";
import { materializeCheckpointStoryboardStoredRecord, detachCheckpointStoryboardStoredRecord } from "./checkpoint-storyboard-materialization.js";
import { assertCheckpointStoryboardMaterializationAuthorityStore, type CheckpointStoryboardMaterializationAuthority } from "./checkpoint-storyboard-materialization-authority.js";
import { detachCheckpointStoryboardBehaviorStoredRecord, resolveCheckpointStoryboardBehaviorStoredRecord } from "./checkpoint-storyboard-behavior-resolution.js";
import { assertCheckpointStoryboardBehaviorResolutionAuthorityStore, type CheckpointStoryboardBehaviorResolutionAuthority } from "./checkpoint-storyboard-behavior-resolution-authority.js";
import { detachCheckpointStoryboardRelationStoredRecord, resolveCheckpointStoryboardRelationStoredRecord } from "./checkpoint-storyboard-relation-resolution.js";
import { assertCheckpointStoryboardRelationResolutionAuthorityStore, type CheckpointStoryboardRelationResolutionAuthority } from "./checkpoint-storyboard-relation-resolution-authority.js";
import { detachCheckpointStoryboardRelationActionStoredRecord, resolveCheckpointStoryboardRelationActionStoredRecord } from "./checkpoint-storyboard-relation-action-resolution.js";
import { assertCheckpointStoryboardRelationActionResolutionAuthorityStore, type CheckpointStoryboardRelationActionResolutionAuthority } from "./checkpoint-storyboard-relation-action-resolution-authority.js";
import { CHECKPOINT_STORYBOARD_PRIVATE_RESOLUTION_COMMANDS, dispatchCheckpointStoryboardPrivateResolutionCommand, type CheckpointStoryboardPrivateResolutionCommandServices } from "./checkpoint-storyboard-private-resolution-command.js";
import { previewCheckpointStoryboardStoredRecord, type CheckpointStoryboardPreviewRequestTarget } from "./checkpoint-storyboard-preview.js";
import { assertCheckpointStoryboardPreviewAuthorityStore, type CheckpointStoryboardPreviewAuthority } from "./checkpoint-storyboard-preview-authority.js";
import { assertCheckpointStoryboardCreativeReviewAuthorityStore, type CheckpointStoryboardCreativeReviewAuthority } from "./checkpoint-storyboard-creative-review-authority.js";
import { assertCheckpointStoryboardQualityReviewAuthorityStore, type CheckpointStoryboardQualityReviewAuthority } from "./checkpoint-storyboard-quality-review-authority.js";
import { reviewCheckpointStoryboardPreviewQuality, type CheckpointStoryboardQualityReviewResult } from "./checkpoint-storyboard-quality-review.js";
import type { CheckpointStoryboardQualityReviewInput } from "./checkpoint-storyboard-quality-review-types.js";
import { bindCheckpointStoryboardCreativeReview, type CheckpointStoryboardCreativeReviewInput } from "./checkpoint-storyboard-creative-review.js";
import type { CheckpointStoryboardCreativeReviewView } from "./checkpoint-storyboard-record-store-types.js";

export const CHECKPOINT_STORYBOARD_RECORD_COMMANDS = {
  create: "motion.timeline.checkpoint-storyboard.create",
  inspect: "motion.timeline.checkpoint-storyboard.inspect",
  revise: "motion.timeline.checkpoint-storyboard.revise",
  remove: "motion.timeline.checkpoint-storyboard.remove",
  archive: "motion.timeline.checkpoint-storyboard.archive",
  materialize: "motion.timeline.checkpoint-storyboard.materialize",
  detach: "motion.timeline.checkpoint-storyboard.detach",
  behaviorResolve: "motion.timeline.checkpoint-storyboard.behavior.resolve",
  behaviorDetach: "motion.timeline.checkpoint-storyboard.behavior.detach",
  relationResolve: "motion.timeline.checkpoint-storyboard.relation.resolve",
  relationDetach: "motion.timeline.checkpoint-storyboard.relation.detach",
  relationActionResolve: "motion.timeline.checkpoint-storyboard.relation-action.resolve",
  relationActionDetach: "motion.timeline.checkpoint-storyboard.relation-action.detach",
  ...CHECKPOINT_STORYBOARD_PRIVATE_RESOLUTION_COMMANDS,
  preview: "motion.timeline.checkpoint-storyboard.preview",
  creativeReviewBind: "motion.timeline.checkpoint-storyboard.creative-review.bind",
  previewQualityReview: "motion.timeline.checkpoint-storyboard.preview-quality.review",
} as const;

type CheckpointStoryboardRecordCommand = typeof CHECKPOINT_STORYBOARD_RECORD_COMMANDS[keyof typeof CHECKPOINT_STORYBOARD_RECORD_COMMANDS];
type Intent =
  | { readonly kind: "create"; readonly descriptor: unknown }
  | { readonly kind: "inspect"; readonly identity: CheckpointStoryboardRecordIdentity }
  | { readonly kind: "revise"; readonly parent: CheckpointStoryboardRecordIdentity; readonly descriptor: unknown }
  | { readonly kind: "remove"; readonly identity: CheckpointStoryboardRecordIdentity }
  | { readonly kind: "archive"; readonly identity: CheckpointStoryboardRecordIdentity }
  | { readonly kind: "materialize"; readonly identity: CheckpointStoryboardRecordIdentity }
  | { readonly kind: "detach"; readonly identity: CheckpointStoryboardRecordIdentity }
  | { readonly kind: "behaviorResolve"; readonly identity: CheckpointStoryboardRecordIdentity }
  | { readonly kind: "behaviorDetach"; readonly identity: CheckpointStoryboardRecordIdentity }
  | { readonly kind: "relationResolve"; readonly identity: CheckpointStoryboardRecordIdentity }
  | { readonly kind: "relationDetach"; readonly identity: CheckpointStoryboardRecordIdentity }
  | { readonly kind: "relationActionResolve"; readonly identity: CheckpointStoryboardRecordIdentity }
  | { readonly kind: "relationActionDetach"; readonly identity: CheckpointStoryboardRecordIdentity }
  | { readonly kind: "preview"; readonly identity: CheckpointStoryboardRecordIdentity; readonly target: CheckpointStoryboardPreviewRequestTarget }
  | { readonly kind: "creativeReviewBind"; readonly identity: CheckpointStoryboardRecordIdentity; readonly input: CheckpointStoryboardCreativeReviewInput }
  | { readonly kind: "previewQualityReview"; readonly identity: CheckpointStoryboardRecordIdentity; readonly input: CheckpointStoryboardQualityReviewInput };

export interface CheckpointStoryboardRecordLifecycleServices extends CheckpointStoryboardPrivateResolutionCommandServices {
  /** Opaque host configuration; command args can neither select nor inspect it. */
  checkpointStoryboardRecordStore?: CheckpointStoryboardRecordStoreAuthority;
  checkpointStoryboardMaterializationAuthority?: CheckpointStoryboardMaterializationAuthority;
  /** Opaque B2 host authority; exact command args are identity only. */
  checkpointStoryboardBehaviorResolutionAuthority?: CheckpointStoryboardBehaviorResolutionAuthority;
  /** Opaque B3a host authority; exact command args are identity only. */
  checkpointStoryboardRelationResolutionAuthority?: CheckpointStoryboardRelationResolutionAuthority;
  /** Opaque B4a host authority; exact command args are identity only. */
  checkpointStoryboardRelationActionResolutionAuthority?: CheckpointStoryboardRelationActionResolutionAuthority;
  /** Opaque B1b authority; it contains the matching B1a authority and private evidence root. */
  checkpointStoryboardPreviewAuthority?: CheckpointStoryboardPreviewAuthority;
  checkpointStoryboardCreativeReviewAuthority?: CheckpointStoryboardCreativeReviewAuthority;
  checkpointStoryboardQualityReviewAuthority?: CheckpointStoryboardQualityReviewAuthority;
  /** Local-coordinator cancellation only; no preview argument may provide a signal. */
  executionSignal?: AbortSignal;
}

export async function dispatchCheckpointStoryboardRecordLifecycleCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: CheckpointStoryboardRecordLifecycleServices,
): Promise<MotionDebugResult | null> {
  if (!isCommand(command)) return null;
  const privateResolution = await dispatchCheckpointStoryboardPrivateResolutionCommand(command, args, services);
  if (privateResolution) return privateResolution;
  const parsed = readIntent(command, args);
  if (!parsed.ok) return invalid(parsed.problem);
  if (!services.checkpointStoryboardRecordStore) return unavailable("Checkpoint storyboard record lifecycle requires a host-configured private record store.");
  try {
    if (parsed.intent.kind === "create") {
      const storyboard = sealUnparentedCheckpointStoryboardDescriptor(parsed.intent.descriptor);
      const created = await createCheckpointStoryboardStoredRecord(services.checkpointStoryboardRecordStore, storyboard);
      return success(command, created.record, created.replayed, created.evidence, created.materializationBinding);
    }
    if (parsed.intent.kind === "revise") {
      const storyboard = sealCheckpointStoryboardRevisionDescriptor(parsed.intent.descriptor, parsed.intent.parent, services.checkpointStoryboardRecordStore);
      const created = await createCheckpointStoryboardStoredRecord(services.checkpointStoryboardRecordStore, await storyboard, parsed.intent.parent);
      return success(command, created.record, created.replayed, created.evidence, created.materializationBinding);
    }
    if (parsed.intent.kind === "inspect") {
      const view = await inspectCheckpointStoryboardStoredRecordAuditView(services.checkpointStoryboardRecordStore, parsed.intent.identity);
      return success(command, view.record, false, undefined, view.materializationBinding, view.creativeReview);
    }
    if (parsed.intent.kind === "remove") {
      const removed = await tombstoneCheckpointStoryboardStoredRecord(services.checkpointStoryboardRecordStore, parsed.intent.identity);
      return success(command, removed.record, removed.replayed, removed.evidence, removed.materializationBinding);
    }
    if (parsed.intent.kind === "materialize") {
      if (!services.checkpointStoryboardMaterializationAuthority) return unavailable("Checkpoint storyboard materialization requires a host-configured opaque materialization authority.");
      assertCheckpointStoryboardMaterializationAuthorityStore(services.checkpointStoryboardMaterializationAuthority, services.checkpointStoryboardRecordStore);
      return materializationSuccess(command, await materializeCheckpointStoryboardStoredRecord(services.checkpointStoryboardMaterializationAuthority, parsed.intent.identity));
    }
    if (parsed.intent.kind === "detach") {
      if (!services.checkpointStoryboardMaterializationAuthority) return unavailable("Checkpoint storyboard detachment requires a host-configured opaque materialization authority.");
      assertCheckpointStoryboardMaterializationAuthorityStore(services.checkpointStoryboardMaterializationAuthority, services.checkpointStoryboardRecordStore);
      return detachSuccess(command, await detachCheckpointStoryboardStoredRecord(services.checkpointStoryboardMaterializationAuthority, parsed.intent.identity));
    }
    if (parsed.intent.kind === "behaviorResolve") {
      if (!services.checkpointStoryboardBehaviorResolutionAuthority) return unavailable("Checkpoint storyboard behavior resolution requires a host-configured opaque C6B2 authority.");
      assertCheckpointStoryboardBehaviorResolutionAuthorityStore(services.checkpointStoryboardBehaviorResolutionAuthority, services.checkpointStoryboardRecordStore);
      return behaviorResolutionSuccess(command, await resolveCheckpointStoryboardBehaviorStoredRecord(services.checkpointStoryboardBehaviorResolutionAuthority, parsed.intent.identity));
    }
    if (parsed.intent.kind === "behaviorDetach") {
      if (!services.checkpointStoryboardBehaviorResolutionAuthority) return unavailable("Checkpoint storyboard behavior detachment requires a host-configured opaque C6B2 authority.");
      assertCheckpointStoryboardBehaviorResolutionAuthorityStore(services.checkpointStoryboardBehaviorResolutionAuthority, services.checkpointStoryboardRecordStore);
      return behaviorResolutionSuccess(command, await detachCheckpointStoryboardBehaviorStoredRecord(services.checkpointStoryboardBehaviorResolutionAuthority, parsed.intent.identity));
    }
    if (parsed.intent.kind === "relationResolve") { if (!services.checkpointStoryboardRelationResolutionAuthority) return unavailable("Checkpoint storyboard relation resolution requires a host-configured opaque C6B3a authority."); assertCheckpointStoryboardRelationResolutionAuthorityStore(services.checkpointStoryboardRelationResolutionAuthority, services.checkpointStoryboardRecordStore); return relationResolutionSuccess(command, await resolveCheckpointStoryboardRelationStoredRecord(services.checkpointStoryboardRelationResolutionAuthority, parsed.intent.identity)); }
    if (parsed.intent.kind === "relationDetach") { if (!services.checkpointStoryboardRelationResolutionAuthority) return unavailable("Checkpoint storyboard relation detachment requires a host-configured opaque C6B3a authority."); assertCheckpointStoryboardRelationResolutionAuthorityStore(services.checkpointStoryboardRelationResolutionAuthority, services.checkpointStoryboardRecordStore); return relationResolutionSuccess(command, await detachCheckpointStoryboardRelationStoredRecord(services.checkpointStoryboardRelationResolutionAuthority, parsed.intent.identity)); }
    if (parsed.intent.kind === "relationActionResolve") { if (!services.checkpointStoryboardRelationActionResolutionAuthority) return unavailable("Checkpoint storyboard relation-action resolution requires a host-configured opaque C6B4a authority."); assertCheckpointStoryboardRelationActionResolutionAuthorityStore(services.checkpointStoryboardRelationActionResolutionAuthority, services.checkpointStoryboardRecordStore); return relationActionResolutionSuccess(command, await resolveCheckpointStoryboardRelationActionStoredRecord(services.checkpointStoryboardRelationActionResolutionAuthority, parsed.intent.identity)); }
    if (parsed.intent.kind === "relationActionDetach") { if (!services.checkpointStoryboardRelationActionResolutionAuthority) return unavailable("Checkpoint storyboard relation-action detachment requires a host-configured opaque C6B4a authority."); assertCheckpointStoryboardRelationActionResolutionAuthorityStore(services.checkpointStoryboardRelationActionResolutionAuthority, services.checkpointStoryboardRecordStore); return relationActionResolutionSuccess(command, await detachCheckpointStoryboardRelationActionStoredRecord(services.checkpointStoryboardRelationActionResolutionAuthority, parsed.intent.identity)); }
    if (parsed.intent.kind === "preview") {
      if (!services.checkpointStoryboardPreviewAuthority) return unavailable("Checkpoint storyboard Browser preview requires a host-configured opaque preview authority.");
      assertCheckpointStoryboardPreviewAuthorityStore(services.checkpointStoryboardPreviewAuthority, services.checkpointStoryboardRecordStore);
      return previewSuccess(command, await previewCheckpointStoryboardStoredRecord(services.checkpointStoryboardPreviewAuthority, parsed.intent.identity, parsed.intent.target, services.executionSignal));
    }
    if (parsed.intent.kind === "creativeReviewBind") {
      if (!services.checkpointStoryboardCreativeReviewAuthority) return unavailable("Checkpoint storyboard creative review requires a host-configured opaque C6C B1c authority.");
      assertCheckpointStoryboardCreativeReviewAuthorityStore(services.checkpointStoryboardCreativeReviewAuthority, services.checkpointStoryboardRecordStore);
      return creativeReviewSuccess(command, await bindCheckpointStoryboardCreativeReview(services.checkpointStoryboardCreativeReviewAuthority, parsed.intent.identity, parsed.intent.input));
    }
    if (parsed.intent.kind === "previewQualityReview") {
      if (!services.checkpointStoryboardQualityReviewAuthority) return unavailable("Checkpoint storyboard preview quality review requires a host-configured opaque C6C B1e authority.");
      assertCheckpointStoryboardQualityReviewAuthorityStore(services.checkpointStoryboardQualityReviewAuthority, services.checkpointStoryboardRecordStore);
      return qualityReviewSuccess(command, await reviewCheckpointStoryboardPreviewQuality(services.checkpointStoryboardQualityReviewAuthority, parsed.intent.identity, parsed.intent.input));
    }
    const archived = await archiveCheckpointStoryboardStoredLineage(services.checkpointStoryboardRecordStore, parsed.intent.identity);
    return success(command, archived.record, archived.replayed, archived.evidence, archived.materializationBinding);
  } catch (error) {
    if (error instanceof CheckpointStoryboardRecordStoreError) return { ok: false, error: { code: error.code, message: error.message }, warnings: [] };
    return { ok: false, error: { code: "checkpoint_storyboard_record_invalid", message: message(error) }, warnings: [] };
  }
}

function isCommand(command: string): command is CheckpointStoryboardRecordCommand { return Object.values(CHECKPOINT_STORYBOARD_RECORD_COMMANDS).includes(command as CheckpointStoryboardRecordCommand); }

function readIntent(command: CheckpointStoryboardRecordCommand, args: unknown): { ok: true; intent: Intent } | { ok: false; problem: string } {
  const allowed = command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create ? ["descriptor"]
    : command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise ? ["parent", "descriptor"] : ["identity"];
  const opaque = command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create || command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise ? ["descriptor"] : [];
  const preview = command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.preview;
  const creativeReview = command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.creativeReviewBind;
  const qualityReview = command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.previewQualityReview;
  const envelope = readStrictDataRecordEnvelope(args, "Arguments", preview ? ["identity", "target"] : creativeReview ? ["identity", "preview", "creativeReviewHandle"] : qualityReview ? ["identity", "preview", "review"] : allowed, opaque);
  if (!envelope.ok) return envelope;
  try {
    if (command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.create) return { ok: true, intent: { kind: "create", descriptor: required(envelope.value, "descriptor") } };
    if (command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.revise) return {
      ok: true,
      intent: { kind: "revise", parent: readCheckpointStoryboardRecordIdentity(required(envelope.value, "parent")), descriptor: required(envelope.value, "descriptor") },
    };
    const identity = readCheckpointStoryboardRecordIdentity(required(envelope.value, "identity"));
    if (preview) return { ok: true, intent: { kind: "preview", identity, target: readPreviewTarget(required(envelope.value, "target")) } };
    if (creativeReview) return { ok: true, intent: { kind: "creativeReviewBind", identity, input: readCreativeReviewInput(required(envelope.value, "preview"), required(envelope.value, "creativeReviewHandle")) } };
    if (qualityReview) return { ok: true, intent: { kind: "previewQualityReview", identity, input: readQualityReviewInput(required(envelope.value, "preview"), required(envelope.value, "review")) } };
    return { ok: true, intent: command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.inspect ? { kind: "inspect", identity }
      : command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.remove ? { kind: "remove", identity }
        : command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.materialize ? { kind: "materialize", identity }
          : command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.detach ? { kind: "detach", identity }
            : command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorResolve ? { kind: "behaviorResolve", identity }
              : command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.behaviorDetach ? { kind: "behaviorDetach", identity }
                : command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationResolve ? { kind: "relationResolve", identity }
                    : command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationDetach ? { kind: "relationDetach", identity }
                      : command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationActionResolve ? { kind: "relationActionResolve", identity }
                      : command === CHECKPOINT_STORYBOARD_RECORD_COMMANDS.relationActionDetach ? { kind: "relationActionDetach", identity } : { kind: "archive", identity } };
  } catch (error) { return { ok: false, problem: message(error) }; }
}

function success(command: string, record: CheckpointStoryboardStoredRecord, replayed: boolean, evidence: CheckpointStoryboardRecordOperationEvidence | undefined, materializationBinding: CheckpointStoryboardMaterializationBindingState, creativeReview?: CheckpointStoryboardCreativeReviewView): MotionDebugResult {
  const operation = command.slice("motion.".length);
  const result = {
    record: {
      identity: record.identity,
      storyboard: record.storyboard,
      lineage: record.lineage,
      // Public target state overlays the signed B1a journal. The stored target marker remains
      // immutable in the private record store and is intentionally not exposed as a second,
      // potentially contradictory public target shape.
      target: { state: record.target.state, activeMaterializationBindings: materializationBinding.active },
      archive: record.archive,
      admission: record.admission,
      materializationBinding,
    },
    ...(creativeReview ? { creativeReview } : {}),
    ...(evidence ? { evidence } : {}),
    ...(replayed ? { replay: "same-input" as const } : {}),
  };
  return {
    ok: true,
    visibleState: {
      panel: "checkpoint-storyboard",
      operation,
      recordId: record.identity.id,
      revision: record.identity.revision,
      targetState: record.target.state,
      lineageArchived: record.archive.terminal,
      staticProfileAdmitted: true,
      activeMaterializationBindings: materializationBinding.active,
      ...(evidence ? { evidenceId: evidence.id } : {}),
      ...(replayed ? { replay: "same-input" } : {}),
    },
    result: { ok: true, ...result },
    warnings: [],
  };
}

function materializationSuccess(command: string, result: Awaited<ReturnType<typeof materializeCheckpointStoryboardStoredRecord>>): MotionDebugResult {
  return {
    ok: true,
    visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: result.identity.id, revision: result.identity.revision, materializationState: "bound", activeMaterializationBindings: 1, ...(result.replayed ? { replay: "same-input" } : {}) },
    result: { ok: true, identity: result.identity, binding: result.binding, renderer: result.renderer, ...(result.replayed ? { replay: "same-input" } : {}) }, warnings: [],
  };
}
function detachSuccess(command: string, result: Awaited<ReturnType<typeof detachCheckpointStoryboardStoredRecord>>): MotionDebugResult {
  return {
    ok: true,
    visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: result.identity.id, revision: result.identity.revision, materializationState: "detached", activeMaterializationBindings: 0, ...(result.replayed ? { replay: "same-input" } : {}) },
    result: { ok: true, identity: result.identity, binding: result.binding, renderer: result.renderer, ...(result.replayed ? { replay: "same-input" } : {}) }, warnings: [],
  };
}
function behaviorResolutionSuccess(command: string, result: Awaited<ReturnType<typeof resolveCheckpointStoryboardBehaviorStoredRecord>>): MotionDebugResult {
  return {
    ok: true,
    visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: result.identity.id, revision: result.identity.revision, behaviorResolutionState: result.binding.state, activeBehaviorResolutionBindings: result.binding.active, ...(result.replayed ? { replay: "same-input" } : {}) },
    result: { ok: true, identity: result.identity, binding: result.binding, renderer: result.renderer, ...(result.replayed ? { replay: "same-input" } : {}) }, warnings: [],
  };
}
function relationResolutionSuccess(command: string, result: Awaited<ReturnType<typeof resolveCheckpointStoryboardRelationStoredRecord>>): MotionDebugResult { return { ok: true, visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: result.identity.id, revision: result.identity.revision, relationResolutionState: result.binding.state, activeRelationResolutionBindings: result.binding.active, ...(result.replayed ? { replay: "same-input" } : {}) }, result: { ok: true, identity: result.identity, binding: result.binding, renderer: result.renderer, ...(result.replayed ? { replay: "same-input" } : {}) }, warnings: [] }; }
function relationActionResolutionSuccess(command: string, result: Awaited<ReturnType<typeof resolveCheckpointStoryboardRelationActionStoredRecord>>): MotionDebugResult { return { ok: true, visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: result.identity.id, revision: result.identity.revision, relationActionResolutionState: result.binding.state, activeRelationActionResolutionBindings: result.binding.active, ...(result.replayed ? { replay: "same-input" } : {}) }, result: { ok: true, identity: result.identity, binding: result.binding, renderer: result.renderer, ...(result.replayed ? { replay: "same-input" } : {}) }, warnings: [] }; }
function previewSuccess(command: string, result: Awaited<ReturnType<typeof previewCheckpointStoryboardStoredRecord>>): MotionDebugResult {
  return {
    ok: true,
    visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: result.identity.id, revision: result.identity.revision, resolvedAtMs: result.resolvedAtMs, previewHandle: result.previewHandle, runtimeEvidence: result.browser.runtimeEvidence },
    result: { ok: true, ...result }, warnings: [],
  };
}
function creativeReviewSuccess(command: string, result: Awaited<ReturnType<typeof bindCheckpointStoryboardCreativeReview>>): MotionDebugResult { return { ok: true, visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: "private", creativeReviewOutcome: result.binding.outcome, runtimeEvidence: result.binding.preview.runtimeEvidence, ...(result.replayed ? { replay: "same-input" } : {}) }, result: { ok: true, creativeReview: result.binding, ...(result.replayed ? { replay: "same-input" } : {}) }, warnings: [] }; }
function qualityReviewSuccess(command: string, result: CheckpointStoryboardQualityReviewResult): MotionDebugResult {
  const detail = { qualityReceiptHandle: result.qualityReceiptHandle, verdict: result.verdict, finalAcceptance: "unavailable" as const, ...(result.replayed ? { replay: "same-input" as const } : {}) };
  if (result.verdict === "failed") return { ok: false, error: { code: "quality_check_failed", message: "Checkpoint storyboard authenticated PNG integrity review failed; the signed private receipt was retained but cannot produce final acceptance.", detail }, warnings: [] };
  return { ok: true, visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: "private", qualityReceipt: "retained", finalAcceptance: "unavailable", ...(result.replayed ? { replay: "same-input" } : {}) }, result: { ok: true, ...detail }, warnings: [] };
}

function required(record: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(record, key)) throw new Error(`Arguments requires ${key}.`);
  return record[key];
}
function readCreativeReviewInput(previewValue: unknown, handleValue: unknown): CheckpointStoryboardCreativeReviewInput {
  const read = (value: unknown, label: string, fields: readonly string[]) => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a plain data object.`); const record = value as Record<string, unknown>, keys = Object.keys(record); if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(record, field)) || keys.some((key) => !fields.includes(key))) throw new Error(`${label} fields are invalid.`); return record; };
  const preview = read(previewValue, "Creative review preview", ["previewHandle", "receiptHandle"]);
  if (typeof preview.previewHandle !== "string" || typeof preview.receiptHandle !== "string" || typeof handleValue !== "string" || !/^checkpoint_storyboard_creative_review_handle_[a-f0-9]{32}$/u.test(handleValue)) throw new Error("Creative review handles are invalid.");
  return Object.freeze({ preview: Object.freeze({ previewHandle: preview.previewHandle, receiptHandle: preview.receiptHandle }), creativeReviewHandle: handleValue });
}
function readQualityReviewInput(previewValue: unknown, reviewValue: unknown): CheckpointStoryboardQualityReviewInput {
  const read = (value: unknown, label: string, fields: readonly string[]) => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a plain data object.`); const record = value as Record<string, unknown>, keys = Object.keys(record); if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(record, field)) || keys.some((key) => !fields.includes(key))) throw new Error(`${label} fields are invalid.`); return record; };
  const preview = read(previewValue, "Quality review preview", ["previewHandle", "receiptHandle"]);
  if (typeof preview.previewHandle !== "string" || !/^checkpoint_storyboard_preview_[a-f0-9]{32}$/u.test(preview.previewHandle) || typeof preview.receiptHandle !== "string" || !/^checkpoint_storyboard_preview_receipt_[a-f0-9]{32}$/u.test(preview.receiptHandle)) throw new Error("Quality review preview handles are invalid.");
  if (!reviewValue || typeof reviewValue !== "object" || Array.isArray(reviewValue)) throw new Error("Quality review association must be a plain data object.");
  const review = reviewValue as Record<string, unknown>;
  if (review.kind === "interior") { const value = read(review, "Interior quality review", ["kind", "creativeReviewHandle"]); if (typeof value.creativeReviewHandle !== "string" || !/^checkpoint_storyboard_creative_review_handle_[a-f0-9]{32}$/u.test(value.creativeReviewHandle)) throw new Error("Interior quality review handle is invalid."); return Object.freeze({ preview: Object.freeze({ previewHandle: preview.previewHandle, receiptHandle: preview.receiptHandle }), review: Object.freeze({ kind: "interior" as const, creativeReviewHandle: value.creativeReviewHandle }) }); }
  if (review.kind === "terminal-endpoint") { const value = read(review, "Terminal endpoint quality review", ["kind", "endpointWitnessHandle"]); if (typeof value.endpointWitnessHandle !== "string" || !/^checkpoint_storyboard_endpoint_witness_handle_[a-f0-9]{32}$/u.test(value.endpointWitnessHandle)) throw new Error("Terminal endpoint quality review handle is invalid."); return Object.freeze({ preview: Object.freeze({ previewHandle: preview.previewHandle, receiptHandle: preview.receiptHandle }), review: Object.freeze({ kind: "terminal-endpoint" as const, endpointWitnessHandle: value.endpointWitnessHandle }) }); }
  throw new Error("Quality review association kind is invalid.");
}
function readPreviewTarget(value: unknown): CheckpointStoryboardPreviewRequestTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Preview target must be a plain data object.");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.kind === "checkpoint" && keys.length === 2 && Object.hasOwn(record, "checkpointId") && typeof record.checkpointId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(record.checkpointId)) return Object.freeze({ kind: "checkpoint", checkpointId: record.checkpointId });
  if (record.kind === "time" && keys.length === 2 && Object.hasOwn(record, "atMs") && typeof record.atMs === "number" && Number.isSafeInteger(record.atMs) && record.atMs >= 0) return Object.freeze({ kind: "time", atMs: record.atMs });
  throw new Error("Preview target must be exactly `{kind:'checkpoint',checkpointId}` or `{kind:'time',atMs}`.");
}
function invalid(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] }; }
function message(error: unknown): string { return error instanceof Error ? error.message : "Checkpoint storyboard record request is invalid."; }
