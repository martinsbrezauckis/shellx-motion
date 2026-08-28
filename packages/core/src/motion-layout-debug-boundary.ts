import { compareCodeUnits } from "./canonical-json";
import {
  MOTION_LAYOUT_DEBUG_INTENT_SCHEMA,
  MOTION_LAYOUT_DEBUG_REMOVAL_SCHEMA,
  type MotionLayoutDebugIntent,
  type MotionLayoutDebugIssue,
  type MotionLayoutDebugRemoval
} from "./motion-layout-debug-types";
import type { MotionDocument } from "./types";

/** Strict, descriptor-first data boundary for the public Core Debug adapter. */
export function parseMotionLayoutDebugIntent(value: unknown): { ok: true; intent: MotionLayoutDebugIntent } | { ok: false; issues: MotionLayoutDebugIssue[] } {
  const dataIssue = strictDataIssue(value, "/");
  if (dataIssue) return { ok: false, issues: [dataIssue] };
  const root = record(value);
  if (!root) return refused("/", "intent.object", "must be a plain object");
  const operation = root.operation;
  const common = ["schema", "operation", "motion", "createdAt"];
  const allowed = operation === "remove" ? [...common, "removal"] : [...common, "groupId", "layout", "repeaters"];
  const issues: MotionLayoutDebugIssue[] = [];
  exactKeys(root, allowed, "/", issues);
  if (root.schema !== MOTION_LAYOUT_DEBUG_INTENT_SCHEMA) issues.push(issue("/schema", "intent.schema", `must equal ${MOTION_LAYOUT_DEBUG_INTENT_SCHEMA}`));
  if (operation !== "inspect" && operation !== "compile" && operation !== "apply" && operation !== "remove") issues.push(issue("/operation", "intent.operation", "must be inspect, compile, apply, or remove"));
  const motion = motionDocument(root.motion, "/motion", issues);
  const createdAt = isoInstant(root.createdAt, "/createdAt", issues);
  if (operation === "remove") {
    const removal = readRemoval(root.removal, "/removal", issues);
    return issues.length || !motion || !createdAt || !removal ? { ok: false, issues } : { ok: true, intent: { schema: MOTION_LAYOUT_DEBUG_INTENT_SCHEMA, operation: "remove", motion, createdAt, removal } };
  }
  const groupId = identifier(root.groupId, "/groupId", issues);
  if (!record(root.layout)) issues.push(issue("/layout", "intent.layout", "must be a layout record"));
  if (!Array.isArray(root.repeaters)) issues.push(issue("/repeaters", "intent.repeaters", "must be an array"));
  if (issues.length || !motion || !createdAt || !groupId || !record(root.layout) || !Array.isArray(root.repeaters)) return { ok: false, issues };
  if (operation === "inspect" || operation === "compile" || operation === "apply") return { ok: true, intent: { schema: MOTION_LAYOUT_DEBUG_INTENT_SCHEMA, operation, motion, createdAt, groupId, layout: root.layout as never, repeaters: root.repeaters as never[] } };
  return refused("/operation", "intent.operation", "must be inspect, compile, apply, or remove");
}

function readRemoval(value: unknown, path: string, issues: MotionLayoutDebugIssue[]): MotionLayoutDebugRemoval | null {
  const root = record(value);
  if (!root) { issues.push(issue(path, "removal.object", "must be a plain object")); return null; }
  exactKeys(root, ["schema", "applicationId", "applicationFingerprint"], path, issues);
  if (root.schema !== MOTION_LAYOUT_DEBUG_REMOVAL_SCHEMA) issues.push(issue(`${path}/schema`, "removal.schema", `must equal ${MOTION_LAYOUT_DEBUG_REMOVAL_SCHEMA}`));
  const applicationId = identifier(root.applicationId, `${path}/applicationId`, issues);
  if (typeof root.applicationFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(root.applicationFingerprint)) issues.push(issue(`${path}/applicationFingerprint`, "removal.fingerprint", "must be a lowercase SHA-256 hex string"));
  return issues.length || !applicationId || typeof root.applicationFingerprint !== "string" ? null : { schema: MOTION_LAYOUT_DEBUG_REMOVAL_SCHEMA, applicationId, applicationFingerprint: root.applicationFingerprint };
}

