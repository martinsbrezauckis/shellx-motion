import { GPU_FRAME_INTENT_SCHEMA, GPU_MAX_POINTS, compileGpuFramePlan, type GpuDrawIntent, type GpuFramePlan, type GpuPrimitiveIntent, type GpuRgba } from "./gpu-frame-intent";
import { compileGpuSceneAdjustment } from "./gpu-scene-adjustment";
import { compileGpuSceneText, type GpuScene2dFontResources } from "./gpu-scene-text";
import { parseGpuSceneColor as parseColor } from "./gpu-scene-color";
import { compileGpuSceneGradient } from "./gpu-scene-gradient";
import { gpuSceneEffects } from "./gpu-scene-effects";
import { compileGpuSceneEllipseStroke } from "./gpu-scene-ellipse";
import { compileGpuSceneLayerMask } from "./gpu-scene-mask";
import { compileGpuSceneMotionBlur } from "./gpu-scene-motion-blur";
import { expandGpuSceneGroups } from "./gpu-scene-group";
import { compileGpuSceneBrowserSurface, compileGpuSceneHybridTexture, compileGpuSceneImage, compileGpuSceneVideo } from "./gpu-scene-media";
import { compileGpuScene3d } from "./gpu-scene-3d"; import { compileGpuSceneEnvironment } from "./gpu-scene-environment"; import { compileGpuSceneMaterial } from "./gpu-scene-material";
import { canonicalGpuScenePrimitiveShape, isGpuSceneTriangleShape, shapeTriangleVertices } from "./gpu-scene-shape-geometry";
import { compileGpuSceneAuthoredShape, compileGpuScenePathShape, hasGpuScenePathGeometry, isGpuScenePathShape } from "./gpu-scene-path-lowering";
import { compileGpuSceneParticles, compileGpuScenePoints } from "./gpu-scene-points";
import { compileGpuSceneTrailComposite } from "./gpu-scene-trail-composite";
import { gpuSceneUnsupportedFeature, isGpuBrowserSurfaceLayer } from "./gpu-scene-2d-admission";
import { compileGpuStyledRectangle } from "./gpu-scene-styled-rectangle";
import { MAX_ENVIRONMENT_LAYERS } from "./environment";
import { effectiveLayerAtMs } from "./timeline";
import { gpuVideoTimelineAtUs, type GpuVideoFrameRequest } from "./gpu-video-frame-request";
import { gpuHybridTextureFrameResourcesProblem, type GpuHybridTextureRequest, type GpuHybridTextureResourceBinding } from "./gpu-hybrid-texture-request";
import { resolveGpuEffectModuleFrameBindings, type GpuEffectModuleBinding, type GpuEffectModuleStaticDescriptor } from "./effect-module"; import { compileGpuSceneEffectModule } from "./gpu-scene-effect-module";
import { motionBehaviorLaneRefusal } from "./motion-behavior-lane-refusal";
import { motionRelationLaneRefusal } from "./motion-relation-lane-refusal";
import { motionScene3DAnimationLaneRefusal } from "./motion-scene3d-animation-lane-refusal";
import { gpuUnloweredRootAuthorityRefusal } from "./gpu-root-authority-fence";
import { motionLayoutGapAnimationLaneRefusal } from "./motion-layout-gap-animation-lane-refusal";
import type { MotionDocument, MotionLayer } from "./types";
export { gpuSceneUnsupportedFeature, isGpuBrowserSurfaceLayer } from "./gpu-scene-2d-admission";
export const GPU_SCENE_2D_PLAN_SCHEMA = "shellx-motion/gpu-scene-2d-plan@1" as const;
export type GpuScene2dFailureCode =
  | "gpu_invalid_time"
  | "gpu_unsupported_layer"
  | "gpu_unsupported_effect"
  | "gpu_unsupported_feature"
  | "gpu_unsupported_color"
  | "gpu_resource_refused";
