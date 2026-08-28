import {
  loadSchemaSync,
  motionDocumentBudgetError,
  MOTION_DOCUMENT_LIMITS,
  type MotionDocument,
  type PackageManifest,
  validateDocumentSync,
  validateMotionDocumentInStages
} from "@shellx-motion/core";

const MAX_OTIO_DERIVED_TIME_MS = MOTION_DOCUMENT_LIMITS.maxDurationMs;
export const MAX_OTIO_TRACKS = 256;
export const MAX_OTIO_CHILDREN_PER_TRACK = 4_096;
export const MAX_OTIO_TIMELINE_CHILDREN = 10_000;
export const MAX_OTIO_LOSSINESS_FINDINGS = 1_024;
const MAX_OTIO_JSON_DEPTH = 32;
const MAX_OTIO_JSON_NODES = 50_000;
const MAX_OTIO_JSON_KEYS = 100_000;
const MAX_OTIO_OBJECT_KEYS = 256;
const MAX_OTIO_ARRAY_ITEMS = 10_000;
const MAX_OTIO_STRING_BYTES = 8 * 1024 * 1024;

export interface OtioRationalTimeValue {
  value: number;
  rate: number;
}

export interface OtioTimeRangeValue { start_time: OtioRationalTimeValue; duration: OtioRationalTimeValue; }

/** Refuse high-cardinality JSON before JSON.parse allocates the expanded object graph. */
export function assertBoundedOtioJsonText(input: string): void {
  let structuralTokens = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x22) {
      inString = true;
      continue;
    }
    if (code === 0x7b || code === 0x5b) {
      structuralTokens += 1;
      depth += 1;
      if (depth > MAX_OTIO_JSON_DEPTH) throw new Error(`OTIO import exceeds the ${MAX_OTIO_JSON_DEPTH}-level nesting limit.`);
    } else if (code === 0x7d || code === 0x5d) {
      depth -= 1;
    } else if (code === 0x2c) {
      structuralTokens += 1;
    }
    if (structuralTokens > MAX_OTIO_JSON_NODES) throw new Error(`OTIO import exceeds the ${MAX_OTIO_JSON_NODES}-token pre-parse structural limit.`);
  }
}

/** Bound the parsed JSON tree before OTIO-specific readers clone arrays, metadata, or diagnostics. */
export function assertBoundedOtioJson(input: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  let nodes = 0;
  let keys = 0;
  let stringBytes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_OTIO_JSON_NODES) throw new Error(`OTIO import exceeds the ${MAX_OTIO_JSON_NODES}-node structural limit.`);
    if (depth > MAX_OTIO_JSON_DEPTH) throw new Error(`OTIO import exceeds the ${MAX_OTIO_JSON_DEPTH}-level nesting limit.`);
    if (typeof value === "string") {
      stringBytes += Buffer.byteLength(value, "utf8");
      if (stringBytes > MAX_OTIO_STRING_BYTES) throw new Error(`OTIO import exceeds the ${MAX_OTIO_STRING_BYTES}-byte string budget.`);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      if (value.length > MAX_OTIO_ARRAY_ITEMS) throw new Error(`OTIO import exceeds the ${MAX_OTIO_ARRAY_ITEMS}-item array limit.`);
      for (let index = value.length - 1; index >= 0; index -= 1) pending.push({ value: value[index], depth: depth + 1 });
      continue;
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_OTIO_OBJECT_KEYS) throw new Error(`OTIO import exceeds the ${MAX_OTIO_OBJECT_KEYS}-field object limit.`);
    keys += entries.length;
    if (keys > MAX_OTIO_JSON_KEYS) throw new Error(`OTIO import exceeds the ${MAX_OTIO_JSON_KEYS}-field aggregate limit.`);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, entry] = entries[index]!;
      stringBytes += Buffer.byteLength(key, "utf8");
      if (stringBytes > MAX_OTIO_STRING_BYTES) throw new Error(`OTIO import exceeds the ${MAX_OTIO_STRING_BYTES}-byte string budget.`);
      pending.push({ value: entry, depth: depth + 1 });
    }
  }
}

export function requireOtioTimeRange(input: unknown, path: string): OtioTimeRangeValue {
  const range = record(input, path);
  return { start_time: requireOtioRationalTime(range.start_time, `${path}.start_time`), duration: requireOtioRationalTime(range.duration, `${path}.duration`) };
}

export function assertDistinctOtioLayerId(ids: ReadonlySet<string>, id: string, path: string): void {
  if (ids.has(id)) throw new Error(`OTIO import produces duplicate Motion layer id ${JSON.stringify(id)} at ${path}.`);
}

export function deriveOtioMilliseconds(time: OtioRationalTimeValue, path: string): number {
  const milliseconds = Math.round((time.value / time.rate) * 1000);
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_OTIO_DERIVED_TIME_MS) {
    throw new Error(`${path} must resolve to a safe integer millisecond value from 0 to ${MAX_OTIO_DERIVED_TIME_MS}.`);
  }
  return milliseconds;
}

export function requirePositiveOtioDuration(time: OtioRationalTimeValue, path: string): number {
  const milliseconds = deriveOtioMilliseconds(time, path);
  if (milliseconds <= 0) throw new Error(`${path} must resolve to a positive whole-millisecond duration.`);
  return milliseconds;
}

export function addBoundedOtioTimelineTime(currentMs: number, deltaMs: number, path: string): number {
  const nextMs = currentMs + deltaMs;
  if (!Number.isSafeInteger(nextMs) || nextMs > MAX_OTIO_DERIVED_TIME_MS) {
    throw new Error(`${path} exceeds the Motion timing ceiling of ${MAX_OTIO_DERIVED_TIME_MS}ms.`);
  }
  return nextMs;
}

export async function assertGeneratedOtioPackage(manifest: PackageManifest, motion: MotionDocument): Promise<void> {
  for (const [label, schemaName, document] of [["manifest", "packageManifest", manifest], ["Motion document", "motion", motion]] as const) {
    const validation = validateDocumentSync(loadSchemaSync(schemaName), document);
    if (!validation.ok) {
      const first = validation.errors[0];
      throw new Error(`OTIO import generated an invalid ${label}: ${first?.path ?? "document"} ${first?.message ?? "validation failed"}.`);
    }
  }
  const budgetError = motionDocumentBudgetError(motion);
  if (budgetError) throw new Error(`OTIO import generated a Motion document outside the renderable timing budget: ${budgetError}`);
  const staged = await validateMotionDocumentInStages(motion);
  if (!staged.ok) {
    const first = staged.errors[0];
    throw new Error(`OTIO import generated a semantically invalid Motion document: ${first?.path ?? "document"} ${first?.message ?? "validation failed"}.`);
  }
}

function requireOtioRationalTime(input: unknown, path: string): OtioRationalTimeValue {
  const time = record(input, path); const value = time.value, rate = time.rate;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${path}.value must be a non-negative finite number.`);
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) throw new Error(`${path}.rate must be a positive finite number.`);
  return { value, rate };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}
