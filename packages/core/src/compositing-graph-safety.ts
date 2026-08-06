import type { MotionCompositingIssue } from "./compositing-graph-types";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;

  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  const hasAccessor = descriptors.some(
    (descriptor) => "get" in descriptor || "set" in descriptor,
  );
  return hasAccessor ? null : value as Record<string, unknown>;
}

export function allowOnlyFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
  issues: MotionCompositingIssue[],
): void {
  const supported = new Set(fields);
  const unknown = Reflect.ownKeys(value).find(
    (key) => typeof key !== "string" || !supported.has(key),
  );
  if (unknown !== undefined) {
    issues.push(graphIssue(path, "object.field", "contains an unsupported field"));
  }
}

export function safeGraphId(
  value: unknown,
  path: string,
  issues: MotionCompositingIssue[],
): string | null {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    issues.push(graphIssue(path, "id.invalid", "must be a safe 1..64 character id"));
    return null;
  }
  return value;
}

export function isBoundedNumber(value: unknown, min: number, max: number): boolean {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= min
    && value <= max;
}

export function validGraphDimension(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function graphIssue(
  path: string,
  code: string,
  message: string,
): MotionCompositingIssue {
  return { path, code, message };
}
