import { canonicalJsonSha256 } from "./canonical-json";
import { gpuScenePathFailure, GPU_SCENE_PATH_GEOMETRY_SCHEMA, type GpuScenePathGeometry, type GpuScenePathGeometryFailure, type GpuScenePathGeometryResult, type GpuScenePathStroke } from "./gpu-scene-path-contract";
import { parseGpuScenePathContour } from "./gpu-scene-path-parser";
import { validateAndTriangulateGpuScenePath } from "./gpu-scene-path-tessellation";
import { readGpuSceneStrokeDash, type GpuSceneStrokeDash } from "./gpu-scene-stroke-dash";
import { resolveMotionShapeGeometry, validateOpenMotionShapeGeometryStyle } from "./motion-shape-geometry";
import { parseMotionPathViewBox } from "./path-contract";
import type { MotionLayer } from "./types";

export * from "./gpu-scene-path-contract";
export { parseGpuSceneColor } from "./gpu-scene-color";
export { readGpuSceneStrokeDash } from "./gpu-scene-stroke-dash";
export { gpuSceneAuthoredClosedStrokeMiterProblem, gpuSceneAuthoredDashStrokeProblem, tessellateGpuSceneAuthoredShapeGeometry, tessellateGpuScenePathGeometry } from "./gpu-scene-path-tessellation";

/** Returns true for the fixed, Core-lowered path spellings. */
export function isGpuScenePathShape(value: unknown): value is "path" | "freeform" { return value === "path" || value === "freeform"; }

/** New geometry is a path-contour candidate even though it deliberately has no `shape` string. */
export function hasGpuScenePathGeometry(layer: MotionLayer): boolean { return Object.hasOwn(layer as object, "geometry"); }

/** Separate v1-lowered ABI: legacy path consumers remain pinned to @2. */
export const GPU_SCENE_AUTHORED_SHAPE_GEOMETRY_SCHEMA = "shellx-motion/gpu-scene-authored-shape-geometry@1" as const;
export interface GpuSceneAuthoredShapeGeometry {
  schema: typeof GPU_SCENE_AUTHORED_SHAPE_GEOMETRY_SCHEMA;
  kind: "line" | "polyline" | "polygon" | "arc" | "sector" | "path";
  viewBox: { x: number; y: number; width: number; height: number };
  contour: { closed: boolean; vertices: GpuScenePathGeometry["contours"][number]["vertices"] };
  fillTriangleIndices: readonly number[];
  fillRule: "nonzero";
  stroke: GpuScenePathStroke | null;
  /** Present only for a v1 dashed stroke so solid v1 geometry stays byte-identical. */
  strokeDash?: GpuSceneStrokeDash;
  fingerprint: string;
}
export type GpuSceneAuthoredShapeGeometryResult = { ok: true; geometry: GpuSceneAuthoredShapeGeometry } | GpuScenePathGeometryFailure;

/**
 * Builds immutable, versioned path geometry from a tiny SVG data subset. The
 * page receives triangles only: no package path text, SVG engine, shader, or
 * dynamically-selected parser crosses the renderer boundary.
 */
export function compileGpuScenePathGeometry(layer: MotionLayer): GpuScenePathGeometryResult {
  const path = layer["x-path"];
  if (typeof path !== "string" || path.trim().length === 0) return gpuScenePathFailure(`GPU ${String(layer.shape)} shape ${layer.id} requires a non-empty x-path string.`);
  const viewBox = readViewBox(layer); if (!viewBox.ok) return viewBox;
  const stroke = readStroke(layer); if (!stroke.ok) return stroke;
  if (layer["x-path-fillRule"] !== undefined && layer["x-path-fillRule"] !== "nonzero") return gpuScenePathFailure(`GPU ${String(layer.shape)} shape ${layer.id} supports only nonzero fillRule; holes and evenodd fills are refused.`);
  const contour = parseGpuScenePathContour(path, viewBox.value, layer.id); if (!contour.ok) return contour;
  const topology = validateAndTriangulateGpuScenePath(contour.vertices, viewBox.value, layer.id);
  if (!topology.ok) return topology;
  const vertices = Object.freeze(contour.vertices.map((vertex) => Object.freeze({ ...vertex })));
  const contours = Object.freeze([Object.freeze({ closed: true as const, vertices })]) as unknown as GpuScenePathGeometry["contours"];
  const canonical: Omit<GpuScenePathGeometry, "fingerprint"> = { schema: GPU_SCENE_PATH_GEOMETRY_SCHEMA, viewBox: viewBox.value, contours, fillTriangleIndices: Object.freeze([...topology.indices]), fillRule: "nonzero", stroke: stroke.value };
  return { ok: true, geometry: Object.freeze({ ...canonical, fingerprint: canonicalJsonSha256(canonical) }) };
}

