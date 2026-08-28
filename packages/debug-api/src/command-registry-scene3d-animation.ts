/** Literal registry leaf for closed persisted scene3d animation authoring. */
import type { MotionDebugCommandDefinitionBase } from "./command-registry.js";

export const TIMELINE_SCENE3D_ANIMATION_COMMAND_DEFINITIONS = [
  { command: "motion.timeline.scene3d-animation.inspect", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.scene3d-animation.track.upsert", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.scene3d-animation.track.remove", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.scene3d-animation.keyframe.upsert", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.scene3d-animation.keyframe.delete", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.scene3d-animation.keyframe.move", domain: "timeline", permission: "edit_motion", mutates: true },
] as const satisfies readonly MotionDebugCommandDefinitionBase[];
