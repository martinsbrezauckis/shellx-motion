import type { GpuRgba } from "./gpu-frame-intent";
import type { GpuSceneAuthoredShapeGeometry } from "./gpu-scene-path-geometry";
import { GPU_SCENE_PATH_MAX_VERTICES, gpuScenePathFailure, type GpuScenePathBox, type GpuScenePathGeometry, type GpuScenePathGeometryFailure, type GpuScenePathTessellationVertex, type GpuScenePathVertex } from "./gpu-scene-path-contract";
import { GPU_SCENE_STROKE_DASH_MAX_OUTPUT_VERTICES, readGpuSceneStrokeDash, segmentGpuSceneStrokeDash, type GpuSceneStrokeDash } from "./gpu-scene-stroke-dash";

/** 128 admitted open points make at most 127 quads / 762 emitted GPU vertices. */
export const GPU_SCENE_AUTHORED_OPEN_STROKE_MAX_VERTICES = 768;
/** At most 1,024 segmented dash points can form 1,023 open quads. */
export const GPU_SCENE_AUTHORED_DASH_STROKE_MAX_VERTICES = GPU_SCENE_STROKE_DASH_MAX_OUTPUT_VERTICES * 6;

/** Validates one simple contour then returns stable convex-fan or ear-clipped triples. */
export function validateAndTriangulateGpuScenePath(vertices: readonly GpuScenePathVertex[], viewBox: GpuScenePathBox, layerId: string): { ok: true; indices: number[] } | GpuScenePathGeometryFailure {
  const epsilon = 1e-8;
  for (const vertex of vertices) if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y) || vertex.x < viewBox.x || vertex.x > viewBox.x + viewBox.width || vertex.y < viewBox.y || vertex.y > viewBox.y + viewBox.height) return gpuScenePathFailure(`GPU path ${layerId} vertices must be finite and stay inside its declared viewBox.`);
  for (let index = 0; index < vertices.length; index += 1) {
    const next = (index + 1) % vertices.length;
    if (samePoint(vertices[index], vertices[next])) return gpuScenePathFailure(`GPU path ${layerId} contains a zero-length edge.`);
    for (let other = index + 1; other < vertices.length; other += 1) {
      const otherNext = (other + 1) % vertices.length;
      if (next === other || otherNext === index) continue;
      if (segmentsIntersect(vertices[index], vertices[next], vertices[other], vertices[otherNext], epsilon)) return gpuScenePathFailure(`GPU path ${layerId} refuses self-intersecting contours.`);
    }
  }
  if (Math.abs(signedArea(vertices)) <= epsilon) return gpuScenePathFailure(`GPU path ${layerId} refuses a zero-area contour.`);
  const indices = triangulate(vertices);
  return indices ? { ok: true, indices } : gpuScenePathFailure(`GPU path ${layerId} cannot deterministically triangulate this simple contour.`);
}

/** Fixed triangle lowering. The optional window means butt-capped open stroke only. */
export function tessellateGpuScenePathGeometry(input: { geometry: GpuScenePathGeometry; box: GpuScenePathBox; fill: GpuRgba | null; stroke: GpuRgba | null; strokeWidth: number; reveal?: { start: number; end: number } | null }): GpuScenePathTessellationVertex[] {
  return tessellateContourGeometry({ ...input, contour: input.geometry.contours[0], viewBox: input.geometry.viewBox, fillTriangleIndices: input.geometry.fillTriangleIndices, hasStroke: input.geometry.stroke !== null, miterLimit: input.geometry.stroke?.miterLimit ?? 4 });
}

/** Reuses the same bounded triangle/stroke implementation for exact v1 authored contours. */
export function tessellateGpuSceneAuthoredShapeGeometry(input: { geometry: GpuSceneAuthoredShapeGeometry; box: GpuScenePathBox; fill: GpuRgba | null; stroke: GpuRgba | null; strokeWidth: number; dash?: GpuSceneStrokeDash | null; dashScale?: number; reveal?: { start: number; end: number } | null }): GpuScenePathTessellationVertex[] {
  if (input.dash !== null && input.dash !== undefined) return tessellateDashedAuthoredShapeGeometry({ ...input, dash: input.dash });
  if (!input.geometry.contour.closed && !input.reveal) {
    if (!input.stroke || input.stroke.a <= 0 || !input.geometry.stroke || input.strokeWidth <= 0) return [];
    const pairs = openMiterPairs(scaleVertices(input.geometry.contour.vertices, input.geometry.viewBox, input.box), input.strokeWidth / 2, input.geometry.stroke.miterLimit);
    if (!pairs.ok) return [];
    const output: GpuScenePathTessellationVertex[] = [];
    pushOpenMiterStrip(output, pairs.pairs, input.stroke);
    return output;
  }
  return tessellateContourGeometry({ ...input, contour: input.geometry.contour, viewBox: input.geometry.viewBox, fillTriangleIndices: input.geometry.fillTriangleIndices, hasStroke: input.geometry.stroke !== null, miterLimit: input.geometry.stroke?.miterLimit ?? 4 });
}

