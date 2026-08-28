import type { GpuGroupStartIntent, GpuPrimitiveIntent } from "./gpu-frame-intent";
import type { GpuScene2dFailure } from "./gpu-scene-2d-plan";
import { gpuSceneEffects, gpuSceneHasOnlySupportedEffects } from "./gpu-scene-effects";
import { compileGpuSceneLayerMask } from "./gpu-scene-mask";
import { gpuSceneHasActiveWipeTransition } from "./gpu-scene-wipe-transition";
import { validateMotionGroups } from "./motion-group-validation";
import { effectiveLayerAtMs } from "./timeline";
import type { MotionDocument, MotionLayer } from "./types";

export type GpuSceneLayerEntry =
  | { kind: "layer"; sourceLayer: MotionLayer; atMs: number; atUs: number }
  | { kind: "groupStart"; marker: Omit<GpuGroupStartIntent, "drawCount"> }
  | { kind: "groupEnd"; groupId: string };

/** Expands group ownership into one bounded local-time render order. */
export function expandGpuSceneGroups(motion: MotionDocument, atMs: number): { ok: true; entries: GpuSceneLayerEntry[] } | { ok: false; failure: GpuScene2dFailure } {
  const atUs = toUs(atMs);
  if (atUs === null) return { ok: false, failure: { code: "gpu_invalid_time", message: "GPU group expansion requires a finite non-negative time." } };
  return expand(motion, atMs, atUs);
}

/** Exact-time form for dynamic sources. Group visibility and every child clock stay in microseconds. */
export function expandGpuSceneGroupsAtUs(motion: MotionDocument, atUs: number): { ok: true; entries: GpuSceneLayerEntry[] } | { ok: false; failure: GpuScene2dFailure } {
  if (!Number.isSafeInteger(atUs) || atUs < 0) return { ok: false, failure: { code: "gpu_invalid_time", message: "GPU group expansion requires a non-negative safe integer atUs." } };
  return expand(motion, atUs / 1_000, atUs);
}

function expand(motion: MotionDocument, atMs: number, atUs: number): { ok: true; entries: GpuSceneLayerEntry[] } | { ok: false; failure: GpuScene2dFailure } {
  const structuralErrors: Array<{ path: string; message: string }> = [];
  validateMotionGroups(motion.layers, structuralErrors);
  if (structuralErrors.length) return { ok: false, failure: { code: "gpu_unsupported_feature", message: `GPU group graph is invalid at ${structuralErrors[0].path}: ${structuralErrors[0].message}.` } };
  const byId = new Map(motion.layers.map((layer) => [layer.id, layer])); const owned = new Set<string>();
  const cameraSource = motion.layers.find((layer) => layer.type === "camera" && layer.visible !== false && atMs >= layer.startMs && atMs < layer.startMs + layer.durationMs);
  const camera = cameraSource ? effectiveLayerAtMs(cameraSource, atMs) : undefined;
  const layerIndices = new Map(motion.layers.map((layer, index) => [layer.id, index]));
  for (const layer of motion.layers) if (layer.type === "group") for (const child of layer.childLayerIds ?? []) owned.add(child);
  const entries: GpuSceneLayerEntry[] = []; const ancestry: string[] = [];
  const visit = (sourceLayer: MotionLayer, parentAtMs: number, parentAtUs: number): GpuScene2dFailure | null => {
    const startUs = toUs(sourceLayer.startMs), durationUs = toUs(sourceLayer.durationMs);
    if (startUs === null || durationUs === null) return failure(sourceLayer, "GPU group timing cannot be quantized to integer microseconds.");
    if (sourceLayer.visible === false || parentAtUs < startUs || parentAtUs >= startUs + durationUs) return null;
    if (sourceLayer.type === "camera") return null;
    if (sourceLayer.type !== "group") {
      const marker = camera && sourceLayer.type !== "audio" && sourceLayer.type !== "adjustment" && sourceLayer.type !== "scene3d" && sourceLayer.type !== "environment"
        ? cameraPlaneMarker(motion, camera, sourceLayer, layerIndices.get(sourceLayer.id) ?? 0)
        : undefined;
      if (marker && !marker.ok) return marker.failure;
      if (marker?.ok) entries.push({ kind: "groupStart", marker: marker.marker });
      entries.push({ kind: "layer", sourceLayer, atMs: parentAtMs, atUs: parentAtUs });
      if (marker?.ok) entries.push({ kind: "groupEnd", groupId: marker.marker.id });
      return null;
    }
    if (ancestry.includes(sourceLayer.id) || ancestry.length >= 4) return failure(sourceLayer, "GPU group graph is cyclic or exceeds depth 4.");
    const children = sourceLayer.childLayerIds;
    if (!Array.isArray(children) || children.length < 1 || children.length > 256) return failure(sourceLayer, "GPU groups require 1..256 ordered childLayerIds.");
    if (!gpuSceneHasOnlySupportedEffects(sourceLayer) || sourceLayer.effects?.motionBlur) return failure(sourceLayer, "GPU groups support bounded spatial effects but not group-level temporal blur yet.");
    if (gpuSceneHasActiveWipeTransition(sourceLayer)) return failure(sourceLayer, "GPU groups cannot lower wipe transitions exactly through the fixed single-mask compositor.");
    if (sourceLayer.matte || sourceLayer.crop || sourceLayer.keying || sourceLayer.pathReveal || sourceLayer.depth !== undefined || sourceLayer.textFit || sourceLayer.emitter || sourceLayer.pointCloud || sourceLayer.shader || sourceLayer.scene3d || sourceLayer.environment) return failure(sourceLayer, "GPU group carries unsupported layer-specific fields.");
    const layer = effectiveLayerAtMs(sourceLayer, parentAtMs); const marker = groupMarker(motion, layer, parentAtMs); if (!marker.ok) return marker.failure;
    entries.push({ kind: "groupStart", marker: marker.marker }); ancestry.push(sourceLayer.id);
    const localAtMs = parentAtMs - sourceLayer.startMs, localAtUs = parentAtUs - startUs;
    for (const childId of children) { const child = byId.get(childId); if (!child) return failure(sourceLayer, `GPU group references missing child ${childId}.`); const issue = visit(child, localAtMs, localAtUs); if (issue) return issue; }
    ancestry.pop(); entries.push({ kind: "groupEnd", groupId: marker.marker.id }); return null;
  };
  for (const layer of motion.layers) if (!owned.has(layer.id)) { const issue = visit(layer, atMs, atUs); if (issue) return { ok: false, failure: issue }; }
  return { ok: true, entries };
}

