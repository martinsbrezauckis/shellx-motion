import { canonicalJsonSha256 } from "./canonical-json";
import {
  cloneMotionTextRuns,
  fingerprintMotionTextRuns,
  motionTextRunsPlainText,
  readMotionTextRuns,
} from "./motion-text-runs";
import { readMotionTextRunsOperationEnvelope, readMotionTextRunsReplacementEnvelope } from "./motion-text-runs-input";
import { loadSchemaSync, validateDocumentSync } from "./validate";
import type { MotionDocument, MotionLayer, MotionTextRuns } from "./types";

export interface MotionTextRunsInspectInput { layerId: string; }
export interface MotionTextRunsReplaceInput { layerId: string; textRuns: MotionTextRuns; }
export interface MotionTextRunsRemoveInput { layerId: string; expectedPlainText: string; }

export interface MotionTextRunsInspection {
  layerId: string;
  textRuns: MotionTextRuns;
  plainText: string;
  fingerprint: string;
  fontAssetIds: readonly string[];
}

export interface MotionTextRunsMutation {
  motion: MotionDocument;
  layerId: string;
  layer: MotionLayer;
  action: "replaced" | "removed";
  changedPaths: readonly string[];
  previousFingerprint: string;
  fingerprint: string | null;
  plainText: string;
  fontAssetIds: readonly string[];
  outputMotionSha256: string;
}

/** Read-only inspection of manifest-bound styled text. */
export function inspectMotionTextRuns(motion: MotionDocument, input: MotionTextRunsInspectInput): MotionTextRunsInspection {
  const request = operationInput(input, ["layerId"], "Text-runs inspection");
  const state = textLayerState(motion, request.layerId, false, true);
  const textRuns = cloneMotionTextRuns(state.layer.textRuns!);
  return {
    layerId: state.layer.id,
    textRuns,
    plainText: motionTextRunsPlainText(textRuns),
    fingerprint: fingerprintMotionTextRuns(textRuns),
    fontAssetIds: sortedFontIds(textRuns),
  };
}

/** Replaces the complete closed run record and removes legacy plain text. */
export function replaceMotionTextRuns(motion: MotionDocument, input: MotionTextRunsReplaceInput): MotionTextRunsMutation {
  const request = readMotionTextRunsReplacementEnvelope(input, "Text-runs replacement");
  const state = textLayerState(motion, request.layerId, true, false);
  const textRuns = readMotionTextRuns(request.textRuns, "textRuns");
  const previous = state.layer.textRuns ? fingerprintMotionTextRuns(state.layer.textRuns) : null;
  const nextFingerprint = fingerprintMotionTextRuns(textRuns);
  const layer = { ...structuredClone(state.layer), textRuns: cloneMotionTextRuns(textRuns) } as MotionLayer;
  const layerPath = `/layers/${state.layer.id}`;
  const changedPaths: string[] = [];
  if (Object.hasOwn(layer, "text")) {
    delete layer.text;
    changedPaths.push(`${layerPath}/text`);
  }
  if (previous !== nextFingerprint) changedPaths.push(`${layerPath}/textRuns`);
  changedPaths.push(...removeLegacyFaceAuthority(layer, layerPath));
  if (changedPaths.length === 0) throw new Error("Text-runs replacement did not change the exact v1 record.");
  return commit(motion, state.index, layer, "replaced", previous ?? "none", nextFingerprint, motionTextRunsPlainText(textRuns), sortedFontIds(textRuns), changedPaths);
}