/**
 * Validates the exact transformed open-stroke realization before lowering. A
 * miter beyond the declared limit or a 180-degree reversal is refused instead
 * of drawing independent quads while claiming a miter join.
 */
export function gpuSceneAuthoredOpenMiterProblem(input: { geometry: GpuSceneAuthoredShapeGeometry; box: GpuScenePathBox; strokeWidth: number }): string | null {
  if (input.geometry.contour.closed || !input.geometry.stroke) return null;
  const pairs = openMiterPairs(scaleVertices(input.geometry.contour.vertices, input.geometry.viewBox, input.box), input.strokeWidth / 2, input.geometry.stroke.miterLimit);
  return pairs.ok ? null : pairs.message;
}

/**
 * Checks the exact dashed realization after viewBox mapping. Dash lengths use
 * the same scalar transform scale as strokeWidth, then run along transformed
 * output coordinates; that keeps non-uniform boxes and native/GPU identical.
 */
export function gpuSceneAuthoredDashStrokeProblem(input: { geometry: GpuSceneAuthoredShapeGeometry; box: GpuScenePathBox; strokeWidth: number; dash: GpuSceneStrokeDash | null; dashScale: number }): string | null {
  const dash = input.dash;
  if (!dash) return null;
  if (!input.geometry.stroke || !Number.isFinite(input.strokeWidth) || input.strokeWidth <= 0) return "GPU authored dashed shape requires an explicit supported visible stroke.";
  const segmented = authoredDashSegments({ ...input, dash });
  if (!segmented.ok) return segmented.message;
  let vertices = 0;
  for (const segment of segmented.segments) {
    if (segment.closed) vertices += segment.vertices.length * 6;
    else {
      const pairs = openMiterPairs(segment.vertices, input.strokeWidth / 2, input.geometry.stroke.miterLimit);
      if (!pairs.ok) return pairs.message;
      vertices += (segment.vertices.length - 1) * 6;
    }
  }
  return vertices > GPU_SCENE_AUTHORED_DASH_STROKE_MAX_VERTICES
    ? `GPU authored dashed shape exceeds the ${GPU_SCENE_AUTHORED_DASH_STROKE_MAX_VERTICES}-vertex stroke ceiling.`
    : null;
}

/** Static planners use this before admitting any authored transform scale. */
export function gpuSceneAuthoredDashScaleProblem(dash: GpuSceneStrokeDash | null, scale: number): string | null {
  if (!dash) return null;
  const scaled = scaledDash(dash, scale);
  return scaled.ok ? null : scaled.message;
}

/** Concave closed contours would otherwise fall back to disconnected quads. */
export function gpuSceneAuthoredClosedStrokeMiterProblem(geometry: GpuSceneAuthoredShapeGeometry): string | null {
  return geometry.contour.closed && geometry.stroke && !isStrictlyConvex(geometry.contour.vertices)
    ? "GPU authored closed shape refuses a concave stroked contour until exact closed miter joins are available."
    : null;
}

