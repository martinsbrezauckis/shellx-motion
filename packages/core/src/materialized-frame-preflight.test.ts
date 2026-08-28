import { describe, expect, it } from "vitest";
import {
  MATERIALIZED_BROWSER_HIGH_WATERMARKS,
  MATERIALIZED_BROWSER_REFERENCE,
  preflightMaterializedFrameSequence
} from "./materialized-frame-preflight";

describe("materialized frame sequence preflight", () => {
  const browserSequence = (overrides: Partial<Parameters<typeof preflightMaterializedFrameSequence>[0]> = {}) => preflightMaterializedFrameSequence({
    frameCount: 450,
    width: 1_920,
    height: 1_080,
    frameLane: "browser",
    motion: {
      layers: [
        { id: "rain", type: "environment", startMs: 0, durationMs: 15_000, effects: { motionBlur: { samples: 3, shutterAngle: 180 } } },
        { id: "snow", type: "environment", startMs: 0, durationMs: 15_000, effects: { motionBlur: { samples: 3, shutterAngle: 180 } } }
      ]
    },
    ...overrides
  }, { jobPolicy: { maxProcessTreeRssBytes: 6 * 1024 * 1024 * 1024 } });

  it("refuses the known high-risk browser sequence before frame-array allocation", () => {
    const preflight = browserSequence();

    expect(preflight).toMatchObject({
      schema: "shellx-motion/materialized-frame-preflight@1",
      status: "refused",
      pipeline: { frameSequence: "materialized", encoderStreaming: false },
      sequence: { frameRequestCount: 450, retainedFrameResultCount: 450, retainedBrowserFrameCacheEntryCount: 450 },
      budget: { processTreeRssCeilingBytes: 6 * 1024 * 1024 * 1024, admissionBytes: Math.floor(6 * 1024 * 1024 * 1024 * 0.8) },
      estimate: { model: "calibrated-browser-rss-upper-envelope@1", bytes: MATERIALIZED_BROWSER_REFERENCE.peakProcessTreeRssBytes },
      refusal: { code: "render_resource_preflight_exceeded" }
    });
    expect(preflight.refusal?.suggestedAction).toContain("not bounded producer-to-encoder streaming");
  });

  it("uses observed high-watermarks as a continuous conservative upper envelope", () => {
    const preflight = browserSequence({
      frameCount: 540,
      motion: { layers: Array.from({ length: 4_502 }, (_, index) => ({ id: `shape-${index}`, type: "shape" as const, startMs: 0, durationMs: 18_000 })) }
    });

    expect(preflight.estimate).toMatchObject({
      bytes: expect.any(Number),
      calibration: { observedHighWatermarks: MATERIALIZED_BROWSER_HIGH_WATERMARKS }
    });
    expect(preflight.estimate.bytes).toBeGreaterThanOrEqual(MATERIALIZED_BROWSER_HIGH_WATERMARKS[0].peakProcessTreeRssBytes);

    const immediatelySmaller = browserSequence({
      frameCount: 540,
      motion: { layers: Array.from({ length: 4_501 }, (_, index) => ({ id: `shape-${index}`, type: "shape" as const, startMs: 0, durationMs: 18_000 })) }
    });
    expect(preflight.estimate.bytes - immediatelySmaller.estimate.bytes).toBeLessThan(2 * 1024 * 1024);
  });

  it("retains the measured browser process/session floor for a short sequence", () => {
    const preflight = browserSequence({ frameCount: 1 });

    expect(preflight.estimate).toMatchObject({
      bytes: expect.any(Number),
      calibration: {
        fixedProcessAndSessionFloorBytes: MATERIALIZED_BROWSER_REFERENCE.peakProcessTreeRssBytes - (450 * 1_920 * 1_080 * 4)
      }
    });
    expect(preflight.estimate.bytes).toBeGreaterThan(1_920 * 1_080 * 4);
  });

  it("keeps static safety ceilings absolute when a trusted host supplies a larger RSS policy", () => {
    const preflight = preflightMaterializedFrameSequence({
      frameCount: 36_001,
      width: 1_920,
      height: 1_080,
      frameLane: "native",
      motion: { layers: [] }
    }, { jobPolicy: { maxProcessTreeRssBytes: 64 * 1024 * 1024 * 1024 } });

    expect(preflight).toMatchObject({
      status: "refused",
      staticSafetyCeilings: { enforced: true, maxFrames: 36_000 },
      sequence: { frameRequestCount: 0, retainedFrameResultCount: 0, retainedBrowserFrameCacheEntryCount: 0 },
      refusal: { code: "render_static_sequence_limit_exceeded" }
    });
  });

  it("refuses invalid dimensions before calculating pixel-frame totals", () => {
    const preflight = preflightMaterializedFrameSequence({
      frameCount: 1,
      width: 0,
      height: 1_080,
      frameLane: "native",
      motion: { layers: [] }
    });

    expect(preflight).toMatchObject({
      status: "refused",
      refusal: { code: "render_static_sequence_limit_exceeded", message: "Frame sequence dimensions are invalid." }
    });
  });

  it("accepts only a restrictive trusted host budget override", () => {
    const preflight = preflightMaterializedFrameSequence({
      frameCount: 120,
      width: 1_920,
      height: 1_080,
      frameLane: "browser",
      motion: { layers: [] }
    }, {
      jobPolicy: { maxProcessTreeRssBytes: 6 * 1024 * 1024 * 1024 },
      trustedMemoryBudgetBytes: 64 * 1024 * 1024
    });

    expect(preflight).toMatchObject({ budget: { source: "trusted-host", admissionBytes: 64 * 1024 * 1024 }, status: "refused" });
  });

  it("names a valid trusted environment RSS ceiling as the resolved budget source", () => {
    const preflight = preflightMaterializedFrameSequence({
      frameCount: 120,
      width: 1_920,
      height: 1_080,
      frameLane: "browser",
      motion: { layers: [] }
    }, { env: { SHELLX_MOTION_MAX_JOB_RSS_BYTES: String(2 * 1024 * 1024 * 1024) } });

    expect(preflight).toMatchObject({
      budget: {
        source: "trusted-environment",
        processTreeRssCeilingBytes: 2 * 1024 * 1024 * 1024,
        admissionBytes: Math.floor(2 * 1024 * 1024 * 1024 * 0.8)
      }
    });
  });

  it("raises rather than reuses the reference estimate for extra environments or motion-blur samples", () => {
    const baseline = browserSequence({ frameCount: 120 });
    const withExtraEnvironment = browserSequence({
      frameCount: 120,
      motion: {
        layers: Array.from({ length: 3 }, (_, index) => ({
          id: `environment-${index}`,
          type: "environment" as const,
          startMs: 0,
          durationMs: 15_000,
          effects: { motionBlur: { samples: 3, shutterAngle: 180 } }
        }))
      }
    });
    const withExtraBlur = browserSequence({
      frameCount: 120,
      motion: {
        layers: Array.from({ length: 2 }, (_, index) => ({
          id: `blurred-environment-${index}`,
          type: "environment" as const,
          startMs: 0,
          durationMs: 15_000,
          effects: { motionBlur: { samples: 4, shutterAngle: 180 } }
        }))
      }
    });

    expect(withExtraEnvironment.estimate.bytes).toBeGreaterThan(baseline.estimate.bytes);
    expect(withExtraBlur.estimate.bytes).toBeGreaterThan(baseline.estimate.bytes);
    expect(withExtraEnvironment.estimate.calibration?.aboveReferenceComplexityUpperFactor).toBeGreaterThan(1);
    expect(withExtraBlur.estimate.calibration?.aboveReferenceComplexityUpperFactor).toBeGreaterThan(1);
  });
});
