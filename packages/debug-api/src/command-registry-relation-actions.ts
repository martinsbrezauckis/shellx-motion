/** Literal registry leaf for persisted relation-actions@2 authoring. */
import type { MotionDebugCommandDefinitionBase } from "./command-registry.js";

export const TIMELINE_RELATION_ACTION_COMMAND_DEFINITIONS = [
  { command: "motion.timeline.relation-actions.inspect", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.relation-actions.upsert", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.relation-actions.remove", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.relation-actions.apply", domain: "timeline", permission: "edit_motion", mutates: true },
] as const satisfies readonly MotionDebugCommandDefinitionBase[];
