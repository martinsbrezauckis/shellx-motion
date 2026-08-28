import { createHash } from "node:crypto";
import { readGpuChromaKeyIntent } from "./gpu-frame-chroma-key";
import { GpuFrameIntentError } from "./gpu-frame-intent-error";
import { gpuChromaMatteCleanupPassCount, gpuDrawHasBlur, gpuDrawHasBlurredGlow, gpuDrawHasColorEffects, gpuDrawHasGlow, gpuDrawHasMask, gpuDrawNeedsComposite, isGpuCompositeDraw } from "./gpu-frame-intent-composite";
import { readGpuFrameTextFit, readGpuFrameTextShadow } from "./gpu-frame-intent-text";
import { isGpuFrameRecord, readGpuFrameEnum, readGpuFrameInteger, readGpuFrameNonNegative, readGpuFramePositiveUnitless, readGpuFrameSafeText, readGpuFrameStyledRectangleShadow, readGpuFrameText } from "./gpu-frame-intent-readers";
import { canonicalJson } from "./canonical-json";
import { readGpuAdjustmentIntent, readGpuLayerEffects } from "./gpu-frame-intent-effects";
import { readGpuLayerMask } from "./gpu-frame-intent-mask";
import { readGpuMotionBlurStart, validateGpuMotionBlurGroups } from "./gpu-frame-motion-blur";
import { GPU_MAX_ACTIVE_ENVIRONMENT_LAYERS, GPU_MAX_ENVIRONMENT_DRAW_WORK, gpuTemporalCompositeCount } from "./gpu-frame-temporal-budget";
import { readGpuGroupStart, validateGpuGroups } from "./gpu-frame-group";
import { readGpuScene3dIntent, type GpuScene3dTotals } from "./gpu-frame-scene3d";
import { readGpuEnvironmentIntent } from "./gpu-frame-environment"; import { readGpuMaterialIntent } from "./gpu-frame-material"; import { readGpuEffectModuleIntent } from "./gpu-frame-effect-module";
import { readGpuComputeParticleField } from "./gpu-frame-particle-compute-reader";
import { readGpuComputeBounded, readGpuComputeFinite, readGpuComputeRotation, readGpuComputeSeed } from "./gpu-frame-particle-compute-readers";
import {
  ADJUSTMENT_PLAN_BYTES, ADJUSTMENT_UNIFORM_BYTES, BLUR_PLAN_BYTES, BLUR_UNIFORM_BYTES,
  CHROMA_KEY_PLAN_BYTES, CHROMA_KEY_UNIFORM_BYTES, CHROMA_MATTE_CLEANUP_PLAN_BYTES, CHROMA_MATTE_CLEANUP_UNIFORM_BYTES,
  COMPOSITE_PLAN_BYTES, COMPOSITE_UNIFORM_BYTES, GLOW_PLAN_BYTES, GLOW_UNIFORM_BYTES,
  GRADIENT_STOP_PLAN_BYTES, GRADIENT_UNIFORM_BYTES, GROUP_PLAN_BYTES, IMAGE_VERTEX_PLAN_BYTES,
  MASK_PLAN_BYTES, MASK_UNIFORM_BYTES, MOTION_BLUR_GROUP_PLAN_BYTES, POINT_INSTANCE_BYTES,
  RECTANGLE_PLAN_BYTES, STYLED_RECTANGLE_PLAN_BYTES, STYLED_RECTANGLE_UNIFORM_BYTES,
  SCENE_3D_INDEX_BYTES, SCENE_3D_OBJECT_UNIFORM_BYTES, SCENE_3D_PLAN_BYTES, SCENE_3D_VERTEX_BYTES,
  ENVIRONMENT_PLAN_BYTES, ENVIRONMENT_UNIFORM_BYTES, MATERIAL_PLAN_BYTES, MATERIAL_UNIFORM_BYTES, COMPUTE_PARTICLE_PLAN_BYTES, EFFECT_MODULE_PLAN_BYTES, EFFECT_MODULE_UNIFORM_BYTES,
  TEXT_VERTEX_PLAN_BYTES, TRIANGLE_VERTEX_BYTES
} from "./gpu-frame-intent-budget";
import {
  GPU_FRAME_INTENT_SCHEMA, GPU_MAX_DRAW_BATCHES, GPU_MAX_FRAME_DIMENSION, GPU_MAX_FRAME_PIXELS, GPU_MAX_PRIMITIVE_EXTENT,
  GPU_MAX_GRADIENT_STOPS, GPU_MAX_IMAGE_DRAWS, GPU_MAX_PLAN_BYTES, GPU_MAX_POINTS, GPU_MAX_RECTANGLES, GPU_MAX_COMPUTE_PARTICLE_FIELDS, GPU_MAX_COMPUTE_PARTICLES,
  GPU_MAX_TEXT_DRAWS, GPU_MAX_TEXT_SURFACE_PIXELS, GPU_MAX_TEXT_UTF8_BYTES, GPU_MAX_TRIANGLE_VERTICES,
  type GpuDrawIntent, type GpuFrameBudget, type GpuFrameIntent, type GpuFramePlan, type GpuPointInstance, type GpuRgba
} from "./gpu-frame-intent-types";
import { GPU_COMPUTE_PARTICLE_FIELD_V2_SCHEMA, GPU_COMPUTE_PARTICLE_INSTANCE_BYTES, GPU_COMPUTE_PARTICLE_PING_PONG_BUFFER_COUNT } from "./gpu-particle-compute";
export * from "./gpu-frame-intent-types"; export { GpuFrameIntentError } from "./gpu-frame-intent-error";
const MAX_COORDINATE = 1_000_000; const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter"] as const;
export function compileGpuFramePlan(input: unknown): GpuFramePlan {
  if (!isGpuFrameRecord(input)) throw new GpuFrameIntentError("GPU frame intent must be an object.");
  if (input.schema !== GPU_FRAME_INTENT_SCHEMA) throw new GpuFrameIntentError(`Unsupported GPU frame schema '${String(input.schema)}'.`);
  const width = readDimension(input.width, "width");
  const height = readDimension(input.height, "height");
  if (width * height > GPU_MAX_FRAME_PIXELS) throw new GpuFrameIntentError(`GPU frame exceeds the ${GPU_MAX_FRAME_PIXELS}-pixel internal budget.`);
  const clear = readRgba(input.clear, "clear");
  if (!Array.isArray(input.draws)) throw new GpuFrameIntentError("GPU frame draws must be an array.");
  if (input.draws.length > GPU_MAX_DRAW_BATCHES) throw new GpuFrameIntentError(`GPU frame exceeds ${GPU_MAX_DRAW_BATCHES} draw batches.`);
  const ids = new Set<string>();
  let rectangleCount = 0;
  let pointCount = 0;
  let computeParticleFieldCount = 0, computeParticleCount = 0, computeParticleBufferBytes = 0, computeParticleComputeDispatchCount = 0, computeParticleRasterPassCount = 0;
  let triangleVertexCount = 0;
  let imageCount = 0;
  let chromaKeyCount = 0;
  let chromaMatteCleanupCount = 0;
  let textCount = 0;
  let textUtf8Bytes = 0;
  let textSurfacePixels = 0;
  let gradientStopCount = 0;
  let adjustmentCount = 0;
  let environmentCount = 0, materialCount = 0, effectModuleCount = 0;
  const scene3d: GpuScene3dTotals = { scenes: 0, objects: 0, vertices: 0, indices: 0 };
  const draws: GpuDrawIntent[] = input.draws.map((draw, index) => {
    if (!isGpuFrameRecord(draw)) throw new GpuFrameIntentError(`draws[${index}] must be an object.`);
    const id = readId(draw.id, `draws[${index}].id`, ids);
    if (draw.kind === "adjustment") {
      adjustmentCount += 1;
      return readGpuAdjustmentIntent(draw, id, refuse);
    }
    if (draw.kind === "effectModule") { effectModuleCount += 1; if (effectModuleCount > 1) refuse("GPU frames support at most one fixed effect module."); return readGpuEffectModuleIntent(draw, id, refuse); }
    if (draw.kind === "motionBlurEnd" || draw.kind === "groupEnd") return { kind: draw.kind, id, groupId: readResourceId(draw.groupId, `${id}.groupId`) };
    const blendMode = readGpuFrameEnum(draw.blendMode ?? "normal", `${id}.blendMode`, BLEND_MODES);
    const effects = readGpuLayerEffects(draw.effects, `${id}.effects`, refuse);
    const mask = readGpuLayerMask(draw.mask, `${id}.mask`, refuse);
    const composite = { blendMode, effects, ...(mask ? { mask } : {}) };
    if (draw.kind === "motionBlurStart") return readGpuMotionBlurStart(draw, id, composite, refuse);
    if (draw.kind === "groupStart") return readGpuGroupStart(draw,id,composite,readCoordinate,readRotation,readUnit,refuse);
    if (draw.kind === "scene3d") return readGpuScene3dIntent(draw, id, composite, scene3d, refuse);
    if (draw.kind === "environment") { environmentCount += 1; if (environmentCount > GPU_MAX_ENVIRONMENT_DRAW_WORK) refuse(`GPU frames support at most ${GPU_MAX_ENVIRONMENT_DRAW_WORK} environment draw samples.`); return readGpuEnvironmentIntent(draw,id,composite,refuse); }
    if (draw.kind === "material") { materialCount += 1; if (materialCount > 8) refuse("GPU frames support at most eight fixed material layers."); return readGpuMaterialIntent(draw,id,composite,refuse); }
    if (draw.kind === "rect" || draw.kind === "ellipse") {
      rectangleCount += 1;
      if (rectangleCount > GPU_MAX_RECTANGLES) throw new GpuFrameIntentError(`GPU frame exceeds ${GPU_MAX_RECTANGLES} quad primitives.`);
      const geometry = {
        x: readCoordinate(draw.x, `${id}.x`), y: readCoordinate(draw.y, `${id}.y`),
        rotationDeg: readRotation(draw.rotationDeg ?? 0, `${id}.rotationDeg`),
        pivotX: readCoordinate(draw.pivotX ?? (readFinite(draw.x, `${id}.x`) + (readFinite(draw.width, `${id}.width`) / 2)), `${id}.pivotX`),
        pivotY: readCoordinate(draw.pivotY ?? (readFinite(draw.y, `${id}.y`) + (readFinite(draw.height, `${id}.height`) / 2)), `${id}.pivotY`)
      };
      if (draw.kind === "ellipse") return { kind: "ellipse", id, ...composite, ...geometry,
        width: readPositivePrimitiveExtent(draw.width, `${id}.width`), height: readPositivePrimitiveExtent(draw.height, `${id}.height`),
        color: readRgba(draw.color, `${id}.color`), strokeWidth: readGpuFrameNonNegative(draw.strokeWidth, `${id}.strokeWidth`, GPU_MAX_FRAME_DIMENSION), stroke: readRgba(draw.stroke, `${id}.stroke`) };
      return { kind: "rect", id, ...composite, ...geometry, width: readPositiveCoordinate(draw.width, `${id}.width`), height: readPositiveCoordinate(draw.height, `${id}.height`), color: readRgba(draw.color, `${id}.color`) };
    }
    if (draw.kind === "points") {
      if (!Array.isArray(draw.points)) throw new GpuFrameIntentError(`${id}.points must be an array.`);
      const points: GpuPointInstance[] = draw.points.map((point, pointIndex) => {
        if (!isGpuFrameRecord(point)) throw new GpuFrameIntentError(`${id}.points[${pointIndex}] must be an object.`);
        pointCount += 1;
        if (pointCount > GPU_MAX_POINTS) throw new GpuFrameIntentError(`GPU frame exceeds ${GPU_MAX_POINTS} point instances.`);
        return {
          x: readCoordinate(point.x, `${id}.points[${pointIndex}].x`),
          y: readCoordinate(point.y, `${id}.points[${pointIndex}].y`),
          size: readPositiveCoordinate(point.size, `${id}.points[${pointIndex}].size`),
          color: readRgba(point.color, `${id}.points[${pointIndex}].color`)
        };
      });
      return { kind: "points", id, ...composite, seed: readSeed(draw.seed, `${id}.seed`), instanceBufferMode: readGpuFrameEnum(draw.instanceBufferMode ?? "dynamic", `${id}.instanceBufferMode`, ["static", "dynamic"] as const), points };
    }
    if (draw.kind === "particleCompute") {
      computeParticleFieldCount += 1;
      if (computeParticleFieldCount > GPU_MAX_COMPUTE_PARTICLE_FIELDS) throw new GpuFrameIntentError(`GPU frame supports at most ${GPU_MAX_COMPUTE_PARTICLE_FIELDS} fixed compute particle field.`);
      const compute = readGpuComputeParticleField(draw, id, composite, { seed: readSeed, finite: readFinite, bounded: readBounded, positive: readPositiveCoordinate, coordinate: readCoordinate, rotation: readRotation, unit: readUnit, color: readRgba }, GPU_MAX_COMPUTE_PARTICLES);
      computeParticleCount += compute.count;
      if (computeParticleCount > GPU_MAX_COMPUTE_PARTICLES) throw new GpuFrameIntentError(`GPU frame exceeds ${GPU_MAX_COMPUTE_PARTICLES} fixed compute particle instances.`);
      if (compute.schema === GPU_COMPUTE_PARTICLE_FIELD_V2_SCHEMA) { computeParticleBufferBytes += compute.retainedInstanceBytes; computeParticleComputeDispatchCount += compute.computeDispatchCount; computeParticleRasterPassCount += compute.rasterPassCount; }
      else { computeParticleBufferBytes += compute.count * GPU_COMPUTE_PARTICLE_INSTANCE_BYTES * GPU_COMPUTE_PARTICLE_PING_PONG_BUFFER_COUNT; computeParticleComputeDispatchCount += 1; computeParticleRasterPassCount += 1; }
      return compute;
    }
    if (draw.kind === "triangles") {
      if (!Array.isArray(draw.vertices) || draw.vertices.length < 3 || draw.vertices.length % 3 !== 0) throw new GpuFrameIntentError(`${id}.vertices must contain complete triangle triples.`);
      triangleVertexCount += draw.vertices.length;
      if (triangleVertexCount > GPU_MAX_TRIANGLE_VERTICES) throw new GpuFrameIntentError(`GPU frame exceeds ${GPU_MAX_TRIANGLE_VERTICES} triangle vertices.`);
      const vertices = draw.vertices.map((vertex, vertexIndex) => {
        if (!isGpuFrameRecord(vertex)) throw new GpuFrameIntentError(`${id}.vertices[${vertexIndex}] must be an object.`);
        return { x: readCoordinate(vertex.x, `${id}.vertices[${vertexIndex}].x`), y: readCoordinate(vertex.y, `${id}.vertices[${vertexIndex}].y`) };
      });
      return {
        kind: "triangles", id, ...composite, vertices,
        rotationDeg: readRotation(draw.rotationDeg ?? 0, `${id}.rotationDeg`),
        pivotX: readCoordinate(draw.pivotX ?? 0, `${id}.pivotX`),
        pivotY: readCoordinate(draw.pivotY ?? 0, `${id}.pivotY`),
        color: readRgba(draw.color, `${id}.color`)
      };
    }
    if (draw.kind === "coloredTriangles") {
      if (!Array.isArray(draw.vertices) || draw.vertices.length < 3 || draw.vertices.length % 3 !== 0) throw new GpuFrameIntentError(`${id}.vertices must contain complete triangle triples.`);
      triangleVertexCount += draw.vertices.length;
      if (triangleVertexCount > GPU_MAX_TRIANGLE_VERTICES) throw new GpuFrameIntentError(`GPU frame exceeds ${GPU_MAX_TRIANGLE_VERTICES} triangle vertices.`);
      const vertices = draw.vertices.map((vertex, vertexIndex) => {
        if (!isGpuFrameRecord(vertex)) throw new GpuFrameIntentError(`${id}.vertices[${vertexIndex}] must be an object.`);
        return {
          x: readCoordinate(vertex.x, `${id}.vertices[${vertexIndex}].x`),
          y: readCoordinate(vertex.y, `${id}.vertices[${vertexIndex}].y`),
          color: readRgba(vertex.color, `${id}.vertices[${vertexIndex}].color`)
        };
      });
      return {
        kind: "coloredTriangles", id, ...composite, vertices,
        rotationDeg: readRotation(draw.rotationDeg ?? 0, `${id}.rotationDeg`),
        pivotX: readCoordinate(draw.pivotX ?? 0, `${id}.pivotX`),
        pivotY: readCoordinate(draw.pivotY ?? 0, `${id}.pivotY`)
      };
    }
    if (draw.kind === "image") {
      imageCount += 1;
      if (imageCount > GPU_MAX_IMAGE_DRAWS) throw new GpuFrameIntentError(`GPU frame exceeds ${GPU_MAX_IMAGE_DRAWS} image draws.`);
      const chromaKey = draw.chromaKey === undefined ? undefined : readGpuChromaKeyIntent(draw.chromaKey, `${id}.chromaKey`);
      if (chromaKey) chromaKeyCount += 1;
      if (chromaKey && (chromaKey.matte.denoiseRadiusPx !== 0 || chromaKey.matte.growShrinkPx !== 0 || chromaKey.matte.chokePx !== 0 || chromaKey.matte.featherPx !== 0 || chromaKey.matte.blackClip !== 0 || chromaKey.matte.whiteClip !== 1)) {
        chromaMatteCleanupCount += 1;
        if (chromaMatteCleanupCount > 64) throw new GpuFrameIntentError("GPU frames support at most 64 chroma matte-cleanup draws.");
      }
      return {
        kind: "image", id, ...composite, resourceId: readResourceId(draw.resourceId, `${id}.resourceId`),
        x: readCoordinate(draw.x, `${id}.x`), y: readCoordinate(draw.y, `${id}.y`),
        width: readPositivePrimitiveExtent(draw.width, `${id}.width`), height: readPositivePrimitiveExtent(draw.height, `${id}.height`),
        rotationDeg: readRotation(draw.rotationDeg ?? 0, `${id}.rotationDeg`),
        pivotX: readCoordinate(draw.pivotX ?? 0, `${id}.pivotX`), pivotY: readCoordinate(draw.pivotY ?? 0, `${id}.pivotY`),
        u0: readUnit(draw.u0, `${id}.u0`), v0: readUnit(draw.v0, `${id}.v0`),
        u1: readUnit(draw.u1, `${id}.u1`), v1: readUnit(draw.v1, `${id}.v1`),
        opacity: readUnit(draw.opacity, `${id}.opacity`),
        ...(chromaKey ? { chromaKey } : {})
      };
    }
    if (draw.kind === "text") {
      textCount += 1;
      if (textCount > GPU_MAX_TEXT_DRAWS) throw new GpuFrameIntentError(`GPU frame exceeds ${GPU_MAX_TEXT_DRAWS} text draws.`);
      const text = readGpuFrameText(draw.text, `${id}.text`);
      textUtf8Bytes += Buffer.byteLength(text, "utf8");
      if (textUtf8Bytes > GPU_MAX_TEXT_UTF8_BYTES) throw new GpuFrameIntentError(`GPU frame text exceeds its ${GPU_MAX_TEXT_UTF8_BYTES}-byte UTF-8 budget.`);
      const width = readPositiveCoordinate(draw.width, `${id}.width`);
      const height = readPositiveCoordinate(draw.height, `${id}.height`);
      textSurfacePixels += Math.ceil(width) * Math.ceil(height);
      if (textSurfacePixels > GPU_MAX_TEXT_SURFACE_PIXELS) throw new GpuFrameIntentError(`GPU text surfaces exceed the ${GPU_MAX_TEXT_SURFACE_PIXELS}-pixel frame budget.`);
      if (!Array.isArray(draw.fontResourceIds) || draw.fontResourceIds.length < 1 || draw.fontResourceIds.length > 32) throw new GpuFrameIntentError(`${id}.fontResourceIds must contain 1..32 font resources.`);
      const fontResourceIds = draw.fontResourceIds.map((resourceId, resourceIndex) => readResourceId(resourceId, `${id}.fontResourceIds[${resourceIndex}]`));
      if (new Set(fontResourceIds).size !== fontResourceIds.length) throw new GpuFrameIntentError(`${id}.fontResourceIds must be unique.`);
      return {
        kind: "text", id, ...composite, surfaceId: readResourceId(draw.surfaceId, `${id}.surfaceId`), fontResourceIds,
        fontFamily: readGpuFrameSafeText(draw.fontFamily, `${id}.fontFamily`, 128), text,
        x: readCoordinate(draw.x, `${id}.x`), y: readCoordinate(draw.y, `${id}.y`), width, height,
        rotationDeg: readRotation(draw.rotationDeg ?? 0, `${id}.rotationDeg`),
        pivotX: readCoordinate(draw.pivotX ?? 0, `${id}.pivotX`), pivotY: readCoordinate(draw.pivotY ?? 0, `${id}.pivotY`),
        opacity: readUnit(draw.opacity, `${id}.opacity`), color: readRgba(draw.color, `${id}.color`),
        fontSize: readPositiveCoordinate(draw.fontSize, `${id}.fontSize`), fontWeight: readGpuFrameInteger(draw.fontWeight, `${id}.fontWeight`, 1, 1_000),
        fontStyle: readGpuFrameEnum(draw.fontStyle, `${id}.fontStyle`, ["normal", "italic", "oblique"] as const),
        letterSpacing: readCoordinate(draw.letterSpacing, `${id}.letterSpacing`), lineHeight: readGpuFramePositiveUnitless(draw.lineHeight, `${id}.lineHeight`, 10),
        textAlign: readGpuFrameEnum(draw.textAlign, `${id}.textAlign`, ["left", "center", "right"] as const),
        verticalAlign: readGpuFrameEnum(draw.verticalAlign, `${id}.verticalAlign`, ["top", "middle", "bottom"] as const),
        direction: readGpuFrameEnum(draw.direction, `${id}.direction`, ["ltr", "rtl"] as const),
        textShadow: draw.textShadow === undefined ? null : readGpuFrameTextShadow(draw.textShadow, `${id}.textShadow`),
        textFit: draw.textFit === undefined ? null : readGpuFrameTextFit(draw.textFit, `${id}.textFit`)
      };
    }
    if (draw.kind === "gradientRect") {
      rectangleCount += 1;
      if (rectangleCount > GPU_MAX_RECTANGLES) throw new GpuFrameIntentError(`GPU frame exceeds ${GPU_MAX_RECTANGLES} quad primitives.`);
      if (!Array.isArray(draw.stops) || draw.stops.length < 2 || draw.stops.length > 16) throw new GpuFrameIntentError(`${id}.stops must contain 2..16 gradient stops.`);
      gradientStopCount += draw.stops.length;
      if (gradientStopCount > GPU_MAX_GRADIENT_STOPS) throw new GpuFrameIntentError(`GPU frame exceeds ${GPU_MAX_GRADIENT_STOPS} total gradient stops.`);
      let priorOffset = -1;
      const stops = draw.stops.map((value, stopIndex) => {
        if (!isGpuFrameRecord(value)) throw new GpuFrameIntentError(`${id}.stops[${stopIndex}] must be an object.`);
        const offset = readUnit(value.offset, `${id}.stops[${stopIndex}].offset`); if (offset < priorOffset) throw new GpuFrameIntentError(`${id}.stops must be ordered.`); priorOffset = offset;
        return { offset, color: readRgba(value.color, `${id}.stops[${stopIndex}].color`) };
      });
      return {
        kind: "gradientRect", id, ...composite, x: readCoordinate(draw.x, `${id}.x`), y: readCoordinate(draw.y, `${id}.y`),
        width: readPositiveCoordinate(draw.width, `${id}.width`), height: readPositiveCoordinate(draw.height, `${id}.height`),
        rotationDeg: readRotation(draw.rotationDeg ?? 0, `${id}.rotationDeg`), pivotX: readCoordinate(draw.pivotX ?? 0, `${id}.pivotX`), pivotY: readCoordinate(draw.pivotY ?? 0, `${id}.pivotY`),
        gradientType: readGpuFrameEnum(draw.gradientType, `${id}.gradientType`, ["linear", "radial"] as const), angleDeg: readRotation(draw.angleDeg ?? 180, `${id}.angleDeg`),
        centerX: readUnit(draw.centerX ?? 0.5, `${id}.centerX`), centerY: readUnit(draw.centerY ?? 0.5, `${id}.centerY`), stops
      };
    }
    if (draw.kind === "styledRect") {
      rectangleCount += 1;
      if (rectangleCount > GPU_MAX_RECTANGLES) throw new GpuFrameIntentError(`GPU frame exceeds ${GPU_MAX_RECTANGLES} quad primitives.`);
      return {
        kind: "styledRect", id, ...composite, x: readCoordinate(draw.x, `${id}.x`), y: readCoordinate(draw.y, `${id}.y`),
        width: readPositiveCoordinate(draw.width, `${id}.width`), height: readPositiveCoordinate(draw.height, `${id}.height`),
        rotationDeg: readRotation(draw.rotationDeg ?? 0, `${id}.rotationDeg`), pivotX: readCoordinate(draw.pivotX ?? 0, `${id}.pivotX`), pivotY: readCoordinate(draw.pivotY ?? 0, `${id}.pivotY`),
        radius: readGpuFrameNonNegative(draw.radius, `${id}.radius`, GPU_MAX_FRAME_DIMENSION), fill: readRgba(draw.fill, `${id}.fill`),
        strokeWidth: readGpuFrameNonNegative(draw.strokeWidth, `${id}.strokeWidth`, GPU_MAX_FRAME_DIMENSION), stroke: readRgba(draw.stroke, `${id}.stroke`),
        shadow: readGpuFrameStyledRectangleShadow(draw.shadow, `${id}.shadow`)
      };
    }
    throw new GpuFrameIntentError(`GPU draw '${id}' has unsupported kind '${String(draw.kind)}'.`);
  });
  const temporal = validateGpuMotionBlurGroups(draws, refuse);
  const authoredEnvironmentCount = environmentCount - temporal.environmentDrawCount + temporal.environmentGroupCount;
  if (authoredEnvironmentCount > GPU_MAX_ACTIVE_ENVIRONMENT_LAYERS) refuse(`GPU frames support at most ${GPU_MAX_ACTIVE_ENVIRONMENT_LAYERS} active environment layers.`);
  const groups = validateGpuGroups(draws, refuse);
  const compositeCount = gpuTemporalCompositeCount(draws);
  const chromaMatteCleanupPassCount = draws.reduce((total, draw) => total + gpuChromaMatteCleanupPassCount(draw), 0);
  const chromaMatteCleanupIntermediateTextureBytes = chromaMatteCleanupCount > 0 ? width * height * 4 * 3 : 0;
  const baseIntermediateTextures=groups.groupCount>0?4:draws.some((draw)=>gpuDrawHasBlur(draw)||gpuDrawHasGlow(draw)||gpuDrawHasMask(draw))?3:draws.some(gpuDrawNeedsComposite)?2:adjustmentCount>0?1:0;
  const budget: GpuFrameBudget = {
    rectangleCount,
    pointCount,
    computeParticleFieldCount,
    computeParticleCount,
    triangleVertexCount,
    imageCount,
    chromaKeyCount,
    chromaMatteCleanupCount,
    chromaMatteCleanupPassCount,
    textCount,
    textUtf8Bytes,
    textSurfacePixels,
    scene3dCount: scene3d.scenes,
    scene3dObjectCount: scene3d.objects,
    scene3dVertexCount: scene3d.vertices,
    scene3dIndexCount: scene3d.indices,
    environmentCount, materialCount,
    gradientStopCount,
    pointBufferBytes: pointCount * POINT_INSTANCE_BYTES,
    computeParticleBufferBytes,
    computeParticleComputeDispatchCount,
    computeParticleRasterPassCount,
    triangleBufferBytes: triangleVertexCount * TRIANGLE_VERTEX_BYTES,
    imageVertexBufferBytes: imageCount * IMAGE_VERTEX_PLAN_BYTES,
    chromaKeyUniformBytes: chromaKeyCount * CHROMA_KEY_UNIFORM_BYTES,
    chromaMatteCleanupUniformBytes: chromaMatteCleanupPassCount * CHROMA_MATTE_CLEANUP_UNIFORM_BYTES,
    textVertexBufferBytes: textCount * IMAGE_VERTEX_PLAN_BYTES,
    scene3dVertexBufferBytes: scene3d.vertices * SCENE_3D_VERTEX_BYTES,
    scene3dIndexBufferBytes: scene3d.indices * SCENE_3D_INDEX_BYTES,
    scene3dUniformBytes: scene3d.objects * SCENE_3D_OBJECT_UNIFORM_BYTES,
    environmentUniformBytes: environmentCount * ENVIRONMENT_UNIFORM_BYTES, materialUniformBytes: materialCount * MATERIAL_UNIFORM_BYTES,
    gradientUniformBytes: draws.filter((draw) => draw.kind === "gradientRect").length * GRADIENT_UNIFORM_BYTES,
    styledRectangleUniformBytes: draws.filter((draw) => draw.kind === "styledRect").length * STYLED_RECTANGLE_UNIFORM_BYTES,
    blendModeCount: draws.filter(isGpuCompositeDraw).filter((draw) => draw.blendMode !== "normal").length,
    colorEffectCount: draws.filter(gpuDrawHasColorEffects).length,
    blurEffectCount: draws.filter(gpuDrawHasBlur).length,
    glowEffectCount: draws.filter(gpuDrawHasGlow).length,
    maskCount: draws.filter(gpuDrawHasMask).length,
    blurPassCount: draws.filter(gpuDrawHasBlur).length * 2 + draws.filter(gpuDrawHasBlurredGlow).length * 2,
    adjustmentCount,
    ...(effectModuleCount ? { effectModuleCount, effectModuleUniformBytes: effectModuleCount * EFFECT_MODULE_UNIFORM_BYTES, effectModuleTextureLoadCount: draws.filter((draw) => draw.kind === "effectModule").reduce((total, draw) => total + draw.textureLoadCount, 0), effectModulePassCount: effectModuleCount } : {}),
    motionBlurGroupCount: temporal.groupCount,
    motionBlurSampleCount: temporal.sampleCount,
    groupCount: groups.groupCount,
    groupMaxDepth: groups.maxDepth,
    compositeCount,
    compositeUniformBytes: compositeCount * COMPOSITE_UNIFORM_BYTES,
    blurUniformBytes: (draws.filter(gpuDrawHasBlur).length * 2 + draws.filter(gpuDrawHasBlurredGlow).length * 2) * BLUR_UNIFORM_BYTES,
    glowUniformBytes: draws.filter(gpuDrawHasGlow).length * GLOW_UNIFORM_BYTES,
    maskUniformBytes: draws.filter(gpuDrawHasMask).length * MASK_UNIFORM_BYTES,
    adjustmentUniformBytes: adjustmentCount * ADJUSTMENT_UNIFORM_BYTES,
    chromaMatteCleanupIntermediateTextureBytes,
    compositeIntermediateTextureBytes: width*height*4*(baseIntermediateTextures+groups.maxDepth*4)+chromaMatteCleanupIntermediateTextureBytes,
    estimatedPlanBytes: rectangleCount * RECTANGLE_PLAN_BYTES + pointCount * POINT_INSTANCE_BYTES + computeParticleFieldCount * COMPUTE_PARTICLE_PLAN_BYTES + triangleVertexCount * TRIANGLE_VERTEX_BYTES + imageCount * IMAGE_VERTEX_PLAN_BYTES + chromaKeyCount * CHROMA_KEY_PLAN_BYTES + chromaMatteCleanupCount * CHROMA_MATTE_CLEANUP_PLAN_BYTES + textCount * TEXT_VERTEX_PLAN_BYTES + textUtf8Bytes + gradientStopCount * GRADIENT_STOP_PLAN_BYTES + scene3d.vertices * SCENE_3D_VERTEX_BYTES + scene3d.indices * SCENE_3D_INDEX_BYTES + scene3d.objects * SCENE_3D_OBJECT_UNIFORM_BYTES + scene3d.scenes * SCENE_3D_PLAN_BYTES + environmentCount * ENVIRONMENT_PLAN_BYTES + materialCount * MATERIAL_PLAN_BYTES + effectModuleCount * EFFECT_MODULE_PLAN_BYTES + draws.filter((draw) => draw.kind === "styledRect").length * STYLED_RECTANGLE_PLAN_BYTES + compositeCount * COMPOSITE_PLAN_BYTES + draws.filter(gpuDrawHasBlur).length * BLUR_PLAN_BYTES + draws.filter(gpuDrawHasGlow).length * GLOW_PLAN_BYTES + draws.filter(gpuDrawHasMask).length * MASK_PLAN_BYTES + adjustmentCount * ADJUSTMENT_PLAN_BYTES + temporal.groupCount * MOTION_BLUR_GROUP_PLAN_BYTES + groups.groupCount * GROUP_PLAN_BYTES
  };
  if (budget.estimatedPlanBytes > GPU_MAX_PLAN_BYTES) throw new GpuFrameIntentError(`GPU draw plan exceeds the ${GPU_MAX_PLAN_BYTES}-byte internal budget.`);
  const normalized = { schema: GPU_FRAME_INTENT_SCHEMA, width, height, clear, draws } satisfies GpuFrameIntent;
  return { ...normalized, fingerprint: createHash("sha256").update(canonicalJson(normalized)).digest("hex"), budget };
}
function refuse(message: string): never { throw new GpuFrameIntentError(message); }
function readDimension(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > GPU_MAX_FRAME_DIMENSION) throw new GpuFrameIntentError(`${name} must be an integer in 1..${GPU_MAX_FRAME_DIMENSION}.`);
  return value;
}
function readId(value: unknown, name: string, ids: Set<string>): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || ids.has(value)) {
    throw new GpuFrameIntentError(`${name} must be a unique 1..128 character identifier.`);
  }
  ids.add(value);
  return value;
}
function readResourceId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new GpuFrameIntentError(`${name} must be a 1..128 character resource identifier.`);
  return value;
}
function readUnit(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new GpuFrameIntentError(`${name} must be finite in 0..1.`);
  return value;
}
function readRgba(value: unknown, name: string): GpuRgba {
  if (!isGpuFrameRecord(value) || ![value.r, value.g, value.b, value.a].every((channel) => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1)) {
    throw new GpuFrameIntentError(`${name} must contain finite r, g, b and a channels in 0..1.`);
  }
  return { r: value.r as number, g: value.g as number, b: value.b as number, a: value.a as number };
}
function readCoordinate(value: unknown, name: string): number {
  const coordinate = readFinite(value, name);
  if (Math.abs(coordinate) > MAX_COORDINATE) throw new GpuFrameIntentError(`${name} exceeds the ${MAX_COORDINATE}-pixel coordinate bound.`);
  return coordinate;
}
function readPositiveCoordinate(value: unknown, name: string): number {
  const coordinate = readCoordinate(value, name);
  if (coordinate <= 0 || coordinate > GPU_MAX_FRAME_DIMENSION) throw new GpuFrameIntentError(`${name} must be positive and no larger than ${GPU_MAX_FRAME_DIMENSION}.`);
  return coordinate;
}
function readPositivePrimitiveExtent(value: unknown, name: string): number {
  const coordinate = readCoordinate(value, name);
  if (coordinate <= 0 || coordinate > GPU_MAX_PRIMITIVE_EXTENT) throw new GpuFrameIntentError(`${name} must be positive and no larger than ${GPU_MAX_PRIMITIVE_EXTENT}.`);
  return coordinate;
}
const readFinite = readGpuComputeFinite;
const readBounded = readGpuComputeBounded;
const readSeed = readGpuComputeSeed;
const readRotation = readGpuComputeRotation;