/** Lowers an exact v1 record into the separate authored-contour ABI. */
export function compileGpuSceneAuthoredShapeGeometry(layer: MotionLayer): GpuSceneAuthoredShapeGeometryResult {
  const resolved = resolveMotionShapeGeometry(layer);
  if (!resolved.ok) return resolved;
  if (resolved.geometry.source !== "v1") return gpuScenePathFailure(`GPU shape ${layer.id} requires a v1 geometry record.`);
  const styleProblem = validateOpenMotionShapeGeometryStyle(layer, resolved.geometry);
  if (styleProblem) return gpuScenePathFailure(styleProblem);
  const stroke = readStroke(layer); if (!stroke.ok) return stroke;
  const dash = readGpuSceneStrokeDash(layer.style, `GPU shape ${layer.id}`);
  if (!dash.ok) return gpuScenePathFailure(dash.message);
  if (dash.dash && !stroke.value) return gpuScenePathFailure(`GPU shape ${layer.id} strokeDasharray requires an explicit supported visible stroke.`);
  const topology = resolved.geometry.closed
    ? validateAndTriangulateGpuScenePath(resolved.geometry.vertices, resolved.geometry.viewBox, layer.id)
    : { ok: true as const, indices: [] };
  if (!topology.ok) return topology;
  const vertices = Object.freeze(resolved.geometry.vertices.map((vertex) => Object.freeze({ ...vertex })));
  const canonical: Omit<GpuSceneAuthoredShapeGeometry, "fingerprint"> = {
    schema: GPU_SCENE_AUTHORED_SHAPE_GEOMETRY_SCHEMA,
    kind: resolved.geometry.kind as GpuSceneAuthoredShapeGeometry["kind"],
    viewBox: resolved.geometry.viewBox,
    contour: Object.freeze({ closed: resolved.geometry.closed, vertices }),
    fillTriangleIndices: Object.freeze([...topology.indices]),
    fillRule: "nonzero",
    stroke: stroke.value,
    ...(dash.dash ? { strokeDash: dash.dash } : {})
  };
  return { ok: true, geometry: Object.freeze({ ...canonical, fingerprint: canonicalJsonSha256(canonical) }) };
}

function readViewBox(layer: MotionLayer): { ok: true; value: GpuScenePathGeometry["viewBox"] } | GpuScenePathGeometryFailure {
  try { const parsed = parseMotionPathViewBox(layer["x-path-viewBox"] ?? "0 0 100 100", `GPU path ${layer.id} viewBox`); return { ok: true, value: { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height } }; }
  catch (error) { return gpuScenePathFailure(error instanceof Error ? error.message : `GPU path ${layer.id} has an invalid viewBox.`); }
}
function readStroke(layer: MotionLayer): { ok: true; value: GpuScenePathStroke | null } | GpuScenePathGeometryFailure {
  const style = layer.style && typeof layer.style === "object" && !Array.isArray(layer.style) ? layer.style : {};
  if (typeof style.stroke !== "string" || style.stroke.trim().length === 0) return { ok: true, value: null };
  const width = style.strokeWidth ?? style.width;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0 || width > 4_096) return gpuScenePathFailure(`GPU path ${layer.id} stroke requires a finite style.strokeWidth in 0..4096.`);
  if (style.strokeLinejoin !== undefined && style.strokeLinejoin !== "miter") return gpuScenePathFailure(`GPU path ${layer.id} supports only the exact miter stroke join.`);
  if (style.strokeLinecap !== undefined && style.strokeLinecap !== "butt") return gpuScenePathFailure(`GPU path ${layer.id} is closed and supports only the butt stroke cap.`);
  return { ok: true, value: { width, join: "miter", cap: "butt", miterLimit: 4 } };
}
