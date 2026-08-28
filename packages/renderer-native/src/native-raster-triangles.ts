import type { Rgba } from "./native-raster-primitives";

export interface NativeFlatTriangleCanvas {
  width: number;
  height: number;
  paintTrianglePixel(x: number, y: number, color: Rgba): void;
}

/** Rasterizes the flat per-triangle colors emitted by Core geometry lowering. */
export function fillNativeFlatColoredTriangles(canvas: NativeFlatTriangleCanvas, vertices: readonly { x: number; y: number; color: Rgba }[]): void {
  if (vertices.length < 3 || vertices.length % 3 !== 0) throw new Error("Native colored triangles require complete triangle triples.");
  for (let index = 0; index < vertices.length; index += 3) {
    const [first, second, third] = [vertices[index], vertices[index + 1], vertices[index + 2]];
    if (!sameRgba(first.color, second.color) || !sameRgba(first.color, third.color)) throw new Error("Native colored triangles refuse unsupported interpolated vertex colors.");
    const minX = Math.max(0, Math.floor(Math.min(first.x, second.x, third.x))), minY = Math.max(0, Math.floor(Math.min(first.y, second.y, third.y)));
    const maxX = Math.min(canvas.width, Math.ceil(Math.max(first.x, second.x, third.x))), maxY = Math.min(canvas.height, Math.ceil(Math.max(first.y, second.y, third.y)));
    for (let y = minY; y < maxY; y += 1) for (let x = minX; x < maxX; x += 1) if (pointInTriangle(x + 0.5, y + 0.5, first, second, third)) canvas.paintTrianglePixel(x, y, first.color);
  }
}

function pointInTriangle(px: number, py: number, first: { x: number; y: number }, second: { x: number; y: number }, third: { x: number; y: number }): boolean {
  if (edge(first, second, third) < 0) [second, third] = [third, second];
  return ownsEdge(px, py, first, second) && ownsEdge(px, py, second, third) && ownsEdge(px, py, third, first);
}

function ownsEdge(px: number, py: number, first: { x: number; y: number }, second: { x: number; y: number }): boolean {
  const value = edge(first, second, { x: px, y: py });
  return value > 0 || (value === 0 && (second.y < first.y || (second.y === first.y && second.x > first.x)));
}

function edge(first: { x: number; y: number }, second: { x: number; y: number }, point: { x: number; y: number }): number {
  return (second.x - first.x) * (point.y - first.y) - (second.y - first.y) * (point.x - first.x);
}

function sameRgba(first: Rgba, second: Rgba): boolean {
  return first.r === second.r && first.g === second.g && first.b === second.b && first.a === second.a;
}
