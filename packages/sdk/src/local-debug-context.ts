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
import type { MotionJobCoordinator } from "@shellx-motion/core";
import { dirname, resolve } from "node:path";
import type { LocalMotionSdkOptions } from "./local";
import type { MotionSdkRenderRequest } from "./types";

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
  options: LocalMotionSdkOptions & { jobCoordinator?: MotionJobCoordinator },
  scratchRoot?: string,
  qualityInputRoots?: string[]
): MotionDebugContext {
  const resolvedScratchRoot = scratchRoot ?? options.scratchRoot;
  return {
    tier,
    actor: sdkActor(tier, options),
    ...(options.callerId?.trim() ? { callerId: options.callerId.trim() } : {}),
    ...(resolvedScratchRoot ? { scratchRoot: resolvedScratchRoot } : {}),
    ...(options.receiptsRoot ? { receiptsRoot: options.receiptsRoot } : {}),
    ...(options.attestedRenderReuseProducerAuthority
      ? { attestedRenderReuseProducerAuthority: options.attestedRenderReuseProducerAuthority }
      : {}),
    ...(qualityInputRoots ? { qualityInputRoots } : {}),
    ...(options.authoringInputRoots ? { authoringInputRoots: options.authoringInputRoots } : {}),
    ...(options.authoringOutputRoots ? { authoringOutputRoots: options.authoringOutputRoots } : {}),
    ...(options.renderPackageRoots ? { renderPackageRoots: options.renderPackageRoots } : {}),
    ...(options.renderInputRoots ? { renderInputRoots: options.renderInputRoots } : {}),
    ...(options.renderOutputRoots ? { renderOutputRoots: options.renderOutputRoots } : {}),
    ...(options.enforceRenderRoots === true ? { enforceRenderRoots: true } : {}),
    ...(options.ffmpegRunner ? { ffmpegRunner: options.ffmpegRunner } : {}),
    ...(options.browserFrameRenderer ? { browserFrameRenderer: options.browserFrameRenderer } : {}),
    ...(options.streamingFinalRenderer ? { streamingFinalRenderer: options.streamingFinalRenderer } : {}),
    ...(options.jobCoordinator ? { jobCoordinator: options.jobCoordinator } : {}),
    ...(typeof options.gpuFinalExecutionAvailable === "boolean" ? { gpuFinalExecutionAvailable: options.gpuFinalExecutionAvailable } : {}),
    ...(options.materializedFrameSequencePreflight
      ? { materializedFrameSequencePreflight: options.materializedFrameSequencePreflight }
      : {})
  };
}

/** Derive narrow roots only for a direct in-process SDK host. */
export function localRenderOptions(
  options: LocalMotionSdkOptions,
  input: MotionSdkRenderRequest,
  packageRoot: string,
  artifactRoot: string,
): LocalMotionSdkOptions {
  if (options.renderPackageRoots !== undefined
    || options.renderInputRoots !== undefined
    || options.renderOutputRoots !== undefined
    || options.enforceRenderRoots) return options;
  return {
    ...options,
    renderPackageRoots: [packageRoot],
    renderInputRoots: [
      packageRoot,
      ...(input.workflowPath ? [dirname(resolve(input.workflowPath))] : []),
      ...(input.qualityManifestPath ? [dirname(resolve(input.qualityManifestPath))] : [])
    ],
    renderOutputRoots: [artifactRoot]
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
