import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { convertScriptedFramesToMotionPackage, writeScriptedMotionPackage } from "./index";

const tempDirs: string[] = [];

describe("scripted frame Motion package adapter", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("compiles Cut Generate scripted frames into a Motion package without requiring Canvas", () => {
    const result = convertScriptedFramesToMotionPackage(scriptedVideo(), {
      createdAt: "2026-06-30T08:00:00.000Z",
      inputPath: "cut-generate/storyboard.json"
    });

    expect(result.manifest).toMatchObject({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_script_launch_demo",
      name: "Launch Demo",
      sourceApp: "shellx-cut",
      compatibility: {
        lanes: ["native", "browser", "ffmpeg", "cut"],
        hosts: ["shellx-motion", "shellx-cut"]
      }
    });
    expect(result.manifest.compatibility.hosts).not.toContain("shellx-canvas");
    expect(result.motion).toMatchObject({
      schema: "shellx-motion/motion@1",
      id: "motion_script_launch_demo",
      name: "Launch Demo",
      durationMs: 2500,
      fps: 24,
      width: 1280,
      height: 720,
      provenance: {
        sourceApp: "shellx-cut",
        createdBy: "script-adapter",
        workflow: "generate",
        sourceSchema: "shellx-motion/scripted-video@1"
      }
    });
    expect(result.motion.layers.map((layer) => ({
      id: layer.id,
      type: layer.type,
      startMs: layer.startMs,
      durationMs: layer.durationMs
    }))).toEqual([
      { id: "frame_hook_background", type: "shape", startMs: 0, durationMs: 1000 },
      { id: "frame_hook_accent_rail", type: "shape", startMs: 0, durationMs: 1000 },
      { id: "frame_hook_signal_bar", type: "shape", startMs: 0, durationMs: 1000 },
      { id: "frame_hook_panel", type: "shape", startMs: 0, durationMs: 1000 },
      { id: "frame_hook_kicker", type: "text", startMs: 0, durationMs: 1000 },
      { id: "frame_hook_title", type: "text", startMs: 0, durationMs: 1000 },
      { id: "frame_hook_body", type: "text", startMs: 0, durationMs: 1000 },
      { id: "frame_cta_background", type: "shape", startMs: 1000, durationMs: 1500 },
      { id: "frame_cta_accent_rail", type: "shape", startMs: 1000, durationMs: 1500 },
      { id: "frame_cta_signal_bar", type: "shape", startMs: 1000, durationMs: 1500 },
      { id: "frame_cta_panel", type: "shape", startMs: 1000, durationMs: 1500 },
      { id: "frame_cta_kicker", type: "text", startMs: 1000, durationMs: 1500 },
      { id: "frame_cta_title", type: "text", startMs: 1000, durationMs: 1500 },
      { id: "frame_cta_caption_plate", type: "shape", startMs: 1000, durationMs: 1500 },
      { id: "frame_cta_caption", type: "caption", startMs: 1000, durationMs: 1500 }
    ]);
    expect(result.receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      operation: "package.compile",
      status: "passed",
      packageId: "pkg_script_launch_demo",
      createdAt: "2026-06-30T08:00:00.000Z",
      lane: "script",
      output: {
        sourceApp: "shellx-cut",
        workflow: "generate",
        motionId: "motion_script_launch_demo",
        manifestId: "pkg_script_launch_demo",
        frameCount: 2,
        layerCount: 15,
        durationMs: 2500
      }
    });
    expect(result.receipt.inputHashes["cut-generate/storyboard.json"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves storyboard review, template, engine, source, and asset metadata as Motion scenes", () => {
    const result = convertScriptedFramesToMotionPackage(storyboardVideo(), {
      createdAt: "2026-07-04T11:00:00.000Z",
      inputPath: "agent/storyboard.json"
    });

    expect(result.manifest).toMatchObject({
      id: "pkg_script_weekly_growth",
      name: "Weekly Growth",
      assets: ["assets/logo.png", "assets/stars.csv"],
      data: {
        intent: "data-viz",
        synopsis: "Turn the weekly growth notes into a reviewed multi-scene video.",
        review: {
          status: "ready-for-review",
          required: true
        }
      }
    });
    expect(result.motion).toMatchObject({
      id: "motion_script_weekly_growth",
      durationMs: 3200,
      scenes: [
        {
          id: "scene_hook",
          name: "Hook",
          startMs: 0,
          durationMs: 1400,
          layerIds: [
            "frame_hook_background",
            "frame_hook_accent_rail",
            "frame_hook_signal_bar",
            "frame_hook_panel",
            "frame_hook_kicker",
            "frame_hook_title",
            "frame_hook_body"
          ],
          "x-storyboard": {
            frameId: "hook",
            reviewStatus: "approved",
            agentNote: "Open with the core trend.",
            template: {
              id: "frame-bold-signal",
              engine: "hyperframes",
              variables: { mood: "confident" }
            },
            sourceRefs: [
              { type: "article", title: "Weekly growth notes", url: "https://example.test/growth" }
            ],
            assetRefs: ["assets/logo.png"],
            tags: ["intro", "growth"]
          }
        },
        {
          id: "scene_data",
          name: "Data",
          startMs: 1400,
          durationMs: 1800,
          layerIds: [
            "frame_data_background",
            "frame_data_accent_rail",
            "frame_data_signal_bar",
            "frame_data_panel",
            "frame_data_kicker",
            "frame_data_title",
            "frame_data_caption_plate",
            "frame_data_caption"
          ],
          "x-storyboard": {
            frameId: "data",
            reviewStatus: "needs-review",
            agentNote: "Reviewer should confirm the CSV values.",
            template: {
              id: "frame-data-chart-nyt",
              engine: "hyperframes",
              variables: {
                chart: "stars",
                highlight: "week-27"
              }
            },
            engine: {
              id: "hyperframes",
              mode: "base"
            },
            sourceRefs: [
              { type: "repo", title: "ShellX Motion", url: "https://github.com/example/shellx-motion" }
            ],
            assetRefs: ["assets/stars.csv"],
            tags: ["data-viz"]
          }
        }
      ],
      provenance: {
        workflow: "storyboard-review",
        sourceSchema: "shellx-motion/scripted-video@1"
      }
    });
    expect(result.motion.layers[0]).toMatchObject({
      id: "frame_hook_background",
      "x-storyboard": { frameId: "hook", sceneId: "scene_hook" }
    });
    expect(result.receipt).toMatchObject({
      operation: "package.compile",
      packageId: "pkg_script_weekly_growth",
      output: {
        frameCount: 2,
        layerCount: 15,
        durationMs: 3200,
        storyboard: {
          intent: "data-viz",
          reviewStatus: "ready-for-review",
          reviewRequired: true,
          sceneCount: 2,
          templateHintCount: 2,
          engineHintCount: 1,
          assetRefCount: 2,
          sourceRefCount: 2,
          needsReviewCount: 1
        }
      }
    });
  });

  it("scales scripted-video layouts for FHD marketing renders with richer frame structure", () => {
    const result = convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      width: 1920,
      height: 1080,
      frames: [
        {
          id: "hook",
          title: "ShellX Motion",
          body: "Generate polished scripted video straight from Cut.",
          caption: "FHD product bumper",
          durationMs: 1200,
          background: "#07111f",
          accent: "#00d4ff"
        }
      ]
    });

    expect(result.motion).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 24,
      durationMs: 1200
    });
    expect(result.motion.layers.map((layer) => layer.id)).toEqual([
      "frame_hook_background",
      "frame_hook_accent_rail",
      "frame_hook_signal_bar",
      "frame_hook_panel",
      "frame_hook_kicker",
      "frame_hook_title",
      "frame_hook_body",
      "frame_hook_caption_plate",
      "frame_hook_caption"
    ]);
    expect(result.motion.layers.find((layer) => layer.id === "frame_hook_panel")).toMatchObject({
      type: "shape",
      shape: "rect",
      transform: { x: 144, y: 270, width: 1344, height: 540 },
      style: {
        fill: "rgba(7,17,31,0.78)",
        radius: 36,
        stroke: "#00d4ff",
        strokeWidth: 2
      }
    });
    expect(result.motion.layers.find((layer) => layer.id === "frame_hook_title")).toMatchObject({
      type: "text",
      transform: { x: 216, y: 368, width: 1128, height: 190 },
      style: { fontSize: 96, fontWeight: 900, lineHeight: 1.02 }
    });
    expect(result.motion.layers.find((layer) => layer.id === "frame_hook_body")).toMatchObject({
      transform: { x: 220, y: 600, width: 1104, height: 120 },
      style: { fontSize: 42, lineHeight: 1.18 }
    });
  });

  it("lowers deterministic scripted effects into native Motion layers and keyframes", () => {
    const result = convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      width: 1920,
      height: 1080,
      frames: [
        {
          id: "storm",
          title: "Render weather over the work",
          body: "Procedural rain, pulse, and camera push stay deterministic.",
          caption: "No model dependency",
          durationMs: 2400,
          background: "#07111f",
          accent: "#00d4ff",
          effects: [
            { type: "rain", intensity: 4, speed: 1.2, opacity: 0.32, angle: -12, color: "#bfdbfe", seed: "storm-a" },
            { type: "signalPulse", intensity: 0.55 },
            { type: "cameraPush", scale: 1.035, x: -18, y: -12 }
          ]
        }
      ]
    });

    expect(result.motion.layers.map((layer) => layer.id)).toEqual([
      "frame_storm_background",
      "frame_storm_rain_00",
      "frame_storm_rain_01",
      "frame_storm_rain_02",
      "frame_storm_rain_03",
      "frame_storm_accent_rail",
      "frame_storm_signal_bar",
      "frame_storm_panel",
      "frame_storm_kicker",
      "frame_storm_title",
      "frame_storm_body",
      "frame_storm_caption_plate",
      "frame_storm_caption"
    ]);
    expect(result.motion.scenes?.[0]?.["x-storyboard"]).toMatchObject({
      frameId: "storm",
      effects: [
        { type: "rain", intensity: 4, speed: 1.2, opacity: 0.32, angle: -12, color: "#bfdbfe", seed: "storm-a" },
        { type: "signalPulse", intensity: 0.55 },
        { type: "cameraPush", scale: 1.035, x: -18, y: -12 }
      ]
    });
    expect(result.receipt.output).toMatchObject({
      storyboard: {
        effectHintCount: 3
      }
    });
    expect(result.motion.layers.find((layer) => layer.id === "frame_storm_rain_00")).toMatchObject({
      type: "shape",
      shape: "rect",
      durationMs: 2400,
      opacity: 0.32,
      style: { fill: "#bfdbfe" },
      keyframes: {
        "transform.y": [
          { atMs: 0, value: expect.any(Number), easing: "linear" },
          { atMs: 2400, value: expect.any(Number) }
        ],
        opacity: [
          { atMs: 0, value: 0 },
          { atMs: 360, value: 0.32, easing: "ease-out" },
          { atMs: 2160, value: 0.32, easing: "linear" },
          { atMs: 2400, value: 0, easing: "ease-in" }
        ]
      }
    });
    expect(result.motion.layers.find((layer) => layer.id === "frame_storm_signal_bar")).toMatchObject({
      keyframes: {
        "transform.width": [
          { atMs: 0, value: 346, easing: "ease-out" },
          { atMs: 1200, value: 536, easing: "ease-in-out" },
          { atMs: 2400, value: 346, easing: "ease-in" }
        ],
        opacity: [
          { atMs: 0, value: 0.85 },
          { atMs: 1200, value: 0.45 },
          { atMs: 2400, value: 0.85 }
        ]
      }
    });
    expect(result.motion.layers.find((layer) => layer.id === "frame_storm_title")).toMatchObject({
      keyframes: {
        "transform.x": [
          { atMs: 0, value: 216, easing: "ease-out" },
          { atMs: 2400, value: 198 }
        ],
        "transform.y": [
          { atMs: 0, value: 368, easing: "ease-out" },
          { atMs: 2400, value: 356 }
        ],
        "transform.scale": [
          { atMs: 0, value: 1, easing: "ease-out" },
          { atMs: 2400, value: 1.035 }
        ]
      }
    });
  });

  it("lowers particle fields and scan sweeps into editable deterministic Motion layers", () => {
    const result = convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      width: 1920,
      height: 1080,
      frames: [
        {
          id: "spark",
          title: "Procedural overlays stay editable",
          body: "Spark particles and scan sweeps are native shape layers.",
          durationMs: 2000,
          background: "#07111f",
          accent: "#a7f3d0",
          effects: [
            { type: "particleField", intensity: 3, speed: 1.4, opacity: 0.52, color: "#f8fafc", seed: "spark-a", scale: 1.12, x: 24, y: -18, shape: "ellipse" },
            { type: "scanSweep", intensity: 0.4, speed: 1.25, opacity: 0.28, angle: -14, color: "#ffffff" }
          ]
        }
      ]
    });

    expect(result.motion.layers.map((layer) => layer.id)).toEqual([
      "frame_spark_background",
      "frame_spark_particle_00",
      "frame_spark_particle_01",
      "frame_spark_particle_02",
      "frame_spark_scan_sweep",
      "frame_spark_accent_rail",
      "frame_spark_signal_bar",
      "frame_spark_panel",
      "frame_spark_kicker",
      "frame_spark_title",
      "frame_spark_body"
    ]);
    expect(result.receipt.output).toMatchObject({
      storyboard: {
        effectHintCount: 2
      }
    });

    const particle = result.motion.layers.find((layer) => layer.id === "frame_spark_particle_00");
    expect(particle).toMatchObject({
      type: "shape",
      shape: "ellipse",
      durationMs: 2000,
      opacity: 0.52,
      style: { fill: "#f8fafc" },
      keyframes: {
        "transform.x": [
          { atMs: 0, value: expect.any(Number), easing: "ease-out" },
          { atMs: 2000, value: expect.any(Number) }
        ],
        "transform.y": [
          { atMs: 0, value: expect.any(Number), easing: "ease-out" },
          { atMs: 2000, value: expect.any(Number) }
        ],
        "transform.scale": [
          { atMs: 0, value: expect.any(Number), easing: "ease-out" },
          { atMs: 1000, value: expect.any(Number), easing: "ease-in-out" },
          { atMs: 2000, value: expect.any(Number) }
        ],
        opacity: [
          { atMs: 0, value: 0 },
          { atMs: 300, value: 0.52, easing: "ease-out" },
          { atMs: 1700, value: 0.52, easing: "linear" },
          { atMs: 2000, value: 0, easing: "ease-in" }
        ]
      },
      "x-storyboard": {
        effect: { type: "particleField", groupIndex: 0, index: 0, seed: "spark-a" }
      }
    });
    expect(particle?.keyframes?.["transform.x"]?.[1]?.value).not.toBe(particle?.keyframes?.["transform.x"]?.[0]?.value);
    expect(particle?.keyframes?.["transform.y"]?.[1]?.value).not.toBe(particle?.keyframes?.["transform.y"]?.[0]?.value);

    expect(result.motion.layers.find((layer) => layer.id === "frame_spark_scan_sweep")).toMatchObject({
      type: "shape",
      shape: "rect",
      opacity: 0.28,
      style: { fill: "#ffffff" },
      transform: { rotation: -14 },
      keyframes: {
        "transform.x": [
          { atMs: 0, value: expect.any(Number), easing: "ease-out" },
          { atMs: 2000, value: expect.any(Number), easing: "ease-in" }
        ],
        opacity: [
          { atMs: 0, value: 0 },
          { atMs: 400, value: 0.28, easing: "ease-out" },
          { atMs: 1600, value: 0.28, easing: "linear" },
          { atMs: 2000, value: 0, easing: "ease-in" }
        ]
      },
      "x-storyboard": {
        effect: { type: "scanSweep", groupIndex: 0 }
      }
    });
  });

  it("keeps rain layer IDs unique when a frame uses multiple rain effects", () => {
    const result = convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [
        {
          id: "storm",
          title: "Layered rain",
          durationMs: 1200,
          effects: [
            { type: "rain", intensity: 2, seed: "near" },
            { type: "rain", intensity: 2, seed: "far" }
          ]
        }
      ]
    });

    const rainIds = result.motion.layers
      .filter((layer) => layer.id.includes("_rain_"))
      .map((layer) => layer.id);
    expect(rainIds).toEqual([
      "frame_storm_rain_00_00",
      "frame_storm_rain_00_01",
      "frame_storm_rain_01_00",
      "frame_storm_rain_01_01"
    ]);
    expect(new Set(result.motion.layers.map((layer) => layer.id)).size).toBe(result.motion.layers.length);
  });

  it("accepts fractional non-rain intensity while keeping rain intensity integral", () => {
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [
        {
          id: "pulse",
          title: "Pulse",
          durationMs: 1000,
          effects: [{ type: "signalPulse", intensity: 0.55 }]
        }
      ]
    })).not.toThrow();
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [
        {
          id: "sweep",
          title: "Sweep",
          durationMs: 1000,
          effects: [{ type: "scanSweep", intensity: 0.55 }]
        }
      ]
    })).not.toThrow();
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [
        {
          id: "particles",
          title: "Particles",
          durationMs: 1000,
          effects: [{ type: "particleField", intensity: 4 }]
        }
      ]
    })).not.toThrow();
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [
        {
          id: "rain",
          title: "Bad rain",
          durationMs: 1000,
          effects: [{ type: "rain", intensity: 0.55 }]
        }
      ]
    })).toThrow("frames[0].effects[0].intensity must be an integer between 1 and 48.");
  });

  it("writes a loadable scripted-frame package with compile receipt evidence", async () => {
    const packageDir = await mkdtemp(join(tmpdir(), "shellx-motion-script-package-"));
    tempDirs.push(packageDir);
    await mkdir(packageDir, { recursive: true });

    const scriptedExport = convertScriptedFramesToMotionPackage(scriptedVideo(), {
      createdAt: "2026-06-30T08:01:00.000Z",
      inputPath: "cut-generate/storyboard.json"
    });
    const written = await writeScriptedMotionPackage(scriptedExport, { packageDir });
    const loaded = await loadMotionPackage(packageDir);
    const receipt = JSON.parse(await readFile(written.receiptPath, "utf8")) as Record<string, unknown>;

    expect(written).toEqual({
      packageDir,
      manifestPath: join(packageDir, "manifest.json"),
      motionPath: join(packageDir, "motion.json"),
      receiptPath: join(packageDir, "receipts", "script-compile.receipt.json")
    });
    expect(loaded.manifest.id).toBe("pkg_script_launch_demo");
    expect(loaded.motion.layers).toHaveLength(15);
    expect(receipt).toMatchObject({
      operation: "package.compile",
      packageId: "pkg_script_launch_demo",
      lane: "script"
    });
  });

  it("rejects storyboard dimensions and frame rates outside the first local render envelope", () => {
    expect(() => convertScriptedFramesToMotionPackage({ ...scriptedVideo(), fps: 0 })).toThrow(
      "scripted video.fps must be an integer between 1 and 120."
    );
    expect(() => convertScriptedFramesToMotionPackage({ ...scriptedVideo(), width: 16384 })).toThrow(
      "scripted video.width must be an integer between 16 and 7680."
    );
    expect(() => convertScriptedFramesToMotionPackage({ ...scriptedVideo(), height: 8 })).toThrow(
      "scripted video.height must be an integer between 16 and 4320."
    );
  });

  it("rejects scripted-video frame counts and durations outside the local render envelope", () => {
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [{ id: "too-short", title: "Too short", durationMs: 99 }]
    })).toThrow("frames[0].durationMs must be an integer between 100 and 60000.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [{ id: "too-long", title: "Too long", durationMs: 60001 }]
    })).toThrow("frames[0].durationMs must be an integer between 100 and 60000.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: Array.from({ length: 121 }, (_entry, index) => ({ id: `frame-${index}`, title: `Frame ${index}`, durationMs: 100 }))
    })).toThrow("Scripted video supports at most 120 frames.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: Array.from({ length: 11 }, (_entry, index) => ({ id: `long-${index}`, title: `Long ${index}`, durationMs: 60000 }))
    })).toThrow("Scripted video total duration must be at most 600000ms.");
  });

  it("rejects frame IDs that collide after Motion layer ID sanitization", () => {
    const input = {
      ...scriptedVideo(),
      frames: [
        { id: "a-b", title: "First", durationMs: 1000 },
        { id: "a_b", title: "Second", durationMs: 1000 }
      ]
    };

    expect(() => convertScriptedFramesToMotionPackage(input)).toThrow(
      "Scripted frame IDs must be unique after sanitization; duplicate slug: a_b."
    );
  });

  it("rejects scripted effects outside deterministic renderer bounds", () => {
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [
        {
          id: "storm",
          title: "Too much rain",
          durationMs: 1000,
          effects: [{ type: "rain", intensity: 80 }]
        }
      ]
    })).toThrow("frames[0].effects[0].intensity must be an integer between 1 and 48.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [
        {
          id: "spark",
          title: "Too many particles",
          durationMs: 1000,
          effects: [{ type: "particleField", intensity: 80 }]
        }
      ]
    })).toThrow("frames[0].effects[0].intensity must be an integer between 1 and 48.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [
        {
          id: "spark",
          title: "Bad particle shape",
          durationMs: 1000,
          effects: [{ type: "particleField", intensity: 4, shape: "hexagon" }]
        }
      ]
    })).toThrow("frames[0].effects[0].shape must be one of: rect, ellipse, star.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [
        {
          id: "push",
          title: "Bad push",
          durationMs: 1000,
          effects: [{ type: "cameraPush", scale: 0.8 }]
        }
      ]
    })).toThrow("frames[0].effects[0].scale must be a finite number between 1 and 1.2.");
    expect(() => convertScriptedFramesToMotionPackage({
      ...scriptedVideo(),
      frames: [
        {
          id: "unknown",
          title: "Unsupported effect",
          durationMs: 1000,
          effects: [{ type: "glitchWarp" }]
        }
      ]
    })).toThrow("frames[0].effects[0].type must be one of: rain, signalPulse, cameraPush, particleField, scanSweep.");
  });

  it("enforces review and public source refs for source-derived storyboard workflows", () => {
    const sourceStoryboard = sourceStoryboardVideo();

    expect(() => convertScriptedFramesToMotionPackage({
      ...sourceStoryboard,
      review: { status: "needs-review", required: false }
    })).toThrow("Source-derived scripted videos require review.required to be true.");

    expect(() => convertScriptedFramesToMotionPackage({
      ...sourceStoryboard,
      frames: [
        {
          id: "source-001",
          title: "Missing source",
          durationMs: 1200,
          reviewStatus: "needs-review",
          sourceRefs: []
        }
      ]
    })).toThrow("frames[0].sourceRefs must include at least one source reference for source-derived storyboard workflows.");

    expect(() => convertScriptedFramesToMotionPackage({
      ...sourceStoryboard,
      frames: [
        {
          id: "source-001",
          title: "Private source",
          durationMs: 1200,
          reviewStatus: "needs-review",
          sourceRefs: [{ type: "article", title: "Local", url: "http://127.0.0.1/private" }]
        }
      ]
    })).toThrow("frames[0].sourceRefs[0].url must be a public http(s) URL: refusing to fetch private IP: 127.0.0.1");
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

function storyboardVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "weekly-growth",
    name: "Weekly Growth",
    sourceApp: "shellx-motion",
    workflow: "storyboard-review",
    intent: "data-viz",
    synopsis: "Turn the weekly growth notes into a reviewed multi-scene video.",
    review: {
      status: "ready-for-review",
      required: true
    },
    width: 1280,
    height: 720,
    fps: 30,
    frames: [
      {
        id: "hook",
        title: "Growth is accelerating",
        body: "The last release cycle changed the slope.",
        durationMs: 1400,
        reviewStatus: "approved",
        agentNote: "Open with the core trend.",
        assetRefs: ["assets/logo.png"],
        sourceRefs: [
          { type: "article", title: "Weekly growth notes", url: "https://example.test/growth" }
        ],
        tags: ["intro", "growth"],
        template: {
          id: "frame-bold-signal",
          engine: "hyperframes",
          variables: { mood: "confident" }
        }
      },
      {
        id: "data",
        title: "Stars up 18%",
        caption: "Source: repo metrics",
        durationMs: 1800,
        reviewStatus: "needs-review",
        agentNote: "Reviewer should confirm the CSV values.",
        assetRefs: ["assets/stars.csv"],
        sourceRefs: [
          { type: "repo", title: "ShellX Motion", url: "https://github.com/example/shellx-motion" }
        ],
        tags: ["data-viz"],
        template: {
          id: "frame-data-chart-nyt",
          engine: "hyperframes",
          variables: {
            chart: "stars",
            highlight: "week-27"
          }
        },
        engine: {
          id: "hyperframes",
          mode: "base"
        }
      }
    ]
  };
}

function sourceStoryboardVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "source-storyboard",
    name: "Source Storyboard",
    sourceApp: "shellx-motion",
    workflow: "source-to-scripted-video",
    intent: "source_to_storyboard",
    review: {
      status: "needs-review",
      required: true
    },
    width: 1280,
    height: 720,
    fps: 30,
    frames: [
      {
        id: "source-001",
        title: "Source point",
        durationMs: 1200,
        reviewStatus: "needs-review",
        sourceRefs: [
          { type: "article", title: "Article", url: "https://example.com/article" }
        ]
      }
    ]
  };
}