function strictDataIssue(value: unknown, path: string, seen = new WeakSet<object>(), depth = 0): MotionLayoutDebugIssue | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : issue(path, "intent.data_only", "must contain only finite JSON data values");
  if (typeof value !== "object") return issue(path, "intent.data_only", "must contain only JSON data values");
  if (depth > 64) return issue(path, "intent.data_only", "must not exceed 64 nested data levels");
  if (seen.has(value)) return issue(path, "intent.data_only", "must not contain a cyclic data graph");
  seen.add(value);
  if (Array.isArray(value)) return strictArrayDataIssue(value, path, seen, depth);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return issue(path, "intent.data_only", "must contain only plain data objects");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const symbol of Object.getOwnPropertySymbols(value)) return issue(path, "intent.data_only", `must not contain symbol field ${String(symbol)}`);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const propertyPath = `${path === "/" ? "" : path}/${key}`;
    if (!("value" in descriptor) || !descriptor.enumerable) return issue(propertyPath, "intent.data_only", "must be an enumerable data field, not an accessor");
    const nested = strictDataIssue(descriptor.value, propertyPath, seen, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function strictArrayDataIssue(value: unknown[], path: string, seen: WeakSet<object>, depth: number): MotionLayoutDebugIssue | null {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const symbol of Object.getOwnPropertySymbols(value)) return issue(path, "intent.data_only", `must not contain symbol field ${String(symbol)}`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]; const itemPath = `${path}/${index}`;
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return issue(itemPath, "intent.data_only", "must be a dense enumerable data array");
    const nested = strictDataIssue(descriptor.value, itemPath, seen, depth + 1);
    if (nested) return nested;
  }
  for (const key of Object.keys(descriptors)) if (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) return issue(`${path}/${key}`, "intent.data_only", "must not contain non-index array fields");
  return null;
}

function motionDocument(value: unknown, path: string, issues: MotionLayoutDebugIssue[]): MotionDocument | null { const root = record(value); if (!root || !Array.isArray(root.layers) || typeof root.id !== "string" || !root.id.trim()) { issues.push(issue(path, "intent.motion", "must be a Motion document with non-empty id and layers")); return null; } return value as MotionDocument; }
function isoInstant(value: unknown, path: string, issues: MotionLayoutDebugIssue[]): string | null { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) { issues.push(issue(path, "intent.created_at", "must be a canonical ISO-8601 instant")); return null; } return value; }
function identifier(value: unknown, path: string, issues: MotionLayoutDebugIssue[]): string | null { if (typeof value !== "string" || !value || value.length > 128) { issues.push(issue(path, "identifier", "must be a 1..128 code-unit string")); return null; } return value; }
function record(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) ? value as Record<string, unknown> : null; }
function exactKeys(value: Record<string, unknown>, allowed: string[], path: string, issues: MotionLayoutDebugIssue[]): void { const set = new Set(allowed); Object.keys(value).sort(compareCodeUnits).forEach((key) => { if (!set.has(key)) issues.push(issue(`${path === "/" ? "" : path}/${key}`, "field.unknown", "is not allowed")); }); allowed.forEach((key) => { if (!Object.hasOwn(value, key)) issues.push(issue(`${path === "/" ? "" : path}/${key}`, "field.required", "is required")); }); }
function issue(path: string, code: string, message: string): MotionLayoutDebugIssue { return { path, code, message }; }
function refused(path: string, code: string, message: string): { ok: false; issues: MotionLayoutDebugIssue[] } { return { ok: false, issues: [issue(path, code, message)] }; }
