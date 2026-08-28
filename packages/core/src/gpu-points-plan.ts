import { createHash } from "node:crypto";
import {
  GPU_FRAME_INTENT_SCHEMA,
  GPU_MAX_POINTS,
  compileGpuFramePlan,
  type GpuFramePlan,
  type GpuRgba
} from "./gpu-frame-intent";
import { effectivePointCloudAtMs, type MotionPointCloud } from "./motion-points";
import type { MotionDocument, MotionLayer } from "./types";

/**
 * The deliberately small public GPU contract. It is a preview/still-frame lane
 * for static points only; final-video, effects and CPU fallback are outside it.
 */
export const GPU_POINTS_PREVIEW_SCHEMA = "shellx-motion/gpu-points-preview@1" as const;

export type GpuPointsPlanFailureCode =
  | "gpu_invalid_time"
  | "gpu_unsupported_layer"
  | "gpu_unsupported_effect"
  | "gpu_unsupported_feature"
  | "gpu_unsupported_color"
  | "gpu_resource_refused";

export interface GpuPointsPlanFailure {
  code: GpuPointsPlanFailureCode;
  message: string;
  layerId?: string;
}

export interface GpuPointsPreviewPlan {
  schema: typeof GPU_POINTS_PREVIEW_SCHEMA;
  atMs: number;
  frame: GpuFramePlan;
  pointCount: number;
}

export type GpuPointsPlanResult =
  | { ok: true; plan: GpuPointsPreviewPlan }
  | { ok: false; failure: GpuPointsPlanFailure };

/**
 * Lower a validated Motion package to fixed WebGPU point instances. `atMs` is
 * passed directly to the shared point evaluator, which is the v1 exact-time,
 * six-decimal quantized interpolation authority used by CPU paths as well.
 */
export function compileGpuPointsPreviewPlan(motion: MotionDocument, atMs: number): GpuPointsPlanResult {
  if (!Number.isFinite(atMs) || atMs < 0 || atMs > motion.durationMs) {
    return failure("gpu_invalid_time", `GPU preview atMs must be within 0..${motion.durationMs}.`);
  }
  const clear = parseGpuColor(motion.background ?? "transparent");
  if (!clear) return failure("gpu_unsupported_color", "GPU points preview accepts only transparent or #rgb/#rgba/#rrggbb/#rrggbbaa document backgrounds.");

  const activeLayers = motion.layers.filter((layer) => layer.visible !== false && layerIsActive(layer, atMs));
  for (const layer of activeLayers) {
    const unsupported = unsupportedLayerFeature(layer);
    if (unsupported) return unsupported;
  }

  const draws: Array<{ kind: "points"; id: string; blendMode: "normal"; effects: null; seed: number; points: Array<{ x: number; y: number; size: number; color: GpuRgba }> }> = [];
  let pointCount = 0;
  for (const layer of activeLayers) {
    const cloud = layer.pointCloud as MotionPointCloud;
    const fallbackColor = pointFallbackColor(layer);
    const resolvedFallback = parseGpuColor(fallbackColor);
    if (!resolvedFallback) return failure("gpu_unsupported_color", `GPU points preview layer ${layer.id} uses unsupported fallback color '${fallbackColor}'.`, layer.id);
    const layerOpacity = finiteOpacity(layer.opacity);
    if (layerOpacity === null) return failure("gpu_unsupported_feature", `GPU points preview layer ${layer.id} has an invalid opacity.`, layer.id);
    const points: Array<{ x: number; y: number; size: number; color: GpuRgba }> = [];
    const resolvedPoints = effectivePointCloudAtMs(cloud, atMs);
    for (const [index, point] of resolvedPoints.entries()) {
      const color = parseGpuColor(point.color ?? fallbackColor);
      if (!color) return failure("gpu_unsupported_color", `GPU points preview layer ${layer.id} point ${index} uses unsupported color '${point.color}'.`, layer.id);
      points.push({
        x: point.x,
        y: point.y,
        size: point.size,
        color: { ...color, a: color.a * point.opacity * layerOpacity }
      });
    }
    pointCount += points.length;
    if (pointCount > GPU_MAX_POINTS) return failure("gpu_resource_refused", `GPU points preview exceeds its ${GPU_MAX_POINTS}-point total admission limit.`, layer.id);
    draws.push({ kind: "points", id: layer.id, blendMode: "normal", effects: null, seed: deterministicSeed(layer.id), points });
  }

  try {
    const frame = compileGpuFramePlan({
      schema: GPU_FRAME_INTENT_SCHEMA,
      width: motion.width,
      height: motion.height,
      clear,
      draws
    });
    return { ok: true, plan: { schema: GPU_POINTS_PREVIEW_SCHEMA, atMs, frame, pointCount } };
  } catch (error) {
    return failure("gpu_resource_refused", error instanceof Error ? error.message : "GPU points preview could not admit this frame.");
  }
}

function layerIsActive(layer: MotionLayer, atMs: number): boolean {
  return atMs >= layer.startMs && atMs <= layer.startMs + layer.durationMs;
}

function unsupportedLayerFeature(layer: MotionLayer): GpuPointsPlanResult | null {
  if (layer.type !== "points") return failure("gpu_unsupported_layer", `GPU points preview refuses visible layer ${layer.id} of type '${layer.type}'.`, layer.id);
  if (!layer.pointCloud) return failure("gpu_unsupported_layer", `GPU points preview requires pointCloud data on layer ${layer.id}.`, layer.id);
  if (hasKeys(layer.effects)) return failure("gpu_unsupported_effect", `GPU points preview refuses effects on layer ${layer.id}, including trails.`, layer.id);
  if (hasKeys(layer.transform) || hasKeys(layer.keyframes) || hasKeys(layer.transitions)) {
    return failure("gpu_unsupported_feature", `GPU points preview refuses transforms, keyframes, and transitions on layer ${layer.id}.`, layer.id);
  }
  if (layer.blendMode && layer.blendMode !== "normal") return failure("gpu_unsupported_feature", `GPU points preview supports only normal blend mode on layer ${layer.id}.`, layer.id);
  if (hasKeys(layer.style) || layer.gradient || layer.mask || layer.matte || layer.keying || layer.crop || layer.pathReveal || layer.depth !== undefined) {
    return failure("gpu_unsupported_feature", `GPU points preview refuses additional visual features on layer ${layer.id}.`, layer.id);
  }
  return null;
}

function pointFallbackColor(layer: MotionLayer): string {
  return layer.color ?? layer.fill ?? "#ffffff";
}

function finiteOpacity(value: number | undefined): number | null {
  if (value === undefined) return 1;
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function hasKeys(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0;
}

function deterministicSeed(value: string): number {
  return createHash("sha256").update(value, "utf8").digest().readUInt32BE(0);
}

function parseGpuColor(value: string): GpuRgba | null {
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (!match) return null;
  const hex = match[1].length < 5 ? [...match[1]].map((part) => part + part).join("") : match[1];
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16) / 255,
    g: Number.parseInt(hex.slice(2, 4), 16) / 255,
    b: Number.parseInt(hex.slice(4, 6), 16) / 255,
    a: alpha / 255
  };
}

function failure(code: GpuPointsPlanFailureCode, message: string, layerId?: string): GpuPointsPlanResult {
  return { ok: false, failure: { code, message, ...(layerId ? { layerId } : {}) } };
}
