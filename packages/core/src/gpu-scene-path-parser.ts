import { GPU_SCENE_PATH_FLATTEN_TOLERANCE, GPU_SCENE_PATH_MAX_CURVE_DEPTH, GPU_SCENE_PATH_MAX_SOURCE_SEGMENTS, GPU_SCENE_PATH_MAX_VERTICES, gpuScenePathFailure, type GpuScenePathBox, type GpuScenePathGeometryFailure, type GpuScenePathVertex } from "./gpu-scene-path-contract";

/** Parses the fixed M/L/H/V/Q/C one-contour subset and flattens curves in Core. */
export function parseGpuScenePathContour(path: string, box: GpuScenePathBox, layerId: string): { ok: true; vertices: GpuScenePathVertex[] } | GpuScenePathGeometryFailure {
  const text = path.trim();
  if (text.length > 16 * 1024) return gpuScenePathFailure(`GPU path ${layerId} exceeds the 16384-byte bounded path input.`);
  const residue = text.replace(/[MmLlHhVvQqCcZz]/g, "").replace(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g, "").replace(/[\s,]/g, "");
  if (residue) return gpuScenePathFailure(`GPU path ${layerId} permits only M, L, H, V, Q, C, and terminal Z commands (absolute or relative).`);
  const tokens = text.match(/[MmLlHhVvQqCcZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  if (tokens.length === 0 || (tokens[0] !== "M" && tokens[0] !== "m")) return gpuScenePathFailure(`GPU path ${layerId} must begin with one M or m command.`);
  const vertices: GpuScenePathVertex[] = []; let current: GpuScenePathVertex | null = null, started = false, closed = false, sourceSegments = 0, command = "", index = 0;
  const read = (count: number, name: string): number[] | GpuScenePathGeometryFailure => {
    if (index + count > tokens.length) return gpuScenePathFailure(`GPU path ${layerId} has an incomplete ${name} command.`);
    const values = tokens.slice(index, index + count).map(pathNumber);
    if (values.some((value) => value === null)) return gpuScenePathFailure(`GPU path ${layerId} contains invalid ${name} parameters.`);
    index += count; return values as number[];
  };
  const append = (point: GpuScenePathVertex): GpuScenePathGeometryFailure | null => {
    if (!current || samePoint(current, point)) return gpuScenePathFailure(`GPU path ${layerId} contains a zero-length edge.`);
    if (vertices.length >= GPU_SCENE_PATH_MAX_VERTICES) return gpuScenePathFailure(`GPU path ${layerId} exceeds ${GPU_SCENE_PATH_MAX_VERTICES} flattened vertices.`);
    vertices.push(point); current = point; return null;
  };
  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++]; else if (!command) return gpuScenePathFailure(`GPU path ${layerId} contains parameters without a command.`);
    if (closed) return gpuScenePathFailure(`GPU path ${layerId} requires one terminal Z closure.`);
    if (command === "Z" || command === "z") { if (!current || !started || index !== tokens.length) return gpuScenePathFailure(`GPU path ${layerId} requires one terminal Z closure.`); closed = true; command = ""; continue; }
    const relative = command === command.toLowerCase();
    if (command === "M" || command === "m") {
      const values = read(2, command); if (!Array.isArray(values)) return values;
      if (started) return gpuScenePathFailure(`GPU path ${layerId} supports exactly one contour.`);
      current = { x: values[0], y: values[1] }; vertices.push(current); started = true; command = relative ? "l" : "L"; continue;
    }
    if (!current || !started) return gpuScenePathFailure(`GPU path ${layerId} requires an initial M command before ${command}.`);
    sourceSegments += 1; if (sourceSegments > GPU_SCENE_PATH_MAX_SOURCE_SEGMENTS) return gpuScenePathFailure(`GPU path ${layerId} exceeds ${GPU_SCENE_PATH_MAX_SOURCE_SEGMENTS} source segments.`);
    const values = read(command.toLowerCase() === "h" || command.toLowerCase() === "v" ? 1 : command.toLowerCase() === "q" ? 4 : command.toLowerCase() === "c" ? 6 : 2, command); if (!Array.isArray(values)) return values;
    const start = current;
    if (command === "L" || command === "l") { const issue = append({ x: values[0] + (relative ? start.x : 0), y: values[1] + (relative ? start.y : 0) }); if (issue) return issue; continue; }
    if (command === "H" || command === "h") { const issue = append({ x: values[0] + (relative ? start.x : 0), y: start.y }); if (issue) return issue; continue; }
    if (command === "V" || command === "v") { const issue = append({ x: start.x, y: values[0] + (relative ? start.y : 0) }); if (issue) return issue; continue; }
    const flattened = command === "Q" || command === "q"
      ? flattenQuadratic(start, { x: values[0] + (relative ? start.x : 0), y: values[1] + (relative ? start.y : 0) }, { x: values[2] + (relative ? start.x : 0), y: values[3] + (relative ? start.y : 0) }, box, 0)
      : flattenCubic(start, { x: values[0] + (relative ? start.x : 0), y: values[1] + (relative ? start.y : 0) }, { x: values[2] + (relative ? start.x : 0), y: values[3] + (relative ? start.y : 0) }, { x: values[4] + (relative ? start.x : 0), y: values[5] + (relative ? start.y : 0) }, box, 0);
    if (!flattened.ok) return gpuScenePathFailure(`GPU path ${layerId} ${flattened.message}`);
    for (const point of flattened.points) { const issue = append(point); if (issue) return issue; }
  }
  return closed && vertices.length >= 3 ? { ok: true, vertices } : gpuScenePathFailure(`GPU path ${layerId} requires at least three vertices and one terminal Z closure.`);
}

