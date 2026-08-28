import type { MotionChromaKey, MotionMask } from "./keying";
import type { MotionSpatialInterpolation } from "./spatial-path-types";
import type { MotionCompositingGraph } from "./compositing-graph-types";
import type { MotionScene3D } from "./scene-3d-types";
import type { MotionEnvironment } from "./environment-types";
import type { MotionGpuMaterial } from "./gpu-material";
import type { MotionProceduralGraph } from "./procedural-relationship-types";
import type { MotionPointCloud } from "./motion-points";
import type { MotionAudioDocument, MotionAudioFadeCurve } from "./audio-types";
import type { MotionShapeGeometry } from "./motion-shape-geometry-types"; import type { MotionShapeGeometryKeyframes } from "./motion-shape-geometry-keyframes-types";
import type { MotionParticleAnalyticTrail, MotionParticleEmitterOrigin, MotionParticleField, MotionParticleShading } from "./particle-field-types"; import type { MotionEffectModuleReference } from "./effect-module";
import type { MotionLayoutApplicationRecord } from "./motion-layout-application-types"; import type { MotionLayoutGapAnimationDescriptor } from "./motion-layout-gap-animation-types";
import type { MotionGradientColorKeyframes } from "./motion-gradient-color-keyframes-types";
import type { MotionTextRuns } from "./motion-text-runs-types";
import type { MotionBehaviorStore } from "./motion-behavior-types"; import type { MotionRelationStore } from "./motion-relation-types";
import type { MotionRelationActionStore } from "./motion-relation-actions-public-types";
// Template authoring types live in ./template-types for the module-size gate. Re-export the
// whole family so `@shellx-motion/core` consumers keep importing them from here; the local import keeps
// `TemplateDocument` in scope for `MotionPackage` below.
import type { TemplateDocument } from "./template-types";
export * from "./template-types";
export type { MotionScene3D, MotionScene3DMeshGeometry, MotionScene3DMeshObject, MotionScene3DObject, MotionVec3 } from "./scene-3d-types";
export type { MotionEnvironment, MotionEnvironmentQuality, MotionFogEnvironment, MotionFogParameters, MotionRainAtmosphere, MotionRainEnvironment, MotionRainGround, MotionSnowAtmosphere, MotionSnowEnvironment, MotionSnowFall, MotionSnowGround, MotionWaterEnvironment, MotionWaterOptics, MotionWaterSurface } from "./environment-types";
export type { MotionGpuMaterial, MotionGpuMaterialPreset, MotionGpuMaterialUniform } from "./gpu-material";
export type { MotionShapeGeometry, MotionShapeGeometryPoint, MotionShapeGeometryViewBox } from "./motion-shape-geometry-types"; export type { MotionShapeGeometryKeyframe, MotionShapeGeometryKeyframes } from "./motion-shape-geometry-keyframes-types";
export type { MotionGradientColorKeyframe, MotionGradientColorKeyframes } from "./motion-gradient-color-keyframes-types";
export type { MotionBehavior, MotionBehaviorBounce, MotionBehaviorGravity, MotionBehaviorSquash, MotionBehaviorStore, MotionPathFollowBehavior, MotionTransformBehavior } from "./motion-behavior-types";
export {
  MOTION_LAYOUT_APPLICATION_SCHEMA,
  type MotionLayoutApplicationGeneratedLayer,
  type MotionLayoutApplicationPatch,
  type MotionLayoutApplicationRecord,
  type MotionLayoutApplicationSnapshot,
  type MotionLayoutApplicationTrackPatch
} from "./motion-layout-application-types";
/**
 * The layer types Motion advertises to authors.
 *
 * Invariant, pinned by `layer-type-source-of-truth.test.ts`: **every member here is renderable by
 * at least one lane.** The set must equal `renderableLayerTypes()` — the union of the renderer
 * capability cards — so a type cannot be declared before something can draw it. A declared type no
 * lane renders teaches an author something false: they build with it, the package validates, and
 * the first render refuses it.
 *
 * `"group"` returned only after the GPU lane gained bounded local timelines, nested isolated targets,
 * transforms, opacity, effects, masks and blend compositing. Other lanes may still refuse it.
 *
 * Note this union is advisory: `MotionLayer.type` is `MotionLayerType | string`, because hosts may
 * carry their own types through a document. Advisory is precisely why it must not lie — it is read
 * as the menu of what works.
 */
