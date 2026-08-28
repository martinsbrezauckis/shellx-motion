import { canonicalJson } from "./canonical-json";
import { readGpuSceneStrokeDash, type GpuSceneStrokeDash } from "./gpu-scene-stroke-dash";
import { resolveMotionShapeGeometry, validateMotionShapeGeometryLayers } from "./motion-shape-geometry";
import type { MotionDocument, MotionLayer } from "./types";

export interface MotionShapeGeometryDashSetInput {
  layerId: string;
  strokeDasharray: readonly number[];
  strokeDashoffset?: number;
}

export interface MotionShapeGeometryDashRemoveInput { layerId: string }

export interface MotionShapeGeometryDashMutationResult {
  motion: MotionDocument;
  changedPaths: string[];
  action: "dash-set" | "dash-removed";
  layerId: string;
  oldDash: GpuSceneStrokeDash | null;
  newDash: GpuSceneStrokeDash | null;
  layer: MotionLayer;
}

/** Atomically replaces the exact v1 geometry dash pair; semantic no-ops refuse. */
export function setMotionShapeGeometryDash(motion: MotionDocument, input: MotionShapeGeometryDashSetInput): MotionShapeGeometryDashMutationResult {
  exactInput(input, ["layerId", "strokeDasharray", "strokeDashoffset"], "Dash set");
  const state = editableGeometryLayer(motion, input.layerId);
  const nextRead = readGpuSceneStrokeDash({ strokeDasharray: input.strokeDasharray, ...(input.strokeDashoffset === undefined ? {} : { strokeDashoffset: input.strokeDashoffset }) }, `Shape ${state.layer.id}`);
  if (!nextRead.ok) throw new Error(nextRead.message);
  if (!nextRead.dash) throw new Error("Dash set requires a non-empty strokeDasharray.");
  if (canonicalJson(state.oldDash) === canonicalJson(nextRead.dash)) throw new Error("Shape geometry stroke dash did not change.");
  const style = structuredClone(state.layer.style ?? {});
  style.strokeDasharray = [...nextRead.dash.pattern];
  style.strokeDashoffset = nextRead.dash.offset;
  const layer = checkedLayer({ ...structuredClone(state.layer), style });
  return result(motion, state.layer.id, layer, "dash-set", state.oldDash, nextRead.dash, [
    `/layers/${state.layer.id}/style/strokeDasharray`, `/layers/${state.layer.id}/style/strokeDashoffset`
  ]);
}

/** Removes both dash fields together; an offset can never survive without its array. */
export function removeMotionShapeGeometryDash(motion: MotionDocument, input: MotionShapeGeometryDashRemoveInput): MotionShapeGeometryDashMutationResult {
  exactInput(input, ["layerId"], "Dash remove");
  const state = editableGeometryLayer(motion, input.layerId);
  if (!state.oldDash) throw new Error("Shape geometry stroke dash is already absent.");
  const style = structuredClone(state.layer.style ?? {});
  const hadOffset = Object.hasOwn(style, "strokeDashoffset");
  delete style.strokeDasharray;
  delete style.strokeDashoffset;
  const layer = checkedLayer({ ...structuredClone(state.layer), ...(Object.keys(style).length ? { style } : {}) });
  if (!Object.keys(style).length) delete layer.style;
  return result(motion, state.layer.id, layer, "dash-removed", state.oldDash, null, [
    `/layers/${state.layer.id}/style/strokeDasharray`, ...(hadOffset ? [`/layers/${state.layer.id}/style/strokeDashoffset`] : [])
  ]);
}

function editableGeometryLayer(motion: MotionDocument, layerIdValue: unknown): { layer: MotionLayer; oldDash: GpuSceneStrokeDash | null } {
  const layerId = typeof layerIdValue === "string" ? layerIdValue.trim() : "";
  if (!layerId) throw new Error("Layer id is required.");
  const layer = motion.layers.find((candidate) => candidate.id === layerId);
  if (!layer) throw new Error(`Motion layer not found: ${layerId}.`);
  const resolved = resolveMotionShapeGeometry(layer);
  if (!resolved.ok || resolved.geometry.source !== "v1") throw new Error(`Shape geometry dash requires a valid v1 geometry layer: ${resolved.ok ? "legacy geometry is not supported" : resolved.message}`);
  if (layer.locked) throw new Error(`Cannot edit locked layer: ${layer.id}.`);
  const lockedTrack = (motion.tracks ?? []).find((track) => track.locked && (track.id === layer.trackId || track.layerIds?.includes(layer.id)));
  if (lockedTrack) throw new Error(`Cannot edit layer style on locked track: ${lockedTrack.id}.`);
  const old = readGpuSceneStrokeDash(layer.style, `Shape ${layer.id}`);
  if (!old.ok) throw new Error(old.message);
  return { layer, oldDash: old.dash };
}

function checkedLayer(layer: MotionLayer): MotionLayer {
  const issues: Array<{ path: string; message: string }> = [];
  validateMotionShapeGeometryLayers([layer], issues);
  if (issues.length) throw new Error(issues.map((entry) => `${entry.path}: ${entry.message}`).join("; "));
  return layer;
}

function result(motion: MotionDocument, layerId: string, layer: MotionLayer, action: "dash-set" | "dash-removed", oldDash: GpuSceneStrokeDash | null, newDash: GpuSceneStrokeDash | null, changedPaths: string[]): MotionShapeGeometryDashMutationResult {
  return { motion: { ...motion, layers: motion.layers.map((candidate) => candidate.id === layerId ? layer : structuredClone(candidate)) }, changedPaths, action, layerId, oldDash, newDash, layer };
}

function exactInput(value: object, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} has unknown field ${unknown}.`);
}
