/** Literal registry leaf for the host-owned C6C B1 immutable-record lifecycle. */
import type { MotionDebugCommandDefinitionBase } from "./command-registry.js";

export const CHECKPOINT_STORYBOARD_RECORD_COMMAND_DEFINITIONS = [
  { command: "motion.timeline.checkpoint-storyboard.create", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.inspect", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.checkpoint-storyboard.revise", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.remove", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.archive", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.materialize", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.detach", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.behavior.resolve", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.behavior.detach", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.relation.resolve", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.relation.detach", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.relation-action.resolve", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.relation-action.detach", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.lifecycle.resolve", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.lifecycle.detach", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.geometry-morph.resolve", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.geometry-morph.detach", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.retained-trace.resolve", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.retained-trace.detach", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.retained-trace.preview", domain: "timeline", permission: "render_motion", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.retained-trace.review.bind", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.preview", domain: "timeline", permission: "render_motion", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.creative-review.bind", domain: "timeline", permission: "write_local", mutates: true },
  { command: "motion.timeline.checkpoint-storyboard.preview-quality.review", domain: "timeline", permission: "write_local", mutates: true },
] as const satisfies readonly MotionDebugCommandDefinitionBase[];