export interface GpuScene2dFailure { code: GpuScene2dFailureCode; message: string; layerId?: string }
export interface GpuScene2dPlan {
  schema: typeof GPU_SCENE_2D_PLAN_SCHEMA;
  atMs: number;
  frame: GpuFramePlan;
  visualLayerCount: number;
  shapeCount: number;
  pointCount: number;
  particleCount: number;
  imageCount: number;
  /** Browser-produced textures are deliberately counted separately from native image assets. */
  browserSurfaceCount: number;
  videoCount: number;
  scene3dCount: number; scene3dObjectCount: number; environmentCount: number; materialCount: number;
  cameraCount: number;
  depthPlaneCount: number;
  textCount: number;
  adjustmentCount: number; effectModuleCount?: number;
  maskCount: number;
  matteCount: number;
  motionBlurLayerCount: number;
  motionBlurSampleCount: number;
  groupCount: number;
  groupMaxDepth: number;
}
export interface GpuScene2dImageResource { resourceId: string; assetRef: string; width: number; height: number; sha256: string }
/**
 * Legacy streaming/final providers carry `sourceAtMs`; V25-B1 preview adds the optional exact
 * binding fields. They become mandatory only when the caller supplies `videoRequests`.
 */
export interface GpuScene2dVideoResource extends GpuScene2dImageResource {
  layerId: string;
  sourceAtMs: number;
  sourceAtUs?: number;
  sourceSnapshotSha256?: string;
  decodedRgbaSha256?: string;
  decodeContractSha256?: string;
  requestFingerprint?: string;
}
export interface GpuScene2dCompileResources { images?: ReadonlyMap<string, GpuScene2dImageResource>; videos?: ReadonlyMap<string, GpuScene2dVideoResource>; /** Exact-time Core requests keyed by video layer id. */ videoRequests?: ReadonlyMap<string, GpuVideoFrameRequest>; browserSurfaces?: ReadonlyMap<string, GpuScene2dImageResource>; /** Strict B2 requests keyed by active governed hybrid layer id. */ hybridTextureRequests?: ReadonlyMap<string, GpuHybridTextureRequest>; /** Strict B2 decoded-RGBA bindings keyed by active governed hybrid layer id. */ hybridTextures?: ReadonlyMap<string, GpuHybridTextureResourceBinding>; /** Static-plan descriptors and host-resolved immutable C1 bindings keyed by module adjustment layer id. */ effectModuleDescriptors?: ReadonlyMap<string, GpuEffectModuleStaticDescriptor>; effectModuleBindings?: ReadonlyMap<string, GpuEffectModuleBinding>; fonts?: GpuScene2dFontResources }
export type GpuScene2dPlanResult = { ok: true; plan: GpuScene2dPlan } | { ok: false; failure: GpuScene2dFailure };

