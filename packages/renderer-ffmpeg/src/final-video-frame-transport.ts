import { streamingFrameQualityPolicyRefusal } from "@shellx-motion/core";

/** Closed reasons for choosing the bounded streamed handoff or its existing materialized counterpart. */
export type FinalVideoFrameTransportReason =
  | "stream_default"
  | "explicit_frame_retention"
  | "captured_browser_workflow"
  | "exact_source_quality"
  | "streaming_quality_capacity"
  | "injected_frame_renderer";

/** A pre-execution decision for an FFmpeg video; PNG stills and image sequences do not use this planner. */
export type FinalVideoFrameTransportPlan =
  | { delivery: "streamed"; reason: "stream_default" }
  | { delivery: "materialized"; reason: Exclude<FinalVideoFrameTransportReason, "stream_default"> };

const MATERIALIZED_REASONS: readonly Exclude<FinalVideoFrameTransportReason, "stream_default">[] = [
  "explicit_frame_retention",
  "captured_browser_workflow",
  "exact_source_quality",
  "streaming_quality_capacity",
  "injected_frame_renderer"
];

/** Small, surface-neutral facts that determine the final-video frame transport. */
export interface FinalVideoFrameTransportPlanInput {
  /** A caller explicitly wants reusable frame files. A framesDir alone is not retention intent. */
  keepFrames?: boolean;
  /** Browser workflow state is currently replayed by the materialized browser path. */
  capturedBrowserWorkflow?: boolean;
  /** Exact decoded-media/source-PNG comparisons currently require source files. */
  exactSourceQuality?: boolean;
  /** The requested unique-frame hash threshold, checked through Core's bounded streaming authority. */
  minUniqueFrameHashes?: number;
  /** Test-only/materialized renderer seam; never selected implicitly after a streamed failure. */
  injectedFrameRenderer?: boolean;
}

/**
 * Decide the frame transport before execution. Precedence is deterministic: explicit retention,
 * browser workflow, exact-source quality, streaming hash capacity, injected renderer, then stream.
 */
export function planFinalVideoFrameTransport(input: FinalVideoFrameTransportPlanInput = {}): FinalVideoFrameTransportPlan {
  if (input.keepFrames === true) return { delivery: "materialized", reason: "explicit_frame_retention" };
  if (input.capturedBrowserWorkflow === true) return { delivery: "materialized", reason: "captured_browser_workflow" };
  if (input.exactSourceQuality === true) return { delivery: "materialized", reason: "exact_source_quality" };
  if (streamingFrameQualityPolicyRefusal({ minUniqueFrameHashes: input.minUniqueFrameHashes })) {
    return { delivery: "materialized", reason: "streaming_quality_capacity" };
  }
  if (input.injectedFrameRenderer === true) return { delivery: "materialized", reason: "injected_frame_renderer" };
  return { delivery: "streamed", reason: "stream_default" };
}

/** True only for a complete, closed planner result supplied by a caller. */
export function isFinalVideoFrameTransportPlan(value: unknown): value is FinalVideoFrameTransportPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as { delivery?: unknown; reason?: unknown };
  if (plan.delivery === "streamed") return plan.reason === "stream_default";
  return plan.delivery === "materialized"
    && MATERIALIZED_REASONS.includes(plan.reason as Exclude<FinalVideoFrameTransportReason, "stream_default">);
}
