/** Agent actions for data-only procedural relationship authoring. */
import type { MotionAction } from "./catalog.js";

const MUTATION_SURFACES = ["procedural", "timeline", "prompt", "preview", "receipts"];

export const PROCEDURAL_ACTIONS: MotionAction[] = [
  {
    id: "motion.procedural.inspect",
    aliases: [
      "inspect procedural relationships",
      "show linked properties",
      "show relationship drivers",
      "explain driven animation",
      "inspect expressions without code",
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.procedural.inspect"],
    verify: [
      "Inspection returns readable source and target properties, enabled state, graph validation, resource estimates, and optional evaluated values without changing the package.",
    ],
    surfaces: ["procedural", "timeline", "prompt", "receipts"],
  },
  {
    id: "motion.procedural.relationship.set",
    aliases: [
      "link animation properties",
      "create driven property",
      "set procedural relationship",
      "drive animation from audio",
      "add deterministic wiggle",
      "link layer values",
    ],
    permission: "edit_motion",
    mutates: true,
    calls: [
      "motion.procedural.inspect",
      "motion.procedural.relationship.set",
      "motion.preview.frame",
      "motion.receipts.read",
    ],
    verify: [
      "Set rejects arbitrary JavaScript, unknown node types, missing properties, cycles, and over-budget graphs before creating one copy-on-write package revision.",
      "Inspect and preview confirm the readable relationship and evaluated pixels before downstream handoff.",
    ],
    surfaces: MUTATION_SURFACES,
  },
  {
    id: "motion.procedural.relationship.enabled.set",
    aliases: [
      "enable procedural relationship",
      "disable procedural relationship",
      "toggle driven property",
      "mute animation link",
    ],
    permission: "edit_motion",
    mutates: true,
    calls: [
      "motion.procedural.inspect",
      "motion.procedural.relationship.enabled.set",
      "motion.preview.frame",
      "motion.receipts.read",
    ],
    verify: [
      "Enabled state changes in one package revision while preserving the relationship definition for reversible editing.",
    ],
    surfaces: MUTATION_SURFACES,
  },
  {
    id: "motion.procedural.relationship.bake",
    aliases: [
      "bake procedural animation",
      "convert relationship to keyframes",
      "freeze driven animation",
      "bake expressions to keyframes",
      "make procedural motion editable",
    ],
    permission: "edit_motion",
    mutates: true,
    calls: [
      "motion.procedural.inspect",
      "motion.procedural.relationship.bake",
      "motion.timeline.keyframes.panel",
      "motion.preview.frame",
      "motion.receipts.read",
    ],
    verify: [
      "Bake samples deterministic values within the bounded frame budget, writes ordinary numeric keyframes, detaches only selected relationships, and records sample, keyframe, and fingerprint evidence in one receipt.",
    ],
    surfaces: MUTATION_SURFACES,
  },
  {
    id: "motion.procedural.relationship.detach",
    aliases: [
      "detach procedural relationship",
      "remove animation link",
      "unlink driven property",
      "delete relationship without baking",
    ],
    permission: "edit_motion",
    mutates: true,
    calls: [
      "motion.procedural.inspect",
      "motion.procedural.relationship.detach",
      "motion.preview.frame",
      "motion.receipts.read",
    ],
    verify: [
      "Detach removes the selected relationship without inventing keyframes and preserves all unrelated graph entries in one copy-on-write revision.",
    ],
    surfaces: MUTATION_SURFACES,
  },
];
