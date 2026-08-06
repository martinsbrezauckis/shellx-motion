import {
  validateLayerKeyingAndRoto,
  type MotionChromaKey,
  type MotionMask,
} from "./keying";
import type { MotionDocument, MotionLayer } from "./types";

export interface MotionLayerKeyingState {
  layerId: string;
  layerType: string;
  keying: MotionChromaKey | null;
  roto: MotionMask | null;
  trackingAttached: boolean;
}

export interface MotionKeyingEditResult {
  motion: MotionDocument;
  changedPaths: string[];
  state: MotionLayerKeyingState;
}

export function inspectMotionLayerKeying(motion: MotionDocument, layerId: string): MotionLayerKeyingState {
  const layer = requiredLayer(motion, layerId);
  const roto = layer.mask?.type === "roto" ? structuredClone(layer.mask) : null;
  return {
    layerId,
    layerType: layer.type,
    keying: layer.keying ? structuredClone(layer.keying) : null,
    roto,
    trackingAttached: Boolean(roto?.tracking),
  };
}

export function applyMotionLayerChromaKey(
  motion: MotionDocument,
  layerId: string,
  keying: MotionChromaKey,
): MotionKeyingEditResult {
  return editLayer(motion, layerId, (layer, path) => {
    layer.keying = structuredClone(keying);
    assertValid(layer, path);
    return [`${path}/keying`];
  });
}

export function removeMotionLayerChromaKey(motion: MotionDocument, layerId: string): MotionKeyingEditResult {
  return editLayer(motion, layerId, (layer, path) => {
    if (!layer.keying) throw new Error(`Layer ${layerId} has no chroma key to remove.`);
    delete layer.keying;
    return [`${path}/keying`];
  });
}

export function upsertMotionLayerRotoMask(
  motion: MotionDocument,
  layerId: string,
  mask: MotionMask,
): MotionKeyingEditResult {
  if (mask.type !== "roto") throw new Error("Roto upsert requires mask.type roto.");
  return editLayer(motion, layerId, (layer, path) => {
    layer.mask = structuredClone(mask);
    assertValid(layer, path);
    return [`${path}/mask`];
  });
}

export function detachMotionLayerRotoTracking(motion: MotionDocument, layerId: string): MotionKeyingEditResult {
  return editLayer(motion, layerId, (layer, path) => {
    if (layer.mask?.type !== "roto" || !layer.mask.tracking) {
      throw new Error(`Layer ${layerId} has no roto tracking attachment to detach.`);
    }
    delete layer.mask.tracking;
    assertValid(layer, path);
    return [`${path}/mask/tracking`];
  });
}

export function removeMotionLayerRotoMask(motion: MotionDocument, layerId: string): MotionKeyingEditResult {
  return editLayer(motion, layerId, (layer, path) => {
    if (layer.mask?.type !== "roto") throw new Error(`Layer ${layerId} has no roto mask to remove.`);
    delete layer.mask;
    return [`${path}/mask`];
  });
}

function editLayer(
  motion: MotionDocument,
  layerId: string,
  edit: (layer: MotionLayer, path: string) => string[],
): MotionKeyingEditResult {
  const patched = structuredClone(motion);
  const index = patched.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) throw new Error(`Motion layer does not exist: ${layerId}.`);
  const path = `/layers/${index}`;
  const changedPaths = edit(patched.layers[index], path);
  return { motion: patched, changedPaths, state: inspectMotionLayerKeying(patched, layerId) };
}

function requiredLayer(motion: MotionDocument, layerId: string): MotionLayer {
  const layer = motion.layers.find((candidate) => candidate.id === layerId);
  if (!layer) throw new Error(`Motion layer does not exist: ${layerId}.`);
  return layer;
}

function assertValid(layer: MotionLayer, path: string): void {
  const issues = validateLayerKeyingAndRoto(layer, path);
  if (issues.length > 0) throw new Error(`${issues[0].path}: ${issues[0].message}.`);
}
