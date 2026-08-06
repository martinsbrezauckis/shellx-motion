/**
 * The dispatch context every in-process SDK operation runs under.
 *
 * Role: turn `LocalMotionSdkOptions` — what the embedding host configured once — plus a per-operation
 * tier into the `MotionDebugContext` that `dispatchDebugCommand` receives. One builder, so an
 * operation cannot quietly run with fewer host roots than its neighbours.
 *
 * `receiptsRoot`/`scratchRoot` are here so an SDK embedded by the loopback debug server dispatches
 * with the SAME host declaration the server's `/sdk` door enforced, instead of running as a host
 * that declared nothing one layer below a door that declared something. An SDK embedded by an
 * ordinary in-process host sets neither and is unchanged, because that host is the caller and there
 * is no boundary between them. Defence in depth rather than the fence itself — see
 * `sdk-local-options.ts` in `@shellx-motion/debug-server` for the precise scope of what it buys.
 *
 * Extracted from `local.ts` rather than added to it: that file carries a declared non-growth
 * baseline in `scripts/module-size-gate.mjs`.
 *
 * Primary caller: `./local.ts`.
 */
import type { MotionDebugContext, ReceiptActor } from "@shellx-motion/debug-api";
import type { LocalMotionSdkOptions } from "./local";

/**
 * Build the dispatch context for one local SDK operation.
 *
 * @param tier permission tier this operation runs at.
 * @param options host configuration for this SDK instance.
 * @param scratchRoot per-operation scratch override; wins over the host's configured one.
 * @param qualityInputRoots per-operation quality input roots, when the operation reads them.
 */
export function localDebugContext(
  tier: MotionDebugContext["tier"],
  options: LocalMotionSdkOptions,
  scratchRoot?: string,
  qualityInputRoots?: string[]
): MotionDebugContext {
  const resolvedScratchRoot = scratchRoot ?? options.scratchRoot;
  return {
    tier,
    actor: sdkActor(tier, options),
    ...(resolvedScratchRoot ? { scratchRoot: resolvedScratchRoot } : {}),
    ...(options.receiptsRoot ? { receiptsRoot: options.receiptsRoot } : {}),
    ...(qualityInputRoots ? { qualityInputRoots } : {}),
    ...(options.authoringInputRoots ? { authoringInputRoots: options.authoringInputRoots } : {}),
    ...(options.authoringOutputRoots ? { authoringOutputRoots: options.authoringOutputRoots } : {}),
    ...(options.ffmpegRunner ? { ffmpegRunner: options.ffmpegRunner } : {}),
    ...(options.browserFrameRenderer ? { browserFrameRenderer: options.browserFrameRenderer } : {})
  };
}

/**
 * Build the receipt actor for an in-process local-SDK dispatch. The observed transport is "sdk" (no
 * wire); kind/label default to a "host" embedding named "sdk", overridable via
 * {@link LocalMotionSdkOptions.actor} so a host app can identify itself. The granted tier is
 * recorded. A per-operation createdBy claim still wins for the label; the "sdk" transport is the
 * observed, non-spoofable fact.
 */
function sdkActor(tier: MotionDebugContext["tier"], options: LocalMotionSdkOptions): ReceiptActor {
  return {
    kind: options.actor?.kind ?? "host",
    label: options.actor?.label && options.actor.label.trim() ? options.actor.label.trim() : "sdk",
    transport: "sdk",
    sessionId: `sdk-${process.pid}`,
    grantedTier: tier
  };
}
