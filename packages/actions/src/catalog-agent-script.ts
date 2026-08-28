/** The narrow host-gated approved-agent-entry action; kept separate for the catalog size ratchet. */
import type { MotionAction } from "./catalog.js";

export const AGENT_SCRIPT_ACTION: MotionAction = {
  id: "motion.package.script.author",
  aliases: [
    "author approved local script",
    "create agent html animation",
    "add trusted local canvas script",
    "author browser animation entry",
    "create local web animation"
  ],
  permission: "write_local",
  mutates: true,
  calls: ["motion.package.script.author", "motion.preview.frame", "motion.receipts.read"],
  verify: [
    "Host receipt records requested and active script mode, resolver version, source hashes, and non-secret attestation evidence.",
    "Approved-agent-entry provenance attests a host-approved local entry and bytes, not semantic or human authorship."
  ],
  surfaces: ["packages"]
};
