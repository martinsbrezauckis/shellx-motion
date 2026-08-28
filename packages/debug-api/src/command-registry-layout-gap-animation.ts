import type { MotionDebugCommandDefinitionBase } from "./command-registry.js";

export const TIMELINE_LAYOUT_GAP_ANIMATION_COMMAND_DEFINITIONS = [
  { command: "motion.timeline.layout-gap-animation.inspect", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.layout-gap-animation.track.upsert", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layout-gap-animation.track.remove", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layout-gap-animation.keyframe.upsert", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layout-gap-animation.keyframe.delete", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layout-gap-animation.keyframe.move", domain: "timeline", permission: "edit_motion", mutates: true },
] as const satisfies readonly MotionDebugCommandDefinitionBase[];
