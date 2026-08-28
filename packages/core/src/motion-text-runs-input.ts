/**
 * Descriptor-first boundary for the intentionally tiny text-runs@1 tree.
 *
 * This is deliberately not the general point-operation clone: a text-runs
 * array has a 32-item product limit, so its `length` must be checked before
 * inspecting keys or element descriptors. That makes oversized/proxy input a
 * bounded refusal rather than a walk over caller-controlled indexes.
 */
export interface MotionTextRunsInputSnapshot {
  schema: unknown;
  runs: readonly Record<string, unknown>[];
}

export interface MotionTextRunsReplacementEnvelope {
  layerId: unknown;
  textRuns: unknown;
}

export const MAX_MOTION_TEXT_RUN_INPUT_RUNS = 32;
const RUN_KEYS = ["text", "fontAssetId", "color", "fontSizePx", "letterSpacingPx"] as const;

export function readMotionTextRunsInput(value: unknown, label: string): MotionTextRunsInputSnapshot {
  const root = exactRecord(value, ["schema", "runs"], label);
  if (!Object.hasOwn(root, "schema") || !Object.hasOwn(root, "runs")) throw problem(`${label} requires schema and runs.`);
  return { schema: root.schema, runs: denseRuns(root.runs, `${label}.runs`) };
}

/** Reads the Core replace envelope without recursively cloning `textRuns`. */
export function readMotionTextRunsReplacementEnvelope(value: unknown, label: string): MotionTextRunsReplacementEnvelope {
  const root = exactRecord(value, ["layerId", "textRuns"], label);
  if (!Object.hasOwn(root, "layerId") || !Object.hasOwn(root, "textRuns")) throw problem(`${label} requires layerId and textRuns.`);
  return { layerId: root.layerId, textRuns: root.textRuns };
}

/** Reads scalar inspect/remove envelopes through the same descriptor-only boundary. */
export function readMotionTextRunsOperationEnvelope(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  const root = exactRecord(value, allowed, label);
  for (const key of allowed) if (!Object.hasOwn(root, key)) throw problem(`${label} requires ${key}.`);
  return root;
}

function denseRuns(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw problem(`${label} must be an array.`);
  const lengthDescriptor = descriptor(value, "length", label);
  const length = "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  // Check this before ownKeys or any index descriptor. In particular, a 100k
  // Proxy run list receives this one bounded reflection only.
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 1 || length > MAX_MOTION_TEXT_RUN_INPUT_RUNS) {
    throw problem(`${label} must contain 1..${MAX_MOTION_TEXT_RUN_INPUT_RUNS} non-empty runs.`);
  }
  const keys = ownStringKeys(value, label);
  if (keys.length !== length + 1 || keys.some((key) => key !== "length" && (!arrayIndex(key) || Number(key) >= length))) {
    throw problem(`${label} must be a dense data array without extension fields.`);
  }
  const runs: Record<string, unknown>[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = descriptor(value, String(index), `${label}[${index}]`);
    if (!entry.enumerable || !("value" in entry)) throw problem(`${label}[${index}] must be an enumerable data value.`);
    runs.push(exactRecord(entry.value, RUN_KEYS, `${label}[${index}]`));
  }
  return runs;
}

function exactRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw problem(`${label} must be a plain data object.`);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw problem(`${label} must be a plain data object.`);
    const keys = ownStringKeys(value, label);
    if (keys.length > allowed.length) throw problem(`${label} exceeds the ${allowed.length}-field data limit.`);
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (!allowed.includes(key)) throw problem(`${label} does not support ${key}.`);
      const entry = descriptor(value, key, `${label}.${key}`);
      if (!entry.enumerable || !("value" in entry)) throw problem(`${label}.${key} must contain an enumerable data value.`);
      Object.defineProperty(copy, key, { value: entry.value, enumerable: true, configurable: true, writable: true });
    }
    return copy;
  } catch (error) {
    if (error instanceof TextRunsInputError) throw error;
    throw problem(`${label} must be plain JSON data.`);
  }
}

function ownStringKeys(value: object, label: string): string[] {
  try {
    const keys = Reflect.ownKeys(value);
    const strings: string[] = [];
    for (const key of keys) {
      if (typeof key !== "string") throw problem(`${label} must not contain symbol keys.`);
      strings.push(key);
    }
    return strings;
  } catch (error) {
    if (error instanceof TextRunsInputError) throw error;
    throw problem(`${label} must be plain JSON data.`);
  }
}

function descriptor(value: object, key: string, label: string): PropertyDescriptor {
  try {
    const entry = Object.getOwnPropertyDescriptor(value, key);
    if (!entry) throw problem(`${label} must be a data value.`);
    return entry;
  } catch (error) {
    if (error instanceof TextRunsInputError) throw error;
    throw problem(`${label} must be plain JSON data.`);
  }
}

function arrayIndex(value: string): boolean { return /^(0|[1-9][0-9]*)$/.test(value); }
class TextRunsInputError extends Error {}
function problem(message: string): TextRunsInputError { return new TextRunsInputError(message); }
