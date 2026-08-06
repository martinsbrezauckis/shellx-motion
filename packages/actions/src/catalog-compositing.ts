/** Agent actions for safe typed compositing graph workflows. */
import type { MotionAction } from "./catalog.js";

export const COMPOSITING_ACTIONS: MotionAction[] = [
  {
    id: "motion.compositing.graph.inspect",
    aliases: [
      "inspect compositing graph",
      "show node graph",
      "check compositing graph",
      "show graph compile diagnostics",
      "inspect graph resource budget",
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.compositing.graph.inspect"],
    verify: [
      "Inspection returns the editable graph, validation diagnostics, deterministic fingerprint, resource estimate, and matching compile metadata without mutation.",
    ],
    surfaces: ["compositing", "prompt", "preview", "receipts"],
  },
  {
    id: "motion.compositing.graph.set",
    aliases: [
      "set compositing graph",
      "compile node graph",
      "create blend graph",
      "add matte graph",
      "apply graph effects",
      "connect compositing nodes",
    ],
    permission: "edit_motion",
    mutates: true,
    calls: [
      "motion.compositing.graph.inspect",
      "motion.compositing.graph.set",
      "motion.preview.frame",
      "motion.receipts.read",
    ],
    verify: [
      "Set validates data-only nodes, typed ports, cycles, matte constraints, and resource budgets before creating one copy-on-write package.",
      "Inspect confirms graph fingerprint and compile metadata; preview verifies the compiled MotionIR pixels before handoff.",
    ],
    surfaces: ["compositing", "prompt", "preview", "receipts"],
  },
  {
    id: "motion.compositing.graph.remove",
    aliases: [
      "remove compositing graph",
      "detach node graph",
      "restore graph source layers",
      "clear compiled graph",
    ],
    permission: "edit_motion",
    mutates: true,
    calls: [
      "motion.compositing.graph.inspect",
      "motion.compositing.graph.remove",
      "motion.preview.frame",
      "motion.receipts.read",
    ],
    verify: [
      "Remove deletes generated graph output and compile metadata while restoring the exact editable source-layer visibility and preserving the source package.",
    ],
    surfaces: ["compositing", "prompt", "preview", "receipts"],
  },
];
