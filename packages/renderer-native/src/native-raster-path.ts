import { distanceToSegment } from "./native-raster-geometry";
import { type PolygonPoint } from "./native-raster-primitives";
export function pathPolygonPoints(pathData: string, x: number, y: number, width: number, height: number): PolygonPoint[] {
  const localPoints = parsePathPolygon(pathData);
  if (localPoints.length < 3) throw new Error("Native path shapes require at least three path points.");
  const bounds = polygonBounds(localPoints);
  const minX = Math.min(0, bounds.minX);
  const minY = Math.min(0, bounds.minY);
  const sourceWidth = Math.max(1, Math.max(100, bounds.maxX) - minX);
  const sourceHeight = Math.max(1, Math.max(100, bounds.maxY) - minY);
  return localPoints.map((point) => ({
    x: x + ((point.x - minX) / sourceWidth) * width,
    y: y + ((point.y - minY) / sourceHeight) * height
  }));
}

function parsePathPolygon(pathData: string): PolygonPoint[] {
  const tokens = pathData.match(/[MLHVZmlhvz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const points: PolygonPoint[] = [];
  let index = 0;
  let command = "";
  let current: PolygonPoint = { x: 0, y: 0 };
  let start: PolygonPoint | null = null;

  while (index < tokens.length) {
    const token = tokens[index];
    if (isPathCommand(token)) {
      command = token;
      index += 1;
      if (command === "Z" || command === "z") {
        if (start && (current.x !== start.x || current.y !== start.y)) points.push({ ...start });
        current = start ? { ...start } : current;
      }
      continue;
    }
    if (!command) throw new Error("Native path shapes must start with a path command.");

    if (command === "M" || command === "m" || command === "L" || command === "l") {
      const xValue = readPathNumber(tokens[index]);
      const yValue = readPathNumber(tokens[index + 1]);
      index += 2;
      current = command === command.toLowerCase()
        ? { x: current.x + xValue, y: current.y + yValue }
        : { x: xValue, y: yValue };
      points.push({ ...current });
      if (!start) start = { ...current };
      if (command === "M") command = "L";
      if (command === "m") command = "l";
      continue;
    }

    if (command === "H" || command === "h") {
      const xValue = readPathNumber(tokens[index]);
      index += 1;
      current = command === "h" ? { x: current.x + xValue, y: current.y } : { x: xValue, y: current.y };
      points.push({ ...current });
      continue;
    }

    if (command === "V" || command === "v") {
      const yValue = readPathNumber(tokens[index]);
      index += 1;
      current = command === "v" ? { x: current.x, y: current.y + yValue } : { x: current.x, y: yValue };
      points.push({ ...current });
      continue;
    }

    throw new Error(`Native path shapes do not support path command ${command}.`);
  }

  const last = points.at(-1);
  if (start && last && last.x === start.x && last.y === start.y) points.pop();
  return points;
}

function isPathCommand(token: string): boolean {
  return /^[MLHVZmlhvz]$/.test(token);
}

function readPathNumber(token: string | undefined): number {
  if (token === undefined || isPathCommand(token)) throw new Error("Native path shapes contain an incomplete command.");
  const value = Number(token);
  if (!Number.isFinite(value)) throw new Error(`Native path shapes contain an invalid number: ${token}`);
  return value;
}

function polygonBounds(points: PolygonPoint[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y)
  }), { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY });
}

export function polygonContains(px: number, py: number, points: PolygonPoint[]): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
    const currentPoint = points[current];
    const previousPoint = points[previous];
    if ((currentPoint.y > py) === (previousPoint.y > py)) continue;
    const intersectionX = ((previousPoint.x - currentPoint.x) * (py - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (px < intersectionX) inside = !inside;
  }
  return inside;
}

export function polygonEdgeDistance(px: number, py: number, points: PolygonPoint[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    distance = Math.min(distance, distanceToSegment(px, py, current.x, current.y, next.x, next.y));
  }
  return distance;
}
