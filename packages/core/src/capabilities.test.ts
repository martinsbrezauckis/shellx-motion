import { describe, expect, it } from "vitest";
import {
  BROWSER_CAPABILITY,
  listRendererCapabilityCards,
  matchRendererCapability,
  matchRendererCapabilityCards,
  NATIVE_CAPABILITY,
  renderableLayerTypes,
  renderLanesFor,
  rendererCapabilityForLane,
  unrenderableMotionLayers,
  unrenderablePackageRefusal
} from "./capabilities";
import { CHROMA_KEY_SCHEMA, ROTO_MASK_SCHEMA, ROTO_TRACKING_ATTACHMENT_SCHEMA } from "./keying";
import type { MotionDocument, RendererCapability } from "./types";
const baseMotion: MotionDocument = {
  schema: "shellx-motion/motion@1",
  id: "motion_lower_third",
  name: "Lower Third",
  durationMs: 4000,
  fps: 30,
  width: 1920,
  height: 1080,
  layers: [
    { id: "title", type: "text", startMs: 0, durationMs: 4000, text: "Anna" },
    { id: "shape", type: "shape", startMs: 0, durationMs: 4000, shape: "rect" }
  ],
  assets: [],
  provenance: { sourceApp: "shellx-motion", createdBy: "test" }
};

