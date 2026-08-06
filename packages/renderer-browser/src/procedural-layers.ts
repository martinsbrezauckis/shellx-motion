import { evaluateMotionProceduralLayers, type MotionDocument, type MotionLayer } from "@shellx-motion/core";

export function effectiveProceduralLayersAtMs(motion: MotionDocument, atMs: number): MotionLayer[] {
  return evaluateMotionProceduralLayers(motion, atMs).layers;
}

export function effectiveProceduralLayerAtMs(motion: MotionDocument, layerId: string, atMs: number): MotionLayer {
  const layer = effectiveProceduralLayersAtMs(motion, atMs).find((candidate) => candidate.id === layerId);
  if (!layer) throw new Error(`Procedural render layer is missing: ${layerId}.`);
  return layer;
}
