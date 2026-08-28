/** C6C B7 Debug command boundary; retained-trace resolution is identity-only. */
import type { MotionDebugResult } from "../command-registry.js";
import { readStrictDataRecordEnvelope } from "./timeline-strict-data.js";
import {
  CheckpointStoryboardRecordStoreError,
  readCheckpointStoryboardRecordIdentity,
  type CheckpointStoryboardRecordIdentity,
  type CheckpointStoryboardRecordStoreAuthority,
} from "./checkpoint-storyboard-record-store.js";
import { detachCheckpointStoryboardRetainedTraceStoredRecord, resolveCheckpointStoryboardRetainedTraceStoredRecord } from "./checkpoint-storyboard-retained-trace-resolution.js";
import { assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore, type CheckpointStoryboardRetainedTraceResolutionAuthority } from "./checkpoint-storyboard-retained-trace-resolution-authority.js";
import { previewCheckpointStoryboardRetainedTraceStoredRecord } from "./checkpoint-storyboard-retained-trace-preview.js";
import { assertCheckpointStoryboardRetainedTracePreviewAuthorityStore, type CheckpointStoryboardRetainedTracePreviewAuthority } from "./checkpoint-storyboard-retained-trace-preview-authority.js";
import { bindCheckpointStoryboardRetainedTraceReview } from "./checkpoint-storyboard-retained-trace-review.js";
import { assertCheckpointStoryboardRetainedTraceReviewAuthorityStore, type CheckpointStoryboardRetainedTraceReviewAuthority } from "./checkpoint-storyboard-retained-trace-review-authority.js";

export const CHECKPOINT_STORYBOARD_RETAINED_TRACE_RESOLUTION_COMMANDS = {
  retainedTraceResolve: "motion.timeline.checkpoint-storyboard.retained-trace.resolve",
  retainedTraceDetach: "motion.timeline.checkpoint-storyboard.retained-trace.detach",
  retainedTracePreview: "motion.timeline.checkpoint-storyboard.retained-trace.preview",
  retainedTraceReviewBind: "motion.timeline.checkpoint-storyboard.retained-trace.review.bind",
} as const;

type RetainedTraceResolutionCommand = typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_RESOLUTION_COMMANDS[keyof typeof CHECKPOINT_STORYBOARD_RETAINED_TRACE_RESOLUTION_COMMANDS];

export interface CheckpointStoryboardRetainedTraceResolutionCommandServices {
  checkpointStoryboardRecordStore?: CheckpointStoryboardRecordStoreAuthority;
  /** Opaque B7 host authority; exact command args are identity only. */
  checkpointStoryboardRetainedTraceResolutionAuthority?: CheckpointStoryboardRetainedTraceResolutionAuthority;
  /** Opaque B7 preview authority; command data can select only identity and exact atUs. */
  checkpointStoryboardRetainedTracePreviewAuthority?: CheckpointStoryboardRetainedTracePreviewAuthority;
  /** Opaque B7 review authority; command data contains only identity and opaque handles. */
  checkpointStoryboardRetainedTraceReviewAuthority?: CheckpointStoryboardRetainedTraceReviewAuthority;
  executionSignal?: AbortSignal;
}

