import { effectivePointCloudAtMs, evaluateMotionTrail, type MotionLayer } from "@shellx-motion/core";
import { drawNativeTrail, type NativeTrailTransform } from "./native-trail-renderer";

interface NativePointCanvas<Color> {
  fillEllipse(x: number, y: number, width: number, height: number, color: Color): void;
  strokeLine(x0: number, y0: number, x1: number, y1: number, width: number, color: Color): void;
}

interface NativePointLayerCanvas<Color, Clip> extends NativePointCanvas<Color> {
  withClip(clip: Clip | null, paint: () => void): void;
}

export interface NativePointRenderInput<Color> {
  canvas: NativePointCanvas<Color>;
  layer: MotionLayer;
  atMs: number;
  viewport: { width: number; height: number };
  transform: NativeTrailTransform;
  defaultColor: string;
  colorFor: (value: string, pointOpacity: number) => Color;
}

export interface NativePointLayerRenderInput<Color, Clip> {
  canvas: NativePointLayerCanvas<Color, Clip>;
  layer: MotionLayer;
  atMs: number;
  viewport: { width: number; height: number };
  services: {
    readTransform: (layer: MotionLayer) => NativeTrailTransform;
    scaleBoxAroundOrigin: (x: number, y: number, width: number, height: number, scale: number, originX: number | undefined, originY: number | undefined) => { x: number; y: number; width: number; height: number };
    layerPaintClip: (layer: MotionLayer, box: { x: number; y: number; width: number; height: number }, scale: number, atMs: number) => Clip | null;
  };
  colorFor: (value: string, pointOpacity: number) => Color;
}

/** Direct CPU rasterization for the same ordered/interpolated geometry used by browser canvas. */
export function drawNativePointCloud<Color>(input: NativePointRenderInput<Color>): void {
  const pointCloud = input.layer.pointCloud;
  if (!pointCloud) throw new Error(`Points layer ${input.layer.id} has no pointCloud payload.`);
  const originX = input.transform.originX ?? input.viewport.width / 2;
  const originY = input.transform.originY ?? input.viewport.height / 2;
  const style = record(input.layer.style);
  const defaultColor = stringValue(input.layer.fill) ?? stringValue(input.layer.color) ?? stringValue(style.fill) ?? stringValue(style.color) ?? "#ffffff";
  const trail = evaluateMotionTrail({ layer: input.layer, atMs: input.atMs });
  drawNativeTrail({
    canvas: input.canvas,
    segments: trail.segments,
    transform: input.transform,
    dimensions: input.viewport,
    viewport: input.viewport,
    colorFor: (color, opacity) => input.colorFor(color ?? defaultColor, opacity)
  });
  for (const point of effectivePointCloudAtMs(pointCloud, input.atMs)) {
    const diameter = point.size * input.transform.scale;
    const x = input.transform.x + originX + (point.x - originX) * input.transform.scale;
    const y = input.transform.y + originY + (point.y - originY) * input.transform.scale;
    input.canvas.fillEllipse(x - diameter / 2, y - diameter / 2, diameter, diameter, input.colorFor(point.color ?? input.defaultColor, point.opacity));
  }
}

/** Applies the native layer transform/mask shell around Core's interpolated point cloud. */
export function drawNativePointCloudLayer<Color, Clip>(input: NativePointLayerRenderInput<Color, Clip>): void {
  const transform = input.services.readTransform(input.layer);
  const box = input.services.scaleBoxAroundOrigin(transform.x, transform.y, input.viewport.width, input.viewport.height, transform.scale, transform.originX, transform.originY);
  const clip = input.services.layerPaintClip(input.layer, box, transform.scale, input.atMs);
  const style = record(input.layer.style);
  const defaultColor = stringValue(input.layer.fill) ?? stringValue(input.layer.color) ?? stringValue(style.fill) ?? stringValue(style.color) ?? "#ffffff";
  input.canvas.withClip(clip, () => drawNativePointCloud({
    canvas: input.canvas,
    layer: input.layer,
    atMs: input.atMs,
    viewport: input.viewport,
    transform,
    defaultColor,
    colorFor: input.colorFor
  }));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
