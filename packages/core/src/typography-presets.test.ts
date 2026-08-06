import { describe, expect, it } from "vitest";
import {
  applyTypographyPresetToLayer,
  compileTypographyPreset,
  getTypographyPreset,
  listTypographyPresets
} from "./typography-presets";
import type { MotionLayer } from "./types";

describe("kinetic typography preset catalog", () => {
  it("lists named typography presets for promptable templates", () => {
    const presets = listTypographyPresets();

    expect(presets.map((preset) => preset.id)).toEqual([
      "title-entrance",
      "subtitle-stagger",
      "statistic-count-up",
      "emphasis-pulse",
      "caption-reveal",
      "final-callout"
    ]);
    for (const preset of presets) {
      expect(preset.compatibleLanes).toEqual(expect.arrayContaining(["browser", "ffmpeg"]));
      expect(preset.shellxSurfaces).toEqual(expect.arrayContaining(["motion", "cut", "canvas"]));
      expect(preset.textFit).toEqual(expect.objectContaining({ maxChars: expect.any(Number) }));
    }
  });

  it("compiles title-entrance into readable MotionIR text keyframes", () => {
    expect(compileTypographyPreset("title-entrance", {
      durationMs: 700,
      yOffset: 42,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)"
    })).toEqual({
      ok: true,
      presetId: "title-entrance",
      style: {
        fontWeight: 800,
        lineHeight: 1.02
      },
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
          { atMs: 700, value: 1, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
        ],
        "transform.y": [
          { atMs: 0, value: 42, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
          { atMs: 700, value: 0, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
        ]
      },
      warnings: []
    });
  });

  it("applies caption-reveal without mutating the source text layer", () => {
    const layer: MotionLayer = {
      id: "caption",
      type: "text",
      startMs: 0,
      durationMs: 1800,
      text: "Canvas exports direct to MP4.",
      style: { fontSize: 42 }
    };

    const result = applyTypographyPresetToLayer(layer, "caption-reveal", { durationMs: 360 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(layer).not.toHaveProperty("keyframes");
    expect(result.layer).toMatchObject({
      style: {
        fontSize: 42,
        fontWeight: 600,
        lineHeight: 1.12
      },
      keyframes: {
        opacity: [
          { atMs: 0, value: 0, easing: "ease-out" },
          { atMs: 360, value: 1, easing: "ease-out" }
        ],
        "style.letterSpacing": [
          { atMs: 0, value: 1.6, easing: "ease-out" },
          { atMs: 360, value: 0, easing: "ease-out" }
        ]
      }
    });
  });

  it("returns typed errors for unknown typography presets", () => {
    expect(getTypographyPreset("missing")).toBeUndefined();
    expect(compileTypographyPreset("missing")).toEqual({
      ok: false,
      presetId: "missing",
      error: "unknown typography preset: missing"
    });
  });
});