/** Returns null only for commands outside this B7-only dispatch boundary. */
export async function dispatchCheckpointStoryboardRetainedTraceResolutionCommand(
  command: string,
  args: unknown,
  services: CheckpointStoryboardRetainedTraceResolutionCommandServices,
): Promise<MotionDebugResult | null> {
  if (!isCommand(command)) return null;
  if (command === CHECKPOINT_STORYBOARD_RETAINED_TRACE_RESOLUTION_COMMANDS.retainedTraceReviewBind) {
    const parsed = readReview(args);
    if (!parsed.ok) return invalid(parsed.problem);
    if (!services.checkpointStoryboardRecordStore) return unavailable("Checkpoint storyboard record lifecycle requires a host-configured private record store.");
    try {
      const authority = services.checkpointStoryboardRetainedTraceReviewAuthority;
      if (!authority) return unavailable("Checkpoint storyboard retained-trace review requires a host-configured opaque B7 review authority.");
      assertCheckpointStoryboardRetainedTraceReviewAuthorityStore(authority, services.checkpointStoryboardRecordStore);
      const result = await bindCheckpointStoryboardRetainedTraceReview(authority, parsed.identity, { preview: parsed.preview, reviewHandle: parsed.reviewHandle });
      return { ok: true, visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: parsed.identity.id, revision: parsed.identity.revision, atUs: result.review.scope.atUs, retainedTraceReview: result.review.outcome, ...(result.replayed ? { replay: "same-input" } : {}) }, result: { ok: true, review: result.review, ...(result.replayed ? { replay: "same-input" } : {}) }, warnings: [] };
    } catch (error) { return commandFailure(error); }
  }
  if (command === CHECKPOINT_STORYBOARD_RETAINED_TRACE_RESOLUTION_COMMANDS.retainedTracePreview) {
    const parsed = readPreview(args);
    if (!parsed.ok) return invalid(parsed.problem);
    if (!services.checkpointStoryboardRecordStore) return unavailable("Checkpoint storyboard record lifecycle requires a host-configured private record store.");
    try {
      const authority = services.checkpointStoryboardRetainedTracePreviewAuthority;
      if (!authority) return unavailable("Checkpoint storyboard retained-trace preview requires a host-configured opaque C6B7 preview authority.");
      assertCheckpointStoryboardRetainedTracePreviewAuthorityStore(authority, services.checkpointStoryboardRecordStore);
      return previewSuccess(command, await previewCheckpointStoryboardRetainedTraceStoredRecord(authority, parsed.identity, parsed.atUs, services.executionSignal));
    } catch (error) {
      return commandFailure(error);
    }
  }
  const parsed = readIdentity(args);
  if (!parsed.ok) return invalid(parsed.problem);
  if (!services.checkpointStoryboardRecordStore) return unavailable("Checkpoint storyboard record lifecycle requires a host-configured private record store.");
  try {
    const authority = services.checkpointStoryboardRetainedTraceResolutionAuthority;
    if (!authority) {
      return unavailable(command === CHECKPOINT_STORYBOARD_RETAINED_TRACE_RESOLUTION_COMMANDS.retainedTraceResolve
        ? "Checkpoint storyboard retained-trace resolution requires a host-configured opaque C6B7 authority."
        : "Checkpoint storyboard retained-trace detachment requires a host-configured opaque C6B7 authority.");
    }
    assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore(authority, services.checkpointStoryboardRecordStore);
    const result = command === CHECKPOINT_STORYBOARD_RETAINED_TRACE_RESOLUTION_COMMANDS.retainedTraceResolve
      ? await resolveCheckpointStoryboardRetainedTraceStoredRecord(authority, parsed.identity)
      : await detachCheckpointStoryboardRetainedTraceStoredRecord(authority, parsed.identity);
    return success(command, result);
  } catch (error) {
    return commandFailure(error);
  }
}

