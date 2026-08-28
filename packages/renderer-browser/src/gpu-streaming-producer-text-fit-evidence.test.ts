import { describe, expect, it } from "vitest";
import { emptyGpuStreamingEvidence } from "./gpu-streaming-producer-state";
import { bindGpuTextFitEvidence } from "./gpu-streaming-producer-text-fit-evidence";

describe("GPU text-fit producer evidence", () => {
  it("retains bounded browser glyph-layout observations without text or pixel buffers", () => {
    const evidence = emptyGpuStreamingEvidence({});
    const observation = {
      layerId: "title", surfaceId: "text-abc", policy: "auto-fit" as const, status: "auto-fitted" as const,
      requestedFontSize: 48, appliedFontSize: 36, minFontSize: 24,
      internalOverflowPx: { horizontal: 0, vertical: 0 }, safeAreaOverflowPx: { top: 0, right: 0, bottom: 0, left: 0 }
    };
    bindGpuTextFitEvidence(evidence, 0, [observation]);
    bindGpuTextFitEvidence(evidence, 33, Array.from({ length: 130 }, (_, index) => ({ ...observation, layerId: `title-${index}`, surfaceId: `text-${index}` })));
    expect(evidence.typography.textFit).toMatchObject({
      authority: "browser-canvas-glyph-bounds", checkedFrameCount: 2, retainedObservationCount: 128, omittedObservationCount: 3
    });
    expect(evidence.typography.textFit?.observations).toHaveLength(128);
    expect(evidence.typography.textFit?.observations[0]).toMatchObject({ layerId: "title", atMs: 0, appliedFontSize: 36 });
  });
});
