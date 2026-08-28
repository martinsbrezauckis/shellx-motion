/** C6C B6 Debug command boundary; geometry-morph resolution is identity-only. */
import type { MotionDebugResult } from "../command-registry.js";
import { readStrictDataRecordEnvelope } from "./timeline-strict-data.js";
import {
  CheckpointStoryboardRecordStoreError,
  readCheckpointStoryboardRecordIdentity,
  type CheckpointStoryboardRecordIdentity,
  type CheckpointStoryboardRecordStoreAuthority,
} from "./checkpoint-storyboard-record-store.js";
import { detachCheckpointStoryboardGeometryMorphStoredRecord, resolveCheckpointStoryboardGeometryMorphStoredRecord } from "./checkpoint-storyboard-geometry-morph-resolution.js";
import { assertCheckpointStoryboardGeometryMorphResolutionAuthorityStore, type CheckpointStoryboardGeometryMorphResolutionAuthority } from "./checkpoint-storyboard-geometry-morph-resolution-authority.js";

export const CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_RESOLUTION_COMMANDS = {
  geometryMorphResolve: "motion.timeline.checkpoint-storyboard.geometry-morph.resolve",
  geometryMorphDetach: "motion.timeline.checkpoint-storyboard.geometry-morph.detach",
} as const;

type GeometryMorphResolutionCommand = typeof CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_RESOLUTION_COMMANDS[keyof typeof CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_RESOLUTION_COMMANDS];

export interface CheckpointStoryboardGeometryMorphResolutionCommandServices {
  checkpointStoryboardRecordStore?: CheckpointStoryboardRecordStoreAuthority;
  /** Opaque B6 host authority; exact command args are identity only. */
  checkpointStoryboardGeometryMorphResolutionAuthority?: CheckpointStoryboardGeometryMorphResolutionAuthority;
}

/** Returns null only for commands outside this B6-only dispatch boundary. */
export async function dispatchCheckpointStoryboardGeometryMorphResolutionCommand(
  command: string,
  args: unknown,
  services: CheckpointStoryboardGeometryMorphResolutionCommandServices,
): Promise<MotionDebugResult | null> {
  if (!isCommand(command)) return null;
  const parsed = readIdentity(args);
  if (!parsed.ok) return invalid(parsed.problem);
  if (!services.checkpointStoryboardRecordStore) return unavailable("Checkpoint storyboard record lifecycle requires a host-configured private record store.");
  try {
    const authority = services.checkpointStoryboardGeometryMorphResolutionAuthority;
    if (!authority) {
      return unavailable(command === CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_RESOLUTION_COMMANDS.geometryMorphResolve
        ? "Checkpoint storyboard geometry-morph resolution requires a host-configured opaque C6B6 authority."
        : "Checkpoint storyboard geometry-morph detachment requires a host-configured opaque C6B6 authority.");
    }
    assertCheckpointStoryboardGeometryMorphResolutionAuthorityStore(authority, services.checkpointStoryboardRecordStore);
    const result = command === CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_RESOLUTION_COMMANDS.geometryMorphResolve
      ? await resolveCheckpointStoryboardGeometryMorphStoredRecord(authority, parsed.identity)
      : await detachCheckpointStoryboardGeometryMorphStoredRecord(authority, parsed.identity);
    return success(command, result);
  } catch (error) {
    if (error instanceof CheckpointStoryboardRecordStoreError) return { ok: false, error: { code: error.code, message: error.message }, warnings: [] };
    return { ok: false, error: { code: "checkpoint_storyboard_record_invalid", message: message(error) }, warnings: [] };
  }
}

function isCommand(command: string): command is GeometryMorphResolutionCommand { return Object.values(CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_RESOLUTION_COMMANDS).includes(command as GeometryMorphResolutionCommand); }
function readIdentity(args: unknown): { ok: true; identity: CheckpointStoryboardRecordIdentity } | { ok: false; problem: string } {
  const envelope = readStrictDataRecordEnvelope(args, "Arguments", ["identity"]);
  if (!envelope.ok) return envelope;
  try { return { ok: true, identity: readCheckpointStoryboardRecordIdentity(required(envelope.value, "identity")) }; } catch (error) { return { ok: false, problem: message(error) }; }
}
function success(command: string, result: Awaited<ReturnType<typeof resolveCheckpointStoryboardGeometryMorphStoredRecord>>): MotionDebugResult {
  return { ok: true, visibleState: { panel: "checkpoint-storyboard", operation: command.slice("motion.".length), recordId: result.identity.id, revision: result.identity.revision, geometryMorphResolutionState: result.binding.state, activeGeometryMorphResolutionBindings: result.binding.active, ...(result.replayed ? { replay: "same-input" } : {}) }, result: { ok: true, identity: result.identity, binding: result.binding, renderer: result.renderer, ...(result.replayed ? { replay: "same-input" } : {}) }, warnings: [] };
}
function required(record: Record<string, unknown>, key: string): unknown { if (!Object.hasOwn(record, key)) throw new Error(`Arguments requires ${key}.`); return record[key]; }
function invalid(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] }; }
function message(error: unknown): string { return error instanceof Error ? error.message : "Checkpoint storyboard record request is invalid."; }