/** Removes only styling after an exact content confirmation; it never accepts replacement text. */
export function removeMotionTextRuns(motion: MotionDocument, input: MotionTextRunsRemoveInput): MotionTextRunsMutation {
  const request = operationInput(input, ["layerId", "expectedPlainText"], "Text-runs removal");
  if (typeof request.expectedPlainText !== "string") throw new Error("Text-runs removal expectedPlainText must be a string.");
  const state = textLayerState(motion, request.layerId, true, true);
  const textRuns = state.layer.textRuns!;
  const plainText = motionTextRunsPlainText(textRuns);
  if (request.expectedPlainText !== plainText) throw new Error("Text-runs removal expectedPlainText must exactly equal the concatenated run text.");
  const previousFingerprint = fingerprintMotionTextRuns(textRuns);
  const layer = { ...structuredClone(state.layer), text: plainText } as MotionLayer;
  delete layer.textRuns;
  return commit(motion, state.index, layer, "removed", previousFingerprint, null, plainText, sortedFontIds(textRuns), [`/layers/${state.layer.id}/textRuns`, `/layers/${state.layer.id}/text`]);
}

interface TextLayerState { index: number; layer: MotionLayer; }

function textLayerState(motion: MotionDocument, layerIdValue: unknown, editable: boolean, requireRuns: boolean): TextLayerState {
  const layerId = typeof layerIdValue === "string" ? layerIdValue.trim() : "";
  if (!layerId) throw new Error("Text-runs layerId must be a non-empty string.");
  const index = motion.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) throw new Error(`Motion layer not found: ${layerId}.`);
  const layer = motion.layers[index]!;
  if (layer.type !== "text" && layer.type !== "caption") throw new Error(`Motion layer ${layerId} is not a text or caption layer.`);
  if (requireRuns && !layer.textRuns) throw new Error(`Motion layer ${layerId} has no text-runs@1 content.`);
  if (editable && layer.locked) throw new Error(`Cannot edit locked layer: ${layerId}.`);
  const lockedTrack = editable ? (motion.tracks ?? []).find((track) => track.locked && (track.id === layer.trackId || track.layerIds?.includes(layer.id))) : undefined;
  if (lockedTrack) throw new Error(`Cannot edit text runs on locked track: ${lockedTrack.id}.`);
  return { index, layer };
}

function operationInput(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  return readMotionTextRunsOperationEnvelope(value, allowed, label);
}

function commit(
  source: MotionDocument,
  index: number,
  layer: MotionLayer,
  action: MotionTextRunsMutation["action"],
  previousFingerprint: string,
  fingerprint: string | null,
  plainText: string,
  fontAssetIds: readonly string[],
  changedPaths: readonly string[],
): MotionTextRunsMutation {
  const motion = { ...source, layers: source.layers.map((candidate, candidateIndex) => candidateIndex === index ? layer : structuredClone(candidate)) };
  const validation = validateDocumentSync(loadSchemaSync("motion"), motion);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new Error(`Text-runs mutation would produce an invalid Motion document: ${first?.path ?? "/motion"} ${first?.message ?? "unknown validation error"}.`);
  }
  return {
    motion,
    layerId: layer.id,
    layer,
    action,
    changedPaths,
    previousFingerprint,
    fingerprint,
    plainText,
    fontAssetIds,
    outputMotionSha256: canonicalJsonSha256(motion),
  };
}

function sortedFontIds(textRuns: MotionTextRuns): string[] { return [...new Set(textRuns.runs.map((run) => run.fontAssetId))].sort(); }

function removeLegacyFaceAuthority(layer: MotionLayer, layerPath: string): string[] {
  const changedPaths: string[] = [];
  if (layer.style) {
    for (const field of ["fontFamily", "fontWeight", "fontStyle"] as const) {
      if (!Object.hasOwn(layer.style, field)) continue;
      delete layer.style[field];
      changedPaths.push(`${layerPath}/style/${field}`);
    }
    if (Object.keys(layer.style).length === 0) delete layer.style;
  }
  if (layer.keyframes && Object.hasOwn(layer.keyframes, "style.fontWeight")) {
    delete layer.keyframes["style.fontWeight"];
    changedPaths.push(`${layerPath}/keyframes/style.fontWeight`);
    if (Object.keys(layer.keyframes).length === 0) delete layer.keyframes;
  }
  return changedPaths;
}