describe("renderer capability matching", () => {
  it("ships agent-readable renderer lane capability cards", () => {
    const cards = listRendererCapabilityCards();

    expect(cards.map((card) => card.lane)).toEqual([
      "native",
      "browser",
      "gpu",
      "ffmpeg",
      "connector",
      "svg-adapter",
      "lottie-adapter",
      "rive-adapter"
    ]);
    expect(cards.find((card) => card.lane === "native")).toMatchObject({
      stability: "degraded",
      weaknesses: expect.arrayContaining([expect.stringContaining("uppercase-folded ASCII block-glyph set")])
    });
    expect(cards.find((card) => card.lane === "browser")).toMatchObject({
      id: "renderer.browser",
      lane: "browser",
      paradigms: ["motion-ir", "html", "css", "browser-capture"],
      outputs: expect.arrayContaining(["png-frame", "jpeg-frame", "png-sequence"]),
      alpha: true,
      audio: "none",
      subtitles: true,
      renderTargets: expect.arrayContaining(["preview", "frame-sequence", "deterministic-capture"]),
      speed: "medium",
      runtime: {
        // Pinned deliberately: browser readiness goes through the same Motion resolver as the
        // renderer, never an independently-executed `chromium --version` command.
        availability: "external-binary",
        requirement: "Chrome or Chromium browser binary (not shipped; see doctor)",
        cost: "local-cpu",
        readiness: { command: "motion.platform.requirements", tools: ["chromium"] },
        setupHint: "Install a Chrome/Chromium browser, or set SHELLX_MOTION_BROWSER to one. Run `doctor` for what this machine is missing."
      },
      strengths: expect.arrayContaining(["HTML/CSS/web layer fidelity"]),
      weaknesses: expect.arrayContaining(["requires deterministic browser readiness gates"])
    });
    expect(cards.find((card) => card.lane === "browser")).toMatchObject({
      layerTypes: expect.arrayContaining(["camera", "points"]),
      features: expect.arrayContaining(["camera.2d", "points.viewport-batched"])
    });
    expect(cards.find((card) => card.lane === "ffmpeg")).toMatchObject({
      layerTypes: expect.arrayContaining(["camera", "particles", "points"]),
      runtime: {
        availability: "external-binary",
        requirement: "FFmpeg and FFprobe binaries",
        cost: "local-cpu",
        readiness: { command: "motion.platform.requirements", tools: ["ffmpeg", "ffprobe"] },
        setupHint: "Install FFmpeg with FFprobe available on PATH before final media renders."
      }
    });
    expect(cards.find((card) => card.lane === "svg-adapter")).toMatchObject({
      id: "adapter.svg",
      category: "adapter",
      outputs: expect.arrayContaining(["motion-package"]),
      adapter: {
        formats: ["svg"],
        unsupportedFeatureClasses: expect.arrayContaining(["filters", "masks", "scripts"]),
        expectedLossiness: "medium-to-high for animated SVG; supported path geometry can lower to Motion shapes but filters, masks, scripts, and complex SMIL/CSS animation require browser fallback.",
        previewLaneRequirement: "browser",
        finalLaneRequirement: "ffmpeg",
        hostCompatibility: expect.arrayContaining(["ShellX Motion", "ShellX Cut via rendered media", "Design Studio via package preview"])
      }
    });
    expect(cards.find((card) => card.lane === "lottie-adapter")).toMatchObject({
      id: "adapter.lottie",
      outputs: expect.arrayContaining(["motion-package"]),
      features: expect.arrayContaining(["lottie.shape.gradient.linear.static"]),
      strengths: expect.arrayContaining([
        "fixture-backed static path/transform/text, linear-gradient, blend-mode, matte, effect, and bundled-image lowering",
        "atomic source-preserving Motion package installation"
      ])
    });
  });

  it("routes keyframed cameras to the browser lane", () => {
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "camera-main",
          type: "camera",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 0, y: 0, scale: 1 },
          keyframes: { "transform.scale": [{ atMs: 0, value: 1 }, { atMs: 1000, value: 1.25 }] }
        },
        ...baseMotion.layers
      ]
    };

    const result = matchRendererCapabilityCards(motion, { output: "png-frame", target: "preview" });

    expect(result.recommendedLane).toBe("browser");
    expect(result.matches.find((match) => match.lane === "browser")).toMatchObject({ ok: true });
    expect(result.matches.find((match) => match.lane === "native")).toMatchObject({
      ok: false,
      unsupported: [
        { layerId: "camera-main", feature: "layer.type:camera", reason: "Lane native does not support camera layers." }
      ]
    });
    expect(matchRendererCapabilityCards(motion, { output: "mp4-h264", target: "final" })).toMatchObject({
      recommendedLane: "ffmpeg",
      matches: expect.arrayContaining([expect.objectContaining({ lane: "ffmpeg", ok: true })])
    });
  });

  it("recommends browser for web-layer frame captures and explains native rejection", () => {
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        { id: "web-card", type: "web", startMs: 0, durationMs: 1000, src: "card.html" }
      ]
    };

    const result = matchRendererCapabilityCards(motion, { output: "png-frame", target: "preview" });

    expect(result.recommendedLane).toBe("browser");
    expect(result.matches.find((match) => match.lane === "browser")).toMatchObject({
      lane: "browser",
      ok: true,
      outputOk: true,
      targetOk: true
    });
    expect(result.matches.find((match) => match.lane === "native")).toMatchObject({
      lane: "native",
      ok: false,
      unsupported: [
        { layerId: "web-card", feature: "layer.type:web", reason: "Lane native does not support web layers." }
      ]
    });
  });

  it("routes bidirectional and complex-script text away from the block-glyph native lane", () => {
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "arabic-title",
          type: "text",
          text: "مرحبا بالعالم",
          startMs: 0,
          durationMs: 1000,
          style: { direction: "rtl" }
        }
      ]
    };

    const result = matchRendererCapabilityCards(motion, { output: "png-frame", target: "preview" });

    expect(result.recommendedLane).toBe("browser");
    expect(result.matches.find((match) => match.lane === "browser")).toMatchObject({
      lane: "browser",
      ok: true,
      unsupported: []
    });
    expect(result.matches.find((match) => match.lane === "native")).toMatchObject({
      lane: "native",
      ok: false,
      unsupported: [
        {
          layerId: "arabic-title",
          feature: "text.direction",
          reason: "Lane native does not support text.direction on layer arabic-title."
        },
        {
          layerId: "arabic-title",
          feature: "text.shaping.complex",
          reason: "Lane native does not support text.shaping.complex on layer arabic-title."
        },
        {
          layerId: "arabic-title",
          feature: "text.charset.non-ascii",
          reason: "Lane native does not support text.charset.non-ascii on layer arabic-title."
        }
      ]
    });
  });

  it("routes explicitly requested font families away from the block-glyph native lane", () => {
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [{
        id: "brand-title",
        type: "text",
        text: "Branded title",
        startMs: 0,
        durationMs: 1000,
        style: { fontFamily: "ShellX Brand" },
      }],
    };

    const result = matchRendererCapabilityCards(motion, { output: "png-frame", target: "preview" });
    expect(result.recommendedLane).toBe("browser");
    expect(result.matches.find((match) => match.lane === "browser")).toMatchObject({ ok: true });
    expect(result.matches.find((match) => match.lane === "native")).toMatchObject({
      ok: false,
      unsupported: [{
        layerId: "brand-title",
        feature: "text.font.family",
        reason: "Lane native does not support text.font.family on layer brand-title.",
      }],
    });
  });

  it("routes bounded path masks to Chromium and rejects unknown mask overclaims", () => {
    const pathMasked: MotionDocument = {
      ...baseMotion,
      layers: [{
        id: "masked",
        type: "shape",
        shape: "rect",
        startMs: 0,
        durationMs: 1000,
        mask: { type: "path", path: "M 0 0 L 100 0 L 50 100 Z", viewBox: "0 0 100 100" }
      }]
    };
    const unknownMasked: MotionDocument = {
      ...pathMasked,
      layers: [{ ...pathMasked.layers[0], mask: { type: "hexagon" } }]
    };

    const pathMatches = matchRendererCapabilityCards(pathMasked);
    expect(pathMatches.matches.find((match) => match.lane === "browser")).toMatchObject({ ok: true });
    expect(pathMatches.matches.find((match) => match.lane === "native")).toMatchObject({
      ok: false,
      unsupported: [expect.objectContaining({ feature: "mask.path" })]
    });
    expect(matchRendererCapabilityCards(unknownMasked).matches.find((match) => match.lane === "browser")).toMatchObject({
      ok: false,
      unsupported: [expect.objectContaining({ feature: "mask.hexagon" })]
    });
  });

  it("routes explicit alpha matte consumers to Chromium only", () => {
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        { id: "matte", type: "shape", shape: "ellipse", startMs: 0, durationMs: 1000 },
        { id: "consumer", type: "shape", shape: "rect", startMs: 0, durationMs: 1000, matte: { type: "alpha", sourceLayerId: "matte" } }
      ]
    };

    const matches = matchRendererCapabilityCards(motion);
    expect(matches.matches.find((match) => match.lane === "browser")).toMatchObject({ ok: true });
    expect(matches.matches.find((match) => match.lane === "native")).toMatchObject({
      ok: false,
      unsupported: [expect.objectContaining({ layerId: "consumer", feature: "matte.alpha" })]
    });
  });

  it("classifies combining marks and joiners as complex shaping requirements", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["text"],
      outputs: ["png"],
      features: []
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        { id: "combining", type: "text", text: "Cafe\u0301", startMs: 0, durationMs: 1000 },
        { id: "indic", type: "text", text: "क्ष", startMs: 0, durationMs: 1000 }
      ]
    };

    expect(matchRendererCapability(motion, native).unsupported).toEqual([
      {
        layerId: "combining",
        feature: "text.shaping.complex",
        reason: "Lane native does not support text.shaping.complex on layer combining."
      },
      {
        layerId: "combining",
        feature: "text.charset.non-ascii",
        reason: "Lane native does not support text.charset.non-ascii on layer combining."
      },
      {
        layerId: "indic",
        feature: "text.shaping.complex",
        reason: "Lane native does not support text.shaping.complex on layer indic."
      },
      {
        layerId: "indic",
        feature: "text.charset.non-ascii",
        reason: "Lane native does not support text.charset.non-ascii on layer indic."
      }
    ]);
  });

  it("classifies simple-shaping non-ASCII scripts as a charset requirement the block-glyph lane cannot meet", () => {
    // the text-delivery invariant regression: these all shape trivially (no combining marks, no joiners, no
    // bidi), so the old complex-shaping-only gate passed them straight through to the native
    // block-glyph fallback, which drew codepoint-derived noise boxes. Latvian diacritics,
    // Greek, Cyrillic, CJK, emoji and typographic punctuation must all be detected.
    const samples: Array<[string, string]> = [
      ["latin-ext", "Ziemeļu Zibens"],
      ["latin-1", "Café done right".normalize("NFC")],
      ["greek", "Αθήνα"],
      ["cyrillic", "Москва"],
      ["cjk", "東京"],
      ["emoji", "Ship it 🚀"],
      ["typographic-punctuation", "It’s “fine” — really"]
    ];
    for (const [id, text] of samples) {
      const motion: MotionDocument = {
        ...baseMotion,
        layers: [{ id, type: "text", text, startMs: 0, durationMs: 1000 }]
      };
      const matches = matchRendererCapabilityCards(motion, { output: "png-frame", target: "preview" });
      expect(matches.matches.find((match) => match.lane === "browser")).toMatchObject({ ok: true });
      expect(matches.matches.find((match) => match.lane === "native")).toMatchObject({
        ok: false,
        unsupported: expect.arrayContaining([
          expect.objectContaining({ layerId: id, feature: "text.charset.non-ascii" })
        ])
      });
    }
  });

  it("keeps plain ASCII text on the fast native lane", () => {
    // The demotion is scoped: the native lane stays a legitimate preview lane for text its
    // block-glyph set actually covers.
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [{ id: "ascii", type: "text", text: "SHELLX MOTION 2026!", startMs: 0, durationMs: 1000 }]
    };

    expect(matchRendererCapabilityCards(motion, { output: "png-frame", target: "preview" })
      .matches.find((match) => match.lane === "native")).toMatchObject({ ok: true, unsupported: [] });
  });

  it("recommends FFmpeg for final MP4 requests that need audio", () => {
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        ...baseMotion.layers,
        { id: "music", type: "audio", startMs: 0, durationMs: 4000, source: "assets/music.wav", volume: 0.7 }
      ]
    };

    const result = matchRendererCapabilityCards(motion, { output: "mp4-h264", target: "final", needsAudio: true });

    expect(result.recommendedLane).toBe("ffmpeg");
    expect((result as typeof result & { recommendedPipeline?: unknown }).recommendedPipeline).toEqual({
      lanes: ["browser", "ffmpeg"],
      frameLane: "browser",
      finalLane: "ffmpeg",
      reason: "Lane ffmpeg requires browser frame capture before final encode."
    });
    expect(result.matches.find((match) => match.lane === "ffmpeg")).toMatchObject({
      lane: "ffmpeg",
      ok: true,
      outputOk: true,
      audioOk: true
    });
    expect(result.matches.find((match) => match.lane === "browser")).toMatchObject({
      lane: "browser",
      ok: false,
      audioOk: false
    });
  });

  it("recommends FFmpeg for transparent final WebM requests", () => {
    const result = matchRendererCapabilityCards(baseMotion, { output: "webm-vp9-alpha", target: "final", needsAlpha: true });

    expect(result.recommendedLane).toBe("ffmpeg");
    expect((result as typeof result & { recommendedPipeline?: unknown }).recommendedPipeline).toEqual({
      lanes: ["browser", "ffmpeg"],
      frameLane: "browser",
      finalLane: "ffmpeg",
      reason: "Lane ffmpeg requires browser frame capture before final encode."
    });
    expect(result.matches.find((match) => match.lane === "ffmpeg")).toMatchObject({
      lane: "ffmpeg",
      ok: true,
      outputOk: true,
      targetOk: true,
      alphaOk: true
    });
  });

  it("accepts supported layer types", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["text", "shape", "image"],
      outputs: ["png"],
      features: ["shape.rect"]
    };

    expect(matchRendererCapability(baseMotion, native)).toEqual({
      ok: true,
      lane: "native",
      unsupported: []
    });
  });

  it("reports exact unsupported layer ids", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["text", "shape", "image"],
      outputs: ["png"],
      features: ["shape.rect"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [...baseMotion.layers, { id: "web-card", type: "web", startMs: 0, durationMs: 1000, src: "index.html" }]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [{ layerId: "web-card", feature: "layer.type:web", reason: "Lane native does not support web layers." }]
    });
  });

  it("ignores invisible layers when matching renderer capabilities", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["text", "shape", "image"],
      outputs: ["png"],
      features: ["shape.rect"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        ...baseMotion.layers,
        { id: "hidden-web-card", type: "web", visible: false, startMs: 0, durationMs: 1000, src: "index.html" }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: true,
      lane: "native",
      unsupported: []
    });
  });

  it("reports unsupported features on otherwise supported layer types", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["text", "shape"],
      outputs: ["png"],
      features: ["shape.rect", "keyframe.opacity", "transition.fade"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "title",
          type: "text",
          startMs: 0,
          durationMs: 1000,
          text: "Move",
          keyframes: {
            "transform.x": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 100 }
            ]
          }
        },
        {
          id: "panel",
          type: "shape",
          startMs: 0,
          durationMs: 1000,
          shape: "rect",
          mask: { type: "rect" },
          transitions: { in: { type: "wipe", durationMs: 300 } }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "title", feature: "keyframe.transform.x", reason: "Lane native does not support keyframe.transform.x on layer title." },
        { layerId: "panel", feature: "mask.rect", reason: "Lane native does not support mask.rect on layer panel." },
        { layerId: "panel", feature: "transition.wipe", reason: "Lane native does not support transition.wipe on layer panel." }
      ]
    });
    expect(matchRendererCapability(motion, { ...native, features: [...native.features, "mask.rect"] })).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "title", feature: "keyframe.transform.x", reason: "Lane native does not support keyframe.transform.x on layer title." },
        { layerId: "panel", feature: "transition.wipe", reason: "Lane native does not support transition.wipe on layer panel." }
      ]
    });
    expect(matchRendererCapability(motion, { ...native, features: [...native.features, "mask.rect", "transition.wipe"] })).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "title", feature: "keyframe.transform.x", reason: "Lane native does not support keyframe.transform.x on layer title." }
      ]
    });
  });

  it("negotiates chroma key and tracked roto independently", () => {
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [{
        id: "subject",
        type: "video",
        source: "assets/subject.mp4",
        startMs: 0,
        durationMs: 1_000,
        keying: { schema: CHROMA_KEY_SCHEMA, keyColor: "#00ff00" },
        mask: {
          type: "roto",
          schema: ROTO_MASK_SCHEMA,
          frames: [{
            atMs: 0,
            vertices: [
              { id: "a", x: 0.1, y: 0.1 },
              { id: "b", x: 0.9, y: 0.1 },
              { id: "c", x: 0.5, y: 0.9 },
            ],
          }],
          tracking: {
            schema: ROTO_TRACKING_ATTACHMENT_SCHEMA,
            analysisId: "subject-track",
            sourceSha256: "a".repeat(64),
            segmentIndex: 0,
            model: "similarity",
          },
        },
      }],
    };
    const result = matchRendererCapability(motion, {
      lane: "browser",
      layerTypes: ["video"],
      outputs: ["png-frame"],
      features: [],
    });

    expect(result.ok).toBe(false);
    expect(result.unsupported).toEqual(expect.arrayContaining([
      expect.objectContaining({ layerId: "subject", feature: "keying.chroma" }),
      expect.objectContaining({ layerId: "subject", feature: "mask.roto" }),
      expect.objectContaining({ layerId: "subject", feature: "mask.roto.tracked" }),
    ]));
  });

  it("reports image source crop rectangles as media features", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["image"],
      outputs: ["png"],
      features: []
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "product",
          type: "image",
          assetRef: "assets/product.png",
          startMs: 0,
          durationMs: 1000,
          crop: { x: 10, y: 20, width: 300, height: 200 }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "product", feature: "image.crop", reason: "Lane native does not support image.crop on layer product." }
      ]
    });
    expect(matchRendererCapability(motion, { ...native, features: ["image.crop"] })).toEqual({
      ok: true,
      lane: "native",
      unsupported: []
    });
  });

  it("reports video source crop rectangles as media features", () => {
    const browser: RendererCapability = {
      lane: "browser",
      layerTypes: ["video"],
      outputs: ["png"],
      features: []
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "clip",
          type: "video",
          source: "assets/clip.mp4",
          startMs: 0,
          durationMs: 1000,
          crop: { x: 10, y: 20, width: 300, height: 200 }
        }
      ]
    };

    expect(matchRendererCapability(motion, browser)).toEqual({
      ok: false,
      lane: "browser",
      unsupported: [
        { layerId: "clip", feature: "video.crop", reason: "Lane browser does not support video.crop on layer clip." }
      ]
    });
    expect(matchRendererCapability(motion, { ...browser, features: ["video.crop"] })).toEqual({
      ok: true,
      lane: "browser",
      unsupported: []
    });
  });

  it("treats freeform shapes with path geometry as path capabilities", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape"],
      outputs: ["png"],
      features: ["shape.path"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "badge",
          type: "shape",
          shape: "freeform",
          "x-path": "M 10 50 L 50 10 L 90 50 L 70 90 L 30 90 Z",
          startMs: 0,
          durationMs: 1000
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: true,
      lane: "native",
      unsupported: []
    });
    expect(matchRendererCapability({
      ...motion,
      layers: [{ id: "bare", type: "shape", shape: "freeform", startMs: 0, durationMs: 1000 }]
    }, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "bare", feature: "shape.freeform", reason: "Lane native does not support shape.freeform on layer bare." }
      ]
    });
  });

  it("requires explicit curve support for curved SVG path geometry", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape"],
      outputs: ["png"],
      features: ["shape.path"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "curve",
          type: "shape",
          shape: "path",
          "x-path": "M 10 80 C 30 10 70 10 90 80 Z",
          startMs: 0,
          durationMs: 1000
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "curve", feature: "shape.path.curve", reason: "Lane native does not support shape.path.curve on layer curve." }
      ]
    });
    expect(matchRendererCapability(motion, { ...native, features: ["shape.path.curve"] })).toEqual({
      ok: true,
      lane: "native",
      unsupported: []
    });
  });

  it("reports advanced media fit values as renderer lane capabilities", () => {
    const browser: RendererCapability = {
      lane: "browser",
      layerTypes: ["image", "video"],
      outputs: ["png"],
      features: []
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "product",
          type: "image",
          source: "assets/product.png",
          startMs: 0,
          durationMs: 1000,
          style: { objectFit: "none" }
        },
        {
          id: "clip",
          type: "video",
          source: "assets/clip.mp4",
          startMs: 0,
          durationMs: 1000,
          style: { fit: "scale-down" }
        }
      ]
    };

    expect(matchRendererCapability(motion, browser)).toEqual({
      ok: false,
      lane: "browser",
      unsupported: [
        { layerId: "product", feature: "image.fit.none", reason: "Lane browser does not support image.fit.none on layer product." },
        { layerId: "clip", feature: "video.fit.scale-down", reason: "Lane browser does not support video.fit.scale-down on layer clip." }
      ]
    });
    expect(matchRendererCapability(motion, { ...browser, features: ["image.fit.*", "video.fit.scale-down"] })).toEqual({
      ok: true,
      lane: "browser",
      unsupported: []
    });
  });

  it("reports audio pan keyframes as renderer lane capabilities", () => {
    const ffmpeg: RendererCapability = {
      lane: "ffmpeg",
      layerTypes: ["audio"],
      outputs: ["mp4"],
      features: ["keyframe.volume"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "music",
          type: "audio",
          source: "assets/music.wav",
          startMs: 0,
          durationMs: 1000,
          keyframes: {
            pan: [
              { atMs: 0, value: -1 },
              { atMs: 1000, value: 1 }
            ]
          }
        }
      ]
    };

    expect(matchRendererCapability(motion, ffmpeg)).toEqual({
      ok: false,
      lane: "ffmpeg",
      unsupported: [
        { layerId: "music", feature: "keyframe.pan", reason: "Lane ffmpeg does not support keyframe.pan on layer music." }
      ]
    });
    expect(matchRendererCapability(motion, { ...ffmpeg, features: [...ffmpeg.features, "keyframe.pan"] })).toEqual({
      ok: true,
      lane: "ffmpeg",
      unsupported: []
    });
  });

  it("reports video timing controls as renderer lane capabilities", () => {
    const browser: RendererCapability = {
      lane: "browser",
      layerTypes: ["video"],
      outputs: ["png"],
      features: []
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "clip",
          type: "video",
          source: "assets/clip.mp4",
          startMs: 0,
          durationMs: 1000,
          trimStartMs: 200,
          trimDurationMs: 600,
          loop: true,
          playbackRate: 1.5
        }
      ]
    };

    expect(matchRendererCapability(motion, browser)).toEqual({
      ok: false,
      lane: "browser",
      unsupported: [
        { layerId: "clip", feature: "video.trim", reason: "Lane browser does not support video.trim on layer clip." },
        { layerId: "clip", feature: "video.loop", reason: "Lane browser does not support video.loop on layer clip." },
        { layerId: "clip", feature: "video.playbackRate", reason: "Lane browser does not support video.playbackRate on layer clip." }
      ]
    });
    expect(matchRendererCapability(motion, { ...browser, features: ["video.trim", "video.loop", "video.playbackRate"] })).toEqual({
      ok: true,
      lane: "browser",
      unsupported: []
    });
  });

  it("reports audio mix controls as renderer lane capabilities", () => {
    const ffmpeg: RendererCapability = {
      lane: "ffmpeg",
      layerTypes: ["audio"],
      outputs: ["mp4"],
      features: []
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "music",
          type: "audio",
          source: "assets/music.wav",
          startMs: 0,
          durationMs: 1000,
          trimStartMs: 100,
          trimDurationMs: 800,
          loop: true,
          volume: 0.6,
          pan: -0.25,
          muted: true,
          fadeInMs: 120,
          fadeOutMs: 200,
          normalizeLoudness: true,
          ducking: { triggerLayerIds: ["voice"], duckToVolume: 0.35 }
        }
      ]
    };

    expect(matchRendererCapability(motion, ffmpeg)).toEqual({
      ok: false,
      lane: "ffmpeg",
      unsupported: [
        { layerId: "music", feature: "audio.trim", reason: "Lane ffmpeg does not support audio.trim on layer music." },
        { layerId: "music", feature: "audio.loop", reason: "Lane ffmpeg does not support audio.loop on layer music." },
        { layerId: "music", feature: "audio.volume", reason: "Lane ffmpeg does not support audio.volume on layer music." },
        { layerId: "music", feature: "audio.pan", reason: "Lane ffmpeg does not support audio.pan on layer music." },
        { layerId: "music", feature: "audio.muted", reason: "Lane ffmpeg does not support audio.muted on layer music." },
        { layerId: "music", feature: "audio.fade", reason: "Lane ffmpeg does not support audio.fade on layer music." },
        { layerId: "music", feature: "audio.normalizeLoudness", reason: "Lane ffmpeg does not support audio.normalizeLoudness on layer music." },
        { layerId: "music", feature: "audio.ducking", reason: "Lane ffmpeg does not support audio.ducking on layer music." }
      ]
    });
    expect(matchRendererCapability(motion, {
      ...ffmpeg,
      features: [
        "audio.trim",
        "audio.loop",
        "audio.volume",
        "audio.pan",
        "audio.muted",
        "audio.fade",
        "audio.normalizeLoudness",
        "audio.ducking"
      ]
    })).toEqual({
      ok: true,
      lane: "ffmpeg",
      unsupported: []
    });
  });

  it("reports video audio extraction controls separately from visual video controls", () => {
    const browser: RendererCapability = {
      lane: "browser",
      layerTypes: ["video"],
      outputs: ["png"],
      features: ["video.trim", "video.loop", "video.playbackRate"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "clip",
          type: "video",
          source: "assets/clip.mp4",
          startMs: 0,
          durationMs: 1000,
          trimStartMs: 100,
          trimDurationMs: 700,
          loop: true,
          playbackRate: 1.25,
          includeAudio: true,
          volume: 0.5,
          fadeInMs: 100
        }
      ]
    };

    expect(matchRendererCapability(motion, browser)).toEqual({
      ok: false,
      lane: "browser",
      unsupported: [
        { layerId: "clip", feature: "video.includeAudio", reason: "Lane browser does not support video.includeAudio on layer clip." },
        { layerId: "clip", feature: "audio.trim", reason: "Lane browser does not support audio.trim on layer clip." },
        { layerId: "clip", feature: "audio.loop", reason: "Lane browser does not support audio.loop on layer clip." },
        { layerId: "clip", feature: "audio.playbackRate", reason: "Lane browser does not support audio.playbackRate on layer clip." },
        { layerId: "clip", feature: "audio.volume", reason: "Lane browser does not support audio.volume on layer clip." },
        { layerId: "clip", feature: "audio.fade", reason: "Lane browser does not support audio.fade on layer clip." }
      ]
    });
  });

  it("reports layer blend modes as compositor features", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape"],
      outputs: ["png"],
      features: ["shape.rect"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "multiply-panel",
          type: "shape",
          startMs: 0,
          durationMs: 1000,
          shape: "rect",
          blendMode: "multiply"
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "multiply-panel", feature: "blend.multiply", reason: "Lane native does not support blend.multiply on layer multiply-panel." }
      ]
    });
  });

  it("reports blend mode keyframes as both keyframe and compositor features", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape"],
      outputs: ["png"],
      features: ["shape.rect"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "blend-panel",
          type: "shape",
          startMs: 0,
          durationMs: 1000,
          shape: "rect",
          keyframes: {
            blendMode: [
              { atMs: 0, value: "normal" },
              { atMs: 500, value: "multiply" }
            ]
          }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "blend-panel", feature: "blend.multiply", reason: "Lane native does not support blend.multiply on layer blend-panel." },
        { layerId: "blend-panel", feature: "keyframe.blendMode", reason: "Lane native does not support keyframe.blendMode on layer blend-panel." }
      ]
    });
    expect(matchRendererCapability(motion, { ...native, features: [...native.features, "keyframe.blendMode", "blend.*"] })).toEqual({
      ok: true,
      lane: "native",
      unsupported: []
    });
  });

  it("reports explicit transform origins as anchor features", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape"],
      outputs: ["png"],
      features: ["shape.rect"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "anchored-panel",
          type: "shape",
          startMs: 0,
          durationMs: 1000,
          shape: "rect",
          transform: { x: 80, y: 40, width: 40, height: 20, scale: 2, originX: 0, originY: 0 }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "anchored-panel", feature: "transform.origin", reason: "Lane native does not support transform.origin on layer anchored-panel." }
      ]
    });
  });

  it("reports transform origin keyframes as anchor features even with generic transform keyframe support", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape"],
      outputs: ["png"],
      features: ["shape.rect", "keyframe.transform.*"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "anchored-panel",
          type: "shape",
          startMs: 0,
          durationMs: 1000,
          shape: "rect",
          keyframes: {
            "transform.originX": [
              { atMs: 0, value: 20 },
              { atMs: 1000, value: 0 }
            ]
          }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "anchored-panel", feature: "transform.origin", reason: "Lane native does not support transform.origin on layer anchored-panel." }
      ]
    });
  });

  it("reports unsupported style radius keyframes separately from supported text style keyframes", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape", "text"],
      outputs: ["png"],
      features: ["shape.rect", "keyframe.style.fontSize"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "title",
          type: "text",
          text: "Grow",
          startMs: 0,
          durationMs: 1000,
          keyframes: {
            "style.fontSize": [
              { atMs: 0, value: 24 },
              { atMs: 1000, value: 48 }
            ],
            "style.fontWeight": [
              { atMs: 0, value: 400 },
              { atMs: 1000, value: 900 }
            ],
            "style.letterSpacing": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 24 }
            ],
            "style.textAlign": [
              { atMs: 0, value: "left" },
              { atMs: 1000, value: "right" }
            ],
            "style.verticalAlign": [
              { atMs: 0, value: "top" },
              { atMs: 1000, value: "bottom" }
            ],
            "style.alignY": [
              { atMs: 0, value: "top" },
              { atMs: 1000, value: "middle" }
            ],
            "style.lineHeight": [
              { atMs: 0, value: 1.1 },
              { atMs: 1000, value: 1.6 }
            ]
          }
        },
        {
          id: "panel",
          type: "shape",
          startMs: 0,
          durationMs: 1000,
          shape: "rect",
          keyframes: {
            "style.width": [
              { atMs: 0, value: 80 },
              { atMs: 1000, value: 160 }
            ],
            "style.height": [
              { atMs: 0, value: 40 },
              { atMs: 1000, value: 80 }
            ],
            "style.radius": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 28 }
            ],
            "style.borderRadius": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 28 }
            ],
            "style.padding": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 16 }
            ],
            "style.paddingX": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 16 }
            ],
            "style.paddingY": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 16 }
            ],
            "style.paddingTop": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 16 }
            ],
            "style.paddingRight": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 16 }
            ],
            "style.paddingBottom": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 16 }
            ],
            "style.paddingLeft": [
              { atMs: 0, value: 0 },
              { atMs: 1000, value: 16 }
            ]
          }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "title", feature: "keyframe.style.fontWeight", reason: "Lane native does not support keyframe.style.fontWeight on layer title." },
        { layerId: "title", feature: "keyframe.style.letterSpacing", reason: "Lane native does not support keyframe.style.letterSpacing on layer title." },
        { layerId: "title", feature: "keyframe.style.textAlign", reason: "Lane native does not support keyframe.style.textAlign on layer title." },
        { layerId: "title", feature: "keyframe.style.verticalAlign", reason: "Lane native does not support keyframe.style.verticalAlign on layer title." },
        { layerId: "title", feature: "keyframe.style.alignY", reason: "Lane native does not support keyframe.style.alignY on layer title." },
        { layerId: "title", feature: "keyframe.style.lineHeight", reason: "Lane native does not support keyframe.style.lineHeight on layer title." },
        { layerId: "panel", feature: "keyframe.style.width", reason: "Lane native does not support keyframe.style.width on layer panel." },
        { layerId: "panel", feature: "keyframe.style.height", reason: "Lane native does not support keyframe.style.height on layer panel." },
        { layerId: "panel", feature: "keyframe.style.radius", reason: "Lane native does not support keyframe.style.radius on layer panel." },
        { layerId: "panel", feature: "keyframe.style.borderRadius", reason: "Lane native does not support keyframe.style.borderRadius on layer panel." },
        { layerId: "panel", feature: "keyframe.style.padding", reason: "Lane native does not support keyframe.style.padding on layer panel." },
        { layerId: "panel", feature: "keyframe.style.paddingX", reason: "Lane native does not support keyframe.style.paddingX on layer panel." },
        { layerId: "panel", feature: "keyframe.style.paddingY", reason: "Lane native does not support keyframe.style.paddingY on layer panel." },
        { layerId: "panel", feature: "keyframe.style.paddingTop", reason: "Lane native does not support keyframe.style.paddingTop on layer panel." },
        { layerId: "panel", feature: "keyframe.style.paddingRight", reason: "Lane native does not support keyframe.style.paddingRight on layer panel." },
        { layerId: "panel", feature: "keyframe.style.paddingBottom", reason: "Lane native does not support keyframe.style.paddingBottom on layer panel." },
        { layerId: "panel", feature: "keyframe.style.paddingLeft", reason: "Lane native does not support keyframe.style.paddingLeft on layer panel." }
      ]
    });
  });

  it("reports color keyframe support per lane", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape", "text"],
      outputs: ["png"],
      features: ["shape.rect", "keyframe.fill"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "panel",
          type: "shape",
          startMs: 0,
          durationMs: 1000,
          shape: "rect",
          keyframes: {
            fill: [
              { atMs: 0, value: "#000000" },
              { atMs: 1000, value: "#ffffff" }
            ],
            "style.fill": [
              { atMs: 0, value: "#111827" },
              { atMs: 1000, value: "#f8fafc" }
            ],
            "style.stroke": [
              { atMs: 0, value: "#111827" },
              { atMs: 1000, value: "#f8fafc" }
            ],
            "style.strokeWidth": [
              { atMs: 0, value: 2 },
              { atMs: 1000, value: 8 }
            ]
          }
        },
        {
          id: "title",
          type: "text",
          text: "Color",
          startMs: 0,
          durationMs: 1000,
          keyframes: {
            "style.color": [
              { atMs: 0, value: "#ffffff" },
              { atMs: 1000, value: "#111827" }
            ],
            "style.borderColor": [
              { atMs: 0, value: "#ffffff" },
              { atMs: 1000, value: "#111827" }
            ],
            "style.backgroundColor": [
              { atMs: 0, value: "#ffffff" },
              { atMs: 1000, value: "#111827" }
            ],
            "style.background": [
              { atMs: 0, value: "#ffffff" },
              { atMs: 1000, value: "#111827" }
            ],
            "style.borderWidth": [
              { atMs: 0, value: 2 },
              { atMs: 1000, value: 8 }
            ]
          }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "panel", feature: "keyframe.style.fill", reason: "Lane native does not support keyframe.style.fill on layer panel." },
        { layerId: "panel", feature: "keyframe.style.stroke", reason: "Lane native does not support keyframe.style.stroke on layer panel." },
        { layerId: "panel", feature: "keyframe.style.strokeWidth", reason: "Lane native does not support keyframe.style.strokeWidth on layer panel." },
        { layerId: "title", feature: "keyframe.style.color", reason: "Lane native does not support keyframe.style.color on layer title." },
        { layerId: "title", feature: "keyframe.style.borderColor", reason: "Lane native does not support keyframe.style.borderColor on layer title." },
        { layerId: "title", feature: "keyframe.style.backgroundColor", reason: "Lane native does not support keyframe.style.backgroundColor on layer title." },
        { layerId: "title", feature: "keyframe.style.background", reason: "Lane native does not support keyframe.style.background on layer title." },
        { layerId: "title", feature: "keyframe.style.borderWidth", reason: "Lane native does not support keyframe.style.borderWidth on layer title." }
      ]
    });
  });

  it("reports shape strokes as renderer features", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape"],
      outputs: ["png"],
      features: ["shape.rect"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "outlined-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 10, width: 120, height: 80 },
          style: { fill: "#ffffff", stroke: "#111827", width: 4 }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "outlined-panel", feature: "shape.stroke", reason: "Lane native does not support shape.stroke on layer outlined-panel." }
      ]
    });
  });

  it("reports non-rect shape kinds as renderer features", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape"],
      outputs: ["png"],
      features: ["shape.rect"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "badge",
          type: "shape",
          shape: "ellipse",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 10, width: 120, height: 80 }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "badge", feature: "shape.ellipse", reason: "Lane native does not support shape.ellipse on layer badge." }
      ]
    });
    expect(matchRendererCapability(motion, { ...native, features: ["shape.rect", "shape.ellipse"] })).toEqual({
      ok: true,
      lane: "native",
      unsupported: []
    });

    const triangleMotion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "play-icon",
          type: "shape",
          shape: "triangle",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 10, width: 120, height: 80 }
        }
      ]
    };
    expect(matchRendererCapability(triangleMotion, { ...native, features: ["shape.rect", "shape.triangle"] })).toEqual({
      ok: true,
      lane: "native",
      unsupported: []
    });
  });

  it("normalizes rectangle shape aliases to the rect capability feature", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape"],
      outputs: ["png"],
      features: ["shape.rect"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "panel",
          type: "shape",
          shape: "rectangle",
          startMs: 0,
          durationMs: 1000
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: true,
      lane: "native",
      unsupported: []
    });
  });

  it("reports rounded shape corners as renderer features", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape"],
      outputs: ["png"],
      features: ["shape.rect"]
    };
    const roundedNative: RendererCapability = {
      ...native,
      features: ["shape.rect", "shape.radius"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "rounded-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 10, y: 10, width: 120, height: 80 },
          style: { fill: "#ffffff", radius: 16 }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "rounded-panel", feature: "shape.radius", reason: "Lane native does not support shape.radius on layer rounded-panel." }
      ]
    });
    expect(matchRendererCapability(motion, roundedNative)).toEqual({
      ok: true,
      lane: "native",
      unsupported: []
    });
  });

  it("reports visual shadows as renderer style features", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape", "text"],
      outputs: ["png"],
      features: ["shape.rect"]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "shadow-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 80, height: 60 },
          style: { fill: "#ffffff", shadow: { x: 16, y: 0, blur: 0, color: "#000000" } }
        },
        {
          id: "shadow-title",
          type: "text",
          text: "Depth",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 90, width: 120, height: 40 },
          style: { color: "#ffffff", textShadow: { x: 2, y: 2, blur: 0, color: "#000000" } }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "shadow-panel", feature: "style.shadow", reason: "Lane native does not support style.shadow on layer shadow-panel." },
        { layerId: "shadow-title", feature: "style.textShadow", reason: "Lane native does not support style.textShadow on layer shadow-title." }
      ]
    });

    expect(matchRendererCapability(motion, { ...native, features: ["shape.rect", "style.shadow"] })).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "shadow-title", feature: "style.textShadow", reason: "Lane native does not support style.textShadow on layer shadow-title." }
      ]
    });
  });

  it("reports shadow component keyframes as renderer style features", () => {
    const native: RendererCapability = {
      lane: "native",
      layerTypes: ["shape", "text"],
      outputs: ["png"],
      features: ["shape.rect", "style.shadow", "style.textShadow"]
    };
    const shadowNative: RendererCapability = {
      ...native,
      features: [
        "shape.rect",
        "style.shadow",
        "style.textShadow",
        "keyframe.style.shadow.x",
        "keyframe.style.shadow.offsetX",
        "keyframe.style.shadow.offsetY",
        "keyframe.style.shadow.blurRadius",
        "keyframe.style.shadow.spreadRadius",
        "keyframe.style.textShadow.offsetX",
        "keyframe.style.textShadow.offsetY",
        "keyframe.style.textShadow.blurRadius"
      ]
    };
    const motion: MotionDocument = {
      ...baseMotion,
      layers: [
        {
          id: "shadow-panel",
          type: "shape",
          shape: "rect",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 80, height: 60 },
          style: { fill: "#ffffff", shadow: { x: 0, y: 0, blur: 0, color: "#000000" } },
          keyframes: {
            "style.shadow.x": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 16 }
            ],
            "style.shadow.offsetX": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 16 }
            ],
            "style.shadow.offsetY": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 16 }
            ],
            "style.shadow.blurRadius": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 4 }
            ],
            "style.shadow.spreadRadius": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 4 }
            ]
          }
        },
        {
          id: "shadow-title",
          type: "text",
          text: "Depth",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 90, width: 120, height: 40 },
          style: { color: "#ffffff", textShadow: { offsetX: 0, offsetY: 0, blurRadius: 0, color: "#000000" } },
          keyframes: {
            "style.textShadow.offsetX": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 16 }
            ],
            "style.textShadow.offsetY": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 16 }
            ],
            "style.textShadow.blurRadius": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 4 }
            ]
          }
        }
      ]
    };

    expect(matchRendererCapability(motion, native)).toEqual({
      ok: false,
      lane: "native",
      unsupported: [
        { layerId: "shadow-panel", feature: "keyframe.style.shadow.x", reason: "Lane native does not support keyframe.style.shadow.x on layer shadow-panel." },
        { layerId: "shadow-panel", feature: "keyframe.style.shadow.offsetX", reason: "Lane native does not support keyframe.style.shadow.offsetX on layer shadow-panel." },
        { layerId: "shadow-panel", feature: "keyframe.style.shadow.offsetY", reason: "Lane native does not support keyframe.style.shadow.offsetY on layer shadow-panel." },
        { layerId: "shadow-panel", feature: "keyframe.style.shadow.blurRadius", reason: "Lane native does not support keyframe.style.shadow.blurRadius on layer shadow-panel." },
        { layerId: "shadow-panel", feature: "keyframe.style.shadow.spreadRadius", reason: "Lane native does not support keyframe.style.shadow.spreadRadius on layer shadow-panel." },
        { layerId: "shadow-title", feature: "keyframe.style.textShadow.offsetX", reason: "Lane native does not support keyframe.style.textShadow.offsetX on layer shadow-title." },
        { layerId: "shadow-title", feature: "keyframe.style.textShadow.offsetY", reason: "Lane native does not support keyframe.style.textShadow.offsetY on layer shadow-title." },
        { layerId: "shadow-title", feature: "keyframe.style.textShadow.blurRadius", reason: "Lane native does not support keyframe.style.textShadow.blurRadius on layer shadow-title." }
      ]
    });
    expect(matchRendererCapability(motion, shadowNative)).toEqual({
      ok: true,
      lane: "native",
      unsupported: []
    });
  });
});

