import { evaluateMotionParticles, evaluateMotionTrail, type MotionLayer } from "@shellx-motion/core";
import { drawNativeTrail, type NativeTrailTransform } from "./native-trail-renderer";

interface NativeParticleCanvas<Color> {
  fillEllipse(x: number, y: number, width: number, height: number, color: Color): void;
  fillRect(x: number, y: number, width: number, height: number, color: Color): void;
  strokeLine(x0: number, y0: number, x1: number, y1: number, width: number, color: Color): void;
}

interface NativeParticleLayerCanvas<Color, Clip> extends NativeParticleCanvas<Color> {
  withClip(clip: Clip | null, paint: () => void): void;
}

export interface NativeParticleTransform extends NativeTrailTransform {
  width?: number;
  height?: number;
  originX?: number;
  originY?: number;
}

export interface NativeParticleRenderInput<Color> {
  canvas: NativeParticleCanvas<Color>;
  layer: MotionLayer;
  atMs: number;
  transform: NativeParticleTransform;
  dimensions: { width: number; height: number };
  viewport: { width: number; height: number };
  colorFor: (value: string, particleOpacity: number) => Color;
}

export interface NativeParticleLayerRenderInput<Color, Clip> {
  canvas: NativeParticleLayerCanvas<Color, Clip>;
  layer: MotionLayer;
  atMs: number;
  viewport: { width: number; height: number };
  services: {
    readTransform: (layer: MotionLayer) => NativeParticleTransform;
    scaleBoxAroundOrigin: (x: number, y: number, width: number, height: number, scale: number, originX: number | undefined, originY: number | undefined) => { x: number; y: number; width: number; height: number };
    layerPaintClip: (layer: MotionLayer, box: { x: number; y: number; width: number; height: number }, scale: number, atMs: number) => Clip | null;
  };
  colorFor: (value: string, particleOpacity: number) => Color;
}

/** CPU rasterization of the Core-owned seeded particle/analytic-field sample sequence. */
export function drawNativeParticles<Color>(input: NativeParticleRenderInput<Color>): void {
  const emitter = input.layer.emitter;
  if (!emitter) throw new Error(`Particles layer ${input.layer.id} has no emitter payload.`);
  const originX = input.transform.originX ?? input.dimensions.width / 2;
  const originY = input.transform.originY ?? input.dimensions.height / 2;
  const trail = evaluateMotionTrail({ layer: input.layer, atMs: input.atMs, particleDimensions: input.dimensions });
  drawNativeTrail({
    canvas: input.canvas,
    segments: trail.segments,
    transform: input.transform,
    dimensions: input.dimensions,
    viewport: input.viewport,
    colorFor: (color, opacity) => input.colorFor(color ?? emitter.color, opacity)
  });
  for (const particle of evaluateMotionParticles({
    emitter,
    atMs: input.atMs,
    startMs: input.layer.startMs,
    width: input.dimensions.width,
    height: input.dimensions.height
  })) {
    const diameter = particle.size * input.transform.scale;
    const x = input.transform.x + originX + (particle.x - originX) * input.transform.scale;
    const y = input.transform.y + originY + (particle.y - originY) * input.transform.scale;
    const color = input.colorFor(particle.color, particle.opacity);
    if (particle.shape === "square") input.canvas.fillRect(x, y, diameter, diameter, color);
    else input.canvas.fillEllipse(x, y, diameter, diameter, color);
  }
}

/** Applies the native layer transform/mask shell around the shared Core particle samples. */
export function drawNativeParticleLayer<Color, Clip>(input: NativeParticleLayerRenderInput<Color, Clip>): void {
  const transform = input.services.readTransform(input.layer);
  const dimensions = nativeParticleLayerDimensions(input.layer, transform);
  const box = input.services.scaleBoxAroundOrigin(transform.x, transform.y, dimensions.width, dimensions.height, transform.scale, transform.originX, transform.originY);
  const clip = input.services.layerPaintClip(input.layer, box, transform.scale, input.atMs);
  input.canvas.withClip(clip, () => drawNativeParticles({
    canvas: input.canvas,
    layer: input.layer,
    atMs: input.atMs,
    transform,
    dimensions,
    viewport: input.viewport,
    colorFor: input.colorFor
  }));
}

export function nativeParticleLayerDimensions(layer: MotionLayer, transform: NativeParticleTransform): { width: number; height: number } {
  const style = record(layer.style);
  return {
    width: transform.width ?? numberValue(layer.width) ?? numberValue(style.width) ?? 100,
    height: transform.height ?? numberValue(layer.height) ?? numberValue(style.height) ?? 100
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
