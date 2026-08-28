/** Prompt action metadata for the compact, read-only agent snapshot. */
import type { MotionAction } from "./catalog.js";

export const AGENT_SNAPSHOT_ACTION: MotionAction = {
  id: "motion.agent.snapshot",
  aliases: [
    "compact motion context",
    "motion agent snapshot",
    "summarize motion for agent",
    "show compact package receipts jobs",
    "agent context snapshot",
    "what should motion agent know"
  ],
  permission: "read_motion",
  mutates: false,
  calls: ["motion.agent.snapshot"],
  verify: ["Agent snapshot returns a bounded path-free package, action, receipt, warning, and own-job summary without creating a receipt or mutating Motion."],
  surfaces: ["prompt"]
};
