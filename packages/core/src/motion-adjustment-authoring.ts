import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import {
  FIXED_ADJUSTMENT_DEFINITION_FIELDS,
  FIXED_ADJUSTMENT_ENVELOPE_FIELDS,
  FIXED_EFFECT_FIELDS,
  FIXED_FILM_GRAIN_FIELDS,
  FIXED_EXISTING_ADJUSTMENT_FIELDS,
  FIXED_VIGNETTE_FIELDS,
  snapshotFixedAdjustmentLayerIdInput,
  snapshotFixedAdjustmentUpsertInput,
} from "./motion-adjustment-input";
import { expandedDocumentDuration, assertEditableLayers, readMotionGroupGraph } from "./motion-group-structural-support";
import { createTimelineLayer, deleteTimelineLayer } from "./timeline";
import { loadSchemaSync, validateDocumentSync } from "./validate";
import type { MotionDocument, MotionEffects, MotionLayer } from "./types";

export interface MotionFixedAdjustmentDefinition {
  id: string;
  startMs: number;
  durationMs: number;
  name?: string;
  visible?: boolean;
  effects: Pick<MotionEffects, "vignette" | "filmGrain">;
}

export interface MotionFixedAdjustmentInspectInput { layerId: string; }
export interface MotionFixedAdjustmentUpsertInput { adjustment: MotionFixedAdjustmentDefinition; }
export interface MotionFixedAdjustmentRemoveInput { layerId: string; }

export interface MotionFixedAdjustmentInspection {
  layerId: string;
  index: number;
  adjustment: MotionLayer;
  adjustmentFingerprint: string;
  documentFingerprint: string;
}

export interface MotionFixedAdjustmentMutation {
  motion: MotionDocument;
  action: "created" | "replaced" | "removed";
  layerId: string;
  index: number;
  changedPaths: readonly string[];
  inputFingerprint: string;
  outputFingerprint: string;
  adjustmentFingerprint: string | null;
  layer: MotionLayer | null;
  removedTrackRefs: readonly string[];
}

/** Reads one root, fixed-effect adjustment without widening its authoring surface. */
export function inspectMotionFixedAdjustment(
  motion: MotionDocument,
  input: MotionFixedAdjustmentInspectInput,
): MotionFixedAdjustmentInspection {
  const layerId = readLayerId(input, "Adjustment inspection");
  assertValidDocument(motion, "Adjustment inspection source");
  const state = adjustmentState(motion, layerId);
  return {
    layerId: state.layer.id,
    index: state.index,
    adjustment: structuredClone(state.layer),
    adjustmentFingerprint: canonicalJsonSha256(state.layer),
    documentFingerprint: canonicalJsonSha256(motion),
  };
}

/** Creates an untracked root adjustment at stack end, or replaces its exact existing slot. */
export function createOrReplaceMotionFixedAdjustment(
  motion: MotionDocument,
  input: MotionFixedAdjustmentUpsertInput,
): MotionFixedAdjustmentMutation {
  const definition = readDefinition(input);
  assertValidDocument(motion, "Adjustment upsert source");
  const inputFingerprint = canonicalJsonSha256(motion);
  const existingIndex = motion.layers.findIndex((layer) => layer.id === definition.id);
  if (existingIndex < 0) {
    const created = createTimelineLayer(motion, {
      layer: adjustmentLayer(definition),
      index: motion.layers.length,
    });
    assertValidDocument(created.motion, "Adjustment creation");
    return mutation(created.motion, "created", definition.id, created.index, created.changedPaths, inputFingerprint, created.layer, []);
  }

  const state = adjustmentState(motion, definition.id);
  assertEditableLayers(motion, state.graph, [state.layer.id]);
  const layer = adjustmentLayer(definition, state.layer);
  if (canonicalJson(layer) === canonicalJson(state.layer)) {
    throw new Error("Fixed adjustment replacement did not change the exact layer record.");
  }
  const nextMotion: MotionDocument = {
    ...motion,
    layers: motion.layers.map((candidate, index) => index === state.index ? layer : structuredClone(candidate)),
  };
  const expandedDuration = expandedDocumentDuration(nextMotion);
  const changedPaths = [`/layers/${layer.id}`];
  if (expandedDuration !== motion.durationMs) {
    nextMotion.durationMs = expandedDuration;
    changedPaths.push("/durationMs");
  }
  assertValidDocument(nextMotion, "Adjustment replacement");
  return mutation(nextMotion, "replaced", layer.id, state.index, changedPaths, inputFingerprint, layer, []);
}

