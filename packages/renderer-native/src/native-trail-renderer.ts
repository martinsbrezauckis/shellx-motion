import { planMotionTrailStroke, quantizePointValue, type MotionTrailSegment } from "@shellx-motion/core";

export interface NativeTrailCanvas<Color> {
  strokeLine(x0: number, y0: number, x1: number, y1: number, width: number, color: Color): void;
}

export interface NativeTrailTransform {
  x: number;
  y: number;
  scale: number;
  originX?: number;
  originY?: number;
  rotation?: number;
}

/**
 * Budgets the scaled/translated geometry painted before the layer's rotation
 * shell, so offscreen final geometry cannot hide work performed on its raster. Rotation is
 * intentionally not baked into pixels here because the caller's outer shell
 * performs it for every visual primitive together.
 */
export function drawNativeTrail<Color>(input: {
  canvas: NativeTrailCanvas<Color>;
  segments: readonly MotionTrailSegment[];
  transform: NativeTrailTransform;
  dimensions: { width: number; height: number };
  viewport: { width: number; height: number };
  colorFor: (color: string | undefined, opacity: number) => Color;
}): { vertices: number; segments: number; strokePixels: number } {
  const originX = input.transform.originX ?? input.dimensions.width / 2;
  const originY = input.transform.originY ?? input.dimensions.height / 2;
  const admitted = planMotionTrailStroke({
    segments: input.segments,
    transform: { ...input.transform, originX, originY, rotation: 0 },
    clip: input.viewport
  });
  for (const segment of input.segments) {
    if (segment.opacity <= 0 || segment.width <= 0) continue;
    const x0 = nativeCoordinate(segment.x0, input.transform.x, originX, input.transform.scale);
    const y0 = nativeCoordinate(segment.y0, input.transform.y, originY, input.transform.scale);
    const x1 = nativeCoordinate(segment.x1, input.transform.x, originX, input.transform.scale);
    const y1 = nativeCoordinate(segment.y1, input.transform.y, originY, input.transform.scale);
    input.canvas.strokeLine(x0, y0, x1, y1, segment.width * Math.abs(input.transform.scale), input.colorFor(segment.color, segment.opacity));
  }
  return { vertices: 0, segments: admitted.segments.length, strokePixels: admitted.strokePixels };
}

function nativeCoordinate(value: number, translate: number, origin: number, scale: number): number {
  return quantizePointValue(translate + origin + (value - origin) * scale);
}
