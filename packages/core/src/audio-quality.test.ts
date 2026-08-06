import { describe, expect, it } from "vitest";
import { audioQualityMeasurementRequired, evaluateAudioQuality } from "./audio-quality.js";

const measurements = {
  maxVolumeDb: -2,
  meanVolumeDb: -20,
  integratedLoudnessLufs: -23,
  truePeakDbtp: -0.5,
  loudnessRangeLu: 14
};

describe("audio quality policy", () => {
  it("accepts a complete measurement inside every threshold", () => {
    const policy = {
      maxPeakDb: -1,
      minPeakDb: -10,
      minMeanDb: -30,
      minIntegratedLoudnessLufs: -24,
      maxIntegratedLoudnessLufs: -22,
      maxTruePeakDbtp: -0.1,
      maxLoudnessRangeLu: 15
    };
    expect(audioQualityMeasurementRequired(policy)).toBe(true);
    expect(evaluateAudioQuality(measurements, policy)).toEqual({ ok: true });
    expect(audioQualityMeasurementRequired({})).toBe(false);
  });

  it.each([
    [{ minIntegratedLoudnessLufs: -22 }, "Integrated loudness is -23 LUFS; expected at least -22 LUFS."],
    [{ maxIntegratedLoudnessLufs: -24 }, "Integrated loudness is -23 LUFS; expected at most -24 LUFS."],
    [{ maxTruePeakDbtp: -1 }, "Audio true peak is -0.5 dBTP; expected at most -1 dBTP."],
    [{ maxLoudnessRangeLu: 10 }, "Loudness range is 14 LU; expected at most 10 LU."]
  ] as const)("rejects an out-of-policy professional loudness metric", (policy, message) => {
    expect(evaluateAudioQuality(measurements, policy)).toEqual({ ok: false, message });
  });

  it("fails closed when a requested measurement is absent", () => {
    expect(evaluateAudioQuality({ maxVolumeDb: -2 }, { minIntegratedLoudnessLufs: -24 })).toEqual({
      ok: false,
      message: "Could not measure integrated loudness."
    });
  });

  it("formats silent loudness evidence without throwing", () => {
    expect(evaluateAudioQuality({ maxVolumeDb: null, integratedLoudnessLufs: Number.NEGATIVE_INFINITY }, {
      minIntegratedLoudnessLufs: -70
    })).toEqual({
      ok: false,
      message: "Integrated loudness is -inf LUFS; expected at least -70 LUFS."
    });
  });
});
