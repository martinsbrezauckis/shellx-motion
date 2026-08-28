import { describe, expect, it } from "vitest";
import { planFinalVideoFrameTransport } from "./final-video-frame-transport";

describe("final-video frame transport planner", () => {
  it("defaults FFmpeg video to the bounded streamed handoff", () => {
    expect(planFinalVideoFrameTransport()).toEqual({ delivery: "streamed", reason: "stream_default" });
  });

  it("uses the documented deterministic materialization precedence", () => {
    expect(planFinalVideoFrameTransport({
      keepFrames: true,
      capturedBrowserWorkflow: true,
      exactSourceQuality: true,
      minUniqueFrameHashes: 65,
      injectedFrameRenderer: true
    })).toEqual({ delivery: "materialized", reason: "explicit_frame_retention" });
    expect(planFinalVideoFrameTransport({
      capturedBrowserWorkflow: true,
      exactSourceQuality: true,
      minUniqueFrameHashes: 65,
      injectedFrameRenderer: true
    })).toEqual({ delivery: "materialized", reason: "captured_browser_workflow" });
    expect(planFinalVideoFrameTransport({
      exactSourceQuality: true,
      minUniqueFrameHashes: 65,
      injectedFrameRenderer: true
    })).toEqual({ delivery: "materialized", reason: "exact_source_quality" });
    expect(planFinalVideoFrameTransport({ minUniqueFrameHashes: 65, injectedFrameRenderer: true }))
      .toEqual({ delivery: "materialized", reason: "streaming_quality_capacity" });
    expect(planFinalVideoFrameTransport({ injectedFrameRenderer: true }))
      .toEqual({ delivery: "materialized", reason: "injected_frame_renderer" });
  });
});
