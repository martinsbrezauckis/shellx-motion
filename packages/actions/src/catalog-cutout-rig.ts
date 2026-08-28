/** Agent action for bounded author-time cutout rig baking into ordinary image layers. */
import type { MotionAction } from "./catalog.js";

export const CUTOUT_RIG_ACTIONS: MotionAction[] = [{
  id: "motion.timeline.cutout.rig.bake",
  aliases: [
    "bake cutout rig",
    "split illustration into animated parts",
    "animate character cutouts",
    "rig static image parts",
    "bake parent child cutout animation",
  ],
  permission: "edit_motion",
  mutates: true,
  calls: [
    "motion.timeline.cutout.rig.bake",
    "motion.timeline.keyframes.panel",
    "motion.preview.frame",
    "motion.receipts.read",
  ],
  verify: [
    "Bake accepts one bounded data-only PNG cutout rig, rejects cycles, unsupported source animation, non-decomposable transforms, and unsafe source identity changes before it writes one copy-on-write package revision.",
    "The output contains ordinary cropped image layers and transform keyframes at renderer-observable cadence; its receipt states that this sampled bake does not claim live parent-child equivalence between samples.",
  ],
  surfaces: ["timeline", "preview", "prompt", "receipts"],
}];
