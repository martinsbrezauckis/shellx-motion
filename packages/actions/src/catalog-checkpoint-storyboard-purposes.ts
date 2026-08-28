/**
 * Reviewed purposes for the public Debug/MCP checkpoint-storyboard command family.
 *
 * These commands model host-owned workflow records; they intentionally have no
 * action-surface or CLI route. The text explains the existing published commands
 * without suggesting an agent can discover or invoke them through another surface.
 */
export const CHECKPOINT_STORYBOARD_PURPOSES: Readonly<Record<string, string>> = {
  "motion.timeline.checkpoint-storyboard.create": "Seal one bounded checkpoint-storyboard descriptor as an immutable host-owned record; it does not create or render a package.",
  "motion.timeline.checkpoint-storyboard.inspect": "Read one exact sealed checkpoint-storyboard record, lineage, bindings, and review state without mutating it.",
  "motion.timeline.checkpoint-storyboard.revise": "Seal a successor checkpoint-storyboard record from an exact active parent; the original sealed record remains unchanged.",
  "motion.timeline.checkpoint-storyboard.remove": "Tombstone one exact checkpoint-storyboard record while retaining its sealed audit bytes.",
  "motion.timeline.checkpoint-storyboard.archive": "Terminally archive one checkpoint-storyboard lineage after its required bindings have been retired.",
  "motion.timeline.checkpoint-storyboard.materialize": "Ask the host-owned authority to bind one exact storyboard record to its configured materialized package output.",
  "motion.timeline.checkpoint-storyboard.detach": "Retire one verified storyboard materialization binding without deleting the materialized package.",
  "motion.timeline.checkpoint-storyboard.behavior.resolve": "Ask the host-owned C6B2 authority to resolve one exact behavior storyboard record into its configured output binding.",
  "motion.timeline.checkpoint-storyboard.behavior.detach": "Retire one verified C6B2 behavior-resolution binding without deleting its installed output.",
  "motion.timeline.checkpoint-storyboard.relation.resolve": "Ask the host-owned C6B3 authority to resolve one exact relation storyboard record into its configured output binding.",
  "motion.timeline.checkpoint-storyboard.relation.detach": "Retire one verified C6B3 relation-resolution binding without deleting its installed output.",
  "motion.timeline.checkpoint-storyboard.relation-action.resolve": "Ask the host-owned C6B4 authority to resolve one exact relation-action storyboard record into its configured output binding.",
  "motion.timeline.checkpoint-storyboard.relation-action.detach": "Retire one verified C6B4 relation-action-resolution binding without deleting its installed output.",
  "motion.timeline.checkpoint-storyboard.lifecycle.resolve": "Ask the host-owned C6B5 authority to resolve one exact lifecycle storyboard record into its configured output binding.",
  "motion.timeline.checkpoint-storyboard.lifecycle.detach": "Retire one verified C6B5 lifecycle-resolution binding without deleting its installed output.",
  "motion.timeline.checkpoint-storyboard.geometry-morph.resolve": "Ask the host-owned C6B6 authority to resolve one exact geometry-morph storyboard record into its configured output binding.",
  "motion.timeline.checkpoint-storyboard.geometry-morph.detach": "Retire one verified C6B6 geometry-morph-resolution binding without deleting its installed output.",
  "motion.timeline.checkpoint-storyboard.retained-trace.resolve": "Ask the host-owned C6B7 authority to resolve one exact retained-trace storyboard record into its configured output binding.",
  "motion.timeline.checkpoint-storyboard.retained-trace.detach": "Retire one verified C6B7 retained-trace-resolution binding without deleting its installed output.",
  "motion.timeline.checkpoint-storyboard.retained-trace.preview": "Render one exact scheduled retained-trace sample through the host-owned C6B7 preview binding.",
  "motion.timeline.checkpoint-storyboard.retained-trace.review.bind": "Bind one host-minted review decision to an exact receipt-backed retained-trace preview.",
  "motion.timeline.checkpoint-storyboard.preview": "Render one exact checkpoint or time target through the host-owned receipt-backed storyboard preview authority.",
  "motion.timeline.checkpoint-storyboard.creative-review.bind": "Bind one host-minted creative-review result to an exact receipt-backed storyboard PNG preview.",
  "motion.timeline.checkpoint-storyboard.preview-quality.review": "Associate one exact storyboard PNG preview with its authenticated interior or terminal-endpoint quality review; it cannot establish final acceptance."
};