describe("renderer capability single-source consistency", () => {
  it("derives every per-lane capability from its core card (no drift)", () => {
    // The capability cards in capabilities.ts are the single source of truth. Each renderer lane's
    // runtime capability must be exactly the projection of its card down to the RendererCapability
    // shape; if a future edit lets them diverge, this fails CI.
    for (const card of listRendererCapabilityCards()) {
      expect(rendererCapabilityForLane(card.lane)).toMatchObject({
        lane: card.lane,
        layerTypes: card.layerTypes,
        outputs: card.outputs,
        features: card.features
      });
    }
  });

  it("exposes the native and browser render-lane constants as their card projections", () => {
    expect(NATIVE_CAPABILITY).toEqual(rendererCapabilityForLane("native"));
    expect(BROWSER_CAPABILITY).toEqual(rendererCapabilityForLane("browser"));
  });

  it("throws for a lane with no registered card", () => {
    expect(() => rendererCapabilityForLane("does-not-exist")).toThrow(/No renderer capability card/);
  });
});

describe("unrenderable layer types", () => {
  /** A one-layer document of `type`, so the lane gate can be asked about that type alone. */
  function motionWithLayerType(type: string, extra: Record<string, unknown> = {}): MotionDocument {
    return { ...baseMotion, layers: [{ id: "probe", type, startMs: 0, durationMs: 1000, ...extra }] };
  }

  it("agrees with the lanes' own gate about which types are renderable", () => {
    // The point of renderableLayerTypes() is that it is not a second list. For every type it
    // publishes some lane must accept it, and for a type it withholds every lane must reject it
    // with the same layer.type feature the runtime gate reports.
    for (const type of renderableLayerTypes()) {
      const motion = motionWithLayerType(type);
      const accepted = listRendererCapabilityCards()
        .some((card) => !matchRendererCapability(motion, rendererCapabilityForLane(card.lane))
          .unsupported.some((item) => item.feature === `layer.type:${type}`));
      expect(accepted, `some lane must accept layer type ${type}`).toBe(true);
    }

    const motion = motionWithLayerType("rect");
    for (const card of listRendererCapabilityCards()) {
      expect(matchRendererCapability(motion, rendererCapabilityForLane(card.lane)).unsupported).toContainEqual({
        layerId: "probe",
        feature: "layer.type:rect",
        reason: `Lane ${card.lane} does not support rect layers.`
      });
    }
  });

  it("reports a layer no lane can render", () => {
    expect(unrenderableMotionLayers(motionWithLayerType("rect"))).toEqual([{ layerId: "probe", type: "rect" }]);
  });

  it("reports nothing for a document every layer of which some lane renders", () => {
    expect(unrenderableMotionLayers(motionWithLayerType("shape"))).toEqual([]);
  });

  it("skips hidden layers, exactly as the lane gate does", () => {
    const hidden = motionWithLayerType("rect", { visible: false });
    expect(unrenderableMotionLayers(hidden)).toEqual([]);
    expect(matchRendererCapability(hidden, BROWSER_CAPABILITY).unsupported).toEqual([]);
  });
});