function isCommand(command: string): command is RetainedTraceResolutionCommand { return Object.values(CHECKPOINT_STORYBOARD_RETAINED_TRACE_RESOLUTION_COMMANDS).includes(command as RetainedTraceResolutionCommand); }
function readIdentity(args: unknown): { ok: true; identity: CheckpointStoryboardRecordIdentity } | { ok: false; problem: string } {
  const envelope = readStrictDataRecordEnvelope(args, "Arguments", ["identity"]);
  if (!envelope.ok) return envelope;
  try { return { ok: true, identity: readCheckpointStoryboardRecordIdentity(required(envelope.value, "identity")) }; } catch (error) { return { ok: false, problem: message(error) }; }
}
function readPreview(args: unknown): { ok: true; identity: CheckpointStoryboardRecordIdentity; atUs: number } | { ok: false; problem: string } {
  const envelope = readStrictDataRecordEnvelope(args, "Arguments", ["identity", "atUs"]);
  if (!envelope.ok) return envelope;
  try {
    const atUs = required(envelope.value, "atUs");
    if (typeof atUs !== "number" || !Number.isSafeInteger(atUs) || atUs < 0 || atUs > 3_600_000_000) throw new Error("Arguments.atUs must be a safe integer in 0..3600000000.");
    return { ok: true, identity: readCheckpointStoryboardRecordIdentity(required(envelope.value, "identity")), atUs };
  } catch (error) { return { ok: false, problem: message(error) }; }
}
function readReview(args: unknown): { ok: true; identity: CheckpointStoryboardRecordIdentity; preview: { previewHandle: string; receiptHandle: string }; reviewHandle: string } | { ok: false; problem: string } {
  const envelope = readStrictDataRecordEnvelope(args, "Arguments", ["identity", "preview", "reviewHandle"]);
  if (!envelope.ok) return envelope;
  try {
    const value = required(envelope.value, "preview");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Arguments.preview must be a plain object.");
    const preview = value as Record<string, unknown>, keys = Object.keys(preview);
    if (keys.length !== 2 || !Object.hasOwn(preview, "previewHandle") || !Object.hasOwn(preview, "receiptHandle") || typeof preview.previewHandle !== "string" || !/^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}$/u.test(preview.previewHandle) || typeof preview.receiptHandle !== "string" || !/^checkpoint_storyboard_retained_trace_preview_receipt_[a-f0-9]{32}$/u.test(preview.receiptHandle)) throw new Error("Arguments.preview handles are invalid.");
    const reviewHandle = required(envelope.value, "reviewHandle");
    if (typeof reviewHandle !== "string" || !/^checkpoint_storyboard_retained_trace_review_handle_[a-f0-9]{32}$/u.test(reviewHandle)) throw new Error("Arguments.reviewHandle is invalid.");
    return { ok: true, identity: readCheckpointStoryboardRecordIdentity(required(envelope.value, "identity")), preview: { previewHandle: preview.previewHandle, receiptHandle: preview.receiptHandle }, reviewHandle };
  } catch (error) { return { ok: false, problem: message(error) }; }
}
function success(command: string, result: Awaited<ReturnType<typeof resolveCheckpointStoryboardRetainedTraceStoredRecord>>): MotionDebugResult {
  return { ok: true, visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: result.identity.id, revision: result.identity.revision, retainedTraceResolutionState: result.binding.state, activeRetainedTraceResolutionBindings: result.binding.active, ...(result.replayed ? { replay: "same-input" } : {}) }, result: { ok: true, identity: result.identity, binding: result.binding, renderer: result.renderer, ...(result.replayed ? { replay: "same-input" } : {}) }, warnings: [] };
}
function previewSuccess(command: string, result: Awaited<ReturnType<typeof previewCheckpointStoryboardRetainedTraceStoredRecord>>): MotionDebugResult {
  return { ok: true, visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: result.identity.id, revision: result.identity.revision, atUs: result.atUs, retainedTracePreview: "complete" }, result: { ok: true, ...result }, warnings: [] };
}
function required(record: Record<string, unknown>, key: string): unknown { if (!Object.hasOwn(record, key)) throw new Error(`Arguments requires ${key}.`); return record[key]; }
function invalid(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] }; }
function commandFailure(error: unknown): MotionDebugResult {
  if (error instanceof CheckpointStoryboardRecordStoreError) return { ok: false, error: { code: error.code, message: error.message }, warnings: [] };
  return { ok: false, error: { code: "checkpoint_storyboard_record_invalid", message: message(error) }, warnings: [] };
}
function message(error: unknown): string { return error instanceof Error ? error.message : "Checkpoint storyboard record request is invalid."; }