/** Lowers the bounded GPU scene in canonical layer order. */
export function compileGpuScene2dPlan(motion: MotionDocument, atMs: number, resources: GpuScene2dCompileResources = {}): GpuScene2dPlanResult {
  const rootAuthorityRefusal = gpuUnloweredRootAuthorityRefusal(motion, "frame");
  if (rootAuthorityRefusal) return fail("gpu_unsupported_feature", rootAuthorityRefusal);
  const layoutGapAnimationRefusal = motionLayoutGapAnimationLaneRefusal(motion, "gpu-frame");
  if (layoutGapAnimationRefusal) return fail("gpu_unsupported_feature", layoutGapAnimationRefusal.message);
  const scene3dAnimationRefusal = motionScene3DAnimationLaneRefusal(motion, "gpu-frame");
  if (scene3dAnimationRefusal) return fail("gpu_unsupported_feature", scene3dAnimationRefusal.message);
  const relationRefusal = motionRelationLaneRefusal(motion, "gpu-frame");
  if (relationRefusal) return fail("gpu_unsupported_feature", relationRefusal.message);
  const behaviorRefusal = motionBehaviorLaneRefusal(motion, "gpu-frame");
  if (behaviorRefusal) return fail("gpu_unsupported_feature", behaviorRefusal.message);
  if (!Number.isFinite(atMs) || atMs < 0 || atMs > motion.durationMs) {
    return fail("gpu_invalid_time", `GPU scene atMs must be within 0..${motion.durationMs}.`);
  }
  const atUs = gpuVideoTimelineAtUs(atMs);
  if (atUs === null) return fail("gpu_invalid_time", "GPU scene atMs cannot be represented as integer microseconds.");
  if (resources.hybridTextureRequests !== undefined || resources.hybridTextures !== undefined) {
    const problem = gpuHybridTextureFrameResourcesProblem({ motion, atUs, requests: resources.hybridTextureRequests, textures: resources.hybridTextures });
    if (problem) return fail("gpu_resource_refused", problem);
  }
  const effectModule = resolveGpuEffectModuleFrameBindings(motion, atUs, resources.effectModuleDescriptors, resources.effectModuleBindings); if (!effectModule.ok) return fail("gpu_resource_refused", effectModule.message, effectModule.layerId);
  const clear = parseColor(motion.background ?? "transparent");
  if (!clear) return fail("gpu_unsupported_color", "GPU scenes accept only transparent or hexadecimal document backgrounds.");
  const draws: GpuDrawIntent[] = [];
  let visualLayerCount = 0, shapeCount = 0, pointCount = 0, particleCount = 0;
  let imageCount = 0, browserSurfaceCount = 0, videoCount = 0, scene3dCount = 0, scene3dObjectCount = 0, environmentCount = 0, materialCount = 0;
  const cameraCount = motion.layers.some((layer) => layer.type === "camera" && layer.visible !== false && atMs >= layer.startMs && atMs < layer.startMs + layer.durationMs) ? 1 : 0;
  let depthPlaneCount = 0, textCount = 0, adjustmentCount = 0, effectModuleCount = 0, maskCount = 0, matteCount = 0;
  let motionBlurLayerCount = 0, motionBlurSampleCount = 0, groupCount = 0, groupMaxDepth = 0;
  const matteSourceIds = new Set(motion.layers.map((layer) => layer.matte?.sourceLayerId).filter((id): id is string => typeof id === "string"));
  const expanded=expandGpuSceneGroups(motion,atMs);if(!expanded.ok)return expanded;
  const groupStack:Array<{drawIndex:number;id:string}>=[];
  for (const entry of expanded.entries) {
    if(entry.kind==="groupStart"){const drawIndex=draws.length;draws.push({...entry.marker,drawCount:0});groupStack.push({drawIndex,id:entry.marker.id});if(entry.marker.id.startsWith("camera-plane-"))depthPlaneCount+=1;else{groupCount+=1;visualLayerCount+=1;if(entry.marker.mask)maskCount+=1;}groupMaxDepth=Math.max(groupMaxDepth,groupStack.length);continue;}
    if(entry.kind==="groupEnd"){const open=groupStack.pop();if(!open||open.id!==entry.groupId)return fail("gpu_resource_refused",`GPU group ${entry.groupId} expansion lost its exact opener.`);const start=draws[open.drawIndex];if(start.kind!=="groupStart")return fail("gpu_resource_refused",`GPU group ${entry.groupId} opener changed kind.`);start.drawCount=draws.length-open.drawIndex-1;draws.push({kind:"groupEnd",id:`${entry.groupId}.end`,groupId:entry.groupId});continue;}
    const {sourceLayer}=entry;const layerAtMs=entry.atMs;
    if (matteSourceIds.has(sourceLayer.id)) continue;
    if (sourceLayer.visible === false || !layerIsActive(sourceLayer, layerAtMs) || sourceLayer.type === "audio") continue;
    const unsupported = gpuSceneUnsupportedFeature(sourceLayer);
    if (unsupported) return unsupported;
    const layer = effectiveLayerAtMs(sourceLayer, layerAtMs);
    visualLayerCount += 1;
    if (layer.type === "adjustment") {
      if (layer.effectModule) { if (!effectModule.active || effectModule.active.layerId !== layer.id) return fail("gpu_resource_refused", `GPU effect module ${layer.id} lost its exact active binding.`, layer.id); draws.push(compileGpuSceneEffectModule(effectModule.active)); adjustmentCount += 1; effectModuleCount += 1; continue; }
      const adjustment = compileGpuSceneAdjustment(layer, motion, layerAtMs);
      if (!adjustment.ok) return fail("gpu_unsupported_effect", adjustment.message, layer.id);
      draws.push(adjustment.draw); adjustmentCount += 1;
      continue;
    }
    if (layer.type === "shape") {
      const shape = compileShape(layer);
      if (!shape.ok) return shape;
      // `end <= start` on a GPU path reveal is an explicit empty window. It
      // contributes no primitive, mask pass, or fabricated transparent draw.
      if (shape.draw === null) { shapeCount += 1; continue; }
      const masked = compileGpuSceneLayerMask(motion, layer, shape.draw, layerAtMs); if (!masked.ok) return masked;
      const temporal = compileGpuSceneMotionBlur(sourceLayer, [masked.draw], layerAtMs, motion.fps, (sample) => { const value=compileShape(sample);return value.ok?{ok:true,draws:value.draw?[value.draw]:[]}:value; }); if (!temporal.ok) return temporal;
      draws.push(...temporal.draws); if (temporal.sampleCount) { motionBlurLayerCount += 1; motionBlurSampleCount += temporal.sampleCount; } if (masked.maskKind === "mask") maskCount += 1; if (masked.maskKind === "matte") matteCount += 1;
      shapeCount += 1;
      continue;
    }
    if (layer.type === "particles") {
      const particles = compileGpuSceneParticles(layer, layerAtMs, motion);
      if (!particles.ok) return particles;
      particleCount += particles.particleCount;
      pointCount += particles.pointCount;
      if (pointCount > GPU_MAX_POINTS) return fail("gpu_resource_refused", `GPU scene exceeds its ${GPU_MAX_POINTS}-point total admission limit.`, layer.id);
      const v2Draw = particles.draws.length === 1 && particles.draws[0].kind === "particleCompute" && particles.draws[0].schema === "shellx-motion/gpu-compute-particle-field@2";
      let particleDraws = particles.draws;
      let particleMaskKind: "mask" | "matte" | null = null;
      if (v2Draw) {
        const masked = compileGpuSceneLayerMask(motion, layer, particles.draws[0], layerAtMs);
        if (!masked.ok) return masked;
        particleDraws = [masked.draw];
        particleMaskKind = masked.maskKind;
      }
      const temporal = compileGpuSceneTrailComposite({ sourceLayer, layer, draws: particleDraws, atMs: layerAtMs, fps: motion.fps, compileSample: (sample, sampleAtMs) => { const value=compileGpuSceneParticles(sample,sampleAtMs,motion);return value.ok?{ok:true,draws:value.draws}:value; } }); if (!temporal.ok) return temporal;
      draws.push(...temporal.draws); if (temporal.sampleCount) { motionBlurLayerCount += 1; motionBlurSampleCount += temporal.sampleCount; }
      if (particleMaskKind === "mask") maskCount += 1; if (particleMaskKind === "matte") matteCount += 1;
      continue;
    }
    if (layer.type === "image") {
      const image = compileGpuSceneImage(layer, motion, resources.images);
      if (!image.ok) return image;
      const masked = compileGpuSceneLayerMask(motion, layer, image.draw, layerAtMs); if (!masked.ok) return masked;
      const temporal = compileGpuSceneMotionBlur(sourceLayer, [masked.draw], layerAtMs, motion.fps, (sample) => { const value=compileGpuSceneImage(sample,motion,resources.images);return value.ok?{ok:true,draws:[value.draw]}:value; }); if (!temporal.ok) return temporal;
      draws.push(...temporal.draws); if (temporal.sampleCount) { motionBlurLayerCount += 1; motionBlurSampleCount += temporal.sampleCount; } if (masked.maskKind === "mask") maskCount += 1; if (masked.maskKind === "matte") matteCount += 1; imageCount += 1;
      continue;
    }
    if (layer.type === "video") {
      if (sourceLayer.effects?.motionBlur) return fail("gpu_unsupported_feature", `GPU video layer ${layer.id} does not support temporal motion blur until its decoder can supply every shutter sample.`, layer.id);
      const video = compileGpuSceneVideo(layer, motion, atUs, resources.videos, resources.videoRequests);
      if (!video.ok) return video;
      const masked = compileGpuSceneLayerMask(motion, layer, video.draw, layerAtMs); if (!masked.ok) return masked;
      draws.push(masked.draw); if (masked.maskKind === "mask") maskCount += 1; if (masked.maskKind === "matte") matteCount += 1; videoCount += 1;
      continue;
    }
    if (isGpuBrowserSurfaceLayer(layer.type)) {
      // A browser capture is one exact canonical timestamp, not a shutter-time
      // sequence. Refuse temporal blur rather than sampling browser state at
      // unproven intermediate times.
      if (sourceLayer.effects?.motionBlur) return fail("gpu_unsupported_feature", `GPU browser surface ${layer.id} does not support temporal motion blur.`, layer.id);
      const browserSurface = resources.hybridTextureRequests
        ? compileGpuSceneHybridTexture(layer, motion, atUs, resources.hybridTextures, resources.hybridTextureRequests)
        : compileGpuSceneBrowserSurface(layer, resources.browserSurfaces);
      if (!browserSurface.ok) return browserSurface;
      const masked = compileGpuSceneLayerMask(motion, layer, browserSurface.draw, layerAtMs); if (!masked.ok) return masked;
      draws.push(masked.draw); browserSurfaceCount += 1;
      if (masked.maskKind === "mask") maskCount += 1; if (masked.maskKind === "matte") matteCount += 1;
      continue;
    }
    if (layer.type === "scene3d") {
      if (sourceLayer.effects?.motionBlur) return fail("gpu_unsupported_feature", `GPU scene3d layer ${layer.id} does not yet support temporal supersampling.`, layer.id);
      const scene = compileGpuScene3d(layer, layerAtMs, motion.width, motion.height);
      if (!scene.ok) return fail("gpu_unsupported_feature", scene.message, layer.id);
      const masked = compileGpuSceneLayerMask(motion, layer, scene.draw, layerAtMs); if (!masked.ok) return masked;
      draws.push(masked.draw); scene3dCount += 1; scene3dObjectCount += scene.draw.objects.length;
      if (masked.maskKind === "mask") maskCount += 1; if (masked.maskKind === "matte") matteCount += 1;
      continue;
    }
    if (layer.type === "environment") {
      if (environmentCount >= MAX_ENVIRONMENT_LAYERS) return fail("gpu_resource_refused", `GPU scenes support at most ${MAX_ENVIRONMENT_LAYERS} active environment layers.`, layer.id);
      const environment=compileGpuSceneEnvironment(layer,motion,layerAtMs,resources.images);if(!environment.ok)return environment;const masked=compileGpuSceneLayerMask(motion,layer,environment.draw,layerAtMs);if(!masked.ok)return masked;
      const temporal=compileGpuSceneMotionBlur(sourceLayer,[masked.draw],layerAtMs,motion.fps,(sample,sampleAtMs)=>{const value=compileGpuSceneEnvironment(sample,motion,sampleAtMs,resources.images);return value.ok?{ok:true,draws:[value.draw]}:value;});if(!temporal.ok)return temporal;
      draws.push(...temporal.draws);environmentCount+=1;if(temporal.sampleCount){motionBlurLayerCount+=1;motionBlurSampleCount+=temporal.sampleCount;}if(masked.maskKind==="mask")maskCount+=1;if(masked.maskKind==="matte")matteCount+=1;continue;
    }
    if(layer.type==="shader"){
      if(sourceLayer.effects?.motionBlur){const kind=layer.shader?.gpuMaterial?"material":"shader";return fail("gpu_unsupported_feature",`GPU ${kind} layer ${layer.id} does not yet support temporal supersampling.`,layer.id);}
      if(layer.shader?.gpuMaterial){const material=compileGpuSceneMaterial(layer,motion,layerAtMs);if(!material.ok)return material;const masked=compileGpuSceneLayerMask(motion,layer,material.draw,layerAtMs);if(!masked.ok)return masked;draws.push(masked.draw);materialCount+=1;if(masked.maskKind==="mask")maskCount+=1;if(masked.maskKind==="matte")matteCount+=1;continue;}
      const restricted=resources.hybridTextureRequests?compileGpuSceneHybridTexture(layer,motion,atUs,resources.hybridTextures,resources.hybridTextureRequests):compileGpuSceneBrowserSurface(layer,resources.browserSurfaces);if(!restricted.ok)return restricted;const masked=compileGpuSceneLayerMask(motion,layer,restricted.draw,layerAtMs);if(!masked.ok)return masked;draws.push(masked.draw);browserSurfaceCount+=1;if(masked.maskKind==="mask")maskCount+=1;if(masked.maskKind==="matte")matteCount+=1;continue;
    }
    if (layer.type === "text" || layer.type === "caption") {
      const text = compileGpuSceneText(motion, layer, resources.fonts);
      if (!text.ok) return text;
      const masked = compileGpuSceneLayerMask(motion, layer, text.draw, layerAtMs); if (!masked.ok) return masked;
      const temporal = compileGpuSceneMotionBlur(sourceLayer, [masked.draw], layerAtMs, motion.fps, (sample) => { const value=compileGpuSceneText(motion,sample,resources.fonts);return value.ok?{ok:true,draws:[value.draw]}:value; }); if (!temporal.ok) return temporal;
      draws.push(...temporal.draws); if (temporal.sampleCount) { motionBlurLayerCount += 1; motionBlurSampleCount += temporal.sampleCount; } if (masked.maskKind === "mask") maskCount += 1; if (masked.maskKind === "matte") matteCount += 1; textCount += 1;
      continue;
    }
    const points = compileGpuScenePoints(layer, sourceLayer, sourceLayer.pointCloud!, motion, layerAtMs);
    if (!points.ok) return points;
    pointCount += points.pointCount;
    if (pointCount > GPU_MAX_POINTS) return fail("gpu_resource_refused", `GPU scene exceeds its ${GPU_MAX_POINTS}-point total admission limit.`, layer.id);
    const temporal = compileGpuSceneTrailComposite({ sourceLayer, layer, draws: points.draws, atMs: layerAtMs, fps: motion.fps, compileSample: (sample, sampleAtMs) => { const value=compileGpuScenePoints(sample,sourceLayer,sourceLayer.pointCloud!,motion,sampleAtMs);return value.ok?{ok:true,draws:value.draws}:value; } }); if (!temporal.ok) return temporal;
    draws.push(...temporal.draws); if (temporal.sampleCount) { motionBlurLayerCount += 1; motionBlurSampleCount += temporal.sampleCount; }
  }
  try {
    const frame = compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: motion.width, height: motion.height, clear, draws });
    return { ok: true, plan: { schema: GPU_SCENE_2D_PLAN_SCHEMA, atMs, frame, visualLayerCount, shapeCount, pointCount, particleCount, imageCount, browserSurfaceCount, videoCount, scene3dCount, scene3dObjectCount, environmentCount, materialCount, cameraCount, depthPlaneCount, textCount, adjustmentCount, ...(effectModuleCount ? { effectModuleCount } : {}), maskCount, matteCount, motionBlurLayerCount, motionBlurSampleCount, groupCount, groupMaxDepth } };
  } catch (error) {
    return fail("gpu_resource_refused", error instanceof Error ? error.message : "GPU scene could not admit this frame.");
  }
}
function compileShape(layer: MotionLayer): { ok: true; draw: GpuPrimitiveIntent | null } | { ok: false; failure: GpuScene2dFailure } {
  const transform = layer.transform ?? {};
  const width = finitePositive(transform.width ?? layer.width ?? readStyleNumber(layer, "width") ?? 100);
  const height = finitePositive(transform.height ?? layer.height ?? readStyleNumber(layer, "height") ?? 100);
  const scale = finitePositive(transform.scale ?? 1);
  const x = finiteNumber(transform.x ?? 0);
  const y = finiteNumber(transform.y ?? 0);
  if (width === null || height === null || scale === null || x === null || y === null) return fail("gpu_unsupported_feature", `GPU scene layer ${layer.id} has invalid shape geometry.`, layer.id);
  const originX = finiteNumber(transform.originX ?? width / 2);
  const originY = finiteNumber(transform.originY ?? height / 2);
  const rotationDeg = finiteNumber(transform.rotation ?? 0);
  if (originX === null || originY === null || rotationDeg === null) return fail("gpu_unsupported_feature", `GPU scene layer ${layer.id} has an invalid transform origin or rotation.`, layer.id);
  const colorValue = layer.fill ?? readStyleString(layer, "fill") ?? layer.color ?? readStyleString(layer, "color") ?? "#ffffff";
  const color = parseColor(colorValue);
  const opacity = readOpacity(layer);
  if (!color) return fail("gpu_unsupported_color", `GPU scene layer ${layer.id} uses unsupported fill '${colorValue}'.`, layer.id);
  if (opacity === null) return fail("gpu_unsupported_feature", `GPU scene layer ${layer.id} has invalid opacity.`, layer.id);
  const box = { x: x + originX - (originX * scale), y: y + originY - (originY * scale), width: width * scale, height: height * scale };
  const paint = { ...color, a: color.a * opacity };
  if (hasGpuScenePathGeometry(layer)) {
    const geometry = compileGpuSceneAuthoredShape({ layer, box, fill: paint, opacity, scale, rotationDeg, pivotX: x + originX, pivotY: y + originY });
    return geometry.ok ? geometry : fail(geometry.code, geometry.message, layer.id);
  }
  if (isGpuScenePathShape(layer.shape)) {
    const path = compileGpuScenePathShape({ layer, box, fill: paint, opacity, scale, rotationDeg, pivotX: x + originX, pivotY: y + originY });
    return path.ok ? path : fail(path.code, path.message, layer.id);
  }
  const styled = canonicalGpuScenePrimitiveShape(layer.shape) === "rect" ? compileGpuStyledRectangle(layer, opacity, scale) : { ok: true as const, style: null };
  if (!styled.ok) return styled;
  if (styled.style && layer.gradient) return fail("gpu_unsupported_feature", `GPU scene layer ${layer.id} cannot combine a gradient with radius, stroke or shadow yet.`, layer.id);
  if (layer.gradient) {
    const gradient = compileGpuSceneGradient(layer, opacity);
    if (!gradient.ok) return fail(gradient.code, gradient.message, layer.id);
    return { ok: true, draw: { kind: "gradientRect", id: layer.id, blendMode: layer.blendMode ?? "normal", effects: gpuSceneEffects(layer), ...box, rotationDeg, pivotX: x + originX, pivotY: y + originY, ...gradient.paint } };
  }
  if (styled.style) return { ok: true, draw: { kind: "styledRect", id: layer.id, blendMode: layer.blendMode ?? "normal", effects: gpuSceneEffects(layer), ...box, rotationDeg, pivotX: x + originX, pivotY: y + originY, fill: paint, ...styled.style } };
  if (isGpuSceneTriangleShape(layer.shape)) {
    return { ok: true, draw: { kind: "triangles", id: layer.id, blendMode: layer.blendMode ?? "normal", effects: gpuSceneEffects(layer), vertices: shapeTriangleVertices(layer.shape, box), rotationDeg, pivotX: x + originX, pivotY: y + originY, color: paint } };
  }
  const primitive = canonicalGpuScenePrimitiveShape(layer.shape) as "rect" | "ellipse";
  if (primitive === "ellipse") {
    const stroke = compileGpuSceneEllipseStroke(layer, opacity, scale);
    if (!stroke.ok) return fail("gpu_unsupported_feature", stroke.message, layer.id);
    return { ok: true, draw: { kind: "ellipse", id: layer.id, blendMode: layer.blendMode ?? "normal", effects: gpuSceneEffects(layer), ...box, rotationDeg, pivotX: x + originX, pivotY: y + originY, color: paint, strokeWidth: stroke.strokeWidth, stroke: stroke.stroke } };
  }
  return { ok: true, draw: { kind: "rect", id: layer.id, blendMode: layer.blendMode ?? "normal", effects: gpuSceneEffects(layer), ...box, rotationDeg, pivotX: x + originX, pivotY: y + originY, color: paint } };
}
export { gpuSceneImageAssetRef } from "./gpu-scene-media";
function layerIsActive(layer: MotionLayer, atMs: number): boolean { return atMs >= layer.startMs && atMs < layer.startMs + layer.durationMs; }
function readOpacity(layer: MotionLayer): number | null { const value = layer.opacity ?? layer.transform?.opacity ?? 1; return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null; }
function finiteNumber(value: number): number | null { return Number.isFinite(value) ? value : null; }
function finitePositive(value: number): number | null { return Number.isFinite(value) && value > 0 ? value : null; }
function readStyleNumber(layer: MotionLayer, key: string): number | null { const value = layer.style?.[key]; return typeof value === "number" && Number.isFinite(value) ? value : null; }
function readStyleString(layer: MotionLayer, key: string): string | null { const value = layer.style?.[key]; return typeof value === "string" ? value : null; }
function fail(code: GpuScene2dFailureCode, message: string, layerId?: string): { ok: false; failure: GpuScene2dFailure } { return { ok: false, failure: { code, message, ...(layerId ? { layerId } : {}) } }; }
