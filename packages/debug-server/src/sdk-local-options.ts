/**
 * The host context the in-process SDK transport runs under, when it is the loopback server's SDK.
 *
 * WHY `receiptsRoot` AND `scratchRoot` ARE FORWARDED. They deliberately were not, and the effect was
 * that the SDK's inner dispatches ran as a host that had declared NOTHING while the door they came
 * through had declared a receipts root. The local SDK re-enters `dispatchDebugCommand` for a dozen
 * operations; every containment answer below that door was therefore computed against an empty
 * declared-root set, so it could only be vacuous — admitting or refusing for want of anything to
 * compare against rather than because of what the server actually declared.
 *
 * The right host context for this transport is the SERVER'S OWN. `/sdk` is not a separate product
 * embedding Motion; it is one of this server's four doors, executing in this server's process on
 * this server's behalf. A door that declared different roots from the other three would be a door
 * with different rules, which is precisely the class of defect that made `/sdk` worth auditing.
 *
 * STATED PRECISELY, because overstating it would be its own defect: this is DEFENCE IN DEPTH with no
 * reachable behaviour change today. The fence that actually closed the finding is in `sdk-route.ts`,
 * which refuses a foreign root before this transport is called at all. The commands that consult the
 * strict containment policy from inside the engine — `motion.timeline.playhead.set`,
 * `range.select`, `viewport.set`, `motion.prompt.run` — are not reachable through any SDK operation,
 * and the shipped CLI declares no `scratchRoot`, so forwarding it is a no-op on the shipped path.
 * What forwarding buys is that when a future operation or command DOES consult the host's roots
 * below this door, it sees the same declaration the door enforced, rather than an empty set.
 *
 * Deliberately NOT forwarded: `operatorReceiptRoots`. Those are session grants a human made through
 * the Workbench chooser, and they reach the SDK's inner dispatches only if a future need is argued
 * for explicitly rather than inherited by a spread.
 *
 * Primary caller: `./index.ts` (server construction).
 */
import type { MotionDebugContext } from "@shellx-motion/debug-api";
import type { LocalMotionSdkOptions } from "@shellx-motion/sdk/local";

export function localSdkOptionsFromDebugContext(
  context: Partial<Omit<MotionDebugContext, "tier">> | undefined,
): LocalMotionSdkOptions {
  return {
    ...(context?.ffmpegRunner ? { ffmpegRunner: context.ffmpegRunner } : {}),
    ...(context?.browserFrameRenderer ? { browserFrameRenderer: context.browserFrameRenderer } : {}),
    ...(context?.authoringInputRoots ? { authoringInputRoots: context.authoringInputRoots } : {}),
    ...(context?.authoringOutputRoots ? { authoringOutputRoots: context.authoringOutputRoots } : {}),
    ...(context?.renderPackageRoots ? { renderPackageRoots: context.renderPackageRoots } : {}),
    ...(context?.renderInputRoots ? { renderInputRoots: context.renderInputRoots } : {}),
    ...(context?.renderOutputRoots ? { renderOutputRoots: context.renderOutputRoots } : {}),
    ...(context?.enforceRenderRoots === true ? { enforceRenderRoots: true } : {}),
    ...(context?.receiptsRoot ? { receiptsRoot: context.receiptsRoot } : {}),
    ...(context?.attestedRenderReuseProducerAuthority
      ? { attestedRenderReuseProducerAuthority: context.attestedRenderReuseProducerAuthority }
      : {}),
    ...(context?.scratchRoot ? { scratchRoot: context.scratchRoot } : {}),
    ...(context?.callerId?.trim() ? { callerId: context.callerId.trim() } : {}),
  };
}
