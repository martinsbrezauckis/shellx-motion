/** Strict, data-only argument parsing for the registered timeline group commands. */
import { nonNegativeIntegerArg, nonNegativeNumberArg, objectArg, ownDataArg, stringArg, stringArrayArg } from "./args.js";

export const TIMELINE_GROUP_COMMANDS = {
  create: "motion.timeline.group.create",
  childAdd: "motion.timeline.group.child.add",
  childRemove: "motion.timeline.group.child.remove",
  childMove: "motion.timeline.group.child.move",
  childReorder: "motion.timeline.group.child.reorder",
  wrap: "motion.timeline.group.wrap",
  unwrap: "motion.timeline.group.unwrap",
  delete: "motion.timeline.group.delete",
  duplicate: "motion.timeline.group.duplicate",
  trim: "motion.timeline.group.trim",
  rootReorder: "motion.timeline.group.root.reorder",
  split: "motion.timeline.group.split"
} as const;

export type TimelineGroupCommand = typeof TIMELINE_GROUP_COMMANDS[keyof typeof TIMELINE_GROUP_COMMANDS];

export type TimelineGroupIntent =
  | { kind: "create"; group: Record<string, unknown>; layerIndex?: number; parentGroupId?: string; childIndex?: number; trackIndex?: number }
  | { kind: "child-add"; groupId: string; childLayerId: string; index?: number }
  | { kind: "child-remove"; groupId: string; childLayerId: string }
  | { kind: "child-move"; sourceGroupId: string | null; destinationGroupId: string; childLayerId: string; index?: number }
  | { kind: "child-reorder"; groupId: string; childLayerId: string; index: number }
  | { kind: "wrap"; group: Record<string, unknown>; childLayerIds: string[] }
  | { kind: "unwrap"; groupId: string }
  | { kind: "delete"; groupId: string; disposition: "cascade" | "unwrap" }
  | { kind: "duplicate"; groupId: string; newGroupId?: string; offsetMs?: number }
  | { kind: "trim"; groupId: string; startMs?: number; durationMs?: number }
  | { kind: "root-reorder"; groupId: string; index: number }
  | { kind: "split"; groupId: string; atMs: number; newGroupId?: string };

export type TimelineGroupIntentParseResult =
  | { ok: true; intent: TimelineGroupIntent }
  | { ok: false; problem: string };

export function readTimelineGroupIntent(command: string, args: unknown): TimelineGroupIntentParseResult | null {
  if (!isTimelineGroupCommand(command)) return null;
  const unknown = unknownArgumentProblem(command, args);
  if (unknown) return problem(unknown);
  if (command === TIMELINE_GROUP_COMMANDS.create) return createIntent(args);
  if (command === TIMELINE_GROUP_COMMANDS.childAdd) return childAddIntent(args);
  if (command === TIMELINE_GROUP_COMMANDS.childRemove) return childRemoveIntent(args);
  if (command === TIMELINE_GROUP_COMMANDS.childMove) return childMoveIntent(args);
  if (command === TIMELINE_GROUP_COMMANDS.childReorder) return childReorderIntent(args);
  if (command === TIMELINE_GROUP_COMMANDS.wrap) return wrapIntent(args);
  if (command === TIMELINE_GROUP_COMMANDS.unwrap) return oneGroupIntent(args, "unwrap");
  if (command === TIMELINE_GROUP_COMMANDS.delete) return deleteIntent(args);
  if (command === TIMELINE_GROUP_COMMANDS.duplicate) return duplicateIntent(args);
  if (command === TIMELINE_GROUP_COMMANDS.trim) return trimIntent(args);
  if (command === TIMELINE_GROUP_COMMANDS.rootReorder) return rootReorderIntent(args);
  return splitIntent(args);
}

export function isTimelineGroupCommand(command: string): command is TimelineGroupCommand {
  return Object.values(TIMELINE_GROUP_COMMANDS).includes(command as TimelineGroupCommand);
}

function createIntent(args: unknown): TimelineGroupIntentParseResult {
  const group = requiredObject(args, "group");
  const layerIndex = optionalIndex(args, "layerIndex");
  const childIndex = optionalIndex(args, "childIndex");
  const trackIndex = optionalIndex(args, "trackIndex");
  if (!group.ok || !layerIndex.ok || !childIndex.ok || !trackIndex.ok) return firstProblem(group, layerIndex, childIndex, trackIndex);
  const parentGroupId = optionalId(args, "parentGroupId");
  if (!parentGroupId.ok) return parentGroupId;
  return ok({ kind: "create", group: group.value, ...optional("layerIndex", layerIndex.value), ...optional("parentGroupId", parentGroupId.value), ...optional("childIndex", childIndex.value), ...optional("trackIndex", trackIndex.value) });
}

function childAddIntent(args: unknown): TimelineGroupIntentParseResult {
  const groupId = requiredId(args, "groupId"); const childLayerId = requiredId(args, "childLayerId"); const index = optionalIndex(args, "index");
  if (!groupId.ok || !childLayerId.ok || !index.ok) return firstProblem(groupId, childLayerId, index);
  return ok({ kind: "child-add", groupId: groupId.value, childLayerId: childLayerId.value, ...optional("index", index.value) });
}