describe("render lanes for a document", () => {
  /** `baseMotion` plus `layers`, keeping the rest of the document constant. */
  function motionWithLayers(layers: MotionDocument["layers"]): MotionDocument {
    return { ...baseMotion, layers };
  }

  it("lists every pixel lane that accepts the document, in card order", () => {
    // Plain text + shape with no custom font: all three render lanes take it.
    expect(renderLanesFor(baseMotion)).toEqual(["native", "browser", "ffmpeg"]);
  });

  it("lists the lanes that render a scene3d/particles document instead of withholding them", () => {
    // The defect this function replaced advertised ["canvas"] for exactly this document, because
    // adapters-canvas kept a private layer-type set that predated these kinds.
    const lanes = renderLanesFor(motionWithLayers([
      { id: "stage", type: "scene3d", startMs: 0, durationMs: 1000 },
      { id: "sparks", type: "particles", startMs: 0, durationMs: 1000 }
    ]));

    expect(lanes).toEqual(["browser", "ffmpeg"]);
    // And the omission of native is the card matcher's own verdict, not a second opinion.
    expect(matchRendererCapabilityCards(motionWithLayers([{ id: "stage", type: "scene3d", startMs: 0, durationMs: 1000 }]))
      .matches.find((match) => match.lane === "native")?.ok).toBe(false);
  });

  it("agrees with the card matcher lane by lane, and never invents a lane", () => {
    for (const type of [...renderableLayerTypes(), "rect"]) {
      const motion = motionWithLayers([{ id: "probe", type, startMs: 0, durationMs: 1000 }]);
      const lanes = renderLanesFor(motion);
      for (const match of matchRendererCapabilityCards(motion).matches) {
        const pixelLane = match.category === "preview" || match.category === "final";
        expect(lanes.includes(match.lane), `${match.lane} for ${type}`).toBe(pixelLane && match.ok);
      }
    }
  });

  it("omits connector and adapter lanes even when their cards accept the document", () => {
    // The connector card accepts plain text/shape, but it emits packages and plans rather than
    // pixels: listing it as a render lane would be the same untrue advertisement in a new place.
    expect(matchRendererCapabilityCards(baseMotion).matches.find((match) => match.lane === "connector")?.ok).toBe(true);
    expect(renderLanesFor(baseMotion)).not.toContain("connector");
  });

  it("reports no lane at all for a document nothing can draw", () => {
    expect(renderLanesFor(motionWithLayers([{ id: "probe", type: "rect", startMs: 0, durationMs: 1000 }]))).toEqual([]);
  });
});

