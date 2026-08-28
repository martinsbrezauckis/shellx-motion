/**
 * Reviewed purposes for the public particle-structural Debug/MCP command family.
 *
 * The family already has direct CLI routes but no Action-surface coverage. These descriptions
 * explain those existing typed operations without silently broadening their public routes.
 */
export const PARTICLE_STRUCTURAL_PURPOSES: Readonly<Record<string, string>> = {
  "motion.timeline.particles.structural.inspect": "Inspect one particle layer's bounded analytic field sources, emitter origins, trail, shading, and current limits without mutating it.",
  "motion.timeline.particles.field.source.insert": "Insert one complete bounded analytic field-source record at an ordered index in a copied particle layer.",
  "motion.timeline.particles.field.source.replace": "Replace one existing bounded analytic field-source record at its ordered index in a copied particle layer.",
  "motion.timeline.particles.field.source.move": "Move one bounded analytic field-source record to a different ordered index in a copied particle layer.",
  "motion.timeline.particles.field.source.delete": "Remove one bounded analytic field-source record at its ordered index from a copied particle layer.",
  "motion.timeline.particles.emitter.origin.insert": "Insert one bounded emitter spawn-origin record at an ordered index in a copied particle layer.",
  "motion.timeline.particles.emitter.origin.replace": "Replace one existing bounded emitter spawn-origin record at its ordered index in a copied particle layer.",
  "motion.timeline.particles.emitter.origin.move": "Move one bounded emitter spawn-origin record to a different ordered index in a copied particle layer.",
  "motion.timeline.particles.emitter.origin.delete": "Remove one bounded emitter spawn-origin record at its ordered index from a copied particle layer.",
  "motion.timeline.particles.field.collision.axis.update": "Change only the x/y collision axis of one existing bounded collision field source in a copied particle layer.",
  "motion.timeline.particles.emitter.trail.add": "Add one bounded analytic trail to a copied particle layer that does not already declare one.",
  "motion.timeline.particles.emitter.trail.replace": "Replace the existing bounded analytic trail in a copied particle layer.",
  "motion.timeline.particles.emitter.trail.remove": "Remove the existing bounded analytic trail from a copied particle layer.",
  "motion.timeline.particles.emitter.shading.add": "Add one bounded shading record to a copied particle layer that does not already declare one.",
  "motion.timeline.particles.emitter.shading.replace": "Replace the existing bounded shading record in a copied particle layer.",
  "motion.timeline.particles.emitter.shading.remove": "Remove the existing bounded shading record from a copied particle layer.",
};
