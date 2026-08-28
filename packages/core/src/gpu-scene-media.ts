import type { GpuDrawIntent } from "./gpu-frame-intent";
import { resolveGpuSceneChromaKey } from "./gpu-scene-chroma-key";
import { gpuSceneEffects } from "./gpu-scene-effects";
import { gpuVideoLayerAssetRef, gpuVideoResourceBindingFailure, type GpuVideoFrameRequest } from "./gpu-video-frame-request";
import { gpuHybridTextureResourceBindingFailure, type GpuHybridTextureRequest, type GpuHybridTextureResourceBinding } from "./gpu-hybrid-texture-request";
import type {
  GpuScene2dFailure,
  GpuScene2dImageResource,
  GpuScene2dVideoResource
} from "./gpu-scene-2d-plan";
import type { MotionDocument, MotionLayer } from "./types";

type MediaResult =
  | { ok: true; draw: Extract<GpuDrawIntent, { kind: "image" }> }
  | { ok: false; failure: GpuScene2dFailure };
type ImageFit = "fill" | "contain" | "cover" | "none" | "scale-down";

export function compileGpuSceneImage(
  layer: MotionLayer,
  motion: MotionDocument,
  resources: ReadonlyMap<string, GpuScene2dImageResource> | undefined
): MediaResult {
  const assetRef = gpuSceneImageAssetRef(motion, layer);
  const resource = assetRef ? resources?.get(assetRef) : undefined;
  if (!assetRef || !resource) return fail(`GPU scene image layer ${layer.id} has no prepared exact image resource.`, layer.id);
  return compileMediaTexture(layer, resource, "image");
}

export function compileGpuSceneVideo(
  layer: MotionLayer,
  motion: MotionDocument,
  atUs: number,
  resources: ReadonlyMap<string, GpuScene2dVideoResource> | undefined,
  requests: ReadonlyMap<string, GpuVideoFrameRequest> | undefined
): MediaResult {
  const resource = resources?.get(layer.id);
  if (requests) {
    const request = requests.get(layer.id);
    const bindingProblem = gpuVideoResourceBindingFailure({ layerId: layer.id, assetRef: gpuVideoLayerAssetRef(motion, layer), atUs, request, resource });
    if (bindingProblem) return fail(bindingProblem, layer.id);
  }
  if (!resource) return fail(`GPU scene video layer ${layer.id} has no prepared exact decoded frame.`, layer.id);
  return compileMediaTexture(layer, resource, "video");
}

/**
 * Lowers a governed browser-produced RGBA surface through the same fixed image
 * compositor. The browser remains a source producer only: GPU owns the final
 * transform, crop, blend, mask, and compositing pass.
 */
export function compileGpuSceneBrowserSurface(
  layer: MotionLayer,
  resources: ReadonlyMap<string, GpuScene2dImageResource> | undefined
): MediaResult {
  const resource = resources?.get(layer.id);
  if (!resource) return fail(`GPU browser surface layer ${layer.id} has no exact-time governed capture.`, layer.id);
  return compileMediaTexture(layer, resource, "browser surface");
}

/** Lowers only a re-admitted B2 texture; generic browser surfaces retain their legacy path. */
export function compileGpuSceneHybridTexture(
  layer: MotionLayer,
  motion: MotionDocument,
  atUs: number,
  resources: ReadonlyMap<string, GpuHybridTextureResourceBinding> | undefined,
  requests: ReadonlyMap<string, GpuHybridTextureRequest> | undefined
): MediaResult {
  const resource = resources?.get(layer.id);
  const problem = gpuHybridTextureResourceBindingFailure({ motion, layer, atUs, request: requests?.get(layer.id), resource });
  if (problem) return fail(problem, layer.id);
  return compileMediaTexture(layer, resource!, "governed hybrid texture");
}