export type MotionLayerType =
  | "text"
  | "shape"
  | "image"
  | "video"
  | "caption"
  | "audio"
  | "web"
  | "html"
  | "canvas"
  | "adjustment"
  | "camera"
  | "particles"
  | "points"
  | "shader"
  | "scene3d"
  | "environment"
  | "group";

/**
 * Damped-spring keyframe/transition easing, serialized as data so MotionIR stays
 * portable and receipt-deterministic. Canonical physical param set; evaluation
 * lives in `spring.ts` (both render lanes inherit it via `effectiveLayerAtMs`).
 * Params are normalized to the keyframe segment duration — the spring settles
 * within its own segment. See `spring.ts` for the full segment-duration and
 * overshoot semantics.
 */
export interface MotionSpringEasing {
  /** Discriminant tag distinguishing spring easings from string easings. */
  type: "spring";
  /** Spring constant k (> 0). Higher = stiffer; affects the curve only via the damping ratio. */
  stiffness: number;
  /** Damping coefficient c (> 0). Controls overshoot: critical when c = 2*sqrt(k*m). */
  damping: number;
  /** Oscillator mass m (> 0). Optional; defaults to 1. */
  mass?: number;
  /** Normalized initial velocity (segment deltas per unit normalized time). Optional; defaults to 0. */
  initialVelocity?: number;
}

/**
 * Keyframe/transition easing: either a named string / functional string
 * (`"ease-out"`, `"cubic-bezier(...)"`, `"steps(...)"`, spring preset aliases
 * like `"spring-gentle"`) or a data-level {@link MotionSpringEasing} object.
 */
export type MotionEasing = string | MotionSpringEasing;
export type MotionKeyframeValue = number | string;
export interface MotionKeyframe {
  atMs: number;
  value: MotionKeyframeValue;
  easing?: MotionEasing;
  spatial?: MotionSpatialInterpolation;
}

export interface MotionTransition {
  type: "fade" | "slide" | "wipe" | string;
  durationMs: number;
  easing?: MotionEasing;
  direction?: "left" | "right" | "up" | "down" | string;
  distance?: number;
}

export interface MotionMatte {
  type: "alpha" | "alpha-inverted" | "luma" | "luma-inverted" | string;
  /** Explicit matte-only source layer; it is not drawn as a normal layer. */
  sourceLayerId: string;
}

export interface MotionEffects {
  blur?: number;
  brightness?: number;
  contrast?: number;
  saturate?: number;
  grayscale?: number;
  glow?: {
    radius: number;
    color: string;
  };
  motionBlur?: {
    samples: number;
    shutterAngle: number;
  };
  vignette?: {
    amount: number;
    softness: number;
    color: string;
  };
  filmGrain?: {
    amount: number;
    size: number;
    seed: number;
  };
  /** Bounded, stateless lookback strokes for particles and ordered point clouds. */
  trail?: MotionTrail;
}

export interface MotionTrail {
  /** v1 absolute-millisecond lookback length; static so resource use cannot keyframe. */
  durationMs: number;
  /** Number of trajectory vertices including the current head. */
  samples: number;
}

export interface MotionGradientStop {
  offset: number;
  color: string;
}

/** One complete fixed-topology color snapshot for a structured gradient. */
export interface MotionGradient {
  type: "linear" | "radial";
  angle?: number;
  centerX?: number;
  centerY?: number;
  stops: MotionGradientStop[];
  /** Omitted for legacy/static gradients so existing source identity remains unchanged. */
  colorKeyframes?: MotionGradientColorKeyframes;
}