/** Removes one unlocked root adjustment and its track references. */
export function removeMotionFixedAdjustment(
  motion: MotionDocument,
  input: MotionFixedAdjustmentRemoveInput,
): MotionFixedAdjustmentMutation {
  const layerId = readLayerId(input, "Adjustment removal");
  assertValidDocument(motion, "Adjustment removal source");
  const state = adjustmentState(motion, layerId);
  assertEditableLayers(motion, state.graph, [state.layer.id]);
  const inputFingerprint = canonicalJsonSha256(motion);
  const removed = deleteTimelineLayer(motion, { layerId: state.layer.id });
  assertValidDocument(removed.motion, "Adjustment removal");
  return mutation(removed.motion, "removed", state.layer.id, state.index, removed.changedPaths, inputFingerprint, null, removed.removedTrackRefs);
}

interface AdjustmentState {
  graph: ReturnType<typeof readMotionGroupGraph>;
  index: number;
  layer: MotionLayer;
}

function adjustmentState(motion: MotionDocument, layerId: string): AdjustmentState {
  const graph = readMotionGroupGraph(motion);
  const index = motion.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) throw new Error(`Motion layer not found: ${layerId}.`);
  const layer = motion.layers[index]!;
  if (layer.type !== "adjustment") throw new Error(`Motion layer ${layerId} is not an adjustment layer.`);
  if (graph.parentByChildId.has(layer.id)) throw new Error(`Fixed adjustment layer ${layer.id} must be root-owned.`);
  readFixedLayer(layer, `Fixed adjustment layer ${layer.id}`);
  return { graph, index, layer };
}

function readDefinition(value: unknown): MotionFixedAdjustmentDefinition {
  const request = plainRecord(snapshotFixedAdjustmentUpsertInput(value), "Fixed adjustment upsert", FIXED_ADJUSTMENT_ENVELOPE_FIELDS);
  return readFixedLayer(request.adjustment, "Fixed adjustment upsert.adjustment", false);
}

function readLayerId(value: unknown, label: string): string {
  const request = plainRecord(snapshotFixedAdjustmentLayerIdInput(value, label), label, ["layerId"]);
  const layerId = typeof request.layerId === "string" ? request.layerId.trim() : "";
  if (!layerId) throw new Error(`${label} layerId must be a non-empty string.`);
  return layerId;
}

function readFixedLayer(value: unknown, label: string, hasType = true): MotionFixedAdjustmentDefinition {
  const allowed = hasType ? FIXED_EXISTING_ADJUSTMENT_FIELDS : FIXED_ADJUSTMENT_DEFINITION_FIELDS;
  const record = plainRecord(value, label, allowed);
  if (hasType && record.type !== "adjustment") throw new Error(`${label}.type must equal 'adjustment'.`);
  if (hasType && record.locked !== undefined && typeof record.locked !== "boolean") throw new Error(`${label}.locked must be a boolean when present.`);
  if (hasType && record.trackId !== undefined && (typeof record.trackId !== "string" || !record.trackId.trim())) throw new Error(`${label}.trackId must be a non-empty string when present.`);
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) throw new Error(`${label}.id must be a non-empty string.`);
  const startMs = finiteNumber(record.startMs, `${label}.startMs`);
  const durationMs = finiteNumber(record.durationMs, `${label}.durationMs`);
  if (record.name !== undefined && typeof record.name !== "string") throw new Error(`${label}.name must be a string when present.`);
  if (record.visible !== undefined && typeof record.visible !== "boolean") throw new Error(`${label}.visible must be a boolean when present.`);
  return {
    id,
    startMs,
    durationMs,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.visible === undefined ? {} : { visible: record.visible }),
    effects: readEffects(record.effects, `${label}.effects`),
  };
}

