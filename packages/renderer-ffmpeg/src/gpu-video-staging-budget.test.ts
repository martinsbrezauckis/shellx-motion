import { describe, expect, it } from "vitest";
import { MAX_GPU_VIDEO_STAGING_BYTES, planGpuVideoSourceSnapshotBudget, planGpuVideoStagingBudget, plannedPcmBytesForDuration } from "./gpu-video-staging-budget";

describe("GPU video aggregate staging budget", () => {
  it("charges one deduped immutable source plus exact planned RGBA and bounded PCM", () => {
    const ledger = planGpuVideoStagingBudget([
      { sourceKey: "same", sourceBytes: 7, rgbaBytes: 8, pcmDurationMs: 1_000 },
      { sourceKey: "same", sourceBytes: 7, rgbaBytes: 12, pcmDurationMs: 1_000 }
    ]);
    expect(ledger).toEqual({ maxBytes: MAX_GPU_VIDEO_STAGING_BYTES, immutableSourceBytes: 7, plannedRgbaBytes: 20, plannedPcmBytes: plannedPcmBytesForDuration(1_000), totalBytes: 27 + plannedPcmBytesForDuration(1_000) });
  });

  it("rejects one byte over the aggregate ceiling", () => {
    expect(() => planGpuVideoStagingBudget([{ sourceKey: "source", sourceBytes: 10, rgbaBytes: 10 }], 19)).toThrow("aggregate operation budget");
    expect(planGpuVideoStagingBudget([{ sourceKey: "source", sourceBytes: 10, rgbaBytes: 10 }], 20)).toMatchObject({ totalBytes: 20 });
  });

  it("deduplicates exact source-only admission before snapshots exist", () => {
    expect(planGpuVideoSourceSnapshotBudget([
      { sourceKey: "same", sourceBytes: 10 },
      { sourceKey: "same", sourceBytes: 10 },
      { sourceKey: "other", sourceBytes: 7 }
    ], 17)).toEqual({ maxBytes: 17, immutableSourceBytes: 17 });
    expect(() => planGpuVideoSourceSnapshotBudget([
      { sourceKey: "same", sourceBytes: 10 },
      { sourceKey: "other", sourceBytes: 7 }
    ], 16)).toThrow("aggregate operation budget");
  });
});
