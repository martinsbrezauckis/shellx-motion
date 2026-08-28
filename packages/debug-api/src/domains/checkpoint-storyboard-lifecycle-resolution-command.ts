/** C6C B5 Debug command boundary; lifecycle resolution remains host-authorized and identity-only. */
import type { MotionDebugResult } from "../command-registry.js";
import { readStrictDataRecordEnvelope } from "./timeline-strict-data.js";
import {
  CheckpointStoryboardRecordStoreError,
  readCheckpointStoryboardRecordIdentity,
  type CheckpointStoryboardRecordIdentity,
  type CheckpointStoryboardRecordStoreAuthority,
} from "./checkpoint-storyboard-record-store.js";
import { detachCheckpointStoryboardLifecycleStoredRecord, resolveCheckpointStoryboardLifecycleStoredRecord } from "./checkpoint-storyboard-lifecycle-resolution.js";
import { assertCheckpointStoryboardLifecycleResolutionAuthorityStore, type CheckpointStoryboardLifecycleResolutionAuthority } from "./checkpoint-storyboard-lifecycle-resolution-authority.js";

export const CHECKPOINT_STORYBOARD_LIFECYCLE_RESOLUTION_COMMANDS = {
  lifecycleResolve: "motion.timeline.checkpoint-storyboard.lifecycle.resolve",
  lifecycleDetach: "motion.timeline.checkpoint-storyboard.lifecycle.detach",
} as const;

type CheckpointStoryboardLifecycleResolutionCommand = typeof CHECKPOINT_STORYBOARD_LIFECYCLE_RESOLUTION_COMMANDS[keyof typeof CHECKPOINT_STORYBOARD_LIFECYCLE_RESOLUTION_COMMANDS];

export interface CheckpointStoryboardLifecycleResolutionCommandServices {
  checkpointStoryboardRecordStore?: CheckpointStoryboardRecordStoreAuthority;
  /** Opaque B5 host authority; exact command args are identity only. */
  checkpointStoryboardLifecycleResolutionAuthority?: CheckpointStoryboardLifecycleResolutionAuthority;
}

/** Returns null only for commands outside this B5-only dispatch boundary. */
export async function dispatchCheckpointStoryboardLifecycleResolutionCommand(
  command: string,
  args: unknown,
  services: CheckpointStoryboardLifecycleResolutionCommandServices,
): Promise<MotionDebugResult | null> {
  if (!isCommand(command)) return null;
  const parsed = readIdentity(args);
  if (!parsed.ok) return invalid(parsed.problem);
  if (!services.checkpointStoryboardRecordStore) return unavailable("Checkpoint storyboard record lifecycle requires a host-configured private record store.");
  try {
    if (!services.checkpointStoryboardLifecycleResolutionAuthority) {
      return unavailable(command === CHECKPOINT_STORYBOARD_LIFECYCLE_RESOLUTION_COMMANDS.lifecycleResolve
        ? "Checkpoint storyboard lifecycle resolution requires a host-configured opaque C6B5 authority."
        : "Checkpoint storyboard lifecycle detachment requires a host-configured opaque C6B5 authority.");
    }
    assertCheckpointStoryboardLifecycleResolutionAuthorityStore(services.checkpointStoryboardLifecycleResolutionAuthority, services.checkpointStoryboardRecordStore);
    const result = command === CHECKPOINT_STORYBOARD_LIFECYCLE_RESOLUTION_COMMANDS.lifecycleResolve
      ? await resolveCheckpointStoryboardLifecycleStoredRecord(services.checkpointStoryboardLifecycleResolutionAuthority, parsed.identity)
      : await detachCheckpointStoryboardLifecycleStoredRecord(services.checkpointStoryboardLifecycleResolutionAuthority, parsed.identity);
    return success(command, result);
  } catch (error) {
    if (error instanceof CheckpointStoryboardRecordStoreError) return { ok: false, error: { code: error.code, message: error.message }, warnings: [] };
    return { ok: false, error: { code: "checkpoint_storyboard_record_invalid", message: message(error) }, warnings: [] };
  }
}

function isCommand(command: string): command is CheckpointStoryboardLifecycleResolutionCommand {
  return Object.values(CHECKPOINT_STORYBOARD_LIFECYCLE_RESOLUTION_COMMANDS).includes(command as CheckpointStoryboardLifecycleResolutionCommand);
}
function readIdentity(args: unknown): { ok: true; identity: CheckpointStoryboardRecordIdentity } | { ok: false; problem: string } {
  const envelope = readStrictDataRecordEnvelope(args, "Arguments", ["identity"]);
  if (!envelope.ok) return envelope;
  try { return { ok: true, identity: readCheckpointStoryboardRecordIdentity(required(envelope.value, "identity")) }; } catch (error) { return { ok: false, problem: message(error) }; }
}
function success(command: string, result: Awaited<ReturnType<typeof resolveCheckpointStoryboardLifecycleStoredRecord>>): MotionDebugResult {
  return { ok: true, visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: result.identity.id, revision: result.identity.revision, lifecycleResolutionState: result.binding.state, activeLifecycleResolutionBindings: result.binding.active, ...(result.replayed ? { replay: "same-input" } : {}) }, result: { ok: true, identity: result.identity, binding: result.binding, renderer: result.renderer, ...(result.replayed ? { replay: "same-input" } : {}) }, warnings: [] };
}
function required(record: Record<string, unknown>, key: string): unknown { if (!Object.hasOwn(record, key)) throw new Error(`Arguments requires ${key}.`); return record[key]; }
function invalid(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] }; }
function message(error: unknown): string { return error instanceof Error ? error.message : "Checkpoint storyboard record request is invalid."; }
