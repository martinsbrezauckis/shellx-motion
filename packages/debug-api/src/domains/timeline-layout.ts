/** Exact transport intents for the bounded Core group-layout Debug adapter. */
import {
  MAX_MOTION_LAYOUT_REPEATERS,
  validateMotionLayoutCompileRequest,
  type MotionLayoutDebugRemoval,
} from "@shellx-motion/core";
export const TIMELINE_LAYOUT_COMMANDS = {
  inspect: "motion.timeline.layout.inspect",
  compile: "motion.timeline.layout.compile",
  apply: "motion.timeline.layout.apply",
  remove: "motion.timeline.layout.remove",
} as const;

export type TimelineLayoutCommand = typeof TIMELINE_LAYOUT_COMMANDS[keyof typeof TIMELINE_LAYOUT_COMMANDS];
export type TimelineLayoutIntent =
  | { kind: "inspect"; packageRoot: string; groupId: string; layout: unknown; repeaters: unknown[] }
  | { kind: "compile"; packageRoot: string; groupId: string; layout: unknown; repeaters: unknown[] }
  | { kind: "apply"; packageRoot: string; groupId: string; layout: unknown; repeaters: unknown[] }
  | { kind: "remove"; packageRoot: string; removal: MotionLayoutDebugRemoval };
export type TimelineLayoutIntentParseResult = { ok: true; intent: TimelineLayoutIntent } | { ok: false; problem: string };

// Layout authority is selected by trusted host services, never command data.
const EDIT_KEYS = ["packageRoot", "outDir", "packageDir", "createdBy"];

export function isTimelineLayoutCommand(command: string): command is TimelineLayoutCommand {
  return Object.values(TIMELINE_LAYOUT_COMMANDS).includes(command as TimelineLayoutCommand);
}

/** Refuses non-data, unknown, and forbidden Motion/createdAt transport fields before a package load. */
export function readTimelineLayoutIntent(command: string, args: unknown): TimelineLayoutIntentParseResult | null {
  if (!isTimelineLayoutCommand(command)) return null;
  const input = strictRecord(args, "Arguments");
  if (!input.ok) return input;
  const mutation = command === TIMELINE_LAYOUT_COMMANDS.apply || command === TIMELINE_LAYOUT_COMMANDS.remove;
  const allowed = command === TIMELINE_LAYOUT_COMMANDS.remove
    ? [...(mutation ? EDIT_KEYS : ["packageRoot"]), "removal"]
    : [...(mutation ? EDIT_KEYS : ["packageRoot"]), "groupId", "layout", "repeaters"];
  const unknown = Object.getOwnPropertyNames(input.value).find((key) => !allowed.includes(key));
  if (unknown) return fail(`Unknown argument: ${unknown}.`);
  const packageRoot = requiredString(input.value.packageRoot, "packageRoot");
  if (!packageRoot.ok) return packageRoot;
  if (command === TIMELINE_LAYOUT_COMMANDS.remove) {
    const removal = readRemoval(input.value.removal);
    return removal.ok ? { ok: true, intent: { kind: "remove", packageRoot: packageRoot.value, removal: removal.value } } : removal;
  }
  const groupId = requiredIdentifier(input.value.groupId, "groupId");
  const layout = strictRecord(input.value.layout, "layout");
  const repeaters = strictArray(input.value.repeaters, "repeaters");
  if (!groupId.ok || !layout.ok || !repeaters.ok) return firstProblem(groupId, layout, repeaters);
  const semantic = validateLayoutPayload(layout.value, repeaters.value);
  if (!semantic.ok) return semantic;
  // The Core boundary correctly rejects cyclic data. `structuredClone`, however,
  // retains harmless aliases, so two repeaters sharing one JSON-shaped delta were
  // later misclassified there as a cycle. Clone each occurrence into inert data
  // before crossing the transport boundary; accessors and non-data fields have
  // already been refused above.
  const payload = {
    packageRoot: packageRoot.value,
    groupId: groupId.value,
    layout: cloneDataWithoutAliases(layout.value) as Record<string, unknown>,
    repeaters: cloneDataWithoutAliases(repeaters.value) as unknown[],
  };
  if (command === TIMELINE_LAYOUT_COMMANDS.inspect) return { ok: true, intent: { kind: "inspect", ...payload } };
  if (command === TIMELINE_LAYOUT_COMMANDS.compile) return { ok: true, intent: { kind: "compile", ...payload } };
  return { ok: true, intent: { kind: "apply", ...payload } };
}

