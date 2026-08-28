/** Primitive-only, bounded inputs accepted by the internal GPU renderer. */
export const GPU_FRAME_INTENT_SCHEMA = "shellx-motion/gpu-frame-intent@1" as const;
export const GPU_MAX_FRAME_DIMENSION = 4_096;
/** Geometry-only quad extent. This never sizes a texture or frame arena. */
export const GPU_MAX_PRIMITIVE_EXTENT = 131_072;
export const GPU_MAX_FRAME_PIXELS = 16_777_216;
export const GPU_MAX_DRAW_BATCHES = 2_048;
export const GPU_MAX_RECTANGLES = 2_048;
export const GPU_MAX_POINTS = 65_536;
/** One bounded Motion-owned analytic compute field, never package WGSL. */
export const GPU_MAX_COMPUTE_PARTICLE_FIELDS = 1;
export const GPU_MAX_COMPUTE_PARTICLES = 131_072;
export const GPU_MAX_TRIANGLE_VERTICES = 65_535;
export const GPU_MAX_IMAGE_DRAWS = 256;
export const GPU_MAX_GRADIENT_STOPS = 4_096;
export const GPU_MAX_TEXT_DRAWS = 128;
export const GPU_MAX_TEXT_UTF8_BYTES = 64 * 1024;
export const GPU_MAX_TEXT_SURFACE_PIXELS = 32 * 1024 * 1024;
export const GPU_MAX_PLAN_BYTES = 4 * 1024 * 1024;

export interface GpuRgba { r: number; g: number; b: number; a: number }
export type GpuBlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "color-dodge" | "color-burn" | "hard-light" | "soft-light" | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity" | "plus-lighter";
export interface GpuGlowEffect { radius: number; color: GpuRgba }
export interface GpuLayerEffects { blur: number; brightness: number; contrast: number; saturate: number; grayscale: number; glow: GpuGlowEffect | null }
/** Fixed geometric alpha mask evaluated in canvas coordinates before layer effects. */
export interface GpuLayerMaskIntent {
  /** Triangle is reserved for static, typed triangle track mattes. */
  shape: "rect" | "ellipse" | "triangle";
  x: number; y: number; width: number; height: number; radius: number;
  rotationDeg: number; pivotX: number; pivotY: number;
  inverted: boolean; opacity: number; featherPx: number;
}
export interface GpuCompositeIntent { blendMode: GpuBlendMode; effects: GpuLayerEffects | null; mask?: GpuLayerMaskIntent }

export interface GpuRectangleIntent extends GpuCompositeIntent {
  kind: "rect"; id: string; x: number; y: number; width: number; height: number;
  rotationDeg: number; pivotX: number; pivotY: number; color: GpuRgba;
}

export interface GpuEllipseIntent extends GpuCompositeIntent {
  kind: "ellipse"; id: string; x: number; y: number; width: number; height: number;
  rotationDeg: number; pivotX: number; pivotY: number; color: GpuRgba;
  strokeWidth: number; stroke: GpuRgba;
}

export interface GpuPointInstance { x: number; y: number; size: number; color: GpuRgba }
/** Static instances may be uploaded once; all exact-time values stay dynamic. */
export type GpuPointInstanceBufferMode = "static" | "dynamic";
export interface GpuPointBatchIntent extends GpuCompositeIntent { kind: "points"; id: string; seed: number; instanceBufferMode: GpuPointInstanceBufferMode; points: GpuPointInstance[] }
import type { GpuComputeParticleIntent } from "./gpu-frame-particle-compute-intent";
import type { GpuEffectModuleBinding } from "./effect-module";

export interface GpuTriangleBatchIntent extends GpuCompositeIntent {
  kind: "triangles"; id: string; vertices: Array<{ x: number; y: number }>;
  rotationDeg: number; pivotX: number; pivotY: number; color: GpuRgba;
}

/**
 * One fixed triangle batch with explicitly resolved vertex paint. Used only by
 * Core's bounded path tessellator; package data cannot select a shader or vertex format.
 */
export interface GpuColoredTriangleBatchIntent extends GpuCompositeIntent {
  kind: "coloredTriangles"; id: string; vertices: Array<{ x: number; y: number; color: GpuRgba }>;
  rotationDeg: number; pivotX: number; pivotY: number;
}

export interface GpuImageIntent extends GpuCompositeIntent {
  kind: "image"; id: string; resourceId: string; x: number; y: number; width: number; height: number;
  rotationDeg: number; pivotX: number; pivotY: number; u0: number; v0: number; u1: number; v1: number; opacity: number;
  /** Fixed Motion chroma-key controls evaluated by the owned image pipeline. */
  chromaKey?: GpuChromaKeyIntent;
}

