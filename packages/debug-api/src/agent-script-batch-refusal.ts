/** Batch package copies deliberately do not inherit active-script provenance. */
import { activeScriptLayers, type ExpandedMotionJob } from "@shellx-motion/core";
import type { MotionDebugResult } from "./command-registry.js";

export function agentScriptBatchCopyRefusal(expanded: readonly ExpandedMotionJob[]): MotionDebugResult | null {
  const activeJob = expanded.find((job) => activeScriptLayers(job.motion).length > 0);
  if (!activeJob) return null;
  return {
    ok: false,
    error: {
      code: "script_provenance_unresolved",
      message: `motion.render.batch refuses active-content row ${activeJob.row.id} before package copy; provenance does not transfer to a copied package.`
    },
    warnings: []
  };
}
