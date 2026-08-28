import { describe, expect, it } from "vitest";
import { validateAudioOutput, validateAudioRequest } from "./audio-client.js";

const SHA = "a".repeat(64);

describe("SDK audio transport guards", () => {
  it("admits only bounded data-only master controls and exact crossfade inputs", () => {
    expect(validateAudioRequest("audioMasterSet", {
      packageRoot: "/motion/source",
      outDir: "/motion/output",
      master: { volume: 0.8, loudness: { integratedLufs: -16, toleranceLufs: 1, maxTruePeakDbtp: -1 } },
    })).toBeNull();
    expect(validateAudioRequest("audioMasterSet", {
      master: { volume: 0.8, filter: "aformat=unsafe" },
    })).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/does not allow filter/) });
    expect(validateAudioRequest("audioCrossfadeSet", {
      fromLayerId: "music", toLayerId: "voice", durationMs: 0,
    })).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/positive/) });
    expect(validateAudioRequest("audioCrossfadeSet", {
      fromLayerId: "music", toLayerId: "voice", durationMs: 250, curve: "equal-power",
    })).toBeNull();
  });

  it("binds persisted master and default crossfade evidence to the original SDK request", () => {
    const masterRequest = { packageRoot: "/motion/source", outDir: "/motion/output", master: { volume: 0.8 } };
    expect(validateAudioOutput("audioMasterSet", masterOutput(), masterRequest)).toBeNull();
    expect(validateAudioOutput("audioMasterSet", { ...masterOutput(), master: { volume: 0.4 } }, masterRequest))
      .toMatchObject({ code: "invalid_transport" });

    const crossfadeRequest = { packageRoot: "/motion/source", outDir: "/motion/output", fromLayerId: "music", toLayerId: "voice", durationMs: 250 };
    expect(validateAudioOutput("audioCrossfadeSet", crossfadeOutput(), crossfadeRequest)).toBeNull();
    expect(validateAudioOutput("audioCrossfadeSet", { ...crossfadeOutput(), crossfade: { ...crossfadeOutput().crossfade, curve: "linear" } }, crossfadeRequest))
      .toMatchObject({ code: "invalid_transport" });
  });
});

function receipt(operation: "audio.master.set" | "audio.crossfade.set") {
  return { schema: "shellx-motion/receipt@1", id: "audio-receipt", packageId: "pkg", operation, status: "passed", path: "/motion/output/receipts/audio.json", sha256: SHA };
}
function masterOutput() {
  return {
    packageRoot: "/motion/output", package: { packageId: "pkg", motionId: "motion" }, operation: "audio.master.set",
    changedPaths: ["/audio/master"], master: { volume: 0.8 }, receipt: receipt("audio.master.set"), receiptPath: "/motion/output/receipts/audio.json", warnings: [],
  };
}
function crossfadeOutput() {
  return {
    packageRoot: "/motion/output", package: { packageId: "pkg", motionId: "motion" }, operation: "audio.crossfade.set",
    changedPaths: ["/layers/music/fadeOutMs", "/layers/voice/fadeInMs"], crossfade: { fromLayerId: "music", toLayerId: "voice", durationMs: 250, curve: "equal-power" }, receipt: receipt("audio.crossfade.set"), receiptPath: "/motion/output/receipts/audio.json", warnings: [],
  };
}
