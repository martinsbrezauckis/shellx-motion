import { describe, expect, it } from "vitest";
import { readTimelineLayerCreateArg, timelineLayerCreateArg } from "./timeline-layer-create-args";

describe("timeline layer create bounded payloads", () => {
  it("preserves bounded points and analytic particle payloads for the core validator and rejects non-object input", () => {
    const layer = timelineLayerCreateArg({
      layer: {
        id: "swarm",
        type: "points",
        startMs: 0,
        durationMs: 1_000,
        pointCloud: {
          points: [{ x: 8, y: 12, color: "#ffffff", size: 2 }],
          samples: [{ atMs: 0, positions: [{ x: 8, y: 12 }] }, { atMs: 1_000, positions: [{ x: 40, y: 20 }] }]
        }
      }
    }, {});

    expect(layer).toMatchObject({
      id: "swarm",
      type: "points",
      pointCloud: {
        points: [{ x: 8, y: 12, color: "#ffffff", size: 2 }],
        samples: [{ atMs: 0 }, { atMs: 1_000 }]
      }
    });
    expect(timelineLayerCreateArg({
      layer: { id: "bad", type: "points", startMs: 0, durationMs: 1, pointCloud: "not-data" }
    }, {})).toBeNull();

    expect(timelineLayerCreateArg({
      layer: {
        id: "dust", type: "particles", startMs: 0, durationMs: 1_000,
        transform: { x: 0, y: 0, width: 64, height: 36 },
        emitter: {
          seed: 9, count: 24, lifetimeMs: 900, color: "#ffffff",
          field: { schema: "shellx-motion/particle-field@1", sources: [{ kind: "vortex", centerX: 0.5, centerY: 0.5, strength: 0.4, softening: 0.2 }] }
        }
      }
    }, {})).toMatchObject({
      id: "dust", type: "particles",
      transform: { width: 64, height: 36 },
      emitter: { field: { schema: "shellx-motion/particle-field@1", sources: [{ kind: "vortex", strength: 0.4 }] } }
    });
  });

  it("preserves closed gradients and nested fixed effects without silently stripping them", () => {
    expect(timelineLayerCreateArg({
      layer: {
        id: "lit-stage", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1_000,
        transform: { x: 0, y: 0, width: 100, height: 60 },
        gradient: { type: "radial", centerX: 0.4, centerY: 0.5, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] },
        effects: { glow: { radius: 18, color: "#67e8f9" }, motionBlur: { samples: 3, shutterAngle: 180 }, trail: { durationMs: 240, samples: 4 } }
      }
    }, {})).toMatchObject({
      gradient: { type: "radial", centerX: 0.4, centerY: 0.5, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] },
      effects: { glow: { radius: 18, color: "#67e8f9" }, motionBlur: { samples: 3, shutterAngle: 180 }, trail: { durationMs: 240, samples: 4 } }
    });
    expect(timelineLayerCreateArg({
      layer: { id: "grade", type: "adjustment", startMs: 0, durationMs: 1_000, effects: {
        vignette: { amount: 0.4, softness: 0.7, color: "#02030a" }, filmGrain: { amount: 0.05, size: 1, seed: 71 }
      } }
    }, {})).toMatchObject({ effects: {
      vignette: { amount: 0.4, softness: 0.7, color: "#02030a" }, filmGrain: { amount: 0.05, size: 1, seed: 71 }
    } });
    expect(timelineLayerCreateArg({
      layer: { id: "bad", type: "shape", shape: "rect", startMs: 0, durationMs: 1, gradient: {
        type: "linear", stops: [{ offset: 0, color: "#ffffff", formula: "package-code" }]
      } }
    }, {})).toBeNull();
    expect(timelineLayerCreateArg({
      layer: { id: "bad", type: "shape", shape: "rect", startMs: 0, durationMs: 1, effects: {
        glow: { radius: 4, color: "#ffffff", shader: "package-code" }
      } }
    }, {})).toBeNull();
  });

  it.each([
    ["childLayerIds", { childLayerIds: ["child"] }, "active group authoring lane", false],
    ["shader", { type: "shader", shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "shader", seed: 1, fallbackColor: "#112233" } }, "not yet admitted", false],
    ["scene3d", { type: "scene3d", scene3d: { schema: "shellx-motion/scene3d@1", camera: {}, lighting: {}, backgroundColor: "#000000", objects: [] } }, "active scene3d authoring lane", false],
    ["matte", { matte: { type: "alpha", sourceLayerId: "matte-source" } }, "not yet admitted", false],
    ["effectModule", { type: "adjustment", effectModule: { schema: "shellx-motion/effect-module-ref@1", moduleId: "motion.afterimage-stack", version: "1.0.0", parameters: { amountQ16: 32_768, echoes: [{ dxPx: 1, dyPx: 0, color: "#FFFFFFFF", opacityQ16: 32_768 }] } } }, "not yet admitted", false],
    ["depth", { depth: 0.25 }, "active depth authoring lane", false],
    ["textFit", { type: "text", text: "Headline", textFit: { policy: "allow-crop" } }, "not yet admitted", false],
    ["keying", { type: "image", source: "assets/plate.png", keying: { schema: "shellx-motion/chroma-key@1", keyColor: "#00FF00" } }, "existing keying authoring operations", false],
    ["x-extension", { "x-vendor-control": { amount: 1 } }, "unrecognized extension field", false],
    ["unknown", { unrecognisedControl: true }, "not a recognized MotionLayer field", false],
    ["fadeCurve", { type: "audio", source: "assets/music.wav", fadeCurve: "equal-power" }, "", true],
    ["x-path and pathReveal", {
      shape: "path", fill: "transparent", style: { stroke: "#22d3ee", strokeWidth: 3 },
      "x-path": "M 0 50 L 100 50", "x-path-viewBox": "0 0 100 100", "x-path-fillRule": "nonzero",
      pathReveal: { start: 0.2, end: 0.8 }
    }, "", true]
  ] as const)("handles formerly dropped %s without silent loss", (_field, override, problem, admitted) => {
    const layer = {
      id: "candidate", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000,
      ...override
    };
    const result = readTimelineLayerCreateArg({ layer }, {});

    expect(result.ok).toBe(admitted);
    expect(timelineLayerCreateArg({ layer }, {})).toEqual(admitted ? layer : null);
    if (result.ok) {
      expect(result.layer).toStrictEqual(layer);
    } else {
      expect(result.problem).toContain(problem);
    }
  });

  it.each([
    ["invalid fade curve", { fadeCurve: "exponential" }],
    ["malformed x-path", { shape: "path", "x-path": "M 0 0<script>" }],
    ["malformed x-path viewBox", { shape: "path", "x-path": "M 0 0 L 1 1", "x-path-viewBox": "0 0 NaN 10" }],
    ["out-of-range path reveal", { shape: "path", style: { stroke: "#22d3ee", strokeWidth: 2 }, "x-path": "M 0 0 L 100 0", pathReveal: { start: -0.01, end: 1 } }],
    ["wrong primitive type", { opacity: "opaque" }],
    ["unparsed keyframe spatial metadata", { keyframes: { "transform.x": [{ atMs: 0, value: 0, spatial: { mode: "linear", in: { x: 0, y: 0 }, out: { x: 0, y: 0 } } }] } }]
  ] as const)("refuses malformed %s rather than projecting it away", (_name, override) => {
    const result = readTimelineLayerCreateArg({ layer: { id: "malformed", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, ...override } }, {});
    expect(result.ok).toBe(false);
    expect(timelineLayerCreateArg({ layer: { id: "malformed", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, ...override } }, {})).toBeNull();
  });

  it.each([
    [
      "top-level shorthand",
      { layerId: "title", type: "text", text: "Title", startMs: 25, durationMs: 500, color: "#ffffff", fontSize: 32 },
      { startMs: 25, durationMs: 500 },
      { id: "title", type: "text", text: "Title", startMs: 25, durationMs: 500, style: { color: "#ffffff", fontSize: 32 } }
    ],
    [
      "existing image controls",
      { layer: { id: "plate", type: "image", source: "assets/plate.png", startMs: 0, durationMs: 500, crop: { x: 0, y: 0, width: 32, height: 18 }, transform: { x: 4, y: 5, width: 32, height: 18, scale: 1 }, transitions: { in: { type: "fade", durationMs: 100 } } } },
      {},
      { id: "plate", type: "image", source: "assets/plate.png", startMs: 0, durationMs: 500, crop: { x: 0, y: 0, width: 32, height: 18 }, transform: { x: 4, y: 5, width: 32, height: 18, scale: 1 }, transitions: { in: { type: "fade", durationMs: 100 } } }
    ]
  ] as const)("round-trips supported %s exactly", (_name, args, timing, expected) => {
    expect(readTimelineLayerCreateArg(args, timing)).toEqual({ ok: true, layer: expected });
  });

  it("preserves exact v1 geometry and refuses ambiguous or malformed geometry before mutation", () => {
    const geometry = {
      schema: "shellx-motion/shape-geometry@1" as const,
      kind: "polygon" as const,
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      points: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 50, y: 90 }]
    };
    const layer = { id: "geometry", type: "shape", startMs: 0, durationMs: 1_000, geometry };
    expect(readTimelineLayerCreateArg({ layer }, {})).toEqual({ ok: true, layer });
    const dashed = { ...layer, style: { stroke: "#ffffff", strokeWidth: 2, strokeDasharray: [4, 2], strokeDashoffset: -1 } };
    expect(readTimelineLayerCreateArg({ layer: dashed }, {})).toEqual({ ok: true, layer: dashed });
    expect(readTimelineLayerCreateArg({ layer: { ...layer, style: { stroke: "#ffffff", strokeWidth: 2, strokeDashoffset: 1 } } }, {}))
      .toEqual({ ok: false, problem: expect.stringContaining("requires strokeDasharray") });
    expect(readTimelineLayerCreateArg({ layer: { ...layer, style: { strokeDasharray: [4, 2] } } }, {}))
      .toEqual({ ok: false, problem: expect.stringContaining("requires an explicit supported visible stroke") });
    expect(readTimelineLayerCreateArg({ layer: { id: "legacy", type: "shape", shape: "path", startMs: 0, durationMs: 1_000, style: { stroke: "#fff", strokeWidth: 2, strokeDasharray: [4, 2] }, "x-path": "M0 0 L100 100" } }, {}))
      .toEqual({ ok: false, problem: expect.stringContaining("only with v1 layer.geometry") });
    expect(readTimelineLayerCreateArg({ layer: { ...layer, shape: "polygon" } }, {})).toEqual({
      ok: false,
      problem: expect.stringContaining("cannot combine geometry")
    });
    expect(readTimelineLayerCreateArg({ layer: { ...layer, geometry: { ...geometry, points: [{ x: 0, y: 0 }] } } }, {})).toEqual({
      ok: false,
      problem: expect.stringContaining("points must contain")
    });
  });
});
