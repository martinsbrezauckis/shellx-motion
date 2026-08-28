import { CHECKPOINT_STORYBOARD_RECORD_COMMAND_DEFINITIONS } from "./command-registry-checkpoint-storyboard.js";
import { TIMELINE_LAYOUT_GAP_ANIMATION_COMMAND_DEFINITIONS } from "./command-registry-layout-gap-animation.js";
import { TIMELINE_RELATION_ACTION_COMMAND_DEFINITIONS } from "./command-registry-relation-actions.js";
import { TIMELINE_RELATION_COMMAND_DEFINITIONS } from "./command-registry-relations.js";
import { TIMELINE_SCENE3D_ANIMATION_COMMAND_DEFINITIONS } from "./command-registry-scene3d-animation.js";
import { TIMELINE_STRUCTURAL_COMMAND_DEFINITIONS } from "./command-registry-timeline-structural.js";

/** Large timeline command families kept together so the canonical registry stays reviewable. */
export const TIMELINE_EXTENSION_COMMAND_DEFINITIONS = [
  ...CHECKPOINT_STORYBOARD_RECORD_COMMAND_DEFINITIONS,
  ...TIMELINE_RELATION_COMMAND_DEFINITIONS,
  ...TIMELINE_RELATION_ACTION_COMMAND_DEFINITIONS,
  ...TIMELINE_SCENE3D_ANIMATION_COMMAND_DEFINITIONS,
  ...TIMELINE_LAYOUT_GAP_ANIMATION_COMMAND_DEFINITIONS,
  ...TIMELINE_STRUCTURAL_COMMAND_DEFINITIONS
] as const;