export interface MotionParticleEmitter {
  seed: number;
  count: number;
  lifetimeMs: number;
  shape?: "circle" | "square";
  color: string;
  secondaryColor?: string;
  minSize?: number;
  maxSize?: number;
  minSpeed?: number;
  maxSpeed?: number;
  direction?: number;
  spread?: number;
  gravity?: number;
  fadeOut?: boolean;
  /** Bounded analytic visual deflection; this is not a general physics simulation. */
  field?: MotionParticleField;
  /** v2 only: weighted, bounded spawn origins within the particle layer. */
  origins?: MotionParticleEmitterOrigin[];
  /** v2 only: fixed-shader analytic lookback, never retained particle history. */
  trail?: MotionParticleAnalyticTrail;
  /** v2 only: fixed head shading controls owned by the renderer. */
  shading?: MotionParticleShading;
}

export interface MotionShaderPlugin {
  schema: "shellx-motion/shader-plugin@1";
  language: "glsl-es-100-expression";
  fragmentAssetId: string;
  seed: number;
  uniforms?: Record<string, number>;
  fallbackColor: string;
  /** Optional fixed Motion-owned WebGPU equivalent; package GLSL is never executed by WebGPU. */
  gpuMaterial?: MotionGpuMaterial;
}

export interface MotionCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MotionBlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "plus-lighter";

export interface MotionExtensionFields {
  [key: `x-${string}`]: unknown;
}

export interface MotionTransform extends MotionExtensionFields {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
  scale?: number;
  rotation?: number;
  originX?: number;
  originY?: number;
}

/** A normalized visible window along one authored SVG path. */
export interface MotionPathReveal {
  start: number;
  end: number;
}

export type MotionKeyframeTarget =
  | "transform.x"
  | "transform.y"
  | "transform.width"
  | "transform.height"
  | "transform.originX"
  | "transform.originY"
  | "transform.scale"
  | "transform.rotation"
  | "opacity"
  | "volume"
  | "pan"
  | "blendMode"
  | "playbackRate"
  | "fill"
  | "style.fill"
  | "style.color"
  | "style.stroke"
  | "style.borderColor"
  | "style.backgroundColor"
  | "style.background"
  | "style.strokeWidth"
  | "style.borderWidth"
  | "style.fontSize"
  | "style.fontWeight"
  | "style.letterSpacing"
  | "style.textAlign"
  | "style.verticalAlign"
  | "style.alignY"
  | "style.lineHeight"
  | "style.width"
  | "style.height"
  | "style.radius"
  | "style.borderRadius"
  | "style.padding"
  | "style.paddingX"
  | "style.paddingY"
  | "style.paddingTop"
  | "style.paddingRight"
  | "style.paddingBottom"
  | "style.paddingLeft"
  | "mask.inset.top"
  | "mask.inset.right"
  | "mask.inset.bottom"
  | "mask.inset.left"
  | "crop.x"
  | "crop.y"
  | "crop.width"
  | "crop.height"
  | "style.shadow.x"
  | "style.shadow.y"
  | "style.shadow.offsetX"
  | "style.shadow.offsetY"
  | "style.shadow.blur"
  | "style.shadow.spread"
  | "style.shadow.blurRadius"
  | "style.shadow.spreadRadius"
  | "style.shadow.color"
  | "style.textShadow.x"
  | "style.textShadow.y"
  | "style.textShadow.offsetX"
  | "style.textShadow.offsetY"
  | "style.textShadow.blur"
  | "style.textShadow.blurRadius"
  | "style.textShadow.color"
  | "effects.blur"
  | "effects.brightness"
  | "effects.contrast"
  | "effects.saturate"
  | "effects.grayscale"
  | "effects.glow.radius"
  | "effects.glow.color"
  | "pathReveal.start"
  | "pathReveal.end"
  | "gradient.angle"
  | "environment.intensity"
  | "environment.wind"
  | "environment.dropSpeed"
  | "environment.dropLength"
  | "environment.ground.horizon"
  | "environment.ground.wetness"
  | "environment.ground.roughness"
  | "environment.ground.rippleAmount"
  | "environment.ground.splashAmount"
  | "environment.ground.reflectionStrength"
  | "environment.atmosphere.mist"
  | "environment.atmosphere.lensDroplets"
  | "environment.surface.horizon"
  | "environment.surface.waveScale"
  | "environment.surface.waveHeight"
  | "environment.surface.waveSpeed"
  | "environment.surface.direction"
  | "environment.surface.choppiness"
  | "environment.optics.reflectionStrength"
  | "environment.optics.refractionStrength"
  | "environment.optics.fresnel"
  | "environment.optics.caustics"
  | "environment.optics.clarity"
  | "environment.optics.foam"
  | "environment.fall.intensity"
  | "environment.fall.speed"
  | "environment.fall.wind"
  | "environment.fall.turbulence"
  | "environment.fall.flakeSize"
  | "environment.fall.focusFalloff"
  | "environment.ground.accumulation"
  | "environment.ground.drift"
  | "environment.ground.contactAmount"
  | "environment.atmosphere.haze"
  | "environment.atmosphere.depthFade"
  | "environment.fog.density"
  | "environment.fog.speed"
  | "environment.fog.scale"
  | "environment.fog.turbulence"
  | "environment.fog.height"
  | "environment.fog.lightStrength"
  | `shader.uniforms.${string}`;

