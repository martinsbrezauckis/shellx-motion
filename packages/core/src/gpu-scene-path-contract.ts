import type { GpuRgba } from "./gpu-frame-intent";

/** Versioned, fixed-data ABI for Core-lowered SVG path geometry. */
export const GPU_SCENE_PATH_GEOMETRY_SCHEMA = "shellx-motion/gpu-scene-path-geometry@2" as const;
export const GPU_SCENE_PATH_MAX_VERTICES = 128;
export const GPU_SCENE_PATH_MAX_SOURCE_SEGMENTS = 128;
export const GPU_SCENE_PATH_FLATTEN_TOLERANCE = 1 / 1_024;
export const GPU_SCENE_PATH_MAX_CURVE_DEPTH = 8;

export interface GpuScenePathVertex { x: number; y: number }
export interface GpuScenePathStroke { width: number; join: "miter"; cap: "butt"; miterLimit: 4 }
export interface GpuScenePathGeometry {
  schema: typeof GPU_SCENE_PATH_GEOMETRY_SCHEMA;
  viewBox: { x: number; y: number; width: number; height: number };
  contours: readonly [{ closed: true; vertices: readonly GpuScenePathVertex[] }];
  fillTriangleIndices: readonly number[];
  fillRule: "nonzero";
  stroke: GpuScenePathStroke | null;
  fingerprint: string;
}
export interface GpuScenePathTessellationVertex extends GpuScenePathVertex { color: GpuRgba }
export type GpuScenePathGeometryFailure = { ok: false; message: string };
export type GpuScenePathGeometryResult = { ok: true; geometry: GpuScenePathGeometry } | GpuScenePathGeometryFailure;
export type GpuScenePathBox = { x: number; y: number; width: number; height: number };
export function gpuScenePathFailure(message: string): GpuScenePathGeometryFailure { return { ok: false, message }; }