function tessellateDashedAuthoredShapeGeometry(input: { geometry: GpuSceneAuthoredShapeGeometry; box: GpuScenePathBox; fill: GpuRgba | null; stroke: GpuRgba | null; strokeWidth: number; dash: GpuSceneStrokeDash; dashScale?: number }): GpuScenePathTessellationVertex[] {
  if (!input.stroke || input.stroke.a <= 0 || !input.geometry.stroke || input.strokeWidth <= 0) return [];
  const segmented = authoredDashSegments({ ...input, dashScale: input.dashScale ?? 1 });
  if (!segmented.ok) return [];
  const points = scaleVertices(input.geometry.contour.vertices, input.geometry.viewBox, input.box);
  const output: GpuScenePathTessellationVertex[] = [];
  if (input.geometry.contour.closed && input.fill && input.fill.a > 0) {
    for (let index = 0; index < input.geometry.fillTriangleIndices.length; index += 3) pushTriangle(output, points[input.geometry.fillTriangleIndices[index]], points[input.geometry.fillTriangleIndices[index + 1]], points[input.geometry.fillTriangleIndices[index + 2]], input.fill);
  }
  for (const segment of segmented.segments) {
    if (segment.closed) {
      const ring = miterRing(segment.vertices, input.strokeWidth / 2, input.geometry.stroke.miterLimit);
      for (let index = 0; index < segment.vertices.length; index += 1) { const next = (index + 1) % segment.vertices.length; pushTriangle(output, ring.outer[index], ring.outer[next], ring.inner[index], input.stroke); pushTriangle(output, ring.inner[index], ring.outer[next], ring.inner[next], input.stroke); }
    } else {
      const pairs = openMiterPairs(segment.vertices, input.strokeWidth / 2, input.geometry.stroke.miterLimit);
      if (!pairs.ok) return [];
      pushOpenMiterStrip(output, pairs.pairs, input.stroke);
    }
  }
  return output;
}

function authoredDashSegments(input: { geometry: GpuSceneAuthoredShapeGeometry; box: GpuScenePathBox; dash: GpuSceneStrokeDash; dashScale: number }): { ok: true; segments: readonly { closed: boolean; vertices: readonly GpuScenePathVertex[] }[] } | { ok: false; message: string } {
  const scaled = scaledDash(input.dash, input.dashScale);
  if (!scaled.ok) return scaled;
  const segmented = segmentGpuSceneStrokeDash({ vertices: scaleVertices(input.geometry.contour.vertices, input.geometry.viewBox, input.box), closed: input.geometry.contour.closed, dash: scaled.dash, label: "GPU authored dashed shape" });
  return segmented.ok ? { ok: true, segments: segmented.segmentation.segments } : segmented;
}

function scaledDash(dash: GpuSceneStrokeDash, scale: number): { ok: true; dash: GpuSceneStrokeDash } | { ok: false; message: string } {
  if (!Number.isFinite(scale) || scale <= 0) return { ok: false, message: "GPU authored dashed shape requires a finite positive transform scale." };
  const read = readGpuSceneStrokeDash({ strokeDasharray: dash.pattern.map((value) => value * scale), strokeDashoffset: dash.offset * scale }, "GPU authored dashed shape");
  return read.ok && read.dash ? { ok: true, dash: read.dash } : { ok: false, message: read.ok ? "GPU authored dashed shape unexpectedly resolved to a solid stroke." : read.message };
}

function tessellateContourGeometry(input: { contour: { closed: boolean; vertices: readonly GpuScenePathVertex[] }; viewBox: GpuScenePathBox; fillTriangleIndices: readonly number[]; hasStroke: boolean; miterLimit: number; box: GpuScenePathBox; fill: GpuRgba | null; stroke: GpuRgba | null; strokeWidth: number; reveal?: { start: number; end: number } | null }): GpuScenePathTessellationVertex[] {
  const contour = input.contour;
  const points = scaleVertices(contour.vertices, input.viewBox, input.box);
  const output: GpuScenePathTessellationVertex[] = [];
  if (input.reveal) {
    if (!input.stroke || input.stroke.a <= 0 || !input.hasStroke || input.strokeWidth <= 0 || input.reveal.end <= input.reveal.start) return output;
    const window = strokeWindow(points, input.reveal.start, input.reveal.end, contour.closed);
    if (window.length >= 2) pushStrokeSegments(output, window, input.strokeWidth / 2, input.stroke, false);
    return output;
  }
  if (contour.closed && input.fill && input.fill.a > 0) for (let index = 0; index < input.fillTriangleIndices.length; index += 3) pushTriangle(output, points[input.fillTriangleIndices[index]], points[input.fillTriangleIndices[index + 1]], points[input.fillTriangleIndices[index + 2]], input.fill);
  if (input.stroke && input.stroke.a > 0 && input.hasStroke && input.strokeWidth > 0) {
    if (contour.closed && isStrictlyConvex(points)) {
      const ring = miterRing(points, input.strokeWidth / 2, input.miterLimit);
      for (let index = 0; index < points.length; index += 1) { const next = (index + 1) % points.length; pushTriangle(output, ring.outer[index], ring.outer[next], ring.inner[index], input.stroke); pushTriangle(output, ring.inner[index], ring.outer[next], ring.inner[next], input.stroke); }
    } else pushStrokeSegments(output, points, input.strokeWidth / 2, input.stroke, contour.closed);
  }
  return output;
}

