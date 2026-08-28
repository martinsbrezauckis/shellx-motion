import { types as nodeTypes } from "node:util";

export const FIXED_ADJUSTMENT_ENVELOPE_FIELDS = ["adjustment"] as const;
export const FIXED_ADJUSTMENT_DEFINITION_FIELDS = ["id", "name", "startMs", "durationMs", "visible", "effects"] as const;
export const FIXED_EXISTING_ADJUSTMENT_FIELDS = ["id", "name", "type", "trackId", "startMs", "durationMs", "visible", "locked", "effects"] as const;
export const FIXED_EFFECT_FIELDS = ["vignette", "filmGrain"] as const;
export const FIXED_VIGNETTE_FIELDS = ["amount", "softness", "color"] as const;
export const FIXED_FILM_GRAIN_FIELDS = ["amount", "size", "seed"] as const;

const MAX_INPUT_DEPTH = 4;
const MAX_INPUT_RECORDS = 5;
const MAX_INPUT_FIELDS = 15;

interface InputShape {
  allowed: readonly string[];
  children?: Readonly<Record<string, InputShape>>;
}

const VIGNETTE: InputShape = { allowed: FIXED_VIGNETTE_FIELDS };
const FILM_GRAIN: InputShape = { allowed: FIXED_FILM_GRAIN_FIELDS };
const EFFECTS: InputShape = { allowed: FIXED_EFFECT_FIELDS, children: { vignette: VIGNETTE, filmGrain: FILM_GRAIN } };
const ADJUSTMENT: InputShape = { allowed: FIXED_ADJUSTMENT_DEFINITION_FIELDS, children: { effects: EFFECTS } };
const UPSERT: InputShape = { allowed: FIXED_ADJUSTMENT_ENVELOPE_FIELDS, children: { adjustment: ADJUSTMENT } };
const LAYER_ID: InputShape = { allowed: ["layerId"] };

/** Exact closed input snapshot for the fixed-adjustment upsert envelope. */
export function snapshotFixedAdjustmentUpsertInput(value: unknown): Record<string, unknown> {
  return snapshotInput(value, "Fixed adjustment upsert", UPSERT);
}

/** Exact closed input snapshot for fixed-adjustment inspect/remove envelopes. */
export function snapshotFixedAdjustmentLayerIdInput(value: unknown, label: string): Record<string, unknown> {
  return snapshotInput(value, label, LAYER_ID);
}

function snapshotInput(value: unknown, label: string, shape: InputShape): Record<string, unknown> {
  try {
    const snapshot = snapshotValue(value, label, shape, { active: new WeakSet<object>(), records: 0, fields: 0 }, 0);
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw problem(`${label} must be a plain data object.`);
    return snapshot as Record<string, unknown>;
  } catch (error) {
    if (error instanceof FixedAdjustmentInputError) throw error;
    throw new Error(`${label} data reflection failed.`);
  }
}

function snapshotValue(value: unknown, label: string, shape: InputShape | undefined, state: SnapshotState, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw problem(`${label} must contain finite numbers only.`);
    return value;
  }
  if (typeof value !== "object") throw problem(`${label} must contain plain data only.`);
  if (!shape) return rejectScalarObject(value, label);
  if (depth > MAX_INPUT_DEPTH) throw problem(`${label} exceeds the ${MAX_INPUT_DEPTH}-level input depth limit.`);
  if (state.active.has(value)) throw problem(`${label} must not contain cycles.`);

  let isArray: boolean;
  let keys: readonly PropertyKey[];
  try {
    isArray = Array.isArray(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw problem(`${label} data reflection failed.`);
  }
  if (isArray) throw problem(`${label} must contain plain data objects, not arrays.`);
  if (keys.some((key) => typeof key !== "string")) throw problem(`${label} must not contain symbol keys.`);
  if (keys.length > shape.allowed.length) throw problem(`${label} exceeds the ${shape.allowed.length}-field record limit.`);

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw problem(`${label} data reflection failed.`);
  }
  if (prototype !== Object.prototype && prototype !== null) throw problem(`${label} must contain plain data objects only.`);
  try {
    if (nodeTypes.isProxy(value)) throw problem(`${label} must not contain proxy objects.`);
  } catch (error) {
    if (error instanceof FixedAdjustmentInputError) throw error;
    throw problem(`${label} data reflection failed.`);
  }
  if (state.records >= MAX_INPUT_RECORDS) throw problem(`${label} exceeds the ${MAX_INPUT_RECORDS}-record input limit.`);
  if (state.fields + keys.length > MAX_INPUT_FIELDS) throw problem(`${label} exceeds the ${MAX_INPUT_FIELDS}-field aggregate input limit.`);

  state.active.add(value);
  state.records += 1;
  state.fields += keys.length;
  try {
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const name = key as string;
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        throw problem(`${label} data reflection failed.`);
      }
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw problem(`${label}.${name} must be an enumerable data field.`);
      if (!shape.allowed.includes(name)) throw problem(`${label} has forbidden field '${name}'.`);
      Object.defineProperty(snapshot, name, {
        value: snapshotValue(descriptor.value, `${label}.${name}`, shape.children?.[name], state, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return snapshot;
  } finally {
    state.active.delete(value);
  }
}

function rejectScalarObject(value: object, label: string): never {
  try {
    if (nodeTypes.isProxy(value)) throw problem(`${label} must not contain proxy objects.`);
  } catch (error) {
    if (error instanceof FixedAdjustmentInputError) throw error;
    throw problem(`${label} data reflection failed.`);
  }
  throw problem(`${label} must be a scalar data value.`);
}

interface SnapshotState { active: WeakSet<object>; records: number; fields: number; }
class FixedAdjustmentInputError extends Error {}
function problem(message: string): FixedAdjustmentInputError { return new FixedAdjustmentInputError(message); }
