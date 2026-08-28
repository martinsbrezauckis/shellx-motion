import { describe, expect, it } from "vitest";
import { gpuBatchFrameTransport, gpuBatchPreflightRefusal, readBatchFrameLane } from "./gpu-batch-policy.js";

describe("GPU batch CLI policy", () => {
  it("accepts only fresh streamed final-video batches", () => {
    expect(readBatchFrameLane("gpu")).toBe("gpu");
    expect(readBatchFrameLane("wrong")).toBeUndefined();
    expect(gpuBatchPreflightRefusal({ frameLane: "gpu", resume: false, presets: ["mp4-h264"] })).toBeUndefined();
    expect(gpuBatchFrameTransport()).toMatchObject({ delivery: "streamed" });
  });

  it("refuses stale resume, non-video rows, and stream-capacity materialization", () => {
    expect(gpuBatchPreflightRefusal({ frameLane: "gpu", resume: true })).toContain("fresh-only");
    expect(gpuBatchPreflightRefusal({ frameLane: "gpu", resume: false, presets: ["gif"] })).toContain("streamed FFmpeg video only");
    expect(gpuBatchPreflightRefusal({ frameLane: "gpu", resume: false, presets: ["mp4-h264"], quality: { minUniqueFrameHashes: 65 } })).toContain("materialized frames");
  });
});