function triangulate(vertices: readonly GpuScenePathVertex[]): number[] | null {
  if (isStrictlyConvex(vertices)) { const output: number[] = []; for (let index = 1; index < vertices.length - 1; index += 1) output.push(0, index, index + 1); return output; }
  const orientation = signedArea(vertices) > 0 ? 1 : -1, remaining = vertices.map((_, index) => index), output: number[] = [];
  for (let guard = 0; remaining.length > 3; guard += 1) {
    let clipped = false;
    for (let offset = 0; offset < remaining.length; offset += 1) {
      const previous = remaining[(offset + remaining.length - 1) % remaining.length], current = remaining[offset], next = remaining[(offset + 1) % remaining.length];
      if (orientation * cross(vertices[previous], vertices[current], vertices[next]) <= 1e-8 || remaining.some((candidate) => candidate !== previous && candidate !== current && candidate !== next && pointInTriangle(vertices[candidate], vertices[previous], vertices[current], vertices[next]))) continue;
      output.push(previous, current, next); remaining.splice(offset, 1); clipped = true; break;
    }
    if (!clipped || guard > GPU_SCENE_PATH_MAX_VERTICES * GPU_SCENE_PATH_MAX_VERTICES) return null;
  }
  output.push(remaining[0], remaining[1], remaining[2]); return output;
}
function strokeWindow(points: readonly GpuScenePathVertex[], start: number, end: number, closed: boolean): GpuScenePathVertex[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 1 || end <= start) return [];
  const lengths = closed
    ? points.map((point, index) => Math.hypot(points[(index + 1) % points.length].x - point.x, points[(index + 1) % points.length].y - point.y))
    : points.slice(0, -1).map((point, index) => Math.hypot(points[index + 1].x - point.x, points[index + 1].y - point.y));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (!Number.isFinite(total) || total <= 1e-8) return [];
  const output: GpuScenePathVertex[] = []; let cursor = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index], edgeStart = cursor, edgeEnd = cursor + length, overlapStart = Math.max(total * start, edgeStart), overlapEnd = Math.min(total * end, edgeEnd);
    if (overlapEnd > overlapStart) { const first = interpolate(points[index], points[(index + 1) % points.length], (overlapStart - edgeStart) / length), second = interpolate(points[index], points[(index + 1) % points.length], (overlapEnd - edgeStart) / length); if (!output.length || !samePoint(output[output.length - 1], first)) output.push(first); output.push(second); }
    cursor = edgeEnd;
  }
  return output;
}
function pushStrokeSegments(output: GpuScenePathTessellationVertex[], points: readonly GpuScenePathVertex[], halfWidth: number, color: GpuRgba, closed: boolean): void {
  for (let index = 0, count = closed ? points.length : points.length - 1; index < count; index += 1) {
    const first = points[index], second = points[(index + 1) % points.length], direction = unitVector(first, second), normal = { x: direction.y * halfWidth, y: -direction.x * halfWidth }, outerA = add(first, normal), outerB = add(second, normal), innerA = { x: first.x - normal.x, y: first.y - normal.y }, innerB = { x: second.x - normal.x, y: second.y - normal.y };
    pushTriangle(output, outerA, outerB, innerA, color); pushTriangle(output, innerA, outerB, innerB, color);
  }
}
function openMiterPairs(points: readonly GpuScenePathVertex[], halfWidth: number, miterLimit: number): { ok: true; pairs: Array<{ positive: GpuScenePathVertex; negative: GpuScenePathVertex }> } | { ok: false; message: string } {
  const emittedVertices = Math.max(0, points.length - 1) * 6;
  if (!Number.isFinite(halfWidth) || halfWidth <= 0) return { ok: false, message: "GPU authored open shape requires a finite positive stroke width." };
  if (emittedVertices > GPU_SCENE_AUTHORED_OPEN_STROKE_MAX_VERTICES) return { ok: false, message: `GPU authored open shape exceeds the ${GPU_SCENE_AUTHORED_OPEN_STROKE_MAX_VERTICES}-vertex stroke ceiling.` };
  const pairs: Array<{ positive: GpuScenePathVertex; negative: GpuScenePathVertex }> = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    if (index === 0 || index === points.length - 1) {
      const neighbor = points[index === 0 ? 1 : index - 1];
      const direction = index === 0 ? unitVector(current, neighbor) : unitVector(neighbor, current);
      const normal = { x: direction.y * halfWidth, y: -direction.x * halfWidth };
      pairs.push({ positive: add(current, normal), negative: add(current, { x: -normal.x, y: -normal.y }) });
      continue;
    }
    const previousDirection = unitVector(points[index - 1], current);
    const nextDirection = unitVector(current, points[index + 1]);
    const turn = previousDirection.x * nextDirection.y - previousDirection.y * nextDirection.x;
    const alignment = previousDirection.x * nextDirection.x + previousDirection.y * nextDirection.y;
    const previousNormal = { x: previousDirection.y * halfWidth, y: -previousDirection.x * halfWidth };
    const nextNormal = { x: nextDirection.y * halfWidth, y: -nextDirection.x * halfWidth };
    if (Math.abs(turn) <= 1e-8) {
      if (alignment <= 0) return { ok: false, message: "GPU authored open shape refuses a 180-degree stroke reversal under miter-only joins." };
      pairs.push({ positive: add(current, previousNormal), negative: add(current, { x: -previousNormal.x, y: -previousNormal.y }) });
      continue;
    }
    const positive = intersection(add(current, previousNormal), previousDirection, add(current, nextNormal), nextDirection);
    const negative = intersection(add(current, { x: -previousNormal.x, y: -previousNormal.y }), previousDirection, add(current, { x: -nextNormal.x, y: -nextNormal.y }), nextDirection);
    if (!positive || !negative) return { ok: false, message: "GPU authored open shape cannot construct an exact miter join." };
    if (Math.hypot(positive.x - current.x, positive.y - current.y) > halfWidth * miterLimit + 1e-8 || Math.hypot(negative.x - current.x, negative.y - current.y) > halfWidth * miterLimit + 1e-8) {
      return { ok: false, message: `GPU authored open shape exceeds the fixed miter limit ${miterLimit}.` };
    }
    pairs.push({ positive, negative });
  }
  return { ok: true, pairs };
}
function pushOpenMiterStrip(output: GpuScenePathTessellationVertex[], pairs: readonly { positive: GpuScenePathVertex; negative: GpuScenePathVertex }[], color: GpuRgba): void {
  for (let index = 0; index < pairs.length - 1; index += 1) {
    const current = pairs[index], next = pairs[index + 1];
    pushTriangle(output, current.positive, next.positive, current.negative, color);
    pushTriangle(output, current.negative, next.positive, next.negative, color);
  }
}
function scaleVertices(vertices: readonly GpuScenePathVertex[], viewBox: GpuScenePathBox, box: GpuScenePathBox): GpuScenePathVertex[] {
  return vertices.map((vertex) => ({ x: box.x + ((vertex.x - viewBox.x) / viewBox.width) * box.width, y: box.y + ((vertex.y - viewBox.y) / viewBox.height) * box.height }));
}
function isStrictlyConvex(points: readonly GpuScenePathVertex[]): boolean { let direction = 0; for (let index = 0; index < points.length; index += 1) { const value = cross(points[index], points[(index + 1) % points.length], points[(index + 2) % points.length]); if (Math.abs(value) <= 1e-8) return false; const next = value > 0 ? 1 : -1; if (direction && direction !== next) return false; direction = next; } return direction !== 0; }
function miterRing(points: readonly GpuScenePathVertex[], halfWidth: number, miterLimit: number): { outer: GpuScenePathVertex[]; inner: GpuScenePathVertex[] } { const winding = signedArea(points) > 0 ? 1 : -1, outer: GpuScenePathVertex[] = [], inner: GpuScenePathVertex[] = []; for (let index = 0; index < points.length; index += 1) { const previous = points[(index + points.length - 1) % points.length], current = points[index], next = points[(index + 1) % points.length], previousDirection = unitVector(previous, current), nextDirection = unitVector(current, next), previousOutward = outwardNormal(previousDirection, winding, halfWidth), nextOutward = outwardNormal(nextDirection, winding, halfWidth), previousInward = { x: -previousOutward.x, y: -previousOutward.y }, nextInward = { x: -nextOutward.x, y: -nextOutward.y }; outer.push(limitedIntersection(current, add(current, previousOutward), previousDirection, add(current, nextOutward), nextDirection, previousOutward, nextOutward, halfWidth, miterLimit)); inner.push(limitedIntersection(current, add(current, previousInward), previousDirection, add(current, nextInward), nextDirection, previousInward, nextInward, halfWidth, miterLimit)); } return { outer, inner }; }
function limitedIntersection(origin: GpuScenePathVertex, point: GpuScenePathVertex, direction: GpuScenePathVertex, otherPoint: GpuScenePathVertex, otherDirection: GpuScenePathVertex, fallback: GpuScenePathVertex, otherFallback: GpuScenePathVertex, halfWidth: number, miterLimit: number): GpuScenePathVertex { const value = intersection(point, direction, otherPoint, otherDirection); return !value || Math.hypot(value.x - origin.x, value.y - origin.y) > halfWidth * miterLimit ? add(origin, midpoint(fallback, otherFallback)) : value; }
function signedArea(points: readonly GpuScenePathVertex[]): number { return points.reduce((total, point, index) => { const next = points[(index + 1) % points.length]; return total + point.x * next.y - next.x * point.y; }, 0) / 2; }
function cross(first: GpuScenePathVertex, second: GpuScenePathVertex, third: GpuScenePathVertex): number { return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x); }
function pointInTriangle(point: GpuScenePathVertex, first: GpuScenePathVertex, second: GpuScenePathVertex, third: GpuScenePathVertex): boolean { const a = cross(first, second, point), b = cross(second, third, point), c = cross(third, first, point); return (a >= -1e-8 && b >= -1e-8 && c >= -1e-8) || (a <= 1e-8 && b <= 1e-8 && c <= 1e-8); }
function segmentsIntersect(a: GpuScenePathVertex, b: GpuScenePathVertex, c: GpuScenePathVertex, d: GpuScenePathVertex, epsilon: number): boolean { const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b); if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) return true; return (Math.abs(abC) <= epsilon && pointOnSegment(c, a, b, epsilon)) || (Math.abs(abD) <= epsilon && pointOnSegment(d, a, b, epsilon)) || (Math.abs(cdA) <= epsilon && pointOnSegment(a, c, d, epsilon)) || (Math.abs(cdB) <= epsilon && pointOnSegment(b, c, d, epsilon)); }
function pointOnSegment(point: GpuScenePathVertex, start: GpuScenePathVertex, end: GpuScenePathVertex, epsilon: number): boolean { return point.x >= Math.min(start.x, end.x) - epsilon && point.x <= Math.max(start.x, end.x) + epsilon && point.y >= Math.min(start.y, end.y) - epsilon && point.y <= Math.max(start.y, end.y) + epsilon; }
function unitVector(from: GpuScenePathVertex, to: GpuScenePathVertex): GpuScenePathVertex { const x = to.x - from.x, y = to.y - from.y, length = Math.hypot(x, y); return { x: x / length, y: y / length }; }
function outwardNormal(direction: GpuScenePathVertex, winding: number, amount: number): GpuScenePathVertex { return winding > 0 ? { x: direction.y * amount, y: -direction.x * amount } : { x: -direction.y * amount, y: direction.x * amount }; }
function add(left: GpuScenePathVertex, right: GpuScenePathVertex): GpuScenePathVertex { return { x: left.x + right.x, y: left.y + right.y }; }
function interpolate(start: GpuScenePathVertex, end: GpuScenePathVertex, amount: number): GpuScenePathVertex { return { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount }; }
function midpoint(left: GpuScenePathVertex, right: GpuScenePathVertex): GpuScenePathVertex { return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }; }
function intersection(point: GpuScenePathVertex, direction: GpuScenePathVertex, otherPoint: GpuScenePathVertex, otherDirection: GpuScenePathVertex): GpuScenePathVertex | null { const denominator = direction.x * otherDirection.y - direction.y * otherDirection.x; if (Math.abs(denominator) <= 1e-10) return null; const delta = { x: otherPoint.x - point.x, y: otherPoint.y - point.y }, amount = (delta.x * otherDirection.y - delta.y * otherDirection.x) / denominator, value = { x: point.x + direction.x * amount, y: point.y + direction.y * amount }; return Number.isFinite(value.x) && Number.isFinite(value.y) ? value : null; }
function pushTriangle(output: GpuScenePathTessellationVertex[], first: GpuScenePathVertex, second: GpuScenePathVertex, third: GpuScenePathVertex, color: GpuRgba): void { output.push({ ...first, color }, { ...second, color }, { ...third, color }); }
function samePoint(left: GpuScenePathVertex, right: GpuScenePathVertex): boolean { return left.x === right.x && left.y === right.y; }