function compileMediaTexture(layer: MotionLayer, resource: GpuScene2dImageResource, kind: "image" | "video" | "browser surface" | "governed hybrid texture"): MediaResult {
  const chroma = resolveGpuSceneChromaKey(layer);
  if (!chroma.ok) return fail(chroma.message, layer.id);
  const transform = layer.transform ?? {};
  const style = layer.style ?? {};
  const width = finitePositive(transform.width ?? layer.width ?? readStyleNumber(layer, "width") ?? resource.width);
  const height = finitePositive(transform.height ?? layer.height ?? readStyleNumber(layer, "height") ?? resource.height);
  const x = finiteNumber(transform.x ?? 0);
  const y = finiteNumber(transform.y ?? 0);
  const scale = finitePositive(transform.scale ?? 1);
  const opacity = readOpacity(layer);
  if (width === null || height === null || x === null || y === null || scale === null || opacity === null) {
    return fail(`GPU scene layer ${layer.id} has invalid ${kind} geometry or opacity.`, layer.id);
  }
  const originX = finiteNumber(transform.originX ?? width / 2);
  const originY = finiteNumber(transform.originY ?? height / 2);
  const rotationDeg = finiteNumber(transform.rotation ?? 0);
  if (originX === null || originY === null || rotationDeg === null) return fail(`GPU scene layer ${layer.id} has an invalid image transform origin or rotation.`, layer.id);
  const box = {
    x: x + originX - originX * scale,
    y: y + originY - originY * scale,
    width: width * scale,
    height: height * scale
  };
  const crop = imageCrop(layer, resource);
  const fitValue = layer.fit ?? (typeof style.objectFit === "string" ? style.objectFit : typeof style.fit === "string" ? style.fit : "cover");
  const fit = ["fill", "contain", "cover", "none", "scale-down"].includes(String(fitValue).toLowerCase())
    ? String(fitValue).toLowerCase() as ImageFit
    : "cover";
  const placement = imagePlacement(box, crop, fit);
  const left = Math.max(box.x, placement.x);
  const top = Math.max(box.y, placement.y);
  const right = Math.min(box.x + box.width, placement.x + placement.width);
  const bottom = Math.min(box.y + box.height, placement.y + placement.height);
  if (right <= left || bottom <= top) return fail(`GPU scene layer ${layer.id} has an empty image placement.`, layer.id);
  const u = (value: number) => imageUnit(crop.x + value * crop.width, resource.width);
  const v = (value: number) => imageUnit(crop.y + value * crop.height, resource.height);
  const u0 = u((left - placement.x) / placement.width); const v0 = v((top - placement.y) / placement.height);
  const u1 = u((right - placement.x) / placement.width); const v1 = v((bottom - placement.y) / placement.height);
  if ([u0, v0, u1, v1].some((value) => value === null)) return fail(`GPU scene layer ${layer.id} produced invalid texture coordinates.`, layer.id);
  return { ok: true, draw: {
    kind: "image", id: layer.id, blendMode: layer.blendMode ?? "normal", effects: gpuSceneEffects(layer),
    resourceId: resource.resourceId, x: left, y: top, width: right - left, height: bottom - top,
    rotationDeg, pivotX: x + originX, pivotY: y + originY,
    u0: u0 as number, v0: v0 as number, u1: u1 as number, v1: v1 as number, opacity,
    ...(chroma.chromaKey ? { chromaKey: chroma.chromaKey } : {})
  } };
}

function imageCrop(layer: MotionLayer, image: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const crop = layer.crop;
  if (!crop || !Number.isFinite(crop.x) || !Number.isFinite(crop.y) || !Number.isFinite(crop.width) || !Number.isFinite(crop.height) || crop.width <= 0 || crop.height <= 0) return { x: 0, y: 0, width: image.width, height: image.height };
  const x = Math.min(Math.max(crop.x, 0), image.width - 1);
  const y = Math.min(Math.max(crop.y, 0), image.height - 1);
  return { x, y, width: Math.max(1, Math.min(crop.width, image.width - x)), height: Math.max(1, Math.min(crop.height, image.height - y)) };
}

function imagePlacement(box: { x: number; y: number; width: number; height: number }, source: { width: number; height: number }, fit: ImageFit): { x: number; y: number; width: number; height: number } {
  if (fit === "fill") return box;
  if (fit === "none" || (fit === "scale-down" && source.width <= box.width && source.height <= box.height)) {
    return { x: box.x + (box.width - source.width) / 2, y: box.y + (box.height - source.height) / 2, width: source.width, height: source.height };
  }
  const contain = fit === "contain" || fit === "scale-down";
  const scale = contain ? Math.min(box.width / source.width, box.height / source.height) : Math.max(box.width / source.width, box.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

export function gpuSceneImageAssetRef(motion: MotionDocument, layer: MotionLayer): string | null {
  const direct = [layer.assetRef, layer.source, layer.src].find((value) => typeof value === "string" && value.length > 0);
  if (direct) return direct;
  if (!layer.assetId) return null;
  for (const candidate of motion.assets) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const asset = candidate as Record<string, unknown>;
    if (asset.id !== layer.assetId || !asset.source || typeof asset.source !== "object" || Array.isArray(asset.source)) continue;
    const path = (asset.source as Record<string, unknown>).path;
    if (typeof path === "string" && path.length > 0) return path;
  }
  return null;
}

function readOpacity(layer: MotionLayer): number | null {
  const value = layer.opacity ?? layer.transform?.opacity ?? 1;
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
function finiteNumber(value: number): number | null { return Number.isFinite(value) ? value : null; }
function finitePositive(value: number): number | null { return Number.isFinite(value) && value > 0 ? value : null; }
/** Clamp only floating-point roundoff from mathematically closed crop/placement bounds. */
function imageUnit(value: number, dimension: number): number | null {
  const unit = value / dimension;
  if (!Number.isFinite(unit) || unit < -1e-9 || unit > 1 + 1e-9) return null;
  return Math.min(1, Math.max(0, unit));
}
function readStyleNumber(layer: MotionLayer, key: string): number | null {
  const value = layer.style?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function fail(message: string, layerId: string): { ok: false; failure: GpuScene2dFailure } {
  return { ok: false, failure: { code: "gpu_unsupported_feature", message, layerId } };
}