export type MotionTrackType = "video" | "audio" | "overlay" | "caption" | "effect" | "data" | string;

export interface MotionTrack extends MotionExtensionFields {
  id: string;
  type: MotionTrackType;
  name?: string;
  order?: number;
  layerIds?: string[];
  locked?: boolean;
  muted?: boolean;
  solo?: boolean;
  volume?: number;
  pan?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
}

/**
 * How a ducking control is realized at render time.
 * - "timed": precompute volume keyframes from each trigger layer's *time window*
 *   (the music dips whenever a trigger is present on the timeline, regardless of
 *   whether the trigger actually carries signal). This is the historical behavior.
 * - "sidechain": true level-dependent ducking in the FFmpeg lane via the
 *   `sidechaincompress` filter — the music is attenuated only while the trigger's
 *   audio is genuinely loud, and by an amount that tracks the trigger level.
 * Absent = "timed" so packages authored before this field keep their behavior.
 */
export type MotionAudioDuckingMode = "timed" | "sidechain";

export interface MotionAudioDucking extends MotionExtensionFields {
  triggerLayerIds: string[];
  /** Realization mode; defaults to "timed" when omitted (see MotionAudioDuckingMode). */
  mode?: MotionAudioDuckingMode;
  /**
   * "timed" mode: the level (0-1) the music is ducked toward while a trigger is
   * present. In "sidechain" mode the duck depth is governed by `ratio` and
   * `threshold` instead, so this value is not used there.
   */
  duckToVolume?: number;
  /** Both modes: ramp-in time. "timed" uses it for the keyframe ease; "sidechain" maps it to the compressor attack. */
  attackMs?: number;
  /** Both modes: ramp-out time. "timed" uses it for the keyframe ease; "sidechain" maps it to the compressor release. */
  releaseMs?: number;
  /**
   * "sidechain" only: compressor threshold as linear amplitude in (0, 1]. The
   * music is compressed when the trigger key signal rises above this level.
   * Ignored in "timed" mode.
   */
  threshold?: number;
  /**
   * "sidechain" only: compression ratio (>= 1). Higher ratios duck the music
   * harder for the same amount the trigger exceeds the threshold.
   * Ignored in "timed" mode.
   */
  ratio?: number;
}

/**
 * Per-track EBU R128 loudness evidence recorded on a render receipt. Values are
 * the first-pass (source) measurement used to drive two-pass loudnorm; they are
 * null when the track was not measured (single-pass fallback).
 */