function childRemoveIntent(args: unknown): TimelineGroupIntentParseResult {
  const groupId = requiredId(args, "groupId"); const childLayerId = requiredId(args, "childLayerId");
  if (!groupId.ok || !childLayerId.ok) return firstProblem(groupId, childLayerId);
  return ok({ kind: "child-remove", groupId: groupId.value, childLayerId: childLayerId.value });
}

function childMoveIntent(args: unknown): TimelineGroupIntentParseResult {
  const source = ownDataArg(args, "sourceGroupId");
  if (!source || (source.value !== null && (typeof source.value !== "string" || !source.value.trim()))) {
    return problem("sourceGroupId must be an explicit non-empty string or null.");
  }
  const destinationGroupId = requiredId(args, "destinationGroupId"); const childLayerId = requiredId(args, "childLayerId"); const index = optionalIndex(args, "index");
  if (!destinationGroupId.ok || !childLayerId.ok || !index.ok) return firstProblem(destinationGroupId, childLayerId, index);
  return ok({ kind: "child-move", sourceGroupId: source.value === null ? null : source.value.trim(), destinationGroupId: destinationGroupId.value, childLayerId: childLayerId.value, ...optional("index", index.value) });
}

function childReorderIntent(args: unknown): TimelineGroupIntentParseResult {
  const groupId = requiredId(args, "groupId"); const childLayerId = requiredId(args, "childLayerId"); const index = requiredIndex(args, "index");
  if (!groupId.ok || !childLayerId.ok || !index.ok) return firstProblem(groupId, childLayerId, index);
  return ok({ kind: "child-reorder", groupId: groupId.value, childLayerId: childLayerId.value, index: index.value });
}

function wrapIntent(args: unknown): TimelineGroupIntentParseResult {
  const group = requiredObject(args, "group"); const childLayerIds = requiredIds(args, "childLayerIds");
  if (!group.ok || !childLayerIds.ok) return firstProblem(group, childLayerIds);
  return ok({ kind: "wrap", group: group.value, childLayerIds: childLayerIds.value });
}

function oneGroupIntent(args: unknown, kind: "unwrap"): TimelineGroupIntentParseResult {
  const groupId = requiredId(args, "groupId");
  return groupId.ok ? ok({ kind, groupId: groupId.value }) : groupId;
}

function deleteIntent(args: unknown): TimelineGroupIntentParseResult {
  const groupId = requiredId(args, "groupId"); const disposition = stringArg(args, "disposition");
  if (!groupId.ok) return groupId;
  if (disposition !== "cascade" && disposition !== "unwrap") return problem("disposition must be 'cascade' or 'unwrap'.");
  return ok({ kind: "delete", groupId: groupId.value, disposition });
}

function duplicateIntent(args: unknown): TimelineGroupIntentParseResult {
  const groupId = requiredId(args, "groupId"); const newGroupId = optionalId(args, "newGroupId"); const offsetMs = optionalNonNegativeNumber(args, "offsetMs");
  if (!groupId.ok || !newGroupId.ok || !offsetMs.ok) return firstProblem(groupId, newGroupId, offsetMs);
  return ok({ kind: "duplicate", groupId: groupId.value, ...optional("newGroupId", newGroupId.value), ...optional("offsetMs", offsetMs.value) });
}

function trimIntent(args: unknown): TimelineGroupIntentParseResult {
  const groupId = requiredId(args, "groupId");
  const startMs = optionalNonNegativeNumber(args, "startMs");
  const durationMs = optionalPositiveNumber(args, "durationMs");
  if (!groupId.ok || !startMs.ok || !durationMs.ok) return firstProblem(groupId, startMs, durationMs);
  if (startMs.value === undefined && durationMs.value === undefined) return problem("Group trim requires startMs or durationMs.");
  return ok({ kind: "trim", groupId: groupId.value, ...optional("startMs", startMs.value), ...optional("durationMs", durationMs.value) });
}

function rootReorderIntent(args: unknown): TimelineGroupIntentParseResult {
  const groupId = requiredId(args, "groupId"); const index = requiredIndex(args, "index");
  return groupId.ok && index.ok ? ok({ kind: "root-reorder", groupId: groupId.value, index: index.value }) : firstProblem(groupId, index);
}

