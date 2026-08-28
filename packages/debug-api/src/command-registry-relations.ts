/** Literal registry leaf for document-root relations@1 authoring. */
import type { MotionDebugCommandDefinitionBase } from "./command-registry.js";

export const TIMELINE_RELATION_COMMAND_DEFINITIONS = [
  { command: "motion.timeline.relations.inspect", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.relations.upsert", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.relations.enabled.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.relations.remove", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.relations.detach", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.relations.bake", domain: "timeline", permission: "edit_motion", mutates: true },
] as const satisfies readonly MotionDebugCommandDefinitionBase[];