export interface RenderLoudnessTrack {
  path: string;
  layerId?: string;
  /** Measured input integrated loudness (LUFS). */
  integratedLufs: number | null;
  /** Measured input true peak (dBTP). */
  truePeakDbtp: number | null;
  /** Measured input loudness range (LU). */
  lra: number | null;
  /** Measured input gating threshold (LUFS). */
  thresholdLufs: number | null;
  /** loudnorm target offset (LU) from the first pass. */
  offsetLu: number | null;
  /** Whether the second pass applied measured values or fell back to single-pass. */
  mode: "two-pass" | "single-pass-fallback";
  /** Honest explanation when a track fell back to single-pass. */
  note?: string;
}

/** Loudness-normalization evidence for a render's audio program. */
export interface RenderLoudnessSummary {
  measurement: "ebu-r128";
  /** Normalization targets applied by loudnorm (I / TP / LRA). */
  target: { integratedLufs: number; truePeakDbtp: number; lra: number };
  /** Overall mode: "mixed" when some tracks were two-pass and others fell back. */
  mode: "two-pass" | "single-pass-fallback" | "mixed";
  tracks: RenderLoudnessTrack[];
  /** Measured integrated loudness / true peak / LRA of the final mixed output; null if unmeasured. */
  output: { integratedLufs: number | null; truePeakDbtp: number | null; lra: number | null } | null;
}

export interface MotionScene extends MotionExtensionFields {
  id: string;
  name?: string;
  startMs: number;
  durationMs: number;
  layerIds?: string[];
  trackIds?: string[];
  markerIds?: string[];
}

export interface MotionMarker extends MotionExtensionFields {
  id: string;
  atMs: number;
  label?: string;
  type?: string;
  durationMs?: number;
  color?: string;
}

