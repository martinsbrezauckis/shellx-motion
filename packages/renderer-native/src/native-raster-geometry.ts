import { clamp, type NativeClip, type PolygonPoint } from "./native-raster-primitives";
export function normalizeClip(clip: NativeClip): NativeClip {
  return {
    x: Math.round(clip.x),
    y: Math.round(clip.y),
    width: Math.round(clip.width),
    height: Math.round(clip.height),
    ...(clip.radius !== undefined ? { radius: Math.max(0, clip.radius) } : {})
  };
}

export function intersectClips(existing: NativeClip | null, next: NativeClip): NativeClip {
  if (!existing) return next;
  const x = Math.max(existing.x, next.x);
  const y = Math.max(existing.y, next.y);
  const right = Math.min(existing.x + existing.width, next.x + next.width);
  const bottom = Math.min(existing.y + existing.height, next.y + next.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
    ...(existing.radius !== undefined || next.radius !== undefined
      ? { radius: Math.max(existing.radius ?? 0, next.radius ?? 0) }
      : {})
  };
}

export function clipContains(clip: NativeClip, x: number, y: number): boolean {
  if (clip.radius !== undefined && clip.radius > 0) {
    return roundedRectContains(x + 0.5, y + 0.5, clip.x, clip.y, clip.width, clip.height, clip.radius);
  }
  return x >= clip.x && y >= clip.y && x < clip.x + clip.width && y < clip.y + clip.height;
}

export function roundedRectContains(px: number, py: number, x: number, y: number, width: number, height: number, radius: number): boolean {
  if (px < x || py < y || px >= x + width || py >= y + height || width <= 0 || height <= 0) return false;
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r <= 0) return true;
  if (px >= x + r && px < x + width - r) return true;
  if (py >= y + r && py < y + height - r) return true;
  const cx = px < x + r ? x + r : x + width - r;
  const cy = py < y + r ? y + r : y + height - r;
  const dx = px - cx;
  const dy = py - cy;
  return (dx * dx) + (dy * dy) <= r * r;
}

export function ellipseContains(px: number, py: number, x: number, y: number, width: number, height: number): boolean {
  if (px < x || py < y || px >= x + width || py >= y + height || width <= 0 || height <= 0) return false;
  const rx = width / 2;
  const ry = height / 2;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (px - (x + rx)) / rx;
  const dy = (py - (y + ry)) / ry;
  return (dx * dx) + (dy * dy) <= 1;
}

interface TrianglePoints {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
}

export function trianglePoints(x: number, y: number, width: number, height: number): TrianglePoints {
  return {
    ax: x + (width / 2),
    ay: y,
    bx: x,
    by: y + height,
    cx: x + width,
    cy: y + height
  };
}

export function triangleContains(px: number, py: number, points: TrianglePoints): boolean {
  const d1 = triangleSign(px, py, points.ax, points.ay, points.bx, points.by);
  const d2 = triangleSign(px, py, points.bx, points.by, points.cx, points.cy);
  const d3 = triangleSign(px, py, points.cx, points.cy, points.ax, points.ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function triangleSign(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

export function triangleEdgeDistance(px: number, py: number, points: TrianglePoints): number {
  return Math.min(
    distanceToSegment(px, py, points.ax, points.ay, points.bx, points.by),
    distanceToSegment(px, py, points.bx, points.by, points.cx, points.cy),
    distanceToSegment(px, py, points.cx, points.cy, points.ax, points.ay)
  );
}

export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = (dx * dx) + (dy * dy);
  if (lengthSquared <= 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1);
  const nearestX = ax + (t * dx);
  const nearestY = ay + (t * dy);
  return Math.hypot(px - nearestX, py - nearestY);
}

export function starPoints(x: number, y: number, width: number, height: number): PolygonPoint[] {
  const centerX = x + (width / 2);
  const centerY = y + (height / 2);
  const outerRadiusX = width / 2;
  const outerRadiusY = height / 2;
  const innerRadiusX = outerRadiusX * 0.45;
  const innerRadiusY = outerRadiusY * 0.45;
  const points: PolygonPoint[] = [];
  for (let index = 0; index < 10; index += 1) {
    const angle = (-Math.PI / 2) + (index * Math.PI / 5);
    const radiusX = index % 2 === 0 ? outerRadiusX : innerRadiusX;
    const radiusY = index % 2 === 0 ? outerRadiusY : innerRadiusY;
    points.push({
      x: centerX + (Math.cos(angle) * radiusX),
      y: centerY + (Math.sin(angle) * radiusY)
    });
  }
  return points;
}
