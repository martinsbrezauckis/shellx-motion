import { describe, expect, it } from "vitest";
import {
  applyTransitionPresetToLayer,
  compileTransitionPreset,
  getTransitionPreset,
  listTransitionPresets
} from "./transition-presets";
import type { MotionLayer } from "./types";

describe("transition preset catalog", () => {
  it("lists reusable named transition presets for template packs", () => {
    const presets = listTransitionPresets();

    expect(presets.map((preset) => preset.id)).toEqual([
      "soft-fade",
      "slide-cover",
      "wipe-accent",
      "card-stack",
      "push-zoom",
      "scan-sweep",
      "split-reveal"
    ]);
    for (const preset of presets) {
      expect(preset.compatibleLanes).toEqual(expect.arrayContaining(["browser", "ffmpeg"]));
      expect(preset.shellxSurfaces).toEqual(expect.arrayContaining(["motion", "cut", "canvas"]));
      expect(preset.bestFor.length).toBeGreaterThan(0);
    }
  });

  it("compiles wipe-accent into MotionIR transitions with overrides", () => {
    expect(compileTransitionPreset("wipe-accent", {
      durationMs: 520,
      direction: "right",
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)"
    })).toEqual({
      ok: true,
      presetId: "wipe-accent",
      transitions: {
        in: {
          type: "wipe",
          durationMs: 520,
          direction: "right",
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)"
        },
        out: {
          type: "fade",
          durationMs: 260,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)"
        }
      },
      keyframes: {},
      effects: { brightness: 1.08, saturate: 1.12 },
      warnings: []
    });
  });

  it("applies push-zoom without mutating the source layer", () => {
    const layer: MotionLayer = {
      id: "hero",
      type: "image",
      startMs: 0,
      durationMs: 2000,
      source: "assets/hero.png"
    };

    const result = applyTransitionPresetToLayer(layer, "push-zoom", { durationMs: 600 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(layer).not.toHaveProperty("transitions");
    expect(result.layer).toMatchObject({
      id: "hero",
      transitions: {
        in: { type: "fade", durationMs: 600 },
        out: { type: "fade", durationMs: 300 }
      },
      keyframes: {
        "transform.scale": [
          { atMs: 0, value: 0.96, easing: "ease-out" },
          { atMs: 600, value: 1, easing: "ease-out" },
          { atMs: 2000, value: 1.04, easing: "ease-in" }
        ]
      }
    });
  });

  it("returns typed errors for unknown presets", () => {
    expect(getTransitionPreset("missing")).toBeUndefined();
    expect(compileTransitionPreset("missing")).toEqual({
      ok: false,
      presetId: "missing",
      error: "unknown transition preset: missing"
    });
  });
});
