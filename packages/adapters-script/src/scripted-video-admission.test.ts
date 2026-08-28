import { describe, expect, it } from "vitest";
import { convertScriptedFramesToMotionPackage } from "./index.js";

describe("scripted-video admission bounds", () => {
  it("checks the raw frame count before mapping untrusted frame entries", () => {
    const frames = Array.from({ length: 121 }, (_entry, index) => ({ id: `frame-${index}`, title: `Frame ${index}`, durationMs: 100 }));
    Object.defineProperty(frames, 0, {
      get() {
        throw new Error("frame mapping must not run");
      }
    });

    expect(() => convertScriptedFramesToMotionPackage({ ...scriptedVideo(), frames })).toThrow(
      "Scripted video supports at most 120 frames."
    );
  });

  it("bounds scripted metadata collections before mapping and across the storyboard", () => {
    const frame = { id: "bounded", title: "Bounded", durationMs: 1000 };
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [{ ...frame, effects: Array.from({ length: 13 }, () => ({ type: "scanSweep" })) }]
    })).toThrow("frames[0].effects supports at most 12 entries.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [{ ...frame, assetRefs: Array.from({ length: 33 }, (_entry, index) => `assets/${index}.png`) }]
    })).toThrow("frames[0].assetRefs supports at most 32 entries.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [{ ...frame, sourceRefs: Array.from({ length: 25 }, () => ({ type: "article" })) }]
    })).toThrow("frames[0].sourceRefs supports at most 24 entries.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [{ ...frame, tags: Array.from({ length: 17 }, (_entry, index) => `tag-${index}`) }]
    })).toThrow("frames[0].tags supports at most 16 entries.");

    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: Array.from({ length: 86 }, (_entry, index) => ({
        id: `effect-${index}`, title: "Effects", durationMs: 1000,
        effects: Array.from({ length: 12 }, () => ({ type: "signalPulse" }))
      }))
    })).toThrow("Scripted video supports at most 1024 effects across frames.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: Array.from({ length: 65 }, (_entry, index) => ({
        id: `asset-${index}`, title: "Assets", durationMs: 1000,
        assetRefs: Array.from({ length: 32 }, (_entry, assetIndex) => `assets/${index}-${assetIndex}.png`)
      }))
    })).toThrow("Scripted video supports at most 2048 asset references across frames.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: Array.from({ length: 86 }, (_entry, index) => ({
        id: `source-${index}`, title: "Sources", durationMs: 1000,
        sourceRefs: Array.from({ length: 24 }, () => ({ type: "article" }))
      }))
    })).toThrow("Scripted video supports at most 2048 source references across frames.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: Array.from({ length: 65 }, (_entry, index) => ({
        id: `tag-${index}`, title: "Tags", durationMs: 1000,
        tags: Array.from({ length: 16 }, (_entry, tagIndex) => `tag-${index}-${tagIndex}`)
      }))
    })).toThrow("Scripted video supports at most 1024 tags across frames.");
  });

  it("reserves generated rain, particle, and scan work before lowering", () => {
    const accepted = convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [{
        id: "bounded-effects", title: "Bounded effects", durationMs: 1000,
        effects: [
          { type: "rain", intensity: 48 },
          { type: "particleField", intensity: 48 },
          { type: "scanSweep" },
          { type: "signalPulse" },
          { type: "cameraPush" }
        ]
      }]
    });
    expect(accepted.motion.layers).toHaveLength(103);
    expect(accepted.motion.layers.some((layer) => layer.id === "frame_bounded_effects_scan_sweep")).toBe(true);

    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [{
        id: "rain-overflow", title: "Rain overflow", durationMs: 1000,
        effects: Array.from({ length: 3 }, () => ({ type: "rain", intensity: 48 }))
      }]
    })).toThrow("frames[0] projects 144 generated layers; supports at most 128.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [{
        id: "particle-overflow", title: "Particle overflow", durationMs: 1000,
        effects: Array.from({ length: 2 }, () => ({ type: "particleField", intensity: 48 }))
      }]
    })).toThrow("frames[0] projects 1056 generated keyframes; supports at most 1024.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: Array.from({ length: 86 }, (_entry, index) => ({
        id: `rain-${index}`, title: "Rain", durationMs: 1000,
        effects: Array.from({ length: 2 }, () => ({ type: "rain", intensity: 48 }))
      }))
    })).toThrow("Scripted video supports at most 8192 generated layers across frames.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: Array.from({ length: 81 }, (_entry, index) => ({
        id: `particle-${index}`, title: "Particle", durationMs: 1000,
        effects: [{ type: "particleField", intensity: 48 }, { type: "rain", intensity: 48 }]
      }))
    })).toThrow("Scripted video supports at most 65536 generated keyframes across frames.");
  });
});

function scriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "launch-demo",
    name: "Launch Demo",
    sourceApp: "shellx-cut",
    workflow: "generate",
    width: 1280,
    height: 720,
    fps: 24,
    frames: [
      {
        id: "hook",
        title: "Hook",
        body: "Show the new workflow",
        durationMs: 1000,
        background: "#0f172a",
        accent: "#38bdf8"
      },
      {
        id: "cta",
        title: "Cut edits it",
        caption: "Rendered by Motion",
        durationMs: 1500,
        background: "#111827",
        accent: "#22c55e"
      }
    ]
  };
}
