import { describe, expect, it } from "vitest";
import type { ProbeMediaResult } from "./index.js";
import { validateLinearSrgbSdrFinalMedia } from "./linear-srgb-sdr-final-media.js";

describe("strict linear-sRGB SDR media observation", () => {
  it("accepts and path-redacts exact H.264 BT.709 limited readback", () => {
    const observation = validateLinearSrgbSdrFinalMedia({ media: media(), width: 64, height: 36, fps: 30, frameCount: 30 });
    expect(observation).toMatchObject({ codec: "h264", width: 64, height: 36, fps: 30, color: { pixelFormat: "yuv420p", transfer: "bt709", range: "tv" }, alpha: { present: false }, audio: { present: false } });
    expect(observation).not.toHaveProperty("path");
    expect(JSON.stringify(observation)).not.toContain("private-output");
    expect(Object.isFrozen(observation.color)).toBe(true);
  });

  it.each([
    { codec: "hevc" },
    { width: 63 },
    { fps: 29.97 },
    { durationMs: 900 },
    { container: "matroska,webm" },
    { color: { pixelFormat: "yuv420p", space: "bt709", transfer: "iec61966-2-1", primaries: "bt709", range: "tv" } },
    { alpha: { present: true, mode: "straight", pixelFormat: "yuva420p", decoder: null } },
    { audio: { present: true, streamCount: 1, streams: [] } },
  ])("refuses drifted delivered fact %#", (change) => {
    expect(() => validateLinearSrgbSdrFinalMedia({ media: { ...media(), ...change } as ProbeMediaResult, width: 64, height: 36, fps: 30, frameCount: 30 })).toThrow("does not match");
  });
});

function media(): ProbeMediaResult {
  return {
    ok: true, path: "/private-output/video.mp4", codec: "h264", width: 64, height: 36, durationMs: 1_000, fps: 30, container: "mov,mp4,m4a,3gp,3g2,mj2",
    color: { pixelFormat: "yuv420p", space: "bt709", transfer: "bt709", primaries: "bt709", range: "tv" },
    alpha: { present: false, mode: null, pixelFormat: "yuv420p", decoder: null },
    audio: { present: false, streamCount: 0, streams: [] },
  };
}
