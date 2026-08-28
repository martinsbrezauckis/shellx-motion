/**
 * Reviewed purposes for the R3 agent and transient-surface Debug/MCP commands.
 *
 * This map is intentionally catalog-independent: its caller owns the reviewed union that makes
 * these purposes public. Keeping that wiring separate prevents this scoped review from changing
 * routes, metadata, generated contracts, or runtime behaviour.
 */
export const AGENT_SURFACE_PURPOSES: Readonly<Record<string, string>> = {
  "motion.actions.find": "Search the action catalog for a matching request and return a match or near misses without planning or executing work.",
  "motion.actions.guide": "Return the matching action's typed call sequence and argument contracts as guidance without executing it.",
  "motion.actions.plan": "Plan the matching action or multi-phase workflow, including its typed steps, required tiers, and verification, without executing it.",
  "motion.agent.revision.plan": "Build and optionally write a trusted-root revision plan from supplied quality and contact-sheet evidence; it does not execute the proposed revision.",
  "motion.prompt.run": "Run a host-injected agent for a natural-language request and record its prompt receipt; raw-request retention additionally requires Linux's stable receipt purge capability, and proposed commands execute only when explicitly requested within the caller's grant.",
  "motion.open": "Return a transient intent to focus a named Motion surface panel without mutating package data.",
  "motion.select": "Return a transient timeline selection intent for one layer, track, marker, scene, or target without mutating package data.",
  "motion.highlight": "Return a transient timeline highlight intent for one layer, track, marker, scene, or target, optionally with a display duration, without mutating package data.",
  "motion.platform.gpu.probe": "Run one explicitly confirmed, host-contained Chromium WebGPU frame/readback hardware proof; it is host GPU evidence, not renderer, artifact, or release qualification.",
  "motion.receipts.list": "On Linux, list identity-stable retained receipt records from a trusted host root as historical evidence; it is not live job state, queue, or progress.",
};
