/** Render-domain route for coordinator submission. */
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";

export interface RenderCoordinatorSubmitServices {
  /**
   * The host-owned submit implementation. The render domain owns command routing; only the host
   * owns the durable worker and the re-entry closure that supplies its AbortSignal.
   */
  submitCoordinatedRender?: (args: unknown) => Promise<MotionDebugResult>;
}

export async function dispatchRenderCoordinatorSubmitCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: RenderCoordinatorSubmitServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.job.submit") return null;
  if (!services.submitCoordinatedRender) {
    return {
      ok: false,
      error: {
        code: "capability_unavailable",
        message: "Persistent local Motion job submission is unavailable on this host.",
        suggestedAction: "Configure a persistent local Motion job coordinator before submitting background render work."
      },
      warnings: []
    };
  }
  return await services.submitCoordinatedRender(args);
}
