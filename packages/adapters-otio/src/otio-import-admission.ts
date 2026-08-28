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

export interface OtioRationalTimeValue {
  value: number;
  rate: number;
}

export interface OtioTimeRangeValue { start_time: OtioRationalTimeValue; duration: OtioRationalTimeValue; }

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
