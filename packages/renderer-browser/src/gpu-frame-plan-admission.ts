import { createHash } from "node:crypto";
import { canonicalJson, gpuEffectModuleBindingProblem } from "@shellx-motion/core";
import { admitGpuLayerMask } from "./gpu-frame-mask-admission";
import { admitGpuGroupGrammar } from "./gpu-frame-group-admission";
import { admitGpuTemporalGrammar } from "./gpu-frame-temporal-admission";
import { admitGpuScene3d, type Scene3dAdmissionTotals } from "./gpu-frame-scene3d-admission";
import { admitGpuEnvironment } from "./gpu-frame-environment-admission"; import { admitGpuMaterial } from "./gpu-frame-material-admission";
import { admitGpuChromaKey } from "./gpu-frame-chroma-key-admission";
import { admitGpuFrameBudget } from "./gpu-frame-plan-budget-admission";
import { admitGpuTextFit, admitGpuTextShadow } from "./gpu-frame-text-admission";
import { isRecord, readCoordinate, readEnum, readFiniteRange, readId, readInclusiveRange, readInteger, readNonnegativeTime, readPositivePrimitiveExtent, readPositiveSize, readPrintable, readRgba, readRotation, readSeed, readUnit } from "./gpu-frame-admission-values";
import type { InternalGpuFrameDraw, InternalGpuFramePlan, InternalGpuLayerEffects, InternalGpuRgba } from "./gpu-runtime-types";
// These limits mirror Core's shipped frame-plan compiler. The drift test loads
// a Core-compiled plan directly; this renderer guard owns only admission.
const MAX_DIMENSION = 4_096;
const MAX_PRIMITIVE_EXTENT = 131_072;
const MAX_PIXELS = 16_777_216;
const MAX_DRAW_BATCHES = 2_048;
const MAX_POINTS = 65_536;
const MAX_COMPUTE_PARTICLE_FIELDS = 1;
const MIN_COMPUTE_PARTICLES = 100_000;
const MAX_COMPUTE_PARTICLES = 131_072;
const MAX_TRIANGLE_VERTICES = 65_535;
const MAX_IMAGES = 256;
const MAX_TEXT_DRAWS = 128;
const MAX_TEXT_UTF8_BYTES = 64 * 1024;
const MAX_TEXT_SURFACE_PIXELS = 32 * 1024 * 1024;
const MAX_GRADIENT_STOPS = 4_096;
const MAX_COORDINATE = 1_000_000;
const POINT_BYTES = 32;
const COMPUTE_PARTICLE_PLAN_BYTES = 320;
const RECTANGLE_BYTES = 64;
const TRIANGLE_VERTEX_BYTES = 24;
const IMAGE_VERTEX_BYTES = 120;
const CHROMA_KEY_UNIFORM_BYTES = 48, CHROMA_KEY_PLAN_BYTES = 64;
const CHROMA_MATTE_CLEANUP_UNIFORM_BYTES = 32, CHROMA_MATTE_CLEANUP_PLAN_BYTES = 128;
const TEXT_VERTEX_BYTES = 160;
const GRADIENT_UNIFORM_BYTES = 336;
const GRADIENT_STOP_BYTES = 32;
const STYLED_RECTANGLE_UNIFORM_BYTES = 80;
const STYLED_RECTANGLE_PLAN_BYTES = 160;
const COMPOSITE_UNIFORM_BYTES = 64;
const COMPOSITE_PLAN_BYTES = 32;
const BLUR_UNIFORM_BYTES = 16;
const BLUR_PLAN_BYTES = 16;
const GLOW_UNIFORM_BYTES = 32;
const GLOW_PLAN_BYTES = 48;
const MASK_UNIFORM_BYTES = 48;
const MASK_PLAN_BYTES = 96;
const ADJUSTMENT_UNIFORM_BYTES = 48;
const ADJUSTMENT_PLAN_BYTES = 64;
const MOTION_BLUR_GROUP_PLAN_BYTES = 48;
const GROUP_PLAN_BYTES = 80;
const SCENE_3D_VERTEX_BYTES=24,SCENE_3D_INDEX_BYTES=4,SCENE_3D_OBJECT_UNIFORM_BYTES=192,SCENE_3D_PLAN_BYTES=256;
const ENVIRONMENT_UNIFORM_BYTES=208,ENVIRONMENT_PLAN_BYTES=320;
const MATERIAL_UNIFORM_BYTES=144,MATERIAL_PLAN_BYTES=224;
const EFFECT_MODULE_PLAN_BYTES = 256;
const BLEND_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter"] as const;
/**
 * Re-admits a Core plan at the renderer boundary before a browser or GPU
 * resource is opened. The returned copy excludes any unrecognised fields.
 */
