import { canonicalJson, canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { compileMotionRelationStaticPlan, type MotionRelationStaticPlan } from "./motion-relation-plan";
import { assertMotionRelationTargetsEditable } from "./motion-relation-authoring-guards";
import { readMotionRelationStore, snapshotMotionRelationData } from "./motion-relation-read";
import { MOTION_RELATIONS_SCHEMA, type MotionRelationBinding, type MotionRelationDocument, type MotionRelationStore } from "./motion-relation-types";
import { validateMotionRelations } from "./motion-relation-validate";

export interface MotionRelationInspection { store: MotionRelationStore | null; staticPlan: MotionRelationStaticPlan }
export interface MotionRelationMutation {
  action: "upserted" | "enabled" | "removed" | "detached";
  relationId: string;
  motion: MotionRelationDocument;
  changedPaths: readonly string[];
  beforeSourceSha256: string | null;
  afterSourceSha256: string | null;
  staticPlan: MotionRelationStaticPlan;
}

/** Direct-import COW seam for document-root relation authoring. */
export function inspectMotionRelations(motion: MotionRelationDocument): MotionRelationInspection {
  const checked = checkedStore(motion);
  return Object.freeze({ store: checked.store ? freeze(checked.store) : null, staticPlan: checked.staticPlan });
}

/** Public, document-independent boundary for exactly one relation binding. */
export function readMotionRelationUpsertBinding(value: unknown): MotionRelationBinding {
  return readMotionRelationStore({ schema: MOTION_RELATIONS_SCHEMA, bindings: [value] }).bindings[0]!;
}

/** Inserts or replaces one relation by stable ID after candidate validation; source bytes remain untouched. */
export function upsertMotionRelation(motion: MotionRelationDocument, input: unknown): MotionRelationMutation {
  const binding = readUpsert(input);
  const current = checkedStore(motion);
  const existing = current.store?.bindings ?? [];
  const index = existing.findIndex((entry) => entry.id === binding.id);
  assertMotionRelationTargetsEditable(motion, [
    ...(index >= 0 ? [existing[index]!.target.layerId] : []),
    binding.target.layerId,
  ]);
  if (index >= 0 && canonicalJson(existing[index]) === canonicalJson(binding)) throw new Error(`Motion relation '${binding.id}' did not change.`);
  const bindings = index < 0 ? [...existing, binding] : existing.map((entry, entryIndex) => entryIndex === index ? binding : entry);
  bindings.sort((left, right) => compareCodeUnits(left.id, right.id));
  const next = withStore(motion, { schema: MOTION_RELATIONS_SCHEMA, bindings });
  const staticPlan = checkedStore(next).staticPlan;
  const nextIndex = bindings.findIndex((entry) => entry.id === binding.id);
  return immutableMutation("upserted", binding.id, next, [`/relations/bindings/${nextIndex}`], sourceSha(current.store), sourceSha(next.relations), staticPlan);
}

/** Changes only the persisted enable bit; disabled bindings still remain validated and reserve their masks. */
export function setMotionRelationEnabled(motion: MotionRelationDocument, input: unknown): MotionRelationMutation {
  const { id, enabled } = readEnabled(input);
  const current = checkedStore(motion);
  const existing = current.store?.bindings ?? [];
  const index = existing.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error(`Motion relation '${id}' is absent.`);
  assertMotionRelationTargetsEditable(motion, [existing[index]!.target.layerId]);
  if (existing[index]!.enabled === enabled) throw new Error(`Motion relation '${id}' did not change.`);
  const bindings = existing.map((entry, entryIndex) => entryIndex === index ? { ...entry, enabled } : entry);
  const next = withStore(motion, { schema: MOTION_RELATIONS_SCHEMA, bindings });
  const staticPlan = checkedStore(next).staticPlan;
  return immutableMutation("enabled", id, next, [`/relations/bindings/${index}/enabled`], sourceSha(current.store), sourceSha(next.relations), staticPlan);
}

/** Removes exactly one relation without baking; the final removal omits the private root for legacy identity. */
export function removeMotionRelation(motion: MotionRelationDocument, input: unknown): MotionRelationMutation {
  return deleteMotionRelation(motion, input, "removed");
}

/** Detach is an explicit transform-preserving removal; it never writes a synthetic final hold. */
export function detachMotionRelation(motion: MotionRelationDocument, input: unknown): MotionRelationMutation {
  return deleteMotionRelation(motion, input, "detached");
}

function deleteMotionRelation(
  motion: MotionRelationDocument,
  input: unknown,
  action: Extract<MotionRelationMutation["action"], "removed" | "detached">,
): MotionRelationMutation {
  const id = readRemove(input);
  const current = checkedStore(motion);
  const existing = current.store?.bindings ?? [];
  const index = existing.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error(`Motion relation '${id}' is absent.`);
  assertMotionRelationTargetsEditable(motion, [existing[index]!.target.layerId]);
  const bindings = existing.filter((_, entryIndex) => entryIndex !== index);
  const next = bindings.length ? withStore(motion, { schema: MOTION_RELATIONS_SCHEMA, bindings }) : omitStore(motion);
  const staticPlan = checkedStore(next).staticPlan;
  return immutableMutation(action, id, next, bindings.length ? [`/relations/bindings/${index}`] : ["/relations"], sourceSha(current.store), sourceSha(next.relations), staticPlan);
}

function readUpsert(input: unknown): MotionRelationBinding {
  const record = exactInput(input, ["binding"], "Motion relation upsert");
  return readMotionRelationUpsertBinding(record.binding);
}
function readEnabled(input: unknown): { id: string; enabled: boolean } {
  const record = exactInput(input, ["id", "enabled"], "Motion relation enabled.set");
  if (typeof record.id !== "string" || record.id.length === 0) throw new Error("Motion relation enabled.set.id must be a non-empty string.");
  if (typeof record.enabled !== "boolean") throw new Error("Motion relation enabled.set.enabled must be boolean.");
  return { id: record.id, enabled: record.enabled };
}
function readRemove(input: unknown): string {
  const record = exactInput(input, ["id"], "Motion relation remove");
  if (typeof record.id !== "string" || record.id.length === 0) throw new Error("Motion relation remove.id must be a non-empty string.");
  return record.id;
}
function exactInput(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const snapshot = snapshotMotionRelationData(value);
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) throw new Error(`${label} must be an exact plain object.`);
  const record = snapshot as Record<string, unknown>, present = Object.keys(record);
  const unexpected = present.find((key) => !keys.includes(key));
  if (unexpected) throw new Error(`${label} has unknown field '${unexpected}'.`);
  const missing = keys.find((key) => !Object.hasOwn(record, key));
  if (missing) throw new Error(`${label} requires ${missing}.`);
  return record;
}
function checkedStore(motion: MotionRelationDocument): { store: MotionRelationStore | undefined; staticPlan: MotionRelationStaticPlan } {
  const checked = validateMotionRelations(motion.relations, motion);
  if (!checked.ok) throw new Error(`Motion relations invalid at ${checked.issues[0]!.path}: ${checked.issues[0]!.message}`);
  const plan = compileMotionRelationStaticPlan(motion);
  if (!plan.ok) throw new Error(plan.message);
  return { store: checked.store, staticPlan: plan.plan };
}
function withStore(motion: MotionRelationDocument, relations: MotionRelationStore): MotionRelationDocument { return { ...structuredClone(motion), relations }; }
function omitStore(motion: MotionRelationDocument): MotionRelationDocument { const { relations: _relations, ...next } = structuredClone(motion); return next; }
function sourceSha(store: MotionRelationStore | undefined): string | null { return store ? canonicalJsonSha256(store) : null; }
function immutableMutation(action: MotionRelationMutation["action"], relationId: string, motion: MotionRelationDocument, changedPaths: readonly string[], beforeSourceSha256: string | null, afterSourceSha256: string | null, staticPlan: MotionRelationStaticPlan): MotionRelationMutation {
  return Object.freeze({ action, relationId, motion, changedPaths: Object.freeze([...changedPaths]), beforeSourceSha256, afterSourceSha256, staticPlan });
}
function freeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}