function readEffects(value: unknown, label: string): Pick<MotionEffects, "vignette" | "filmGrain"> {
  const effects = plainRecord(value, label, FIXED_EFFECT_FIELDS, true);
  if (effects.vignette === undefined && effects.filmGrain === undefined) throw new Error(`${label} must contain vignette and/or filmGrain.`);
  const vignette = effects.vignette === undefined ? undefined : readVignette(effects.vignette, `${label}.vignette`);
  const filmGrain = effects.filmGrain === undefined ? undefined : readFilmGrain(effects.filmGrain, `${label}.filmGrain`);
  return { ...(vignette ? { vignette } : {}), ...(filmGrain ? { filmGrain } : {}) };
}

function readVignette(value: unknown, label: string): NonNullable<MotionEffects["vignette"]> {
  const record = plainRecord(value, label, FIXED_VIGNETTE_FIELDS);
  return {
    amount: finiteNumber(record.amount, `${label}.amount`),
    softness: finiteNumber(record.softness, `${label}.softness`),
    color: stringValue(record.color, `${label}.color`),
  };
}

function readFilmGrain(value: unknown, label: string): NonNullable<MotionEffects["filmGrain"]> {
  const record = plainRecord(value, label, FIXED_FILM_GRAIN_FIELDS);
  return {
    amount: finiteNumber(record.amount, `${label}.amount`),
    size: finiteNumber(record.size, `${label}.size`),
    seed: finiteNumber(record.seed, `${label}.seed`),
  };
}

function adjustmentLayer(definition: MotionFixedAdjustmentDefinition, previous?: MotionLayer): MotionLayer {
  return {
    id: definition.id,
    ...(definition.name === undefined ? {} : { name: definition.name }),
    type: "adjustment",
    ...(previous?.trackId === undefined ? {} : { trackId: previous.trackId }),
    startMs: definition.startMs,
    durationMs: definition.durationMs,
    ...(definition.visible === undefined ? {} : { visible: definition.visible }),
    ...(previous && Object.hasOwn(previous, "locked") ? { locked: previous.locked } : {}),
    effects: readEffects(definition.effects, "Fixed adjustment effects"),
  };
}

function mutation(
  motion: MotionDocument,
  action: MotionFixedAdjustmentMutation["action"],
  layerId: string,
  index: number,
  changedPaths: readonly string[],
  inputFingerprint: string,
  layer: MotionLayer | null,
  removedTrackRefs: readonly string[],
): MotionFixedAdjustmentMutation {
  return {
    motion,
    action,
    layerId,
    index,
    changedPaths: [...changedPaths],
    inputFingerprint,
    outputFingerprint: canonicalJsonSha256(motion),
    adjustmentFingerprint: layer ? canonicalJsonSha256(layer) : null,
    layer: layer ? structuredClone(layer) : null,
    removedTrackRefs: [...removedTrackRefs],
  };
}

function assertValidDocument(motion: MotionDocument, label: string): void {
  const validation = validateDocumentSync(loadSchemaSync("motion"), motion);
  if (validation.ok) return;
  const first = validation.errors[0];
  throw new Error(`${label} is not a valid Motion document: ${first?.path ?? "/motion"} ${first?.message ?? "unknown validation error"}.`);
}

function plainRecord(value: unknown, label: string, allowed: readonly string[], allowMissing = false): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`);
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} must not contain symbol keys.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(`${label}.${key} must be an enumerable data field.`);
    if (!allowed.includes(key)) throw new Error(`${label} has forbidden field '${key}'.`);
    record[key] = descriptor.value;
  }
  if (!allowMissing) for (const key of allowed) if (!Object.hasOwn(record, key) && requiredField(label, key)) throw new Error(`${label} requires ${key}.`);
  return record;
}

function requiredField(label: string, key: string): boolean {
  return !(key === "name" || key === "type" || key === "trackId" || key === "visible" || key === "locked" || key === "vignette" || key === "filmGrain")
    || label.endsWith(".vignette") || label.endsWith(".filmGrain");
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}