export function admitInternalGpuFramePlan(value: unknown): InternalGpuFramePlan | null {
  if (!isRecord(value) || value.schema !== "shellx-motion/gpu-frame-intent@1") return null;
  const width = readInteger(value.width, 1, MAX_DIMENSION);
  const height = readInteger(value.height, 1, MAX_DIMENSION);
  const clear = readRgba(value.clear);
  if (width === null || height === null || width * height > MAX_PIXELS || clear === null || !Array.isArray(value.draws) || value.draws.length > MAX_DRAW_BATCHES) return null;
  const ids = new Set<string>();
  let rectangles = 0;
  let points = 0;
  let computeParticleFields = 0;
  let computeParticles = 0;
  let computeParticleBufferBytes = 0;
  let computeParticleComputeDispatches = 0;
  let computeParticleRasterPasses = 0;
  let triangleVertices = 0;
  let images = 0;
  let chromaKeys = 0;
  let chromaMatteCleanups = 0;
  let chromaMatteCleanupPasses = 0;
  let texts = 0;
  let textUtf8Bytes = 0;
  let textSurfacePixels = 0;
  let gradientStops = 0;
  let gradientDraws = 0;
  let styledRectangles = 0;
  let blendModes = 0;
  let colorEffects = 0;
  let blurEffects = 0;
  let glowEffects = 0;
  let blurredGlowEffects = 0;
  let masks = 0;
  let adjustments = 0;
  let effectModules = 0;
  let effectModuleTextureLoads = 0;
  let temporalGroups = 0;
  let temporalSamples = 0;
  let composites = 0;
  let environments=0,materials=0;
  const scene3d:Scene3dAdmissionTotals={scenes:0,objects:0,vertices:0,indices:0};
  const draws: InternalGpuFrameDraw[] = [];
  for (const rawDraw of value.draws) {
    if (!isRecord(rawDraw)) return null;
    const id = readId(rawDraw.id);
    if (id === null || ids.has(id)) return null;
    ids.add(id);
    if (rawDraw.kind === "effectModule") {
      const { kind: _kind, id: _id, blendMode, effects, mask, ...binding } = rawDraw;
      if (++effectModules > 1 || blendMode !== "normal" || effects !== null || mask !== undefined || binding.drawId !== id || binding.scopeGroupDrawId !== `${binding.scopeGroupId}.group` || gpuEffectModuleBindingProblem(binding) !== null) return null;
      effectModuleTextureLoads += binding.textureLoadCount as number;
      draws.push({ kind: "effectModule", id, blendMode: "normal", effects: null, ...(binding as unknown as Omit<Extract<InternalGpuFrameDraw, { kind: "effectModule" }>, "kind" | "id" | "blendMode" | "effects">) });
      continue;
    }
    if (rawDraw.kind === "adjustment") {
      const vignette = readAdjustmentVignette(rawDraw.vignette); const filmGrain = readAdjustmentFilmGrain(rawDraw.filmGrain);
      if (vignette === undefined || filmGrain === undefined || (vignette === null && filmGrain === null)) return null;
      adjustments += 1; draws.push({ kind: "adjustment", id, vignette, filmGrain }); continue;
    }
    if (rawDraw.kind === "motionBlurEnd" || rawDraw.kind === "groupEnd") { const groupId=readId(rawDraw.groupId);if(groupId===null)return null;draws.push({kind:rawDraw.kind,id,groupId});continue; }
    const blendMode = readEnum(rawDraw.blendMode, BLEND_MODES);
    if (blendMode === null) return null;
    const effects = readLayerEffects(rawDraw.effects);
    const mask = admitGpuLayerMask(rawDraw.mask);
    if (effects === undefined || mask === undefined) return null;
    if (blendMode !== "normal") blendModes += 1;
    if (effects !== null && (effects.brightness !== 1 || effects.contrast !== 1 || effects.saturate !== 1 || effects.grayscale !== 0)) colorEffects += 1;
    if ((effects?.blur ?? 0) > 0) blurEffects += 1;
    if (effects?.glow) glowEffects += 1;
    if ((effects?.glow?.radius ?? 0) > 0) blurredGlowEffects += 1;
    if (mask !== null) masks += 1;
    if (blendMode !== "normal" || effects !== null || mask !== null || rawDraw.kind === "motionBlurStart" || rawDraw.kind === "groupStart" || rawDraw.kind === "environment" || rawDraw.kind === "material") composites += 1;
    const composite = { blendMode, effects, ...(mask ? { mask } : {}) };
    if (rawDraw.kind === "motionBlurStart") {
      const sampleCount=readInteger(rawDraw.sampleCount,2,8),drawCount=readInteger(rawDraw.drawCount,sampleCount??2,256),shutterAngle=readFiniteRange(rawDraw.shutterAngle,Number.MIN_VALUE,360),shutterDurationMs=readFiniteRange(rawDraw.shutterDurationMs,Number.MIN_VALUE,1_000);
      if(sampleCount===null||drawCount===null||shutterAngle===null||shutterDurationMs===null)return null;
      temporalGroups+=1;temporalSamples+=sampleCount;draws.push({kind:"motionBlurStart",id,...composite,sampleCount,drawCount,shutterAngle,shutterDurationMs});continue;
    }
    if(rawDraw.kind==="groupStart"){
      const drawCount=readInteger(rawDraw.drawCount,0,2_046),x=readCoordinate(rawDraw.x),y=readCoordinate(rawDraw.y),scale=readFiniteRange(rawDraw.scale,Number.MIN_VALUE,64),rotationDeg=readRotation(rawDraw.rotationDeg),pivotX=readCoordinate(rawDraw.pivotX),pivotY=readCoordinate(rawDraw.pivotY),opacity=readUnit(rawDraw.opacity);
      if(drawCount===null||x===null||y===null||scale===null||rotationDeg===null||pivotX===null||pivotY===null||opacity===null)return null;
      draws.push({kind:"groupStart",id,...composite,drawCount,x,y,scale,rotationDeg,pivotX,pivotY,opacity});continue;
    }
    if(rawDraw.kind==="scene3d") { const admitted=admitGpuScene3d(rawDraw,id,composite,scene3d);if(!admitted)return null;draws.push(admitted);continue; }
    // Four authored environment layers may expand to eight shutter samples each.
    if(rawDraw.kind==="environment"){if(++environments>32)return null;const admitted=admitGpuEnvironment(rawDraw,id,composite);if(!admitted)return null;draws.push(admitted);continue;}
    if(rawDraw.kind==="material"){if(++materials>8)return null;const admitted=admitGpuMaterial(rawDraw,id,composite);if(!admitted)return null;draws.push(admitted);continue;}
    if (rawDraw.kind === "rect") {
      const x = readCoordinate(rawDraw.x);
      const y = readCoordinate(rawDraw.y);
      const drawWidth = readPositiveSize(rawDraw.width);
      const drawHeight = readPositiveSize(rawDraw.height);
      const rotationDeg = readRotation(rawDraw.rotationDeg);
      const pivotX = readCoordinate(rawDraw.pivotX);
      const pivotY = readCoordinate(rawDraw.pivotY);
      const color = readRgba(rawDraw.color);
      if (x === null || y === null || drawWidth === null || drawHeight === null || rotationDeg === null || pivotX === null || pivotY === null || color === null || ++rectangles > MAX_DRAW_BATCHES) return null;
      draws.push({ kind: rawDraw.kind, id, ...composite, x, y, width: drawWidth, height: drawHeight, rotationDeg, pivotX, pivotY, color });
      continue;
    }
    if (rawDraw.kind === "ellipse") {
      const x=readCoordinate(rawDraw.x),y=readCoordinate(rawDraw.y),drawWidth=readPositivePrimitiveExtent(rawDraw.width),drawHeight=readPositivePrimitiveExtent(rawDraw.height),rotationDeg=readRotation(rawDraw.rotationDeg),pivotX=readCoordinate(rawDraw.pivotX),pivotY=readCoordinate(rawDraw.pivotY),color=readRgba(rawDraw.color),strokeWidth=readInclusiveRange(rawDraw.strokeWidth,0,MAX_DIMENSION),stroke=readRgba(rawDraw.stroke);
      if(x===null||y===null||drawWidth===null||drawHeight===null||rotationDeg===null||pivotX===null||pivotY===null||color===null||strokeWidth===null||stroke===null||++rectangles>MAX_DRAW_BATCHES)return null;
      draws.push({kind:"ellipse",id,...composite,x,y,width:drawWidth,height:drawHeight,rotationDeg,pivotX,pivotY,color,strokeWidth,stroke});continue;
    }
    if (rawDraw.kind === "points" && Array.isArray(rawDraw.points)) {
      const seed = readSeed(rawDraw.seed);
      const instanceBufferMode = rawDraw.instanceBufferMode === undefined ? "dynamic" : readEnum(rawDraw.instanceBufferMode, ["static", "dynamic"] as const);
      if (seed === null || instanceBufferMode === null) return null;
      const batch: InternalGpuFrameDraw & { kind: "points" } = { kind: "points", id, ...composite, seed, instanceBufferMode, points: [] };
      for (const rawPoint of rawDraw.points) {
        if (!isRecord(rawPoint)) return null;
        const x = readCoordinate(rawPoint.x);
        const y = readCoordinate(rawPoint.y);
        const size = readPositiveSize(rawPoint.size);
        const color = readRgba(rawPoint.color);
        if (x === null || y === null || size === null || color === null || ++points > MAX_POINTS) return null;
        batch.points.push({ x, y, size, color });
      }
      draws.push(batch);
      continue;
    }
    if (rawDraw.kind === "particleCompute") {
      if (++computeParticleFields > MAX_COMPUTE_PARTICLE_FIELDS || blendMode !== "normal" || effects !== null || (rawDraw.schema !== "shellx-motion/gpu-compute-particle-field@1" && rawDraw.schema !== "shellx-motion/gpu-compute-particle-field@2")) return null;
      if (rawDraw.schema === "shellx-motion/gpu-compute-particle-field@1" && mask !== null) return null;
      if (rawDraw.schema === "shellx-motion/gpu-compute-particle-field@2" && !hasOnlyKeys(rawDraw,["kind","id","blendMode","effects","mask","schema","seed","count","atMs","startMs","lifetimeMs","width","height","x","y","scale","originX","originY","rotationDeg","opacity","color","secondaryColor","minSize","maxSize","minSpeed","maxSpeed","direction","spread","gravity","fadeOut","sources","origins","trail","shading","computeDispatchCount","rasterPassCount","instanceBytes","retainedBufferCount","retainedInstanceBytes"])) return null;
      const seed=readSeed(rawDraw.seed),count=readInteger(rawDraw.count,MIN_COMPUTE_PARTICLES,MAX_COMPUTE_PARTICLES),atMs=readNonnegativeTime(rawDraw.atMs),startMs=readNonnegativeTime(rawDraw.startMs),lifetimeMs=readInclusiveRange(rawDraw.lifetimeMs,0.000001,60_000),drawWidth=readPositiveSize(rawDraw.width),drawHeight=readPositiveSize(rawDraw.height),x=readCoordinate(rawDraw.x),y=readCoordinate(rawDraw.y),scale=readFiniteRange(rawDraw.scale,Number.MIN_VALUE,64),originX=readCoordinate(rawDraw.originX),originY=readCoordinate(rawDraw.originY),rotationDeg=readRotation(rawDraw.rotationDeg),opacity=readUnit(rawDraw.opacity),color=readRgba(rawDraw.color),secondaryColor=readRgba(rawDraw.secondaryColor),minSize=readPositiveSize(rawDraw.minSize),maxSize=readPositiveSize(rawDraw.maxSize),minSpeed=readInclusiveRange(rawDraw.minSpeed,0,2_000),maxSpeed=readInclusiveRange(rawDraw.maxSpeed,0,2_000),direction=readRotation(rawDraw.direction),spread=readInclusiveRange(rawDraw.spread,0,360),gravity=readInclusiveRange(rawDraw.gravity,-5_000,5_000);
      if(seed===null||count===null||atMs===null||startMs===null||lifetimeMs===null||drawWidth===null||drawHeight===null||x===null||y===null||scale===null||originX===null||originY===null||rotationDeg===null||opacity===null||color===null||secondaryColor===null||minSize===null||maxSize===null||minSize>maxSize||minSpeed===null||maxSpeed===null||minSpeed>maxSpeed||direction===null||spread===null||gravity===null||typeof rawDraw.fadeOut!=="boolean"||!Array.isArray(rawDraw.sources)||computeParticles+count>MAX_COMPUTE_PARTICLES)return null;
      if(rawDraw.schema==="shellx-motion/gpu-compute-particle-field@1"){
        if(rawDraw.sources.length<1||rawDraw.sources.length>3)return null;const sources:Array<{kind:"radial"|"vortex";centerX:number;centerY:number;strength:number;softening:number}>=[];
        for(const rawSource of rawDraw.sources){if(!isRecord(rawSource))return null;const kind=readEnum(rawSource.kind,["radial","vortex"] as const),centerX=readUnit(rawSource.centerX),centerY=readUnit(rawSource.centerY),strength=readInclusiveRange(rawSource.strength,-1,1),softening=readInclusiveRange(rawSource.softening,0.01,1);if(kind===null||centerX===null||centerY===null||strength===null||softening===null)return null;sources.push({kind,centerX,centerY,strength,softening});}
        computeParticles+=count;computeParticleBufferBytes+=count*32*2;computeParticleComputeDispatches+=1;computeParticleRasterPasses+=1;draws.push({kind:"particleCompute",id,...composite,schema:"shellx-motion/gpu-compute-particle-field@1",seed,count,atMs,startMs,lifetimeMs,width:drawWidth,height:drawHeight,x,y,scale,originX,originY,rotationDeg,opacity,color,secondaryColor,minSize,maxSize,minSpeed,maxSpeed,direction,spread,gravity,fadeOut:rawDraw.fadeOut,sources});continue;
      }
      if(rawDraw.sources.length<1||rawDraw.sources.length>4||!Array.isArray(rawDraw.origins)||rawDraw.origins.length<1||rawDraw.origins.length>4)return null;
      const sources=rawDraw.sources.map(admitV2ParticleSource);if(sources.some((source)=>source===null))return null;
      const origins=rawDraw.origins.map(admitV2ParticleOrigin);if(origins.some((origin)=>origin===null))return null;
      const trail=admitV2ParticleTrail(rawDraw.trail),shading=admitV2ParticleShading(rawDraw.shading),retained=count*64*2,passes=trail?2:1;
      if(trail===undefined||shading===null||rawDraw.computeDispatchCount!==1||rawDraw.rasterPassCount!==passes||rawDraw.instanceBytes!==64||rawDraw.retainedBufferCount!==2||rawDraw.retainedInstanceBytes!==retained||retained>16*1024*1024)return null;
      computeParticles+=count;computeParticleBufferBytes+=retained;computeParticleComputeDispatches+=1;computeParticleRasterPasses+=passes;
      draws.push({kind:"particleCompute",id,...composite,schema:"shellx-motion/gpu-compute-particle-field@2",seed,count,atMs,startMs,lifetimeMs,width:drawWidth,height:drawHeight,x,y,scale,originX,originY,rotationDeg,opacity,color,secondaryColor,minSize,maxSize,minSpeed,maxSpeed,direction,spread,gravity,fadeOut:rawDraw.fadeOut,sources,origins,trail,shading,computeDispatchCount:1,rasterPassCount:passes,instanceBytes:64,retainedBufferCount:2,retainedInstanceBytes:retained} as unknown as InternalGpuFrameDraw);
      continue;
    }
    if (rawDraw.kind === "triangles" && Array.isArray(rawDraw.vertices) && rawDraw.vertices.length >= 3 && rawDraw.vertices.length % 3 === 0) {
      const rotationDeg = readRotation(rawDraw.rotationDeg);
      const pivotX = readCoordinate(rawDraw.pivotX);
      const pivotY = readCoordinate(rawDraw.pivotY);
      const color = readRgba(rawDraw.color);
      if (rotationDeg === null || pivotX === null || pivotY === null || color === null || triangleVertices + rawDraw.vertices.length > MAX_TRIANGLE_VERTICES) return null;
      const vertices: Array<{ x: number; y: number }> = [];
      for (const rawVertex of rawDraw.vertices) {
        if (!isRecord(rawVertex)) return null;
        const x = readCoordinate(rawVertex.x);
        const y = readCoordinate(rawVertex.y);
        if (x === null || y === null) return null;
        vertices.push({ x, y });
      }
      triangleVertices += vertices.length;
      draws.push({ kind: "triangles", id, ...composite, vertices, rotationDeg, pivotX, pivotY, color });
      continue;
    }
    if (rawDraw.kind === "coloredTriangles" && Array.isArray(rawDraw.vertices) && rawDraw.vertices.length >= 3 && rawDraw.vertices.length % 3 === 0) {
      const rotationDeg = readRotation(rawDraw.rotationDeg);
      const pivotX = readCoordinate(rawDraw.pivotX);
      const pivotY = readCoordinate(rawDraw.pivotY);
      if (rotationDeg === null || pivotX === null || pivotY === null || triangleVertices + rawDraw.vertices.length > MAX_TRIANGLE_VERTICES) return null;
      const vertices: Array<{ x: number; y: number; color: InternalGpuRgba }> = [];
      for (const rawVertex of rawDraw.vertices) {
        if (!isRecord(rawVertex)) return null;
        const x = readCoordinate(rawVertex.x);
        const y = readCoordinate(rawVertex.y);
        const color = readRgba(rawVertex.color);
        if (x === null || y === null || color === null) return null;
        vertices.push({ x, y, color });
      }
      triangleVertices += vertices.length;
      draws.push({ kind: "coloredTriangles", id, ...composite, vertices, rotationDeg, pivotX, pivotY });
      continue;
    }
    if (rawDraw.kind === "text") {
      if (++texts > MAX_TEXT_DRAWS) return null;
      const surfaceId = readId(rawDraw.surfaceId); const fontFamily = readPrintable(rawDraw.fontFamily, 128); const text = typeof rawDraw.text === "string" ? rawDraw.text : null;
      const x = readCoordinate(rawDraw.x); const y = readCoordinate(rawDraw.y); const drawWidth = readPositiveSize(rawDraw.width); const drawHeight = readPositiveSize(rawDraw.height); const rotationDeg = readRotation(rawDraw.rotationDeg); const pivotX = readCoordinate(rawDraw.pivotX); const pivotY = readCoordinate(rawDraw.pivotY); const opacity = readUnit(rawDraw.opacity); const color = readRgba(rawDraw.color);
      const fontSize = readPositiveSize(rawDraw.fontSize); const fontWeight = readInteger(rawDraw.fontWeight, 1, 1_000); const letterSpacing = readCoordinate(rawDraw.letterSpacing); const lineHeight = readFiniteRange(rawDraw.lineHeight, Number.MIN_VALUE, 10);
      const fontStyle = readEnum(rawDraw.fontStyle, ["normal", "italic", "oblique"] as const); const textAlign = readEnum(rawDraw.textAlign, ["left", "center", "right"] as const); const verticalAlign = readEnum(rawDraw.verticalAlign, ["top", "middle", "bottom"] as const); const direction = readEnum(rawDraw.direction, ["ltr", "rtl"] as const);
      const textShadow = admitGpuTextShadow(rawDraw.textShadow, readCoordinate, readRgba); const textFit = admitGpuTextFit(rawDraw.textFit, readCoordinate, readPositiveSize);
      if (surfaceId === null || fontFamily === null || text === null || !Array.isArray(rawDraw.fontResourceIds) || rawDraw.fontResourceIds.length < 1 || rawDraw.fontResourceIds.length > 32 || x === null || y === null || drawWidth === null || drawHeight === null || rotationDeg === null || pivotX === null || pivotY === null || opacity === null || color === null || fontSize === null || fontWeight === null || letterSpacing === null || lineHeight === null || fontStyle === null || textAlign === null || verticalAlign === null || direction === null || textShadow === undefined || textFit === undefined) return null;
      const fontResourceIds = rawDraw.fontResourceIds.map(readId); if (fontResourceIds.some((value) => value === null) || new Set(fontResourceIds).size !== fontResourceIds.length) return null;
      textUtf8Bytes += Buffer.byteLength(text, "utf8"); textSurfacePixels += Math.ceil(drawWidth) * Math.ceil(drawHeight);
      if (textUtf8Bytes > MAX_TEXT_UTF8_BYTES || textSurfacePixels > MAX_TEXT_SURFACE_PIXELS) return null;
      draws.push({ kind: "text", id, ...composite, surfaceId, fontResourceIds: fontResourceIds as string[], fontFamily, text, x, y, width: drawWidth, height: drawHeight, rotationDeg, pivotX, pivotY, opacity, color, fontSize, fontWeight, fontStyle, letterSpacing, lineHeight, textAlign, verticalAlign, direction, textShadow, textFit });
      continue;
    }
    if (rawDraw.kind === "gradientRect") {
      if (++rectangles > MAX_DRAW_BATCHES || ++gradientDraws > MAX_DRAW_BATCHES || !Array.isArray(rawDraw.stops) || rawDraw.stops.length < 2 || rawDraw.stops.length > 16 || gradientStops + rawDraw.stops.length > MAX_GRADIENT_STOPS) return null;
      const x = readCoordinate(rawDraw.x); const y = readCoordinate(rawDraw.y); const drawWidth = readPositiveSize(rawDraw.width); const drawHeight = readPositiveSize(rawDraw.height); const rotationDeg = readRotation(rawDraw.rotationDeg); const pivotX = readCoordinate(rawDraw.pivotX); const pivotY = readCoordinate(rawDraw.pivotY); const gradientType = readEnum(rawDraw.gradientType, ["linear", "radial"] as const); const angleDeg = readRotation(rawDraw.angleDeg); const centerX = readUnit(rawDraw.centerX); const centerY = readUnit(rawDraw.centerY);
      if (x === null || y === null || drawWidth === null || drawHeight === null || rotationDeg === null || pivotX === null || pivotY === null || gradientType === null || angleDeg === null || centerX === null || centerY === null) return null;
      let prior = -1; const stops: Array<{ offset: number; color: InternalGpuRgba }> = [];
      for (const rawStop of rawDraw.stops) { if (!isRecord(rawStop)) return null; const offset = readUnit(rawStop.offset); const color = readRgba(rawStop.color); if (offset === null || color === null || offset < prior) return null; prior = offset; stops.push({ offset, color }); }
      gradientStops += stops.length; draws.push({ kind: "gradientRect", id, ...composite, x, y, width: drawWidth, height: drawHeight, rotationDeg, pivotX, pivotY, gradientType, angleDeg, centerX, centerY, stops }); continue;
    }
    if (rawDraw.kind === "styledRect") {
      if (++rectangles > MAX_DRAW_BATCHES || ++styledRectangles > MAX_DRAW_BATCHES) return null;
      const x = readCoordinate(rawDraw.x); const y = readCoordinate(rawDraw.y); const drawWidth = readPositiveSize(rawDraw.width); const drawHeight = readPositiveSize(rawDraw.height); const rotationDeg = readRotation(rawDraw.rotationDeg); const pivotX = readCoordinate(rawDraw.pivotX); const pivotY = readCoordinate(rawDraw.pivotY); const radius = readFiniteRange(rawDraw.radius, -1, MAX_DIMENSION); const fill = readRgba(rawDraw.fill); const strokeWidth = readFiniteRange(rawDraw.strokeWidth, -1, MAX_DIMENSION); const stroke = readRgba(rawDraw.stroke); const shadow = readStyledRectangleShadow(rawDraw.shadow);
      if (x === null || y === null || drawWidth === null || drawHeight === null || rotationDeg === null || pivotX === null || pivotY === null || radius === null || fill === null || strokeWidth === null || stroke === null || shadow === undefined) return null;
      draws.push({ kind: "styledRect", id, ...composite, x, y, width: drawWidth, height: drawHeight, rotationDeg, pivotX, pivotY, radius, fill, strokeWidth, stroke, shadow }); continue;
    }
    if (rawDraw.kind !== "image" || ++images > MAX_IMAGES) return null;
    const resourceId = readId(rawDraw.resourceId);
    const x = readCoordinate(rawDraw.x); const y = readCoordinate(rawDraw.y);
    const drawWidth = readPositivePrimitiveExtent(rawDraw.width); const drawHeight = readPositivePrimitiveExtent(rawDraw.height);
    const rotationDeg = readRotation(rawDraw.rotationDeg); const pivotX = readCoordinate(rawDraw.pivotX); const pivotY = readCoordinate(rawDraw.pivotY);
    const u0 = readUnit(rawDraw.u0); const v0 = readUnit(rawDraw.v0); const u1 = readUnit(rawDraw.u1); const v1 = readUnit(rawDraw.v1); const opacity = readUnit(rawDraw.opacity); const chromaKey = rawDraw.chromaKey === undefined ? null : admitGpuChromaKey(rawDraw.chromaKey);
    if (resourceId === null || x === null || y === null || drawWidth === null || drawHeight === null || rotationDeg === null || pivotX === null || pivotY === null || u0 === null || v0 === null || u1 === null || v1 === null || opacity === null || (rawDraw.chromaKey !== undefined && chromaKey === undefined)) return null;
    if (chromaKey) {
      chromaKeys += 1;
      if (hasChromaMatteCleanup(chromaKey)) {
        if (++chromaMatteCleanups > 64) return null;
        chromaMatteCleanupPasses += chromaMatteCleanupPassCount(chromaKey);
        if (blendMode === "normal" && effects === null && mask === null) composites += 1;
      }
    }
    draws.push({ kind: "image", id, ...composite, resourceId, x, y, width: drawWidth, height: drawHeight, rotationDeg, pivotX, pivotY, u0, v0, u1, v1, opacity, ...(chromaKey ? { chromaKey } : {}) });
  }
  const temporal=admitGpuTemporalGrammar(draws);if(!temporal||temporal.groupCount!==temporalGroups||temporal.sampleCount!==temporalSamples||temporal.authoredEnvironmentCount>4)return null;
  // A temporal environment has one final composite after all of its shutter
  // samples accumulated; its individual samples are not composited separately.
  composites-=temporal.environmentDrawCount;
  const groups=admitGpuGroupGrammar(draws);if(!groups)return null;
  const budget = admitGpuFrameBudget(value.budget);
  const blurPasses = blurEffects * 2 + blurredGlowEffects * 2;
  const expectedBytes = rectangles * RECTANGLE_BYTES + points * POINT_BYTES + computeParticleFields * COMPUTE_PARTICLE_PLAN_BYTES + triangleVertices * TRIANGLE_VERTEX_BYTES + images * IMAGE_VERTEX_BYTES + chromaKeys * CHROMA_KEY_PLAN_BYTES + chromaMatteCleanups * CHROMA_MATTE_CLEANUP_PLAN_BYTES + texts * TEXT_VERTEX_BYTES + textUtf8Bytes + gradientStops * GRADIENT_STOP_BYTES + scene3d.vertices*SCENE_3D_VERTEX_BYTES+scene3d.indices*SCENE_3D_INDEX_BYTES+scene3d.objects*SCENE_3D_OBJECT_UNIFORM_BYTES+scene3d.scenes*SCENE_3D_PLAN_BYTES+environments*ENVIRONMENT_PLAN_BYTES+materials*MATERIAL_PLAN_BYTES+effectModules*EFFECT_MODULE_PLAN_BYTES + styledRectangles * STYLED_RECTANGLE_PLAN_BYTES + composites * COMPOSITE_PLAN_BYTES + blurEffects * BLUR_PLAN_BYTES + glowEffects * GLOW_PLAN_BYTES + masks * MASK_PLAN_BYTES + adjustments * ADJUSTMENT_PLAN_BYTES + temporalGroups * MOTION_BLUR_GROUP_PLAN_BYTES + groups.count*GROUP_PLAN_BYTES;
  const expectedCleanupTextureBytes = chromaMatteCleanups > 0 ? width * height * 4 * 3 : 0;
  const baseTextures=groups.count>0?4:blurEffects>0||glowEffects>0||masks>0?3:composites>0?2:adjustments>0?1:0;const expectedIntermediateBytes=width*height*4*(baseTextures+groups.maxDepth*4)+expectedCleanupTextureBytes;
  const v2Budget = budget as (InternalGpuFramePlan["budget"] & { computeParticleComputeDispatchCount?: number; computeParticleRasterPassCount?: number }) | null;
  if (v2Budget === null || v2Budget.rectangleCount !== rectangles || v2Budget.pointCount !== points || v2Budget.computeParticleFieldCount!==computeParticleFields||v2Budget.computeParticleCount!==computeParticles||v2Budget.computeParticleBufferBytes!==computeParticleBufferBytes||v2Budget.computeParticleComputeDispatchCount!==computeParticleComputeDispatches||v2Budget.computeParticleRasterPassCount!==computeParticleRasterPasses||v2Budget.triangleVertexCount !== triangleVertices || v2Budget.imageCount !== images || v2Budget.chromaKeyCount !== chromaKeys || v2Budget.chromaMatteCleanupCount !== chromaMatteCleanups || v2Budget.chromaMatteCleanupPassCount !== chromaMatteCleanupPasses || v2Budget.textCount !== texts || v2Budget.textUtf8Bytes !== textUtf8Bytes || v2Budget.textSurfacePixels !== textSurfacePixels || v2Budget.scene3dCount!==scene3d.scenes||v2Budget.scene3dObjectCount!==scene3d.objects||v2Budget.scene3dVertexCount!==scene3d.vertices||v2Budget.scene3dIndexCount!==scene3d.indices||v2Budget.environmentCount!==environments||v2Budget.materialCount!==materials || v2Budget.gradientStopCount !== gradientStops || v2Budget.pointBufferBytes !== points * POINT_BYTES || v2Budget.triangleBufferBytes !== triangleVertices * TRIANGLE_VERTEX_BYTES || v2Budget.imageVertexBufferBytes !== images * IMAGE_VERTEX_BYTES || v2Budget.chromaKeyUniformBytes !== chromaKeys * CHROMA_KEY_UNIFORM_BYTES || v2Budget.chromaMatteCleanupUniformBytes !== chromaMatteCleanupPasses * CHROMA_MATTE_CLEANUP_UNIFORM_BYTES || v2Budget.textVertexBufferBytes !== texts * IMAGE_VERTEX_BYTES || v2Budget.scene3dVertexBufferBytes!==scene3d.vertices*SCENE_3D_VERTEX_BYTES||v2Budget.scene3dIndexBufferBytes!==scene3d.indices*SCENE_3D_INDEX_BYTES||v2Budget.scene3dUniformBytes!==scene3d.objects*SCENE_3D_OBJECT_UNIFORM_BYTES||v2Budget.environmentUniformBytes!==environments*ENVIRONMENT_UNIFORM_BYTES||v2Budget.materialUniformBytes!==materials*MATERIAL_UNIFORM_BYTES || v2Budget.gradientUniformBytes !== gradientDraws * GRADIENT_UNIFORM_BYTES || v2Budget.styledRectangleUniformBytes !== styledRectangles * STYLED_RECTANGLE_UNIFORM_BYTES || v2Budget.blendModeCount !== blendModes || v2Budget.colorEffectCount !== colorEffects || v2Budget.blurEffectCount !== blurEffects || v2Budget.glowEffectCount !== glowEffects || v2Budget.maskCount !== masks || v2Budget.blurPassCount !== blurPasses || v2Budget.adjustmentCount !== adjustments || (effectModules === 0 ? v2Budget.effectModuleCount !== undefined || v2Budget.effectModuleUniformBytes !== undefined || v2Budget.effectModuleTextureLoadCount !== undefined || v2Budget.effectModulePassCount !== undefined : v2Budget.effectModuleCount !== effectModules || v2Budget.effectModuleUniformBytes !== effectModules * 160 || v2Budget.effectModuleTextureLoadCount !== effectModuleTextureLoads || v2Budget.effectModulePassCount !== effectModules) || v2Budget.motionBlurGroupCount !== temporalGroups || v2Budget.motionBlurSampleCount !== temporalSamples || v2Budget.groupCount!==groups.count || v2Budget.groupMaxDepth!==groups.maxDepth || v2Budget.compositeCount !== composites || v2Budget.compositeUniformBytes !== composites * COMPOSITE_UNIFORM_BYTES || v2Budget.blurUniformBytes !== blurPasses * BLUR_UNIFORM_BYTES || v2Budget.glowUniformBytes !== glowEffects * GLOW_UNIFORM_BYTES || v2Budget.maskUniformBytes !== masks * MASK_UNIFORM_BYTES || v2Budget.adjustmentUniformBytes !== adjustments * ADJUSTMENT_UNIFORM_BYTES || v2Budget.chromaMatteCleanupIntermediateTextureBytes !== expectedCleanupTextureBytes || v2Budget.compositeIntermediateTextureBytes !== expectedIntermediateBytes || v2Budget.estimatedPlanBytes !== expectedBytes || expectedBytes > 4 * 1024 * 1024) return null;
  const normalized = { schema: "shellx-motion/gpu-frame-intent@1" as const, width, height, clear, draws };
  const fingerprint = createHash("sha256").update(canonicalJson(normalized)).digest("hex");
  if (value.fingerprint !== fingerprint) return null;
  return { ...normalized, fingerprint, budget: v2Budget };
}
function hasChromaMatteCleanup(key: NonNullable<ReturnType<typeof admitGpuChromaKey>>): boolean { const matte = key.matte; return matte.denoiseRadiusPx !== 0 || matte.growShrinkPx !== 0 || matte.chokePx !== 0 || matte.featherPx !== 0 || matte.blackClip !== 0 || matte.whiteClip !== 1; }
function chromaMatteCleanupPassCount(key: NonNullable<ReturnType<typeof admitGpuChromaKey>>): number { const matte = key.matte; return Number(matte.denoiseRadiusPx > 0) * 2 + Number(matte.growShrinkPx !== 0) * 2 + Number(matte.chokePx > 0) * 2 + Number(matte.featherPx > 0) * 2 + 1; }
function readLayerEffects(value: unknown): InternalGpuLayerEffects | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || Object.keys(value).some((key) => !["blur", "brightness", "contrast", "saturate", "grayscale", "glow"].includes(key))) return undefined;
  const blur = readEffectNumber(value.blur, 128);
  const brightness = readEffectNumber(value.brightness, 4); const contrast = readEffectNumber(value.contrast, 4); const saturate = readEffectNumber(value.saturate, 4); const grayscale = readEffectNumber(value.grayscale, 1);
  const glow = readGlowEffect(value.glow);
  if (blur === null || brightness === null || contrast === null || saturate === null || grayscale === null || glow === undefined || (blur === 0 && brightness === 1 && contrast === 1 && saturate === 1 && grayscale === 0 && glow === null)) return undefined;
  return { blur, brightness, contrast, saturate, grayscale, glow };
}
function readGlowEffect(value: unknown): InternalGpuLayerEffects["glow"] | undefined { if (value === null) return null; if (!isRecord(value) || Object.keys(value).some((key) => key !== "radius" && key !== "color")) return undefined; const radius=readEffectNumber(value.radius,128),color=readRgba(value.color);return radius===null||color===null?undefined:{radius,color}; }
function readEffectNumber(value: unknown, maximum: number): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null; }
function readAdjustmentVignette(value: unknown): Extract<InternalGpuFrameDraw,{kind:"adjustment"}>["vignette"] | undefined { if(value===null)return null;if(!isRecord(value))return undefined;const amount=readUnit(value.amount),softness=readUnit(value.softness),color=readRgba(value.color);return amount===null||softness===null||color===null?undefined:{amount,softness,color}; }
function readAdjustmentFilmGrain(value: unknown): Extract<InternalGpuFrameDraw,{kind:"adjustment"}>["filmGrain"] | undefined { if(value===null)return null;if(!isRecord(value))return undefined;const amount=readUnit(value.amount),size=readInteger(value.size,1,8),frameSeed=readSeed(value.frameSeed);return amount===null||size===null||frameSeed===null?undefined:{amount,size,frameSeed}; }
function readStyledRectangleShadow(value: unknown): Extract<InternalGpuFrameDraw, { kind: "styledRect" }>["shadow"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const offsetX = readCoordinate(value.offsetX); const offsetY = readCoordinate(value.offsetY); const blur = readFiniteRange(value.blur, -1, 512); const spread = readCoordinate(value.spread); const color = readRgba(value.color);
  return offsetX === null || offsetY === null || blur === null || spread === null || color === null ? undefined : { offsetX, offsetY, blur, spread, color };
}
function admitV2ParticleSource(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (value.kind === "radial" || value.kind === "vortex") { if(!hasOnlyKeys(value,["kind","centerX","centerY","strength","softening"]))return null;const centerX=readUnit(value.centerX),centerY=readUnit(value.centerY),strength=readInclusiveRange(value.strength,-1,1),softening=readInclusiveRange(value.softening,0.01,1); return centerX===null||centerY===null||strength===null||softening===null?null:{kind:value.kind,centerX,centerY,strength,softening}; }
  if (value.kind === "flow") { if(!hasOnlyKeys(value,["kind","angleDeg","strength"]))return null;const angleDeg=readInclusiveRange(value.angleDeg,-360,360),strength=readInclusiveRange(value.strength,-1,1); return angleDeg===null||strength===null?null:{kind:"flow",angleDeg,strength}; }
  if (value.kind === "turbulence") { if(!hasOnlyKeys(value,["kind","scale","strength"]))return null;const scale=readInclusiveRange(value.scale,0.01,4),strength=readInclusiveRange(value.strength,-1,1); return scale===null||strength===null?null:{kind:"turbulence",scale,strength}; }
  if (value.kind === "impact") { if(!hasOnlyKeys(value,["kind","centerX","centerY","radius","strength","startProgress","durationProgress"]))return null;const centerX=readUnit(value.centerX),centerY=readUnit(value.centerY),radius=readInclusiveRange(value.radius,0.01,1),strength=readInclusiveRange(value.strength,-1,1),startProgress=readUnit(value.startProgress),durationProgress=readInclusiveRange(value.durationProgress,0.01,1); return centerX===null||centerY===null||radius===null||strength===null||startProgress===null||durationProgress===null||startProgress+durationProgress>1?null:{kind:"impact",centerX,centerY,radius,strength,startProgress,durationProgress}; }
  if (value.kind === "collision") { if(!hasOnlyKeys(value,["kind","axis","position","restitution"]))return null;const axis=readEnum(value.axis,["x","y"] as const),position=readUnit(value.position),restitution=readUnit(value.restitution); return axis===null||position===null||restitution===null?null:{kind:"collision",axis,position,restitution}; }
  return null;
}
function admitV2ParticleOrigin(value: unknown): Record<string, number> | null { if(!isRecord(value)||!hasOnlyKeys(value,["x","y","weight","directionOffsetDeg","speedScale"]))return null;const x=readUnit(value.x),y=readUnit(value.y),weight=readInclusiveRange(value.weight,0.01,1),directionOffsetDeg=readRotation(value.directionOffsetDeg),speedScale=readInclusiveRange(value.speedScale,0.25,4);return x===null||y===null||weight===null||directionOffsetDeg===null||speedScale===null?null:{x,y,weight,directionOffsetDeg,speedScale}; }
function admitV2ParticleTrail(value: unknown): Record<string, number> | null | undefined { if(value===null)return null;if(!isRecord(value)||!hasOnlyKeys(value,["durationMs","samples","opacity"]))return undefined;const durationMs=readInclusiveRange(value.durationMs,1,1_000),samples=readInteger(value.samples,2,4),opacity=readInclusiveRange(value.opacity,0.05,1);return durationMs===null||samples===null||opacity===null?undefined:{durationMs,samples,opacity}; }
function admitV2ParticleShading(value: unknown): Record<string, number|string> | null { if(!isRecord(value)||!hasOnlyKeys(value,["mode","sizeJitter","opacityJitter","glow"]))return null;const mode=readEnum(value.mode,["flat","soft","glow"] as const),sizeJitter=readUnit(value.sizeJitter),opacityJitter=readUnit(value.opacityJitter),glow=readUnit(value.glow);return mode===null||sizeJitter===null||opacityJitter===null||glow===null?null:{mode,sizeJitter,opacityJitter,glow}; }
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
