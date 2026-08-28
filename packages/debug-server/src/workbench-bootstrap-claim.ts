import type { MotionDebugServerSecurityContext } from "./debug-server-security.js";

/** Consumes the browser bootstrap before cleanup so a failed cleanup cannot make it reusable. */
export async function consumeWorkbenchBootstrapClaim(
  security: Pick<MotionDebugServerSecurityContext, "workbenchBootstrapToken" | "onWorkbenchBootstrapClaim">
): Promise<boolean> {
  if (!security.workbenchBootstrapToken) return false;
  security.workbenchBootstrapToken = null;
  try {
    await security.onWorkbenchBootstrapClaim?.();
    return true;
  } catch {
    return false;
  }
}