function flattenQuadratic(start: GpuScenePathVertex, control: GpuScenePathVertex, end: GpuScenePathVertex, box: GpuScenePathBox, depth: number): { ok: true; points: GpuScenePathVertex[] } | { ok: false; message: string } {
  if (flatEnough([control], start, end, box)) return { ok: true, points: [end] };
  if (depth >= GPU_SCENE_PATH_MAX_CURVE_DEPTH) return { ok: false, message: `curve exceeds the fixed ${GPU_SCENE_PATH_MAX_CURVE_DEPTH}-split flattening depth.` };
  const leftControl = midpoint(start, control), rightControl = midpoint(control, end), middle = midpoint(leftControl, rightControl);
  const left = flattenQuadratic(start, leftControl, middle, box, depth + 1), right = flattenQuadratic(middle, rightControl, end, box, depth + 1);
  return !left.ok ? left : !right.ok ? right : { ok: true, points: [...left.points, ...right.points] };
}
function flattenCubic(start: GpuScenePathVertex, first: GpuScenePathVertex, second: GpuScenePathVertex, end: GpuScenePathVertex, box: GpuScenePathBox, depth: number): { ok: true; points: GpuScenePathVertex[] } | { ok: false; message: string } {
  if (flatEnough([first, second], start, end, box)) return { ok: true, points: [end] };
  if (depth >= GPU_SCENE_PATH_MAX_CURVE_DEPTH) return { ok: false, message: `curve exceeds the fixed ${GPU_SCENE_PATH_MAX_CURVE_DEPTH}-split flattening depth.` };
  const a = midpoint(start, first), b = midpoint(first, second), c = midpoint(second, end), d = midpoint(a, b), e = midpoint(b, c), middle = midpoint(d, e);
  const left = flattenCubic(start, a, d, middle, box, depth + 1), right = flattenCubic(middle, e, c, end, box, depth + 1);
  return !left.ok ? left : !right.ok ? right : { ok: true, points: [...left.points, ...right.points] };
}
function flatEnough(controls: readonly GpuScenePathVertex[], start: GpuScenePathVertex, end: GpuScenePathVertex, box: GpuScenePathBox): boolean { return controls.every((control) => normalizedDistance(control, start, end, box) <= GPU_SCENE_PATH_FLATTEN_TOLERANCE); }
function normalizedDistance(point: GpuScenePathVertex, start: GpuScenePathVertex, end: GpuScenePathVertex, box: GpuScenePathBox): number { const p = normalize(point, box), a = normalize(start, box), b = normalize(end, box), dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy); return length <= 1e-12 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / length; }
function normalize(point: GpuScenePathVertex, box: GpuScenePathBox): GpuScenePathVertex { return { x: (point.x - box.x) / box.width, y: (point.y - box.y) / box.height }; }
function midpoint(left: GpuScenePathVertex, right: GpuScenePathVertex): GpuScenePathVertex { return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }; }
function isCommand(value: string | undefined): value is string { return typeof value === "string" && /^[A-Za-z]$/.test(value); }
function pathNumber(value: string | undefined): number | null { const parsed = typeof value === "string" ? Number(value) : Number.NaN; return Number.isFinite(parsed) && Math.abs(parsed) <= 1_000_000 ? parsed : null; }
function samePoint(left: GpuScenePathVertex, right: GpuScenePathVertex): boolean { return left.x === right.x && left.y === right.y; }
