import { canonicalJson, canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { compileMotionBehaviorStaticPlan, type MotionBehaviorStaticPlan } from "./motion-behavior-plan";
import { readMotionBehaviorStore, snapshotMotionBehaviorData } from "./motion-behavior-read";
import { MOTION_BEHAVIORS_SCHEMA, type MotionBehavior, type MotionBehaviorStore } from "./motion-behavior-types";
import { validateMotionBehaviors } from "./motion-behavior-validate";
import type { MotionDocument } from "./types";

export interface MotionBehaviorInspection {
  store: MotionBehaviorStore | null;
  staticPlan: MotionBehaviorStaticPlan;
}

export interface MotionBehaviorMutation {
  action: "upserted" | "removed";
  targetLayerId: string;
  motion: MotionDocument;
  changedPaths: readonly string[];
  beforeSourceSha256: string | null;
  afterSourceSha256: string | null;
  staticPlan: MotionBehaviorStaticPlan;
}

/**
 * Direct-import authoring seam for the persisted behavior store. Inputs are descriptor-snapshotted
 * before any field is read; output uses a newly allocated document and strict code-unit ordering.
 */
export function inspectMotionBehaviors(motion: MotionDocument): MotionBehaviorInspection {
  const checked = checkedStore(motion);
  return Object.freeze({ store: checked.store ? freeze(checked.store) : null, staticPlan: checked.staticPlan });
}

/**
 * Public, document-independent boundary for one upsert binding. It snapshots hostile input and
 * applies the same exact per-shape, evaluator, and nested-data limits as persisted behaviors.
 * Ownership, transform conflicts, duration fit, and locks deliberately need a Motion document.
 */
export function readMotionBehaviorUpsertBinding(value: unknown): MotionBehavior {
  return readMotionBehaviorStore({ schema: MOTION_BEHAVIORS_SCHEMA, bindings: [value] }).bindings[0]!;
}

/** Replaces or inserts exactly one behavior binding; semantic validation precedes the returned copy. */
export function upsertMotionBehavior(motion: MotionDocument, input: unknown): MotionBehaviorMutation {
  const binding = readUpsert(input);
  const current = checkedStore(motion);
  assertTargetEditable(motion, binding.targetLayerId);
  const existing = current.store?.bindings ?? [];
  const index = existing.findIndex((entry) => entry.targetLayerId === binding.targetLayerId);
  if (index >= 0 && canonicalJson(existing[index]) === canonicalJson(binding)) throw new Error(`Motion behavior '${binding.targetLayerId}' did not change.`);
  const bindings = index >= 0 ? existing.map((entry, entryIndex) => entryIndex === index ? binding : entry) : [...existing, binding];
  bindings.sort((left, right) => compareCodeUnits(left.targetLayerId, right.targetLayerId));
  const next = { ...motion, behaviors: { schema: MOTION_BEHAVIORS_SCHEMA, bindings } } as MotionDocument;
  const staticPlan = checkedStore(next).staticPlan;
  const nextIndex = bindings.findIndex((entry) => entry.targetLayerId === binding.targetLayerId);
  return immutableMutation("upserted", binding.targetLayerId, next, [`/behaviors/bindings/${nextIndex}`], sourceSha(current.store), sourceSha(next.behaviors), staticPlan);
}

/** Removes exactly one binding; deleting the final binding omits the root store for legacy identity. */
export function removeMotionBehavior(motion: MotionDocument, input: unknown): MotionBehaviorMutation {
  const targetLayerId = readRemove(input);
  const current = checkedStore(motion);
  const existing = current.store?.bindings ?? [];
  const index = existing.findIndex((entry) => entry.targetLayerId === targetLayerId);
  if (index < 0) throw new Error(`Motion behavior '${targetLayerId}' is absent.`);
  assertTargetEditable(motion, targetLayerId);
  const bindings = existing.filter((_, entryIndex) => entryIndex !== index);
  const next: MotionDocument = bindings.length ? { ...motion, behaviors: { schema: MOTION_BEHAVIORS_SCHEMA, bindings } } : omitBehaviors(motion);
  const staticPlan = checkedStore(next).staticPlan;
  return immutableMutation("removed", targetLayerId, next, bindings.length ? [`/behaviors/bindings/${index}`] : ["/behaviors"], sourceSha(current.store), sourceSha(next.behaviors), staticPlan);
}

function readUpsert(input: unknown): MotionBehavior {
  const record = exactInput(input, ["binding"], "Motion behavior upsert");
  return readMotionBehaviorUpsertBinding(record.binding);
}

function readRemove(input: unknown): string {
  const record = exactInput(input, ["targetLayerId"], "Motion behavior remove");
  if (typeof record.targetLayerId !== "string" || record.targetLayerId.length === 0) throw new Error("Motion behavior remove.targetLayerId must be a non-empty string.");
  return record.targetLayerId;
}

function exactInput(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const snapshot = snapshotMotionBehaviorData(value);
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) throw new Error(`${label} must be an exact plain object.`);
  const record = snapshot as Record<string, unknown>;
  const present = Object.keys(record);
  const unexpected = present.find((key) => !keys.includes(key));
  if (unexpected) throw new Error(`${label} has unknown field '${unexpected}'.`);
  const missing = keys.find((key) => !Object.hasOwn(record, key));
  if (missing) throw new Error(`${label} requires ${missing}.`);
  return record;
}

function checkedStore(motion: MotionDocument): { store: MotionBehaviorStore | undefined; staticPlan: MotionBehaviorStaticPlan } {
  const checked = validateMotionBehaviors(motion.behaviors, motion);
  if (!checked.ok) throw new Error(`Motion behaviors invalid at ${checked.issues[0]!.path}: ${checked.issues[0]!.message}`);
  const plan = compileMotionBehaviorStaticPlan(motion);
  if (!plan.ok) throw new Error(plan.message);
  return { store: checked.store, staticPlan: plan.plan };
}

/** Inspection is read-only; an edit cannot seize a target protected by its layer or track lock. */
function assertTargetEditable(motion: MotionDocument, targetLayerId: string): void {
  const layer = motion.layers.find((candidate) => candidate.id === targetLayerId);
  // Keep the established missing/wrong-target diagnosis under behavior validation. This guard
  // solely adds edit authority checks before an authoring candidate is constructed.
  if (!layer) return;
  if (layer.locked) throw new Error(`Cannot edit locked layer: ${targetLayerId}.`);
  const lockedTrack = (motion.tracks ?? []).find((track) => track.locked && (track.id === layer.trackId || track.layerIds?.includes(layer.id)));
  if (lockedTrack) throw new Error(`Cannot edit behavior on locked track: ${lockedTrack.id}.`);
}

function sourceSha(store: MotionBehaviorStore | undefined): string | null { return store ? canonicalJsonSha256(store) : null; }
function omitBehaviors(motion: MotionDocument): MotionDocument { const { behaviors: _behaviors, ...next } = motion; return next; }
function immutableMutation(action: MotionBehaviorMutation["action"], targetLayerId: string, motion: MotionDocument, changedPaths: readonly string[], beforeSourceSha256: string | null, afterSourceSha256: string | null, staticPlan: MotionBehaviorStaticPlan): MotionBehaviorMutation {
  return Object.freeze({ action, targetLayerId, motion, changedPaths: Object.freeze([...changedPaths]), beforeSourceSha256, afterSourceSha256, staticPlan });
}
function freeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry);
  return Object.freeze(value);
}