function cameraPlaneMarker(
  motion: MotionDocument,
  camera: MotionLayer,
  layer: MotionLayer,
  index: number
): { ok: true; marker: Omit<GpuGroupStartIntent, "drawCount"> } | { ok: false; failure: GpuScene2dFailure } {
  const transform = camera.transform ?? {};
  const depth = finite(layer.depth ?? 0);
  const cameraX = finite(transform.x ?? 0);
  const cameraY = finite(transform.y ?? 0);
  const cameraScale = positive(transform.scale ?? 1, 100);
  const cameraRotation = finite(transform.rotation ?? 0);
  const pivotX = finite(transform.originX ?? motion.width / 2);
  const pivotY = finite(transform.originY ?? motion.height / 2);
  if ([depth, cameraX, cameraY, cameraScale, cameraRotation, pivotX, pivotY].some((value) => value === null)) return { ok: false, failure: failure(camera, "GPU camera or depth plane has invalid transform values.") };
  if (depth! < -0.9 || depth! > 3) return { ok: false, failure: failure(layer, "GPU depth planes require depth within -0.9..3.") };
  const factor = 1 + depth!;
  return { ok: true, marker: {
    kind: "groupStart", id: `camera-plane-${index}`, blendMode: "normal", effects: null,
    x: -cameraX! * factor, y: -cameraY! * factor,
    scale: Math.min(64, Math.max(0.001, cameraScale! ** factor)),
    rotationDeg: -cameraRotation! * factor, pivotX: pivotX!, pivotY: pivotY!, opacity: 1
  } };
}

function groupMarker(motion: MotionDocument, layer: MotionLayer, atMs: number): { ok: true; marker: Omit<GpuGroupStartIntent, "drawCount"> } | { ok: false; failure: GpuScene2dFailure } {
  const transform = layer.transform ?? {}; const x=finite(transform.x??0),y=finite(transform.y??0),scale=positive(transform.scale??1,64),rotationDeg=finite(transform.rotation??0),pivotX=finite(transform.originX??motion.width/2),pivotY=finite(transform.originY??motion.height/2),opacity=unit(transform.opacity??layer.opacity??1);
  if ([x,y,scale,rotationDeg,pivotX,pivotY,opacity].some((value)=>value===null)) return { ok:false, failure:failure(layer,"GPU group has invalid transform or opacity.") };
  const dummy: GpuPrimitiveIntent = { kind:"rect",id:`${layer.id}.group-mask-bounds`,x:0,y:0,width:motion.width,height:motion.height,rotationDeg:0,pivotX:motion.width/2,pivotY:motion.height/2,color:{r:1,g:1,b:1,a:1},blendMode:"normal",effects:null };
  const masked=compileGpuSceneLayerMask(motion,layer,dummy,atMs);if(!masked.ok)return masked;
  return { ok:true, marker:{ kind:"groupStart",id:`${layer.id}.group`,blendMode:layer.blendMode??"normal",effects:gpuSceneEffects(layer),...(masked.draw.mask?{mask:masked.draw.mask}:{}),x:x!,y:y!,scale:scale!,rotationDeg:rotationDeg!,pivotX:pivotX!,pivotY:pivotY!,opacity:opacity! } };
}

function finite(value: unknown): number|null{return typeof value==="number"&&Number.isFinite(value)&&Math.abs(value)<=1_000_000?value:null;}
function positive(value: unknown,maximum:number):number|null{const number=finite(value);return number!==null&&number>0&&number<=maximum?number:null;}
function unit(value: unknown):number|null{return typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=1?value:null;}
function failure(layer: MotionLayer, message: string): GpuScene2dFailure{return{code:"gpu_unsupported_feature",message,layerId:layer.id};}
function toUs(value: number): number|null { if (!Number.isFinite(value) || value < 0) return null; const us=Math.round(value*1_000); return Number.isSafeInteger(us) ? us : null; }