/**
 * A normalized subset of `MotionChromaKey` that is safe to cross into the
 * fixed WebGPU image pipeline. The GPU implementation deliberately has no
 * arbitrary shader, cleanup-kernel, or package code inputs.
 */
export interface GpuChromaKeyIntent {
  keyColor: GpuRgba;
  similarity: number;
  smoothness: number;
  shadow: number;
  spillSuppression: number;
  spillBalance: number;
  edgeColorCorrection: number;
  /**
   * Fixed Motion-owned matte cleanup controls. These are scalar data only;
   * package data never chooses a kernel, workgroup size, or shader source.
   */
  matte: GpuChromaMatteCleanupIntent;
}

export interface GpuChromaMatteCleanupIntent {
  denoiseRadiusPx: number;
  growShrinkPx: number;
  chokePx: number;
  featherPx: number;
  blackClip: number;
  whiteClip: number;
}

export interface GpuGradientStop { offset: number; color: GpuRgba }
export interface GpuGradientRectangleIntent extends GpuCompositeIntent {
  kind: "gradientRect";
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDeg: number;
  pivotX: number;
  pivotY: number;
  gradientType: "linear" | "radial";
  angleDeg: number;
  centerX: number;
  centerY: number;
  stops: GpuGradientStop[];
}

export interface GpuStyledRectangleIntent extends GpuCompositeIntent {
  kind: "styledRect";
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDeg: number;
  pivotX: number;
  pivotY: number;
  radius: number;
  fill: GpuRgba;
  strokeWidth: number;
  stroke: GpuRgba;
  shadow: { offsetX: number; offsetY: number; blur: number; spread: number; color: GpuRgba } | null;
}

/** One fixed-data 3D object. Packages provide geometry and transforms, never shaders. */
export interface GpuScene3dObjectIntent {
  id: string;
  /** Interleaved position.xyz and normal.xyz float values. */
  vertices: number[];
  indices: number[];
  model: number[];
  color: GpuRgba;
  emissive: number;
}

/** One depth-buffered, Motion-owned WebGPU scene. */
export interface GpuScene3dIntent extends GpuCompositeIntent {
  kind: "scene3d";
  id: string;
  background: GpuRgba;
  opacity: number;
  viewProjection: number[];
  lightDirection: [number, number, number];
  lightColor: GpuRgba;
  ambient: number;
  intensity: number;
  objects: GpuScene3dObjectIntent[];
}

