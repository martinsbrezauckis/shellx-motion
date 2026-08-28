/**
 * Static renderer capability-card catalog for ShellX Motion.
 * Role: the authoritative data table describing each renderer lane (native/browser/ffmpeg/host families)
 * — its paradigms, supported layer types, features, outputs, audio handling, runtime requirements, and
 * host compatibility. Extracted verbatim from `capabilities.ts` so the capability-matching logic no longer
 * carries the large data literal to satisfy the module-size architecture gate. Data only, no runtime logic; the
 * cross-lane consistency and feature-sync tests (capabilities.test.ts) continue to enforce its contents.
 * Dependencies: the `RendererCapabilityCard` type from `./types`.
 * Primary caller: `packages/core/src/capabilities.ts` (catalog listing, projection, and matching).
 */
import type { RendererCapabilityCard } from "./types";
import { BROWSER_RENDER_FEATURES, PARTICLE_RENDER_FEATURES } from "./browser-render-capabilities";
import { COLOR_ALPHA_LANE_CAPABILITIES } from "./color-alpha-contract";
import { GPU_CAPABILITY_CARD } from "./gpu-capability-card";
export const RENDERER_CAPABILITY_CARDS: RendererCapabilityCard[] = [
  {
    id: "renderer.native",
    label: "Native Preview",
    category: "preview",
    role: "frame-producer",
    lane: "native",
    visualFeatureSupport: "direct",
    paradigms: ["motion-ir", "canvas-raster"],
    layerTypes: ["text", "shape", "image", "caption", "particles", "points"],
    outputs: ["png-frame", "png", "png-sequence"],
    // This is the authoritative native-lane feature list: the native rasterizer gates renders
    // against exactly these features (see NATIVE_CAPABILITY, re-exported by renderer-native and
    // consumed by matchRendererCapability at render time). It deliberately enumerates specific
    // features instead of using broad wildcards because the native lane genuinely does NOT support
    // some features a wildcard would imply (e.g. shape.gradient, shape.path.curve, effect.glow) and
    // DOES support others a coarse card would miss (e.g. transition.wipe). Keep this in exact sync
    // with the runtime gate; the cross-lane consistency test (capabilities.test.ts) enforces it.
    features: [
      "background.fill",
      "shape.rect",
      "shape.rounded-rect",
      "shape.ellipse",
      "shape.triangle",
      "shape.star",
      "shape.path",
      "shape.geometry.v1", "shape.line", "shape.polyline", "shape.polygon", "shape.arc", "shape.sector", "shape.stroke", "shape.stroke.dash",
      "shape.radius",
      "style.shadow",
      "style.textShadow",
      "image.crop",
      "image.fit.none",
      "image.fit.scale-down",
      // Block glyphs cover an uppercase-folded ASCII subset only (26 letters, 10 digits, 20
      // punctuation marks). `text.charset.non-ascii` is deliberately absent: the lane has no font
      // rasterizer, so anything outside that subset is refused rather than drawn (the text-delivery invariant).
      "text.block-glyphs",
      "caption.block-glyphs",
      "effect.blur",
      "effect.brightness",
      "effect.contrast",
      "effect.saturate",
      "effect.grayscale", "effect.trail", ...PARTICLE_RENDER_FEATURES,
      "points.viewport-batched",
      "blend.*",
      "keyframe.transform.x",
      "keyframe.transform.y",
      "keyframe.transform.width",
      "keyframe.transform.height",
      "keyframe.transform.originX",
      "keyframe.transform.originY",
      "keyframe.transform.rotation",
      "keyframe.transform.scale",
      "keyframe.opacity",
      "keyframe.blendMode",
      "keyframe.fill",
      "keyframe.style.fill",
      "keyframe.style.color",
      "keyframe.style.stroke",
      "keyframe.style.borderColor",
      "keyframe.style.backgroundColor",
      "keyframe.style.background",
      "keyframe.style.strokeWidth",
      "keyframe.style.borderWidth",
      "keyframe.style.fontSize",
      "keyframe.style.fontWeight",
      "keyframe.style.letterSpacing",
      "keyframe.style.textAlign",
      "keyframe.style.verticalAlign",
      "keyframe.style.alignY",
      "keyframe.style.lineHeight",
      "keyframe.style.width",
      "keyframe.style.height",
      "keyframe.style.radius",
      "keyframe.style.borderRadius",
      "keyframe.style.padding",
      "keyframe.style.paddingX",
      "keyframe.style.paddingY",
      "keyframe.style.paddingTop",
      "keyframe.style.paddingRight",
      "keyframe.style.paddingBottom",
      "keyframe.style.paddingLeft",
      "keyframe.mask.inset.top",
      "keyframe.mask.inset.right",
      "keyframe.mask.inset.bottom",
      "keyframe.mask.inset.left",
      "keyframe.crop.x",
      "keyframe.crop.y",
      "keyframe.crop.width",
      "keyframe.crop.height",
      "keyframe.style.shadow.x",
      "keyframe.style.shadow.y",
      "keyframe.style.shadow.offsetX",
      "keyframe.style.shadow.offsetY",
      "keyframe.style.shadow.blur",
      "keyframe.style.shadow.spread",
      "keyframe.style.shadow.blurRadius",
      "keyframe.style.shadow.spreadRadius",
      "keyframe.style.shadow.color",
      "keyframe.style.textShadow.x",
      "keyframe.style.textShadow.y",
      "keyframe.style.textShadow.offsetX",
      "keyframe.style.textShadow.offsetY",
      "keyframe.style.textShadow.blur",
      "keyframe.style.textShadow.blurRadius",
      "keyframe.style.textShadow.color",
      "keyframe.effects.blur",
      "keyframe.effects.brightness",
      "keyframe.effects.contrast",
      "keyframe.effects.saturate",
      "keyframe.effects.grayscale",
      "mask.rect",
      "mask.rounded-rect",
      "transform.origin",
      "transform.rotation",
      "transition.fade",
      "transition.slide",
      "transition.wipe"
    ],
    alpha: true,
    audio: "none",
    subtitles: true,
    renderTargets: ["preview", "still-frame", "fixture-smoke", "frame-sequence"],
    license: "ShellX OSS",
    speed: "fast",
    stability: "degraded",
    strengths: ["fast local preview", "transparent PNG overlays", "no browser dependency"],
    weaknesses: ["text is drawn from a fixed uppercase-folded ASCII block-glyph set: lowercase is case-folded, requested font families are ignored, and non-ASCII text is refused outright; use browser for any real typography", "not a delivery lane for text: final and image-sequence renders refuse native frames whose text would be case-folded, font-substituted, or block-glyph substituted", "no web layers", "no audio muxing", "limited final delivery formats"],
    typography: {
      mode: "block-glyph-preview",
      conformanceFixtureIds: ["native-block-glyph-delivery-refusal"]
    },
    runtime: {
      availability: "bundled",
      requirement: "ShellX native raster renderer",
      cost: "local-cpu",
      setupHint: "No external renderer binary is required for native preview frames."
    },
    colorAlpha: COLOR_ALPHA_LANE_CAPABILITIES.native
  },
  {
    id: "renderer.browser",
    label: "Deterministic Browser Capture",
    category: "preview",
    role: "frame-producer",
    lane: "browser",
    visualFeatureSupport: "direct",
    paradigms: ["motion-ir", "html", "css", "browser-capture"],
    layerTypes: ["text", "shape", "image", "video", "web", "caption", "camera", "particles", "points", "adjustment", "shader", "scene3d", "environment"],
    outputs: ["png-frame", "jpeg-frame", "png-sequence"],
    features: [...BROWSER_RENDER_FEATURES],
    alpha: true,
    audio: "none",
    subtitles: true,
    renderTargets: ["preview", "frame-sequence", "deterministic-capture"],
    license: "ShellX OSS",
    speed: "medium",
    stability: "stable",
    strengths: ["HTML/CSS/web layer fidelity", "manifest-bound font loading, provenance, and fallback-availability evidence", "deterministic replay traces", "visual parity baselines"],
    // The last two entries are the honest cost of the WebGL features listed above (environment.*,
    // particles.seeded, camera.depth). Listing a feature without its budget is how an agent plans a
    // 15s 1080p piece around rain and snow and then loses the render to the job governor at frame
    // ~300: `environment.*` renders correctly at every single frame it is asked for, so a
    // per-frame preview proves nothing about a full-length delivery. Measured, not estimated —
    // see docs/public/rendering.md, "The memory ceiling a rich browser render actually meets first".
    weaknesses: [
      "requires deterministic browser readiness gates",
      "Playwright exposes no Chromium worker PID, so process containment is a cooperative browser-session fallback (killTree false), not Unix process-group or Windows Job Object enforcement; security-sensitive hosts may reject it",
      "does not mux audio by itself",
      "slower than native previews",
      "one Chromium session is reused for a whole frame sequence, so peak resident memory grows with FRAME COUNT and is multiplied by effects.motionBlur.samples, not bounded by the cost of a single frame",
      "the WebGL features on this card (environment.rain/water/snow/fog, particles.seeded, camera.depth) are budget-bound at delivery length: doctor reports adaptive maxProcessTreeRssBytes, a job aborts with job_rss_limit_exceeded above it, and a measured 450-frame 1920x1080 render carrying two environment layers with 3-sample motion blur peaked at 5.07 GiB",
      "final browser delivery preflights the full materialised frame sequence before allocation and records its resolved admission budget, conservative estimate and retention cardinality in dry-run/receipt evidence; it is not a streamed producer-to-encoder pipeline",
      "manifest-bound font provenance, loading, and fallback evidence are proven; this card does not claim a Motion complex-shaping conformance fixture"
    ],
    typography: {
      mode: "manifest-bound-fallback-attested",
      fontProvenance: "manifest-bound",
      fontLoading: "runtime-verified",
      fallbackEvidence: "metric-probe",
      conformanceFixtureIds: ["browser-generated-font-provenance"]
    },
    runtime: {
      // NOT "bundled". `playwright-core` is a driver library and downloads no browser, so this card
      // claimed Motion ships something it does not. Readiness is deliberately a Motion command,
      // rather than `chromium --version`: the browser launcher resolves an explicit override,
      // trusted Playwright cache and platform locations before it ever considers PATH.
      availability: "external-binary",
      requirement: "Chrome or Chromium browser binary (not shipped; see doctor)",
      cost: "local-cpu",
      readiness: { command: "motion.platform.requirements", tools: ["chromium"] },
      setupHint: "Install a Chrome/Chromium browser, or set SHELLX_MOTION_BROWSER to one. Run `doctor` for what this machine is missing."
    },
    colorAlpha: COLOR_ALPHA_LANE_CAPABILITIES.browser
  },
  GPU_CAPABILITY_CARD,
  {
    id: "renderer.ffmpeg",
    label: "FFmpeg Final Encoder",
    category: "final",
    role: "encoder",
    lane: "ffmpeg",
    visualFeatureSupport: "inherited-from-frame-lane",
    paradigms: ["image-sequence", "audio-mux", "final-encode"],
    layerTypes: ["text", "shape", "image", "video", "web", "caption", "audio", "camera", "particles", "points", "adjustment", "shader", "scene3d", "environment"],
    outputs: ["mp4-h264", "mp4-hevc", "webm-av1", "webm-vp9", "webm-vp9-alpha", "gif", "mov-prores", "png-sequence", "png-frame", "jpeg-frame"],
    // These are delivery capabilities, not visual raster capabilities. `visualFeatureSupport`
    // requires a compatible frame-producing lane to accept the package's visual feature set.
    features: [
      "encode.png-sequence", "encode.raw-rgba-stream",
      "encode.audio-mux",
      "encode.caption-burn-in",
      "delivery.mp4.h264",
      "delivery.mp4.hevc",
      "delivery.webm.av1",
      "delivery.webm.vp9",
      "delivery.webm.vp9-alpha",
      "delivery.mov.prores",
      "delivery.gif",
      "delivery.png-sequence",
      "delivery.png-frame",
      "delivery.jpeg-frame"
    ],
    alpha: true,
    audio: "mix",
    subtitles: true,
    renderTargets: ["final", "batch", "delivery"],
    license: "FFmpeg runtime required",
    speed: "slow",
    stability: "stable",
    strengths: ["delivery MP4/WebM/GIF outputs", "package audio mixing", "batch/data render support"],
    // This lane never rasterizes a visual layer; it consumes a PNG sequence from a compatible frame
    // producer. So the browser card's memory budget is this card's budget too for every rich
    // delivery, rather than an unqualified final-lane promise for rain, particles and depth.
    weaknesses: ["requires frame-lane capture for visual layers", "depends on FFmpeg availability", "slower than preview lanes", "final delivery of any visual layer inherits the frame lane's limits, including the browser lane's adaptive per-job resident-memory ceiling reported by doctor"],
    runtime: {
      availability: "external-binary",
      requirement: "FFmpeg and FFprobe binaries",
      cost: "local-cpu",
      readiness: { command: "motion.platform.requirements", tools: ["ffmpeg", "ffprobe"] },
      setupHint: "Install FFmpeg with FFprobe available on PATH before final media renders."
    },
    colorAlpha: COLOR_ALPHA_LANE_CAPABILITIES.ffmpeg,
    frameInputs: ["png-sequence", "raw-rgba"],
    requiresFrameLane: true
  },
  {
    id: "renderer.connector",
    label: "ShellX Product Connectors",
    category: "connector",
    role: "connector",
    lane: "connector",
    visualFeatureSupport: "direct",
    paradigms: ["motion-package", "cut-import", "canvas-export", "scripted-video"],
    layerTypes: ["text", "shape", "image", "video", "web", "caption", "audio"],
    outputs: ["motion-package", "cut-plan", "canvas-package", "connector-receipt"],
    features: ["*"],
    alpha: true,
    audio: "mix",
    subtitles: true,
    renderTargets: ["cut", "canvas", "handoff"],
    license: "ShellX OSS",
    speed: "medium",
    stability: "stable",
    strengths: ["Cut and Design Studio handoff receipts", "editable lowering where supported", "product workflow provenance"],
    weaknesses: ["requires host connector context", "not a standalone final encoder", "may need Cut or Design Studio for apply steps"],
    runtime: {
      availability: "host-connector",
      requirement: "ShellX Cut or Design Studio connector host",
      cost: "host-dependent",
      setupHint: "Run connector workflows from a trusted ShellX host checkout or debug API context."
    }
  },
  {
    id: "adapter.svg",
    label: "SVG Path Adapter Diagnostics",
    category: "adapter",
    role: "adapter",
    lane: "svg-adapter",
    visualFeatureSupport: "direct",
    paradigms: ["svg", "path-animation", "adapter-diagnostics"],
    layerTypes: ["shape", "image", "web"],
    outputs: ["adapter-diagnostics", "motion-document", "motion-package", "browser-fallback"],
    features: [
      "svg.path.d",
      "svg.path.stroke",
      "svg.path.strokeWidth",
      "svg.path.strokeLinecap",
      "svg.viewBox"
    ],
    alpha: true,
    audio: "none",
    subtitles: false,
    renderTargets: ["import", "diagnostics", "preview"],
    license: "Source asset license required",
    speed: "fast",
    stability: "experimental",
    strengths: ["strict static path/stroke lowering", "atomic source-preserving Motion package installation", "source/output hash and lossiness receipts", "full-input XML consumption with executable syntax refusal"],
    weaknesses: ["does not lower transforms, filters, masks, scripts, path morphing, text, images, or SMIL/CSS animation"],
    runtime: {
      availability: "bundled",
      requirement: "ShellX Motion SVG diagnostic parser",
      cost: "local-cpu",
      setupHint: "No external adapter binary is required for SVG diagnostics."
    },
    adapter: {
      formats: ["svg"],
      unsupportedFeatureClasses: ["filters", "masks", "scripts", "foreignObject", "complex SMIL/CSS animation"],
      expectedLossiness: "medium-to-high for animated SVG; supported path geometry can lower to Motion shapes but filters, masks, scripts, and complex SMIL/CSS animation require browser fallback.",
      previewLaneRequirement: "browser",
      finalLaneRequirement: "ffmpeg",
      hostCompatibility: ["ShellX Motion", "ShellX Cut via rendered media", "Design Studio via package preview"]
    }
  },
  {
    id: "adapter.lottie",
    label: "Lottie / dotLottie Adapter Diagnostics",
    category: "adapter",
    role: "adapter",
    lane: "lottie-adapter",
    visualFeatureSupport: "direct",
    paradigms: ["lottie", "dotlottie", "vector-animation", "adapter-diagnostics"],
    layerTypes: ["shape", "image", "text"],
    outputs: ["adapter-diagnostics", "motion-document", "motion-package", "browser-fallback"],
    features: ["lottie.composition", "lottie.shape.path.static", "lottie.shape.rectangle.static", "lottie.shape.ellipse.static", "lottie.shape.fill.static", "lottie.shape.gradient.linear.static", "lottie.shape.stroke.static", "lottie.transform.static", "lottie.text.basic.static", "lottie.blendMode.fixture-backed", "lottie.trackMatte.alpha", "lottie.trackMatte.alphaInverted", "lottie.trackMatte.luma", "lottie.trackMatte.lumaInverted", "lottie.effect.gaussianBlur", "lottie.effect.brightnessContrast", "dotlottie.container.v1", "dotlottie.container.v2", "dotlottie.animation-selection", "dotlottie.bundled-images", "dotlottie.theme.static-subset"],
    alpha: true,
    audio: "none",
    subtitles: false,
    renderTargets: ["import", "diagnostics", "preview"],
    license: "Source asset license required",
    speed: "medium",
    stability: "experimental",
    strengths: ["fixture-backed static path/transform/text, linear-gradient, blend-mode, matte, effect, and bundled-image lowering", "bounded v1/v2 dotLottie selection with atomic archive-preserving package installation", "atomic source-preserving Motion package installation", "source/output hash and lossiness receipts", "expression refusal"],
    weaknesses: ["dotLottie themes lower only the bounded static Color, Scalar, Position, and Vector slot subset; expressions, animated rules, unsupported types, and unmatched slots refuse. State machines are preserved but never executed.", "editable lowering remains unavailable for Lottie masks, rounded rectangles, stars, merge paths, nested compositions, and animated paths"],
    runtime: {
      availability: "bundled",
      requirement: "ShellX Motion Lottie diagnostic parser",
      cost: "local-cpu",
      setupHint: "Use JSON/dotLottie fixtures to collect unsupported features before package lowering."
    },
    adapter: {
      formats: ["json", "lottie", "dotlottie"],
      unsupportedFeatureClasses: ["expressions", "track-matte modes outside alpha, alphaInverted, luma, and lumaInverted", "effects outside gaussian blur and brightness/contrast", "merge paths", "advanced text shaping"],
      expectedLossiness: "medium outside fixture-backed static path/transform/text, linear-gradient, named matte/effect, and bundled-image lowering.",
      previewLaneRequirement: "browser",
      finalLaneRequirement: "ffmpeg",
      hostCompatibility: ["ShellX Motion", "ShellX Cut via rendered media", "Design Studio via package preview"]
    }
  },
  {
    id: "adapter.rive",
    label: "Rive-like State Adapter Diagnostics",
    category: "adapter",
    role: "adapter",
    lane: "rive-adapter",
    visualFeatureSupport: "direct",
    paradigms: ["rive", "state-machine", "vector-animation", "adapter-diagnostics"],
    layerTypes: ["shape", "image", "text"],
    outputs: ["adapter-diagnostics", "motion-package-plan", "browser-fallback"],
    features: ["rive.artboard", "rive.shape.path", "rive.timeline", "rive.state.label"],
    alpha: true,
    audio: "none",
    subtitles: false,
    renderTargets: ["import", "diagnostics", "preview"],
    license: "Source asset license required",
    speed: "medium",
    stability: "experimental",
    strengths: ["state-machine inventory planned", "artboard/timeline diagnostics", "explicit fallback before lossy lowering"],
    weaknesses: ["interactive inputs, constraints, meshes, and full runtime state machines are not lowered yet", "diagnostic card only until fixtures are added"],
    runtime: {
      availability: "bundled",
      requirement: "ShellX Motion Rive diagnostic parser",
      cost: "local-cpu",
      setupHint: "Use Rive-like diagnostic fixtures to inventory state machines before choosing browser fallback or lowering."
    },
    adapter: {
      formats: ["rive", "riv-json"],
      unsupportedFeatureClasses: ["interactive state machines", "constraints", "meshes", "runtime inputs", "advanced text shaping"],
      expectedLossiness: "high until Rive state/timeline fixtures prove deterministic lowering.",
      previewLaneRequirement: "browser",
      finalLaneRequirement: "ffmpeg",
      hostCompatibility: ["ShellX Motion", "ShellX Cut via rendered media", "Design Studio via package preview"]
    }
  }
];