/** Core validates the full closed layout/repeater payload before package loading, using inert probe children only. */
function validateLayoutPayload(layout: Record<string, unknown>, repeaters: unknown[]): Parsed<void> {
  if (repeaters.length > MAX_MOTION_LAYOUT_REPEATERS) return fail(`repeaters must contain at most ${MAX_MOTION_LAYOUT_REPEATERS} items.`);
  const sourceIds = repeaters.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    return typeof (value as Record<string, unknown>).sourceId === "string" ? [(value as Record<string, unknown>).sourceId as string] : [];
  });
  const childIds = sourceIds.length ? sourceIds : ["__layout_probe_child__"];
  let ownerId = "__layout_probe_owner__";
  while (childIds.includes(ownerId)) ownerId += "_";
  const children = childIds.map((id) => ({
    id, sizing: { width: { mode: "fixed", value: 1 }, height: { mode: "fixed", value: 1 } },
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, timing: { startMs: 0, durationMs: 1 },
  }));
  const result = validateMotionLayoutCompileRequest({
    schema: "shellx-motion/layout-compile@1", ownership: { schema: "shellx-motion/layout-ownership-input@1", ownerId, childIds }, layout, children, repeaters,
  });
  return result.ok ? ok(undefined) : fail(result.issues.map((issue) => `${issue.path}: ${issue.code}: ${issue.message}`).join("; "));
}

function requiredString(value: unknown, label: string): Parsed<string> {
  return typeof value === "string" && value.trim().length > 0 ? ok(value) : fail(`${label} must be a non-empty string.`);
}

function requiredIdentifier(value: unknown, label: string): Parsed<string> {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? ok(value) : fail(`${label} must be a 1..128 code-unit string.`);
}

/** A removal names only the document-resident application record; it cannot supply rollback state. */
function readRemoval(value: unknown): Parsed<MotionLayoutDebugRemoval> {
  const removal = strictRecord(value, "removal");
  if (!removal.ok) return removal;
  const unknown = Object.getOwnPropertyNames(removal.value).find((key) => !["schema", "applicationId", "applicationFingerprint"].includes(key));
  if (unknown) return fail(`removal has unknown field ${unknown}.`);
  if (removal.value.schema !== "shellx-motion/debug-layout-removal@1") {
    return fail("removal.schema must equal shellx-motion/debug-layout-removal@1.");
  }
  const applicationId = requiredIdentifier(removal.value.applicationId, "removal.applicationId");
  if (!applicationId.ok) return applicationId;
  if (typeof removal.value.applicationFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(removal.value.applicationFingerprint)) {
    return fail("removal.applicationFingerprint must be a lowercase SHA-256 hex string.");
  }
  return ok({
    schema: "shellx-motion/debug-layout-removal@1",
    applicationId: applicationId.value,
    applicationFingerprint: removal.value.applicationFingerprint,
  });
}

function strictRecord(value: unknown, label: string): Parsed<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(`${label} must be a plain data object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return fail(`${label} must be a plain data object.`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) return fail(`${label}.${key} must be a data property.`);
    const data = strictData(descriptor.value, `${label}.${key}`);
    if (!data.ok) return data;
  }
  return ok(value as Record<string, unknown>);
}

function strictArray(value: unknown, label: string): Parsed<unknown[]> {
  if (!Array.isArray(value)) return fail(`${label} must be an array.`);
  const data = strictData(value, label);
  return data.ok ? ok(value) : data;
}

function strictData(value: unknown, label: string): Parsed<void> {
  if (value === null || typeof value === "string" || typeof value === "boolean") return ok(undefined);
  if (typeof value === "number") return Number.isFinite(value) ? ok(undefined) : fail(`${label} must be finite.`);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) return fail(`${label} has unsupported array property.`);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (key === "length") continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return fail(`${label} has unsupported array property ${key}.`);
      if (!("value" in descriptor)) return fail(`${label}[${key}] must be a data property.`);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return fail(`${label}[${index}] must be present.`);
      const nested = strictData(value[index], `${label}[${index}]`);
      if (!nested.ok) return nested;
    }
    return ok(undefined);
  }
  if (typeof value === "object") {
    const nested = strictRecord(value, label);
    return nested.ok ? ok(undefined) : nested;
  }
  return fail(`${label} must be JSON data.`);
}

/**
 * Produces the JSON value carried by this transport without preserving object
 * aliases. Descriptor reads keep this conversion inert even if a caller tries
 * to supply a getter after the validation pass.
 */
function cloneDataWithoutAliases(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) throw new Error("Validated layout array changed before transport cloning.");
      return cloneDataWithoutAliases(descriptor.value);
    });
  }
  const clone = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) throw new Error("Validated layout object changed before transport cloning.");
    clone[key] = cloneDataWithoutAliases(descriptor.value);
  }
  return clone;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };
function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function fail<T = never>(problem: string): { ok: false; problem: string } { return { ok: false, problem }; }
function firstProblem(...values: Parsed<unknown>[]): { ok: false; problem: string } { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? fail("Invalid layout intent."); }
