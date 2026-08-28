/** Agent-discoverable routes for named, bounded transition presets. */
import type { MotionAction } from "./catalog.js";

export const TRANSITION_PRESET_ACTIONS: MotionAction[] = [
  {
    id: "motion.timeline.transition.presets",
    aliases: ["show transition presets", "list transition presets", "transition library", "reveal and card transition presets", "what transitions are available"],
    permission: "read_motion", mutates: false,
    calls: ["motion.timeline.transition.presets"],
    verify: ["Transition preset response includes stable ids, compatible lanes, ShellX surfaces, default duration, and best-for guidance."],
    surfaces: ["timeline", "prompt"]
  },
  {
    id: "motion.timeline.transition.preset.apply",
    aliases: ["apply transition preset", "apply card stack transition", "apply push zoom", "apply scan sweep", "apply split reveal", "add polished transition"],
    permission: "edit_motion", mutates: true,
    calls: ["motion.state", "motion.timeline.transition.preset.apply", "motion.preview.frame", "motion.receipts.read"],
    verify: ["Transition preset receipt includes the layer, preset id, resolved transitions, changed paths, validation result, and preview evidence."],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  }
];