/** One authored environment evaluated by Motion-owned WGSL, never package code. */
export interface GpuEnvironmentIntent extends GpuCompositeIntent {
  kind: "environment";
  id: string;
  environmentKind: "rain" | "water" | "snow" | "fog";
  mode: "scene" | "overlay";
  seed: number;
  timeSeconds: number;
  x: number; y: number; width: number; height: number;
  rotationDeg: number; pivotX: number; pivotY: number; opacity: number;
  sceneResourceId?: string;
  effectMaskResourceId?: string;
  /** Background, primary, secondary, light/reflection, and accent/foam. */
  colors: [GpuRgba, GpuRgba, GpuRgba, GpuRgba, GpuRgba];
  /** Four bounded vec4 parameter banks interpreted only by the fixed renderer. */
  parameters: [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
}

/** One fixed Motion-owned procedural material; package shader source is never present. */
export interface GpuMaterialIntent extends GpuCompositeIntent {
  kind: "material";
  id: string;
  preset: "plasma" | "hologram" | "energy" | "noise";
  seed: number;
  timeSeconds: number;
  x: number; y: number; width: number; height: number;
  rotationDeg: number; pivotX: number; pivotY: number; opacity: number;
  colors: [GpuRgba, GpuRgba, GpuRgba];
  /** speed, scale, intensity, detail, warp, glow, scanline, phase. */
  parameters: [number, number, number, number, number, number, number, number];
}

/** Browser-shaped text rasterized from exact manifest font bytes, then composited by WebGPU. */
export interface GpuTextIntent extends GpuCompositeIntent {
  kind: "text";
  id: string;
  surfaceId: string;
  fontResourceIds: string[];
  fontFamily: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDeg: number;
  pivotX: number;
  pivotY: number;
  opacity: number;
  color: GpuRgba;
  fontSize: number;
  fontWeight: number;
  fontStyle: "normal" | "italic" | "oblique";
  letterSpacing: number;
  lineHeight: number;
  textAlign: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  direction: "ltr" | "rtl";
  /** One CSS-compatible text shadow lowered through the fixed text surface. */
  textShadow: GpuTextShadow | null;
  /** Browser glyph-layout authority used for the public safe/auto-fit contract. */
  textFit: GpuTextFitIntent | null;
}

export interface GpuTextShadow {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: GpuRgba;
}

/** Absolute document-space safe-area bounds; package ids never cross the renderer boundary. */
export interface GpuTextFitIntent {
  policy: "safe" | "allow-crop" | "auto-fit";
  safeArea: { top: number; right: number; bottom: number; left: number } | null;
  minFontSize: number | null;
}

/** Full-frame authored adjustment evaluated in layer order by the fixed GPU pipeline. */
export interface GpuAdjustmentIntent {
  kind: "adjustment";
  id: string;
  vignette: { amount: number; softness: number; color: GpuRgba } | null;
  filmGrain: { amount: number; size: number; frameSeed: number } | null;
}
export interface GpuEffectModuleIntent extends GpuEffectModuleBinding, GpuCompositeIntent { kind: "effectModule"; id: string; blendMode: "normal"; effects: null; mask?: never }

/** Opens one isolated additive temporal-sample group. */
export interface GpuMotionBlurStartIntent extends GpuCompositeIntent {
  kind: "motionBlurStart";
  id: string;
  sampleCount: number;
  drawCount: number;
  shutterAngle: number;
  shutterDurationMs: number;
}

/** Closes the immediately preceding temporal-sample group. */
export interface GpuMotionBlurEndIntent { kind: "motionBlurEnd"; id: string; groupId: string }

/** Opens one isolated, transformable nested precomposition. */
export interface GpuGroupStartIntent extends GpuCompositeIntent {
  kind: "groupStart"; id: string; drawCount: number;
  x: number; y: number; scale: number; rotationDeg: number; pivotX: number; pivotY: number; opacity: number;
}
export interface GpuGroupEndIntent { kind: "groupEnd"; id: string; groupId: string }

export type GpuPrimitiveIntent = GpuRectangleIntent | GpuEllipseIntent | GpuPointBatchIntent | GpuComputeParticleIntent | GpuTriangleBatchIntent | GpuColoredTriangleBatchIntent | GpuImageIntent | GpuTextIntent | GpuGradientRectangleIntent | GpuStyledRectangleIntent | GpuScene3dIntent | GpuEnvironmentIntent | GpuMaterialIntent;
export type GpuDrawIntent = GpuPrimitiveIntent | GpuAdjustmentIntent | GpuEffectModuleIntent | GpuMotionBlurStartIntent | GpuMotionBlurEndIntent | GpuGroupStartIntent | GpuGroupEndIntent;

export interface GpuFrameIntent {
  schema: typeof GPU_FRAME_INTENT_SCHEMA;
  width: number;
  height: number;
  clear: GpuRgba;
  draws: GpuDrawIntent[];
}

export interface GpuFrameBudget {
  rectangleCount: number;
  pointCount: number;
  computeParticleFieldCount: number;
  computeParticleCount: number;
  /** v1/v2 retained instance memory, excluding renderer-owned frame textures. */
  computeParticleBufferBytes: number;
  /** v2 has one compute dispatch and one head plus optional trail raster pass. */
  computeParticleComputeDispatchCount: number;
  computeParticleRasterPassCount: number;
  triangleVertexCount: number;
  imageCount: number;
  chromaKeyCount: number;
  chromaMatteCleanupCount: number;
  chromaMatteCleanupPassCount: number;
  textCount: number;
  textUtf8Bytes: number;
  textSurfacePixels: number;
  scene3dCount: number;
  scene3dObjectCount: number;
  scene3dVertexCount: number;
  scene3dIndexCount: number;
  environmentCount: number;
  materialCount: number;
  gradientStopCount: number;
  pointBufferBytes: number;
  triangleBufferBytes: number;
  imageVertexBufferBytes: number;
  chromaKeyUniformBytes: number;
  chromaMatteCleanupUniformBytes: number;
  textVertexBufferBytes: number;
  scene3dVertexBufferBytes: number;
  scene3dIndexBufferBytes: number;
  scene3dUniformBytes: number;
  environmentUniformBytes: number;
  materialUniformBytes: number;
  gradientUniformBytes: number;
  styledRectangleUniformBytes: number;
  blendModeCount: number;
  colorEffectCount: number;
  blurEffectCount: number;
  glowEffectCount: number;
  maskCount: number;
  blurPassCount: number;
  adjustmentCount: number;
  effectModuleCount?: number; effectModuleUniformBytes?: number; effectModuleTextureLoadCount?: number; effectModulePassCount?: number;
  motionBlurGroupCount: number;
  motionBlurSampleCount: number;
  groupCount: number;
  groupMaxDepth: number;
  compositeCount: number;
  compositeUniformBytes: number;
  blurUniformBytes: number;
  glowUniformBytes: number;
  maskUniformBytes: number;
  adjustmentUniformBytes: number;
  chromaMatteCleanupIntermediateTextureBytes: number;
  compositeIntermediateTextureBytes: number;
  estimatedPlanBytes: number;
}

export interface GpuFramePlan extends GpuFrameIntent { fingerprint: string; budget: GpuFrameBudget }