function splitIntent(args: unknown): TimelineGroupIntentParseResult {
  const groupId = requiredId(args, "groupId"); const atMs = requiredNonNegativeNumber(args, "atMs"); const newGroupId = optionalId(args, "newGroupId");
  if (!groupId.ok || !atMs.ok || !newGroupId.ok) return firstProblem(groupId, atMs, newGroupId);
  return ok({ kind: "split", groupId: groupId.value, atMs: atMs.value, ...optional("newGroupId", newGroupId.value) });
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

function requiredObject(args: unknown, key: string): Parsed<Record<string, unknown>> {
  const value = objectArg(ownDataArg(args, key)?.value);
  return value ? { ok: true, value: structuredClone(value) } : fail(`${key} must be an object.`);
}

function requiredId(args: unknown, key: string): Parsed<string> {
  const value = stringArg(args, key);
  return value?.trim() ? { ok: true, value: value.trim() } : fail(`${key} must be a non-empty string.`);
}

function optionalId(args: unknown, key: string): Parsed<string | undefined> {
  const entry = ownDataArg(args, key);
  if (!entry || entry.value === undefined) return { ok: true, value: undefined };
  return typeof entry.value === "string" && entry.value.trim() ? { ok: true, value: entry.value.trim() } : fail(`${key} must be a non-empty string when provided.`);
}

function requiredIds(args: unknown, key: string): Parsed<string[]> {
  const value = stringArrayArg(args, key);
  const ids = value?.map((id) => id.trim());
  if (!ids || ids.length === 0 || ids.some((id) => !id) || new Set(ids).size !== ids.length) return fail(`${key} must be unique non-empty strings.`);
  return { ok: true, value: ids };
}

function optionalIndex(args: unknown, key: string): Parsed<number | undefined> {
  const value = nonNegativeIntegerArg(args, key);
  return value === false ? fail(`${key} must be a non-negative integer when provided.`) : { ok: true, value: value ?? undefined };
}

function requiredIndex(args: unknown, key: string): Parsed<number> {
  const value = nonNegativeIntegerArg(args, key);
  return typeof value === "number" ? { ok: true, value } : fail(`${key} must be a non-negative integer.`);
}

function optionalNonNegativeNumber(args: unknown, key: string): Parsed<number | undefined> {
  const value = nonNegativeNumberArg(args, key);
  return value === false ? fail(`${key} must be a non-negative number when provided.`) : { ok: true, value: value ?? undefined };
}

function requiredNonNegativeNumber(args: unknown, key: string): Parsed<number> {
  const value = nonNegativeNumberArg(args, key);
  return typeof value === "number" ? { ok: true, value } : fail(`${key} must be a non-negative finite number.`);
}

function optionalPositiveNumber(args: unknown, key: string): Parsed<number | undefined> {
  const entry = ownDataArg(args, key);
  if (!entry || entry.value === undefined) return { ok: true, value: undefined };
  return typeof entry.value === "number" && Number.isFinite(entry.value) && entry.value > 0
    ? { ok: true, value: entry.value }
    : fail(`${key} must be a positive finite number when provided.`);
}

function unknownArgumentProblem(command: TimelineGroupCommand, args: unknown): string | null {
  const record = objectArg(args);
  if (!record) return "Arguments must be an object.";
  const allowed = new Set(["packageRoot", "outDir", "packageDir", "receiptsRoot", "createdBy", ...commandArgumentNames(command)]);
  const unknown = Object.getOwnPropertyNames(record).find((key) => !allowed.has(key));
  return unknown ? `Unknown argument: ${unknown}.` : null;
}

function commandArgumentNames(command: TimelineGroupCommand): string[] {
  if (command === TIMELINE_GROUP_COMMANDS.create) return ["group", "layerIndex", "parentGroupId", "childIndex", "trackIndex"];
  if (command === TIMELINE_GROUP_COMMANDS.childAdd) return ["groupId", "childLayerId", "index"];
  if (command === TIMELINE_GROUP_COMMANDS.childRemove) return ["groupId", "childLayerId"];
  if (command === TIMELINE_GROUP_COMMANDS.childMove) return ["sourceGroupId", "destinationGroupId", "childLayerId", "index"];
  if (command === TIMELINE_GROUP_COMMANDS.childReorder) return ["groupId", "childLayerId", "index"];
  if (command === TIMELINE_GROUP_COMMANDS.wrap) return ["group", "childLayerIds"];
  if (command === TIMELINE_GROUP_COMMANDS.unwrap) return ["groupId"];
  if (command === TIMELINE_GROUP_COMMANDS.delete) return ["groupId", "disposition"];
  if (command === TIMELINE_GROUP_COMMANDS.duplicate) return ["groupId", "newGroupId", "offsetMs"];
  if (command === TIMELINE_GROUP_COMMANDS.trim) return ["groupId", "startMs", "durationMs"];
  if (command === TIMELINE_GROUP_COMMANDS.rootReorder) return ["groupId", "index"];
  return ["groupId", "atMs", "newGroupId"];
}

function ok(intent: TimelineGroupIntent): TimelineGroupIntentParseResult { return { ok: true, intent }; }
function fail<T>(problem: string): Parsed<T> { return { ok: false, problem }; }
function problem(problem: string): TimelineGroupIntentParseResult { return { ok: false, problem }; }
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> { return value === undefined ? {} : { [key]: value } as Partial<Record<K, V>>; }
function firstProblem(...values: Parsed<unknown>[]): TimelineGroupIntentParseResult { return values.find((value): value is { ok: false; problem: string } => !value.ok) ?? problem("Invalid group arguments."); }
