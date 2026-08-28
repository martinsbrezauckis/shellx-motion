import { compareCodeUnits } from "./canonical-json";
import {
  MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH,
  MOTION_LAYOUT_VALUE_DECIMALS,
  type MotionLayoutAlignment,
  type MotionLayoutDistribution,
  type MotionLayoutIssue,
  type MotionLayoutKind,
} from "./motion-layout-types";

export function issue(path: string, code: string, message: string): MotionLayoutIssue { return { path, code, message }; }
export function issueAt(issues: MotionLayoutIssue[], path: string, code: string, message: string): void { issues.push(issue(path, code, message)); }
export function joinPath(path: string, key: string): string { return path === "/" ? `/${key}` : `${path}/${key}`; }
export function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

export function exactKeys(record: Record<string, unknown>, allowed: string[], path: string, issues: MotionLayoutIssue[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record).sort(compareCodeUnits)) if (!allowedSet.has(key)) issueAt(issues, joinPath(path, key), "field.unknown", "is not allowed");
  for (const key of allowed) if (!Object.hasOwn(record, key)) issueAt(issues, joinPath(path, key), "field.required", "is required");
}

export function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
export function finiteIn(value: unknown, minimum: number, maximum: number): boolean { const number = finite(value); return number !== null && number >= minimum && number <= maximum; }
export function finiteIntegerIn(value: unknown, minimum: number, maximum: number): boolean { return finiteIn(value, minimum, maximum) && Number.isInteger(value); }
export function boundedNumber(value: unknown, path: string, minimum: number, maximum: number, issues: MotionLayoutIssue[]): void {
  if (!finiteIn(value, minimum, maximum)) issueAt(issues, path, "number.range", `must be a finite number between ${minimum} and ${maximum}`);
}
export function integer(value: unknown, path: string, minimum: number, maximum: number, issues: MotionLayoutIssue[]): void {
  if (!finiteIntegerIn(value, minimum, maximum)) issueAt(issues, path, "integer.range", `must be an integer between ${minimum} and ${maximum}`);
}

export function validateIdentifier(value: unknown, path: string, issues: MotionLayoutIssue[]): void {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH) {
    issueAt(issues, path, "identifier", `must be a string of 1..${MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH} UTF-16 code units`);
  }
}

/** Strict reader counterpart used by capability extensions that bind existing layout IDs. */
export function readMotionLayoutIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH) {
    throw new Error(`${label} must be a string of 1..${MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH} UTF-16 code units.`);
  }
  return value;
}
export function validateIdentifierList(value: unknown, path: string, issues: MotionLayoutIssue[], min: number, max: number): string[] | null {
  if (!Array.isArray(value)) { issueAt(issues, path, "identifier_list", "must be an array"); return null; }
  if (value.length < min || value.length > max) { issueAt(issues, path, "identifier_list_budget", `must contain ${min}..${max} ids`); return null; }
  value.forEach((id, index) => validateIdentifier(id, `${path}/${index}`, issues));
  return value.every((id) => typeof id === "string" && id.length >= 1 && id.length <= MAX_MOTION_LAYOUT_IDENTIFIER_LENGTH) ? [...value] as string[] : null;
}
export function validateUniqueIdentifiers(values: unknown[], path: string, issues: MotionLayoutIssue[]): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (typeof value !== "string") return;
    if (seen.has(value)) issueAt(issues, `${path}/${index}`, "identifier.unique", "must be unique");
    seen.add(value);
  });
}
export function validateSortedUniqueIdentifiers(values: unknown[], path: string, issues: MotionLayoutIssue[]): void {
  let previous: string | undefined;
  values.forEach((value, index) => {
    if (typeof value !== "string") return;
    if (previous !== undefined && compareCodeUnits(previous, value) >= 0) {
      issueAt(issues, `${path}/${index}`, "identifier.order", previous === value ? "must be unique" : "must be in ascending UTF-16 code-unit order");
    }
    previous = value;
  });
}

export function isLayoutKind(value: unknown): value is MotionLayoutKind { return value === "row" || value === "column" || value === "stack" || value === "grid" || value === "radial"; }
export function isAlignment(value: unknown): value is MotionLayoutAlignment { return value === "start" || value === "center" || value === "end" || value === "stretch"; }
export function isDistribution(value: unknown): value is MotionLayoutDistribution { return value === "start" || value === "center" || value === "end" || value === "space-between" || value === "space-around" || value === "space-evenly"; }
export function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
export function quantize(value: number): number { const rounded = Number(value.toFixed(MOTION_LAYOUT_VALUE_DECIMALS)); return Object.is(rounded, -0) ? 0 : rounded; }
