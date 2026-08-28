import { describe, expect, it } from "vitest";
import {
  evaluateMotionAudioMasterLoudness,
  normalizeMotionAudioMaster,
  setMotionAudioCrossfade,
  setMotionAudioMaster,
  type MotionDocument,
} from "./index.js";

describe("document audio master", () => {
  it("accepts only bounded plain-data controls and refuses fades beyond the document", () => {
    const getter = Object.create(null, {
      volume: { get: () => { throw new Error("must not invoke getter"); }, enumerable: true },
    });
    expect(() => normalizeMotionAudioMaster({ volume: 1, injected: true })).toThrow(/does not allow injected/);
    expect(() => normalizeMotionAudioMaster({ loudness: { integratedLufs: Number.NaN, toleranceLufs: 1, maxTruePeakDbtp: -1 } })).toThrow(/finite number/);
    expect(() => normalizeMotionAudioMaster(getter)).toThrow(/Audio master must be an object/);
    expect(() => setMotionAudioMaster(document(), { fadeOutMs: 1_001 })).toThrow(/must not exceed document duration/);

    expect(setMotionAudioMaster(document(), {
      volume: 0.8,
      fadeInMs: 100,
      fadeOutMs: 250,
      fadeCurve: "equal-power",
      loudness: { integratedLufs: -16, toleranceLufs: 1, maxTruePeakDbtp: -1, maxLoudnessRangeLu: 11 },
    })).toMatchObject({
      action: "updated",
      newMaster: { volume: 0.8, fadeInMs: 100, fadeOutMs: 250, fadeCurve: "equal-power" },
      changedPaths: ["/audio/master"],
    });
  });

  it("sets only exact-overlap crossfades and evaluates delivered loudness fail-closed", () => {
    const faded = setMotionAudioCrossfade(document(), {
      fromLayerId: "outgoing",
      toLayerId: "incoming",
      durationMs: 250,
      curve: "equal-power",
    });
    expect(faded.motion.layers).toMatchObject([
      { id: "outgoing", fadeOutMs: 250, fadeCurve: "equal-power" },
      { id: "incoming", fadeInMs: 250, fadeCurve: "equal-power" },
    ]);
    expect(() => setMotionAudioCrossfade(document(), {
      fromLayerId: "outgoing", toLayerId: "incoming", durationMs: 300,
    })).toThrow(/exactly match the overlap/);

    const master = normalizeMotionAudioMaster({
      loudness: { integratedLufs: -16, toleranceLufs: 1, maxTruePeakDbtp: -1, maxLoudnessRangeLu: 11 },
    });
    if (!master) throw new Error("fixture master missing");
    expect(evaluateMotionAudioMasterLoudness(master, null)).toMatchObject({ ok: false, message: expect.stringMatching(/complete delivered-program readback/) });
    expect(evaluateMotionAudioMasterLoudness(master, { integratedLufs: -16.3, truePeakDbtp: -1.2, loudnessRangeLu: 10 })).toEqual({ ok: true });
    expect(evaluateMotionAudioMasterLoudness(master, { integratedLufs: -12, truePeakDbtp: -1.2, loudnessRangeLu: 10 })).toMatchObject({ ok: false, message: expect.stringMatching(/integrated loudness/) });
  });
});

function document(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "audio-master-test",
    name: "Audio master test",
    durationMs: 1_000,
    fps: 30,
    width: 320,
    height: 180,
    layers: [
      { id: "outgoing", type: "audio", source: "assets/out.wav", startMs: 0, durationMs: 1_000 },
      { id: "incoming", type: "audio", source: "assets/in.wav", startMs: 750, durationMs: 1_000 },
    ],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
  };
}