describe("unrenderable package refusal", () => {
  /** `baseMotion` plus one layer of `type`, so the refusal can be asked about that type alone. */
  function motionWithLayerType(type: string, extra: Record<string, unknown> = {}): MotionDocument {
    return { ...baseMotion, layers: [{ id: "probe", type, startMs: 0, durationMs: 1000, ...extra }] };
  }

  it("answers null when at least one lane can render every layer", () => {
    expect(unrenderablePackageRefusal(baseMotion)).toBeNull();
    expect(unrenderablePackageRefusal(motionWithLayerType("scene3d"))).toBeNull();
  });

  it("names the offending layers and the correction", () => {
    expect(unrenderablePackageRefusal(motionWithLayerType("rect"))).toEqual({
      code: "package_unrenderable",
      message: 'No render lane supports 1 layer: probe (type "rect").',
      suggestedAction: "Change each layer's type to one a lane renders; motion.capabilities.cards lists the "
        + "layer types every lane accepts.",
      layers: [{ layerId: "probe", type: "rect" }]
    });
  });

  it("counts every offending layer in one answer", () => {
    const refusal = unrenderablePackageRefusal({
      ...baseMotion,
      layers: [
        { id: "box", type: "rect", startMs: 0, durationMs: 1000 },
        { id: "oval", type: "ellipse", startMs: 0, durationMs: 1000 }
      ]
    });

    expect(refusal?.message).toBe('No render lane supports 2 layers: box (type "rect"), oval (type "ellipse").');
    expect(refusal?.layers).toHaveLength(2);
  });

  it("skips hidden layers, exactly as the lane gate does", () => {
    expect(unrenderablePackageRefusal(motionWithLayerType("rect", { visible: false }))).toBeNull();
  });
});
