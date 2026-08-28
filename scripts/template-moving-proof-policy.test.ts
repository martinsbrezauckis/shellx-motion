import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PUBLIC_PRODUCT_TEMPLATE_DIRS } from "./template-product-pack-catalog";
import {
  MOTION_DENSITY_CALIBRATION_MIN_UNIQUE_FRAME_HASHES,
  TEMPLATE_MOVING_PROOF_POLICY_SCHEMA,
  evaluateMotionDensityAcceptance,
  loadTemplateMovingProofPolicy,
  parseTemplateMovingProofPolicy,
  selectMovingProofUniqueFrameHashGate
} from "./template-moving-proof-policy";

describe("promoted template moving-proof policy", () => {
  it("is exact over the public catalog and binds every release threshold to the fresh qualified calibration", async () => {
    const policy = await loadTemplateMovingProofPolicy();
    expect(policy.schema).toBe(TEMPLATE_MOVING_PROOF_POLICY_SCHEMA);
    expect(Object.keys(policy.families).sort()).toEqual([...PUBLIC_PRODUCT_TEMPLATE_DIRS]);
    expect(policy.delivery).toMatchObject({ preset: "mp4-h264", fps: 8, maxDurationDriftFrames: 1 });
    expect(policy.delivery.color).toEqual({
      profile: "sdr-bt709",
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      range: "tv"
    });
    expect(policy.calibration.historicalEvidence).toMatchObject({
      identity: "template-product-pack-calibration-e6ae73c-qualified-linux-gpu/evidence.json",
      commit: "e6ae73c9c8f0224384f98dc548e0aa033848f6c8",
      sha256: "cab468a4129ac9a301698a552366f2d22008767703a0ff45ef7178753e336b65"
    });
    expect(policy.calibration.resourceEvidence).toMatchObject({
      identity: "template-product-pack-calibration-e6ae73c-qualified-linux-gpu/evidence.json",
      commit: "e6ae73c9c8f0224384f98dc548e0aa033848f6c8",
      sha256: "cab468a4129ac9a301698a552366f2d22008767703a0ff45ef7178753e336b65",
      samplingIntervalMs: 25
    });
    for (const family of Object.values(policy.families)) {
      expect(family.minUniqueFrameHashes).toBeLessThanOrEqual(family.calibration.uniqueFrameHashes);
      expect(family.maxArtifactBytes).toBeGreaterThanOrEqual(family.calibration.artifactBytes);
      expect(family.maxScratchBytes).toBeGreaterThanOrEqual(family.calibration.scratchBytes);
      expect(family.maxEncodePeakRssBytes).toBeGreaterThanOrEqual(family.calibration.encodePeakRssBytes);
      expect(family.motionDensity).toMatchObject({ state: "calibrated" });
      if (family.motionDensity.state !== "calibrated") throw new Error("expected calibrated density policy");
      expect(family.motionDensity.maxFrozenRatio).toBeGreaterThanOrEqual(family.motionDensity.calibration.frozenRatio);
      expect(family.motionDensity.maxLongestFrozenMs).toBeGreaterThanOrEqual(family.motionDensity.calibration.longestFrozenMs);
    }
  });

  it("refuses catalog drift and thresholds that contradict their measured calibration", async () => {
    const source = await loadTemplateMovingProofPolicy();
    const unknownFamily = JSON.parse(JSON.stringify(source));
    unknownFamily.families["unreviewed-family"] = unknownFamily.families["audio-launch"];
    expect(() => parseTemplateMovingProofPolicy(unknownFamily)).toThrow("exactly match the promoted public catalog");

    const impossibleMinimum = JSON.parse(JSON.stringify(source));
    impossibleMinimum.families["audio-launch"].minUniqueFrameHashes = 48;
    expect(() => parseTemplateMovingProofPolicy(impossibleMinimum)).toThrow("minimum unique-frame policy exceeds its measured calibration");

    const staleCap = JSON.parse(JSON.stringify(source));
    staleCap.families["cinematic-rain-launch"].maxScratchBytes = 1;
    expect(() => parseTemplateMovingProofPolicy(staleCap)).toThrow("scratch cap is below its measured calibration");

    const unprovenanced = JSON.parse(JSON.stringify(source));
    unprovenanced.calibration.historicalEvidence.sha256 = "not-a-hash";
    expect(() => parseTemplateMovingProofPolicy(unprovenanced)).toThrow("historical evidence SHA-256");

    const underSampled = JSON.parse(JSON.stringify(source));
    underSampled.calibration.resourceEvidence.samplingIntervalMs = 0;
    expect(() => parseTemplateMovingProofPolicy(underSampled)).toThrow("resourceEvidence.samplingIntervalMs");

    const missingDensityState = JSON.parse(JSON.stringify(source));
    delete missingDensityState.families["audio-launch"].motionDensity;
    expect(() => parseTemplateMovingProofPolicy(missingDensityState)).toThrow("motionDensity");

    const invalidDensityAnalysis = JSON.parse(JSON.stringify(source));
    invalidDensityAnalysis.families["audio-launch"].motionDensity.analysis = "frame-hashes";
    expect(() => parseTemplateMovingProofPolicy(invalidDensityAnalysis)).toThrow("rendered or film-grain-stripped");

    const calibratedDensity = JSON.parse(JSON.stringify(source));
    calibratedDensity.families["audio-launch"].motionDensity = {
      state: "calibrated",
      analysis: "rendered",
      calibration: {
        frozenRatio: 0.5,
        longestFrozenMs: 1000,
        longestFrozenSpanMs: 1000,
        meanFrameDifference: 0.01,
        meanChangedPixelRatio: 0.1
      },
      maxFrozenRatio: 0.5,
      maxLongestFrozenMs: 1000
    };
    expect(parseTemplateMovingProofPolicy(calibratedDensity).families["audio-launch"].motionDensity).toMatchObject({
      state: "calibrated",
      maxFrozenRatio: 0.5,
      maxLongestFrozenMs: 1000
    });
    calibratedDensity.families["audio-launch"].motionDensity.maxFrozenRatio = 0.49;
    expect(() => parseTemplateMovingProofPolicy(calibratedDensity)).toThrow("maximum frozen-ratio policy is below its measured motion-density calibration");
  });

  it("never treats calibration-required as an advisory and checks calibrated low-motion caps exactly", async () => {
    const uncalibrated = {
      state: "calibration-required" as const,
      analysis: "rendered" as const,
      reason: "fresh qualified measurement required"
    };
    expect(evaluateMotionDensityAcceptance(uncalibrated, { frozenRatio: 0, longestFrozenMs: 0 })).toMatchObject({
      ok: false,
      code: "motion_density_policy_uncalibrated"
    });

    const calibrated = {
      state: "calibrated" as const,
      analysis: "rendered" as const,
      calibration: {
        frozenRatio: 0.5,
        longestFrozenMs: 1000,
        longestFrozenSpanMs: 1000,
        meanFrameDifference: 0.01,
        meanChangedPixelRatio: 0.1
      },
      maxFrozenRatio: 0.5,
      maxLongestFrozenMs: 1000
    };
    expect(evaluateMotionDensityAcceptance(calibrated, { frozenRatio: 0.5, longestFrozenMs: 1000 })).toEqual({ ok: true });
    expect(evaluateMotionDensityAcceptance(calibrated, { frozenRatio: 0.501, longestFrozenMs: 1000 })).toMatchObject({
      ok: false,
      code: "motion_density_below_policy"
    });
    expect(evaluateMotionDensityAcceptance(calibrated, { frozenRatio: 0.5, longestFrozenMs: 1001 })).toMatchObject({
      ok: false,
      code: "motion_density_below_policy"
    });
  });

  it("uses the source-owned one-frame diagnostic floor only for calibration and records the release threshold", () => {
    const calibration = selectMovingProofUniqueFrameHashGate({
      calibrateMotionDensity: true,
      releaseMinUniqueFrameHashes: 28
    });
    expect(MOTION_DENSITY_CALIBRATION_MIN_UNIQUE_FRAME_HASHES).toBe(1);
    expect(calibration).toEqual({
      renderMinUniqueFrameHashes: 1,
      evidence: {
        uniqueFrameHashGate: "calibration-diagnostic",
        minUniqueFrameHashes: 1,
        releaseMinUniqueFrameHashes: 28
      }
    });

    const ordinary = selectMovingProofUniqueFrameHashGate({
      calibrateMotionDensity: false,
      releaseMinUniqueFrameHashes: 28
    });
    expect(ordinary).toEqual({
      renderMinUniqueFrameHashes: 28,
      evidence: {
        uniqueFrameHashGate: "release-policy",
        minUniqueFrameHashes: 28,
        releaseMinUniqueFrameHashes: 28
      }
    });
  });

  it("retains the exact browser sequence long enough to measure the source-owned movement floor", async () => {
    const proofSource = await readFile(new URL("./template-product-pack-proof.ts", import.meta.url), "utf8");
    expect(proofSource).toContain('"--keep-frames"');
    expect(proofSource).toContain("motion_density_below_policy");
    expect(proofSource).toContain("inspectCompleteFrameSequenceMotionEvidence");
    expect(proofSource).toContain("motionDensity,");
    expect(proofSource).toContain("--calibrate-motion-density");
    expect(proofSource).toContain("motion_density_policy_uncalibrated");
    expect(proofSource).toContain("selectMovingProofUniqueFrameHashGate");
    expect(proofSource).toContain("String(uniqueFrameHashGate.renderMinUniqueFrameHashes)");
    expect(proofSource).toContain("...uniqueFrameHashGate.evidence");
    expect(proofSource).toContain("film-grain-stripped");
    expect(proofSource).toContain("templateProofRssPollIntervalMs = 25");
    expect(proofSource).toContain("ffmpegRunner: templateProofFfmpegRunner");
    expect(proofSource).toContain("encode_rss_sampling_policy_mismatch");
    expect(proofSource).toContain("pruneSuccessfulProofArtifacts");
    // A source manifest id is not authoritative after a materializer changes its rendered id.
    // The product-metric-card lane exercises this exact recovery path.
    expect(proofSource).toContain("renderReceipt.packageId");
    expect(proofSource).toContain("join(framesRoot, packageDirName, renderedPackageId)");
  });
});
