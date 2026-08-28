import { describe, expect, it } from "vitest";
import { listFfmpegExportPresets } from "./index";

const EXPECTED_SDR_DELIVERY_PRESETS = [
  "mov-prores",
  "mp4-h264",
  "mp4-hevc",
  "webm-av1",
  "webm-vp9",
  "webm-vp9-alpha"
];

describe("FFmpeg current colour and alpha contract", () => {
  it("keeps the declared SDR BT.709 delivery transform and readback-capable tags on every video preset", () => {
    const presets = listFfmpegExportPresets();
    const sdrPresets = presets.filter((preset) => preset.color !== null);

    expect(sdrPresets.map((preset) => preset.preset).sort()).toEqual(EXPECTED_SDR_DELIVERY_PRESETS);
    for (const preset of sdrPresets) {
      expect(preset.color, preset.preset).toEqual({
        profile: "sdr-bt709",
        primaries: "bt709",
        transfer: "bt709",
        matrix: "bt709",
        range: "tv",
        conversion: "rgb-full-to-yuv-limited"
      });
      expect(preset.outputArgs, preset.preset).toEqual(expect.arrayContaining([
        "-vf",
        "scale=in_range=full:out_range=tv:out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "-color_trc",
        "-color_range",
        "tv"
      ]));
    }
    expect(presets.find((preset) => preset.preset === "gif")?.color).toBeNull();
  });
});