export interface MotionSafeArea extends MotionExtensionFields {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export type MotionTextFitPolicy = "safe" | "allow-crop" | "auto-fit";

/** Render-time text-fit intent. Missing metadata keeps legacy packages unchecked. */
export type { MotionTextRun, MotionTextRuns } from "./motion-text-runs-types";

export interface MotionTextFit extends MotionExtensionFields {
  policy: MotionTextFitPolicy;
  /** Document safe-area id. Required for safe and auto-fit policies. */
  safeAreaId?: string;
  /** Smallest font size the browser renderer may apply for auto-fit. */
  minFontSize?: number;
}

/**
 * Extensible layer paint, with the v1 geometry dash spelling kept explicitly
 * numeric. Renderers never interpret CSS dash strings or percentages here.
 */
export interface MotionLayerStyle extends Record<string, unknown> {
  strokeDasharray?: readonly number[];
  strokeDashoffset?: number;
}

export interface MotionLayer extends MotionExtensionFields {
  id: string;
  name?: string;
  type: MotionLayerType | string;
  /** Ordered local-timeline children for a bounded isolated group/precomposition. */
  childLayerIds?: string[];
  trackId?: string;
  startMs: number;
  durationMs: number;
  text?: string;
  /** Closed v1 styled text content; it owns a text/caption layer's complete text. */
  textRuns?: MotionTextRuns;
  shape?: string;
  /** v1 exact-key authored geometry; it cannot be combined with legacy `shape`/`x-path` geometry. */
  geometry?: MotionShapeGeometry; geometryKeyframes?: MotionShapeGeometryKeyframes;
  fill?: string;
  color?: string;
  width?: number;
  height?: number;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  source?: string;
  src?: string;
  assetId?: string;
  assetRef?: string;
  trimStartMs?: number;
  trimDurationMs?: number;
  loop?: boolean;
  playbackRate?: number;
  includeAudio?: boolean;
  volume?: number;
  pan?: number;
  muted?: boolean;
  fadeInMs?: number;
  fadeOutMs?: number;
  /** Defaults to linear. Equal-power is appropriate for a matched crossfade. */
  fadeCurve?: MotionAudioFadeCurve;
  normalizeLoudness?: boolean;
  ducking?: MotionAudioDucking;
  fit?: string;
  textFit?: MotionTextFit;
  crop?: MotionCrop;
  allowedOrigins?: unknown[];
  transform?: MotionTransform;
  style?: MotionLayerStyle;
  label?: Record<string, unknown>;
  keyframes?: Partial<Record<MotionKeyframeTarget, MotionKeyframe[]>>;
  transitions?: {
    in?: MotionTransition;
    out?: MotionTransition;
  };
  mask?: MotionMask;
  keying?: MotionChromaKey;
  matte?: MotionMatte;
  effects?: MotionEffects; effectModule?: MotionEffectModuleReference;
  gradient?: MotionGradient;
  /** Browser-only, data-only trim window for one stroked SVG shape path. */
  pathReveal?: MotionPathReveal;
  emitter?: MotionParticleEmitter;
  /** Ordered, bounded instance data for a viewport-coordinate point cloud. */
  pointCloud?: MotionPointCloud;
  shader?: MotionShaderPlugin;
  scene3d?: MotionScene3D;
  environment?: MotionEnvironment;
  /** Camera parallax plane: -0.9 is distant background, 0 is neutral, positive values move closer. */
  depth?: number;
  blendMode?: MotionBlendMode;
}
export interface MotionDocument extends MotionExtensionFields {
  schema: "shellx-motion/motion@1";
  id: string;
  name: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  background?: string;
  audio?: MotionAudioDocument;
  scenes?: MotionScene[];
  tracks?: MotionTrack[];
  markers?: MotionMarker[];
  safeAreas?: Record<string, MotionSafeArea>;
  compositing?: MotionCompositingGraph;
  relationships?: MotionProceduralGraph;
  /** Bounded root-owned transform behavior authorities; absent preserves legacy timing. */
  behaviors?: MotionBehaviorStore;
  /** Bounded root-owned relations reserve their target transforms; current render lanes refuse them. */
  relations?: MotionRelationStore;
  /** Application-bound row/column gap tracks; no generic ordinary-keyframe target is created. */ layoutGapAnimation?: MotionLayoutGapAnimationDescriptor;
  scene3dAnimation?: import("./motion-scene3d-animation-types").MotionScene3DAnimationDescriptor; relationActions?: MotionRelationActionStore; // Persisted authoring metadata; never render authority.
  /** Bounded document-resident inverse records; absent unless layout materialization is active. */
  layoutApplications?: MotionLayoutApplicationRecord[];
  layers: MotionLayer[];
  assets: unknown[];
  designTokens?: unknown;
  provenance: {
    sourceApp: string;
    createdBy: string;
    workflow?: string;
    sourceSchema?: string;
    projectId?: string;
    selectedFrameId?: string;
    integrationProtocol?: number;
    compatibilityAdapter?: string;
    dataRowId?: string;
    dataRowKey?: string;
    dataRowHash?: string;
  };
}


/** Package-local font face consumed by deterministic browser rendering. */
export interface MotionFontAsset {
  id: string;
  type: "font";
  family: string;
  source: {
    path: string;
    mimeType: "font/woff2" | "font/woff" | "font/ttf" | "font/otf";
  };
  weight?: number;
  style?: "normal" | "italic" | "oblique";
}

export interface PackageManifest {
  schema: "shellx-motion/package-manifest@1";
  id: string;
  name: string;
  motion: string;
  template?: string;
  assets: string[];
  sourceApp: string;
  compatibility: {
    lanes: string[];
    hosts: string[];
  };
  quality?: {
    maxFontFallbacks?: number;
  };
  workflow?: string;
  data?: unknown;
  selectedFrameId?: string;
}

export interface MotionPackage {
  root: string;
  manifest: PackageManifest;
  motion: MotionDocument;
  template?: TemplateDocument;
}

export type {
  CapabilityMatch,
  RendererAdapterCapability,
  RendererCapability,
  RendererCapabilityAudio,
  RendererCapabilityCard,
  RendererCapabilityCardMatch,
  RendererCapabilityMatchOptions,
  RendererCapabilityMatchResult,
  RendererCapabilityPipeline,
  RendererRuntimeAvailability,
  RendererRuntimeReadiness,
  RendererRuntimeRequirement
} from "./renderer-capability-types";

/**
 * How an operation reached the engine (the wire/entry point that produced the receipt).
 *   - "cli":       invoked through the Motion CLI process.
 *   - "http":      a POST /debug (or POST /rpc dispatch) over the loopback HTTP transport.
 *   - "ws":        a JSON-RPC frame over the loopback WebSocket transport.
 *   - "mcp":       an MCP tools/call — an AI agent driving the engine over the Model Context Protocol.
 *   - "sdk":       an in-process call through the embedded local SDK (no wire hop).
 *   - "connector": a cross-app connector pipeline (Canvas/Script/Template → Cut, etc.).
 */
export type ReceiptActorTransport = "cli" | "http" | "ws" | "mcp" | "sdk" | "connector";

/** Broad class of the caller behind an operation. See {@link ReceiptActor}. */
export type ReceiptActorKind = "agent" | "human" | "host" | "unknown";

/**
 * First-class actor attribution for a receipt — the engine-room History "BY WHO" answer.
 *
 * IMPORTANT — this field is *attribution evidence, not authentication*. It records two very
 * different classes of information and the reader must keep them apart:
 *
 *   - `label` / `kind` are a CLAIM. They can come from a caller-supplied `createdBy` (or an
 *     `--actor` flag / `SHELLX_MOTION_ACTOR` env). A malicious caller can put anything here.
 *   - `transport` / `sessionId` / `grantedTier` / `clientInfo` are OBSERVED by the dispatch
 *     layer at the choke point. The caller cannot forge them — they reflect the wire the
 *     command actually arrived on, the authenticated session, and the granted permission tier.
 *
 * Because the observed facts always ride alongside the claimed label, a spoofed label is still
 * visibly "…via mcp session <id> (tier render_motion)". Precedence when both are present: the
 * caller's explicit label wins for `label`/`kind`, but the observed transport facts are always
 * recorded (they are never overwritten by a claim). Populated automatically at the transport
 * choke points (debug-server HTTP/WS/MCP dispatch, CLI, local SDK); optional so every historical
 * receipt written before this field existed stays valid and simply reads as "unattributed".
 */
export interface ReceiptActor {
  /** Broad class of the caller. Inferred from the transport unless the caller claims otherwise. */
  kind: ReceiptActorKind;
  /** Human-readable actor name. A claim (caller `createdBy`/`--actor`) when present, else transport-derived. */
  label: string;
  /** The wire the command arrived on. Observed by the dispatch layer; not caller-supplied. */
  transport?: ReceiptActorTransport;
  /** MCP client identity ("name/version") declared in the initialize handshake. Observed, not claimed. */
  clientInfo?: string;
  /** Authenticated session identity the dispatch observed (server-instance or per-connection id). Observed. */
  sessionId?: string;
  /** Permission tier the server granted this session (e.g. "render_motion"). Observed, not claimed. */
  grantedTier?: string;
}
export interface OperationReceipt {
  schema: "shellx-motion/receipt@1";
  id: string;
  operation: string;
  status: "passed" | "failed" | "warning" | "not_run";
  packageId: string;
  inputHashes: Record<string, string>;
  createdAt: string;
  lane: string;
  output: unknown;
  artifacts?: ReceiptArtifact[];
  warnings: string[];
  /**
   * Who ran this operation and how it arrived (see {@link ReceiptActor}). Optional for backward
   * compatibility — absent on receipts written before actor attribution existed, and on receipts
   * produced by paths that observed no transport. Attribution evidence, NOT authentication.
   */
  actor?: ReceiptActor;
}

export interface ReceiptArtifact {
  role: string;
  path: string;
  status: "available" | "planned" | "not_required" | "failed";
  label?: string;
  mediaType?: string;
  primary?: boolean;
}
