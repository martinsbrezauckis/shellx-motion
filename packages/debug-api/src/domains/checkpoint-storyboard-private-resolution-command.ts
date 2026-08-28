/** Aggregate dispatcher for the distinct private B5, B6, and B7 identity-only command partitions. */
import type { MotionDebugResult } from "../command-registry.js";
import { CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_RESOLUTION_COMMANDS, dispatchCheckpointStoryboardGeometryMorphResolutionCommand, type CheckpointStoryboardGeometryMorphResolutionCommandServices } from "./checkpoint-storyboard-geometry-morph-resolution-command.js";
import { CHECKPOINT_STORYBOARD_LIFECYCLE_RESOLUTION_COMMANDS, dispatchCheckpointStoryboardLifecycleResolutionCommand, type CheckpointStoryboardLifecycleResolutionCommandServices } from "./checkpoint-storyboard-lifecycle-resolution-command.js";
import { CHECKPOINT_STORYBOARD_RETAINED_TRACE_RESOLUTION_COMMANDS, dispatchCheckpointStoryboardRetainedTraceResolutionCommand, type CheckpointStoryboardRetainedTraceResolutionCommandServices } from "./checkpoint-storyboard-retained-trace-resolution-command.js";

export const CHECKPOINT_STORYBOARD_PRIVATE_RESOLUTION_COMMANDS = {
  ...CHECKPOINT_STORYBOARD_LIFECYCLE_RESOLUTION_COMMANDS,
  ...CHECKPOINT_STORYBOARD_GEOMETRY_MORPH_RESOLUTION_COMMANDS,
  ...CHECKPOINT_STORYBOARD_RETAINED_TRACE_RESOLUTION_COMMANDS,
} as const;

export interface CheckpointStoryboardPrivateResolutionCommandServices extends CheckpointStoryboardLifecycleResolutionCommandServices, CheckpointStoryboardGeometryMorphResolutionCommandServices, CheckpointStoryboardRetainedTraceResolutionCommandServices {}

export async function dispatchCheckpointStoryboardPrivateResolutionCommand(
  command: string,
  args: unknown,
  services: CheckpointStoryboardPrivateResolutionCommandServices,
): Promise<MotionDebugResult | null> {
  const lifecycle = await dispatchCheckpointStoryboardLifecycleResolutionCommand(command, args, services);
  if (lifecycle) return lifecycle;
  const geometry = await dispatchCheckpointStoryboardGeometryMorphResolutionCommand(command, args, services);
  if (geometry) return geometry;
  return await dispatchCheckpointStoryboardRetainedTraceResolutionCommand(command, args, services);
}
