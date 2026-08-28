/** Private C6C B2 durable behavior-resolution journal.  This is deliberately separate from
 * B1 materialization bindings: a B2 record never acquires a synthetic B1 state head. */
import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import { validateMotionBehaviors } from "@shellx-motion/core/internal/motion-behavior-validation";
import type { C6B2ExactBase } from "./checkpoint-storyboard-behavior-materialize-private/checkpoint-storyboard-behavior-materialize-receipt-private.js";
import type { CheckpointStoryboardBehaviorMaterializationInstalledOutput } from "./checkpoint-storyboard-behavior-materialize-private/checkpoint-storyboard-behavior-materialize-output-private.js";
import { readSignedFile, replaceSignedFile, syncPrivateDirectory, writeExclusiveSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import { readLineageMembers } from "./checkpoint-storyboard-materialization-bindings.js";
import { readStoredRecordUnlocked } from "./checkpoint-storyboard-record-store-state.js";
import { MAX_STATE_BYTES, SHA256, exact, readIdentity, sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

const MAX_JOURNAL_BYTES = 160 * 1024;
const HANDLE = /^checkpoint_storyboard_behavior_output_[a-f0-9]{32}$/u;
const FILE = /^checkpoint_storyboard_[a-f0-9]{32}\.(?:state|intent|binding|cow-start|detach|abandon)\.json$/u;
const PREFIX = {
  intent: "checkpoint_storyboard_behavior_resolution_intent_",
  cowStart: "checkpoint_storyboard_behavior_resolution_cow_start_",
  binding: "checkpoint_storyboard_behavior_resolution_binding_",
  detach: "checkpoint_storyboard_behavior_resolution_detach_",
  abandon: "checkpoint_storyboard_behavior_resolution_abandon_",
} as const;

export type CheckpointStoryboardBehaviorResolutionState = "unbound" | "preparing" | "bound" | "detached" | "abandoned";
export type BehaviorPlanIdentity = Readonly<{ planFingerprint: string; profileFingerprint: string; storeSha256: string }>;
export type BehaviorOutputIdentity = CheckpointStoryboardBehaviorMaterializationInstalledOutput;
type Ref = Readonly<{ id: string; sha256: string }>;
export type BehaviorIntent = Readonly<{ schema: "shellx-motion/private-checkpoint-storyboard-behavior-resolution-intent@1"; id: string; sha256: string; identity: CheckpointStoryboardRecordIdentity; root: CheckpointStoryboardRecordIdentity; plan: BehaviorPlanIdentity; expectedBase: C6B2ExactBase; outputHandle: string }>;
export type BehaviorCowStart = Readonly<{ schema: "shellx-motion/private-checkpoint-storyboard-behavior-resolution-cow-start@1"; id: string; sha256: string; identity: CheckpointStoryboardRecordIdentity; root: CheckpointStoryboardRecordIdentity; intent: Ref }>;
export type BehaviorBinding = Readonly<{ schema: "shellx-motion/private-checkpoint-storyboard-behavior-resolution-binding@1"; id: string; sha256: string; identity: CheckpointStoryboardRecordIdentity; root: CheckpointStoryboardRecordIdentity; intent: Ref; plan: BehaviorPlanIdentity; source: Readonly<{ expected: C6B2ExactBase; reopened: C6B2ExactBase }>; output: Readonly<{ expected: BehaviorOutputIdentity; reopened: BehaviorOutputIdentity }>; receiptFingerprint: string; outputHandle: string }>;
export type BehaviorDetach = Readonly<{ schema: "shellx-motion/private-checkpoint-storyboard-behavior-resolution-detach@1"; id: string; sha256: string; identity: CheckpointStoryboardRecordIdentity; root: CheckpointStoryboardRecordIdentity; binding: Ref }>;
export type BehaviorAbandon = Readonly<{ schema: "shellx-motion/private-checkpoint-storyboard-behavior-resolution-abandon@1"; id: string; sha256: string; identity: CheckpointStoryboardRecordIdentity; root: CheckpointStoryboardRecordIdentity; intent: Ref; reason: "proven-no-install" | "no-cow-start" }>;
export type BehaviorStateHead = Readonly<{ schema: "shellx-motion/private-checkpoint-storyboard-behavior-resolution-state@1"; identity: CheckpointStoryboardRecordIdentity; root: CheckpointStoryboardRecordIdentity; state: CheckpointStoryboardBehaviorResolutionState; active: 0 | 1; intent?: Ref; cowStart?: Ref; binding?: Ref; detach?: Ref; abandon?: Ref }>;
export type BehaviorResolutionBindingState = Readonly<{ state: CheckpointStoryboardBehaviorResolutionState; active: 0 | 1; bindingId?: string; outputHandle?: string; receiptFingerprint?: string }>;

export function createBehaviorIntent(input: Omit<BehaviorIntent, "id" | "sha256" | "schema">): BehaviorIntent { return seal("intent", "shellx-motion/private-checkpoint-storyboard-behavior-resolution-intent@1", input); }
export function createBehaviorCowStart(input: Omit<BehaviorCowStart, "id" | "sha256" | "schema">): BehaviorCowStart { return seal("cowStart", "shellx-motion/private-checkpoint-storyboard-behavior-resolution-cow-start@1", input); }
export function createBehaviorBinding(input: Omit<BehaviorBinding, "id" | "sha256" | "schema">): BehaviorBinding { return seal("binding", "shellx-motion/private-checkpoint-storyboard-behavior-resolution-binding@1", input); }
export function createBehaviorDetach(input: Omit<BehaviorDetach, "id" | "sha256" | "schema">): BehaviorDetach { return seal("detach", "shellx-motion/private-checkpoint-storyboard-behavior-resolution-detach@1", input); }
export function createBehaviorAbandon(input: Omit<BehaviorAbandon, "id" | "sha256" | "schema">): BehaviorAbandon { return seal("abandon", "shellx-motion/private-checkpoint-storyboard-behavior-resolution-abandon@1", input); }
export function behaviorStateHead(identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, state: CheckpointStoryboardBehaviorResolutionState, active: 0 | 1, refs: Partial<Pick<BehaviorStateHead, "intent" | "cowStart" | "binding" | "detach" | "abandon">> = {}): BehaviorStateHead {
  return Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-behavior-resolution-state@1", identity, root, state, active, ...refs });
}

export async function publishBehaviorIntent(facts: AuthorityFacts, value: BehaviorIntent): Promise<void> { await publishExact(path(facts, value.identity, "intent"), value, facts); }
export async function publishBehaviorCowStart(facts: AuthorityFacts, value: BehaviorCowStart): Promise<void> { await publishExact(path(facts, value.identity, "cow-start"), value, facts); }
export async function publishBehaviorBinding(facts: AuthorityFacts, value: BehaviorBinding): Promise<void> { await publishExact(path(facts, value.identity, "binding"), value, facts); }
export async function publishBehaviorDetach(facts: AuthorityFacts, value: BehaviorDetach): Promise<void> { await publishExact(path(facts, value.identity, "detach"), value, facts); }
export async function publishBehaviorAbandon(facts: AuthorityFacts, value: BehaviorAbandon): Promise<void> { await publishExact(path(facts, value.identity, "abandon"), value, facts); }
export async function publishBehaviorStateHead(facts: AuthorityFacts, value: BehaviorStateHead, afterRename?: () => void | Promise<void>): Promise<void> { await replaceSignedFile(path(facts, value.identity, "state"), value, facts, MAX_STATE_BYTES, afterRename); }
/** Create/revise only: the initial B2 head is immutable unbound evidence until the first legal
 * append-only intent promotion. It is never synthesized after a final target exists. */
export async function initializeBehaviorStateHead(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity): Promise<void> {
  await publishExact(path(facts, identity, "state"), behaviorStateHead(identity, root, "unbound", 0), facts);
}

export async function readBehaviorIntent(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<BehaviorIntent | null> { return await optional(path(facts, identity, "intent"), facts, readIntent); }
export async function readBehaviorCowStart(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<BehaviorCowStart | null> { return await optional(path(facts, identity, "cow-start"), facts, readCowStart); }
export async function readBehaviorBinding(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<BehaviorBinding | null> { return await optional(path(facts, identity, "binding"), facts, readBinding); }
export async function readBehaviorStateHead(facts: AuthorityFacts, identityId: string): Promise<BehaviorStateHead | null> {
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/u.test(identityId)) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior state filename identity is invalid.");
  return await optional(join(facts.behaviorResolutions.path, `${identityId}.state.json`), facts, readStateHead);
}
/** Legacy B1 records must have no B2 behavior-resolution head or phase evidence at all. */
export async function assertNoBehaviorResolutionEvidence(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<void> {
  if (await readBehaviorStateHead(facts, identity.id) || await readBehaviorIntent(facts, identity) || await readBehaviorCowStart(facts, identity) || await readBehaviorBinding(facts, identity) || await optional(path(facts, identity, "detach"), facts, readDetach) || await optional(path(facts, identity, "abandon"), facts, readAbandon)) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard scalar-spatial B1 record has forbidden behavior-resolution evidence.");
  }
}

/** B2 records have a signed unbound head from create/revise onward. Legacy B1 records are the
 * only members permitted to lack one. `allowForwardRecovery` is used solely under the lineage
 * lock by resolve/detach; lifecycle inspection and archive remain read-only and fail closed. */
export async function readBehaviorResolutionState(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, options: { readonly requireHead?: boolean; readonly allowForwardRecovery?: boolean } = {}): Promise<BehaviorResolutionBindingState> {
  const requireHead = options.requireHead ?? false, allowForwardRecovery = options.allowForwardRecovery ?? false;
  const head = await optional(path(facts, identity, "state"), facts, readStateHead);
  const intent = await readBehaviorIntent(facts, identity);
  const start = await readBehaviorCowStart(facts, identity);
  const binding = await readBehaviorBinding(facts, identity);
  const detach = await optional(path(facts, identity, "detach"), facts, readDetach);
  const abandon = await optional(path(facts, identity, "abandon"), facts, readAbandon);
  if (!head) {
    if (!requireHead && !intent && !start && !binding && !detach && !abandon) return Object.freeze({ state: "unbound" as const, active: 0 as const });
    if (intent && !start && !binding && !detach && !abandon && allowForwardRecovery) {
      const next = behaviorStateHead(identity, root, "preparing", 0, { intent: ref(intent) });
      await publishBehaviorStateHead(facts, next);
      return await reopenPromoted(facts, identity, root, next, Object.freeze({ state: "preparing" as const, active: 0 as const, outputHandle: intent.outputHandle }));
    }
    if (intent && !start && !binding && !detach && !abandon) throw storeError("record_commit_uncertain", "Checkpoint storyboard behavior intent is durable but its signed state head was not published; retry resolve or detach for exact recovery.");
    throw storeError("store_integrity_failed", requireHead ? "Checkpoint storyboard behavior record is missing its required signed state head." : "Checkpoint storyboard behavior resolution has phase evidence without a signed state head.");
  }
  if (!sameIdentity(head.identity, identity) || !sameIdentity(head.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior state head does not bind this record lineage.");
  if (!intent) {
    if (start || binding || detach || abandon || head.state !== "unbound" || head.active !== 0 || hasRefs(head)) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior resolution state is not unbound.");
    return checked(facts, head, Object.freeze({ state: "unbound" as const, active: 0 as const }), allowForwardRecovery);
  }
  if (!sameIdentity(intent.identity, identity) || !sameIdentity(intent.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior intent does not bind this record lineage.");
  if (!binding) {
    if (detach || (start && !matchesPhase(start, identity, root, intent)) || (abandon && (!matchesPhase(abandon, identity, root, intent) || (abandon.reason === "no-cow-start" && start) || (abandon.reason === "proven-no-install" && !start)))) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior resolution phase evidence is inconsistent.");
    if (abandon) return checked(facts, head, Object.freeze({ state: "abandoned" as const, active: 0 as const, outputHandle: intent.outputHandle }), allowForwardRecovery, intent, start ?? undefined, undefined, undefined, abandon);
    return checked(facts, head, Object.freeze({ state: "preparing" as const, active: 0 as const, outputHandle: intent.outputHandle }), allowForwardRecovery, intent, start ?? undefined);
  }
  if (!start || abandon || !matchesPhase(start, identity, root, intent) || !sameIdentity(binding.identity, identity) || !sameIdentity(binding.root, root) || !sameRef(binding.intent, ref(intent)) || binding.outputHandle !== intent.outputHandle) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior binding does not bind its immutable intent and COW start.");
  if (!detach) return checked(facts, head, Object.freeze({ state: "bound" as const, active: 1 as const, bindingId: binding.id, outputHandle: binding.outputHandle, receiptFingerprint: binding.receiptFingerprint }), allowForwardRecovery, intent, start, binding);
  if (!sameIdentity(detach.identity, identity) || !sameIdentity(detach.root, root) || !sameRef(detach.binding, ref(binding))) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior detach does not bind its immutable binding.");
  return checked(facts, head, Object.freeze({ state: "detached" as const, active: 0 as const, bindingId: binding.id, outputHandle: binding.outputHandle, receiptFingerprint: binding.receiptFingerprint }), allowForwardRecovery, intent, start, binding, detach);
}

export async function assertLineageHasNoPreparingOrBoundBehaviorResolutions(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, requireHeadsFor = new Set<string>()): Promise<void> {
  const members = await readLineageMembers(facts, root);
  if (members.length === 0) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage has no signed membership records.");
  for (const member of members) {
    if (!sameIdentity(member.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage membership root changed.");
    const state = await readBehaviorResolutionState(facts, member.identity, root, { requireHead: requireHeadsFor.has(member.identity.id) });
    if (state.state === "preparing" || state.state === "bound") throw storeError("materialization_binding_conflict", "Checkpoint storyboard remove/archive requires every signed lineage member to be behavior-unbound or detached.");
  }
}

/** Archive scans the complete namespace, not merely heads selected by a caller.  This catches
 * hidden files, symlinks, names for non-members, and missing signed phase/state pairs. */
export async function assertBehaviorResolutionJournalCompleteForLineage(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, requireHeadsFor = new Set<string>()): Promise<void> {
  const members = await readLineageMembers(facts, root);
  const byId = new Map(members.map((member) => [member.identity.id, member.identity]));
  const reader = await opendir(facts.behaviorResolutions.path);
  try {
    for await (const entry of reader) {
      if (!entry.isFile() || !FILE.test(entry.name)) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior-resolution journal contains an invalid entry.");
      const identityId = entry.name.slice(0, 54), identity = byId.get(identityId), head = await readBehaviorStateHead(facts, identityId);
      if (!head) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior-resolution journal state head is missing.");
      if (head.identity.id !== identityId) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior-resolution journal filename does not match its signed identity.");
      if (identity) {
        if (!requireHeadsFor.has(identity.id)) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior-resolution journal attaches to a sealed scalar-spatial B1 member.");
        if (!sameIdentity(head.root, root) || !sameIdentity(head.identity, identity)) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior-resolution journal state head changed roots or identities.");
      } else {
        const foreignMembers = await readLineageMembers(facts, head.root);
        const foreign = foreignMembers.find((member) => sameIdentity(member.identity, head.identity));
        if (!foreign || !sameIdentity(foreign.root, head.root)) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior-resolution journal references an unknown lineage member.");
        const foreignRecord = await readStoredRecordUnlocked(facts, head.identity);
        if (foreignRecord.admission.profile !== "c6b2-behavior@1") throw storeError("store_integrity_failed", "Checkpoint storyboard behavior-resolution journal attaches to a foreign sealed scalar-spatial B1 member.");
        await readBehaviorResolutionState(facts, head.identity, head.root, { requireHead: true });
      }
    }
  } finally { await reader.close().catch(() => undefined); }
  for (const member of members) await readBehaviorResolutionState(facts, member.identity, root, { requireHead: requireHeadsFor.has(member.identity.id) });
}

function path(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity, suffix: "state" | "intent" | "binding" | "cow-start" | "detach" | "abandon"): string { return join(facts.behaviorResolutions.path, `${identity.id}.${suffix}.json`); }
function ref(value: { readonly id: string; readonly sha256: string }): Ref { return Object.freeze({ id: value.id, sha256: value.sha256 }); }
function sameRef(left: Ref | undefined, right: Ref): boolean { return !!left && left.id === right.id && left.sha256 === right.sha256; }
function hasRefs(head: BehaviorStateHead): boolean { return !!head.intent || !!head.cowStart || !!head.binding || !!head.detach || !!head.abandon; }
function matchesPhase(value: { readonly identity: CheckpointStoryboardRecordIdentity; readonly root: CheckpointStoryboardRecordIdentity; readonly intent: Ref }, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, intent: BehaviorIntent): boolean { return sameIdentity(value.identity, identity) && sameIdentity(value.root, root) && sameRef(value.intent, ref(intent)); }
async function synced(facts: AuthorityFacts, state: BehaviorResolutionBindingState): Promise<BehaviorResolutionBindingState> { try { await syncPrivateDirectory(facts.behaviorResolutions.path); } catch { throw storeError("record_commit_uncertain", "Checkpoint storyboard behavior-resolution state requires a durable directory resync."); } return state; }
async function checked(facts: AuthorityFacts, head: BehaviorStateHead, state: BehaviorResolutionBindingState, allowForwardRecovery: boolean, intent?: BehaviorIntent, cowStart?: BehaviorCowStart, binding?: BehaviorBinding, detach?: BehaviorDetach, abandon?: BehaviorAbandon): Promise<BehaviorResolutionBindingState> {
  const match = (actual: Ref | undefined, value: { readonly id: string; readonly sha256: string } | undefined) => value ? sameRef(actual, ref(value)) : !actual;
  if (!legalHead(head)) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior state head has fields invalid for its durable phase.");
  const exact = head.state === state.state && head.active === state.active && match(head.intent, intent) && match(head.cowStart, cowStart) && match(head.binding, binding) && match(head.detach, detach) && match(head.abandon, abandon);
  if (exact) return await synced(facts, state);
  if (!allowForwardRecovery) throw storeError("record_commit_uncertain", "Checkpoint storyboard behavior phase evidence is one publication ahead of its signed state head; read-only lifecycle inspection will not repair it.");
  const next = behaviorStateHead(head.identity, head.root, state.state, state.active, {
    ...(intent ? { intent: ref(intent) } : {}), ...(cowStart ? { cowStart: ref(cowStart) } : {}), ...(binding ? { binding: ref(binding) } : {}), ...(detach ? { detach: ref(detach) } : {}), ...(abandon ? { abandon: ref(abandon) } : {}),
  });
  const oneStep = (head.state === "unbound" && state.state === "preparing" && !!intent && !cowStart)
    || (head.state === "preparing" && state.state === "preparing" && !!intent && !!cowStart && match(head.intent, intent) && !head.cowStart)
    || (head.state === "preparing" && state.state === "bound" && !!intent && !!cowStart && !!binding && match(head.intent, intent) && match(head.cowStart, cowStart))
    || (head.state === "preparing" && state.state === "abandoned" && !!intent && !!abandon && match(head.intent, intent) && match(head.cowStart, cowStart))
    || (head.state === "bound" && state.state === "detached" && !!intent && !!cowStart && !!binding && !!detach && match(head.intent, intent) && match(head.cowStart, cowStart) && match(head.binding, binding));
  if (!oneStep) throw storeError("store_integrity_failed", "Checkpoint storyboard behavior state head skips, diverges from, or rolls back immutable phase evidence.");
  await publishBehaviorStateHead(facts, next);
  return await reopenPromoted(facts, head.identity, head.root, next, state);
}
function legalHead(head: BehaviorStateHead): boolean {
  return (head.state === "unbound" && head.active === 0 && !hasRefs(head))
    || (head.state === "preparing" && head.active === 0 && !!head.intent && !head.binding && !head.detach && !head.abandon)
    || (head.state === "bound" && head.active === 1 && !!head.intent && !!head.cowStart && !!head.binding && !head.detach && !head.abandon)
    || (head.state === "detached" && head.active === 0 && !!head.intent && !!head.cowStart && !!head.binding && !!head.detach && !head.abandon)
    || (head.state === "abandoned" && head.active === 0 && !!head.intent && !!head.abandon && !head.binding && !head.detach);
}
async function reopenPromoted(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity, expected: BehaviorStateHead, state: BehaviorResolutionBindingState): Promise<BehaviorResolutionBindingState> {
  const reopened = await optional(path(facts, identity, "state"), facts, readStateHead);
  if (!reopened || canonicalJson(reopened) !== canonicalJson(expected)) throw storeError("record_commit_uncertain", "Checkpoint storyboard behavior state head promotion could not be reopened exactly.");
  return await synced(facts, state);
}
async function optional<T>(file: string, facts: AuthorityFacts, parse: (value: unknown) => T): Promise<T | null> { try { return parse(await readSignedFile(file, facts, MAX_JOURNAL_BYTES, "record_not_found")); } catch (error) { if (error instanceof Error && (error as { code?: string }).code === "record_not_found") return null; throw error; } }
async function publishExact(file: string, value: object, facts: AuthorityFacts): Promise<void> { try { await writeExclusiveSignedFile(file, value, facts, MAX_JOURNAL_BYTES); } catch (error) { if (!(error instanceof Error) || (error as { code?: string }).code !== "record_identity_conflict") throw error; const prior = await readSignedFile(file, facts, MAX_JOURNAL_BYTES, "record_not_found"); if (canonicalJson(prior) !== canonicalJson(value)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard immutable behavior-resolution member is occupied by different content."); } }
function seal<K extends keyof typeof PREFIX, S extends string, T extends object>(kind: K, schema: S, payload: T): T & { readonly schema: S; readonly id: string; readonly sha256: string } { const sha256 = sha({ schema, ...payload }); return Object.freeze({ schema, id: `${PREFIX[kind]}${sha256.slice(0, 32)}`, sha256, ...payload }); }
function sha(value: object): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function deterministic(record: Record<string, unknown>, label: string, prefix: string): Ref { const id = string(record, "id", label), sha256 = string(record, "sha256", label); if (!id.startsWith(prefix) || id !== `${prefix}${sha256.slice(0, 32)}` || !SHA256.test(sha256)) throw storeError("store_integrity_failed", `${label} deterministic identity is invalid.`); const { id: _id, sha256: _sha256, ...payload } = record; if (sha(payload) !== sha256) throw storeError("store_integrity_failed", `${label} deterministic hash is invalid.`); return Object.freeze({ id, sha256 }); }
function readIntent(value: unknown): BehaviorIntent { const r = exact(value, ["schema", "id", "sha256", "identity", "root", "plan", "expectedBase", "outputHandle"], "Checkpoint storyboard behavior intent"); if (r.schema !== "shellx-motion/private-checkpoint-storyboard-behavior-resolution-intent@1") bad("behavior intent schema"); const identity = readIdentity(r.identity, "Checkpoint storyboard behavior intent identity"), root = readIdentity(r.root, "Checkpoint storyboard behavior intent root"), plan = readPlan(r.plan, "Checkpoint storyboard behavior intent plan"), expectedBase = readBase(r.expectedBase, "Checkpoint storyboard behavior intent exact base"), outputHandle = string(r, "outputHandle", "Checkpoint storyboard behavior intent"); if (!HANDLE.test(outputHandle)) bad("behavior output handle"); return Object.freeze({ schema: r.schema, ...deterministic(r, "Checkpoint storyboard behavior intent", PREFIX.intent), identity, root, plan, expectedBase, outputHandle }); }
function readCowStart(value: unknown): BehaviorCowStart { const r = exact(value, ["schema", "id", "sha256", "identity", "root", "intent"], "Checkpoint storyboard behavior COW start"); if (r.schema !== "shellx-motion/private-checkpoint-storyboard-behavior-resolution-cow-start@1") bad("behavior COW start schema"); return Object.freeze({ schema: r.schema, ...deterministic(r, "Checkpoint storyboard behavior COW start", PREFIX.cowStart), identity: readIdentity(r.identity, "Checkpoint storyboard behavior COW start identity"), root: readIdentity(r.root, "Checkpoint storyboard behavior COW start root"), intent: readRef(r.intent, "Checkpoint storyboard behavior COW start intent", PREFIX.intent) }); }
function readBinding(value: unknown): BehaviorBinding { const r = exact(value, ["schema", "id", "sha256", "identity", "root", "intent", "plan", "source", "output", "receiptFingerprint", "outputHandle"], "Checkpoint storyboard behavior binding"); if (r.schema !== "shellx-motion/private-checkpoint-storyboard-behavior-resolution-binding@1") bad("behavior binding schema"); const outputHandle = string(r, "outputHandle", "Checkpoint storyboard behavior binding"), receiptFingerprint = string(r, "receiptFingerprint", "Checkpoint storyboard behavior binding"); if (!HANDLE.test(outputHandle) || !SHA256.test(receiptFingerprint)) bad("behavior binding handle or receipt"); const source = pair(r.source, "Checkpoint storyboard behavior binding source", readBase), output = pair(r.output, "Checkpoint storyboard behavior binding output", readOutput); return Object.freeze({ schema: r.schema, ...deterministic(r, "Checkpoint storyboard behavior binding", PREFIX.binding), identity: readIdentity(r.identity, "Checkpoint storyboard behavior binding identity"), root: readIdentity(r.root, "Checkpoint storyboard behavior binding root"), intent: readRef(r.intent, "Checkpoint storyboard behavior binding intent", PREFIX.intent), plan: readPlan(r.plan, "Checkpoint storyboard behavior binding plan"), source, output, receiptFingerprint, outputHandle }); }
function readDetach(value: unknown): BehaviorDetach { const r = exact(value, ["schema", "id", "sha256", "identity", "root", "binding"], "Checkpoint storyboard behavior detach"); if (r.schema !== "shellx-motion/private-checkpoint-storyboard-behavior-resolution-detach@1") bad("behavior detach schema"); return Object.freeze({ schema: r.schema, ...deterministic(r, "Checkpoint storyboard behavior detach", PREFIX.detach), identity: readIdentity(r.identity, "Checkpoint storyboard behavior detach identity"), root: readIdentity(r.root, "Checkpoint storyboard behavior detach root"), binding: readRef(r.binding, "Checkpoint storyboard behavior detach binding", PREFIX.binding) }); }
function readAbandon(value: unknown): BehaviorAbandon { const r = exact(value, ["schema", "id", "sha256", "identity", "root", "intent", "reason"], "Checkpoint storyboard behavior abandonment"); if (r.schema !== "shellx-motion/private-checkpoint-storyboard-behavior-resolution-abandon@1") bad("behavior abandonment schema"); if (r.reason !== "proven-no-install" && r.reason !== "no-cow-start") bad("behavior abandonment reason"); return Object.freeze({ schema: r.schema, ...deterministic(r, "Checkpoint storyboard behavior abandonment", PREFIX.abandon), identity: readIdentity(r.identity, "Checkpoint storyboard behavior abandonment identity"), root: readIdentity(r.root, "Checkpoint storyboard behavior abandonment root"), intent: readRef(r.intent, "Checkpoint storyboard behavior abandonment intent", PREFIX.intent), reason: r.reason }); }
function readStateHead(value: unknown): BehaviorStateHead { const r = exact(value, ["schema", "identity", "root", "state", "active"], ["intent", "cowStart", "binding", "detach", "abandon"], "Checkpoint storyboard behavior state head"); if (r.schema !== "shellx-motion/private-checkpoint-storyboard-behavior-resolution-state@1" || (r.state !== "unbound" && r.state !== "preparing" && r.state !== "bound" && r.state !== "detached" && r.state !== "abandoned") || (r.active !== 0 && r.active !== 1)) bad("behavior state head"); const fields = (key: "intent" | "cowStart" | "binding" | "detach" | "abandon", prefix: string) => Object.hasOwn(r, key) ? readRef(r[key], `Checkpoint storyboard behavior state ${key}`, prefix) : undefined; return Object.freeze({ schema: r.schema, identity: readIdentity(r.identity, "Checkpoint storyboard behavior state identity"), root: readIdentity(r.root, "Checkpoint storyboard behavior state root"), state: r.state, active: r.active, ...(fields("intent", PREFIX.intent) ? { intent: fields("intent", PREFIX.intent) } : {}), ...(fields("cowStart", PREFIX.cowStart) ? { cowStart: fields("cowStart", PREFIX.cowStart) } : {}), ...(fields("binding", PREFIX.binding) ? { binding: fields("binding", PREFIX.binding) } : {}), ...(fields("detach", PREFIX.detach) ? { detach: fields("detach", PREFIX.detach) } : {}), ...(fields("abandon", PREFIX.abandon) ? { abandon: fields("abandon", PREFIX.abandon) } : {}) }); }
function readPlan(value: unknown, label: string): BehaviorPlanIdentity { const r = exact(value, ["planFingerprint", "profileFingerprint", "storeSha256"], label); const planFingerprint = string(r, "planFingerprint", label), profileFingerprint = string(r, "profileFingerprint", label), storeSha256 = string(r, "storeSha256", label); if (![planFingerprint, profileFingerprint, storeSha256].every((item) => SHA256.test(item))) bad(label); return Object.freeze({ planFingerprint, profileFingerprint, storeSha256 }); }
function readBase(value: unknown, label: string): C6B2ExactBase { const r = exact(value, ["packageId", "manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "inventory", "planFingerprint", "profileFingerprint", "storeSha256"], label); const packageId = string(r, "packageId", label); if (!/^[A-Za-z0-9._-]{1,128}$/u.test(packageId)) bad(label); const hashes = ["manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "planFingerprint", "profileFingerprint", "storeSha256"] as const; if (hashes.some((key) => !SHA256.test(string(r, key, label)))) bad(label); const inventory = readInventory(r.inventory, label); return Object.freeze({ packageId, manifestRawSha256: string(r, "manifestRawSha256", label), motionRawSha256: string(r, "motionRawSha256", label), manifestCanonicalSha256: string(r, "manifestCanonicalSha256", label), motionCanonicalSha256: string(r, "motionCanonicalSha256", label), inventory, planFingerprint: string(r, "planFingerprint", label), profileFingerprint: string(r, "profileFingerprint", label), storeSha256: string(r, "storeSha256", label) }); }
function readOutput(value: unknown, label: string): BehaviorOutputIdentity {
  const r = exact(value, ["schema", "receipt", "package", "storyboard", "plan", "profile", "behaviorStore", "materialization"], label);
  // Paths are rejected by field *name*, never by string contents: every valid private schema is
  // slash-qualified.  The output reader already proves canonical package facts; this journal
  // repeats a tight, path-free structural envelope before retaining that identity.
  if (containsForbiddenField(value)) bad(label);
  const receipt = exact(r.receipt, ["schema", "fingerprint"], `${label} receipt`);
  const pkg = exact(r.package, ["id", "manifest", "motion", "currentInventory", "nonReceiptInventory", "preservedLeaves"], `${label} package`);
  exact(pkg.manifest, ["rawSha256", "canonicalSha256"], `${label} manifest`); exact(pkg.motion, ["rawSha256", "canonicalSha256"], `${label} motion`);
  const storyboard = exact(r.storyboard, ["id", "sha256", "revision"], `${label} storyboard`), plan = exact(r.plan, ["fingerprint"], `${label} plan`), profile = exact(r.profile, ["fingerprint"], `${label} profile`), store = exact(r.behaviorStore, ["schema", "sha256", "bindings"], `${label} behavior store`), materialization = exact(r.materialization, ["changedMotionRoot", "changedLeafCount", "renderer"], `${label} materialization`), renderer = exact(materialization.renderer, ["invoked", "pixels"], `${label} renderer`);
  const hashes = [receipt.fingerprint, (pkg.manifest as Record<string, unknown>).rawSha256, (pkg.manifest as Record<string, unknown>).canonicalSha256, (pkg.motion as Record<string, unknown>).rawSha256, (pkg.motion as Record<string, unknown>).canonicalSha256, storyboard.sha256, plan.fingerprint, profile.fingerprint, store.sha256];
  const currentInventory = readInventory(pkg.currentInventory, `${label} current inventory`), nonReceiptInventory = readInventory(pkg.nonReceiptInventory, `${label} non-receipt inventory`);
  const preserved = exact(pkg.preservedLeaves, ["sha256", "count"], `${label} preserved leaves`);
  if (r.schema !== "shellx-motion/private-checkpoint-storyboard-behavior-materialization-installed-output@1" || receipt.schema !== "shellx-motion/private-checkpoint-storyboard-behavior-materialization-receipt@1" || store.schema !== "shellx-motion/behaviors@1" || hashes.some((item) => typeof item !== "string" || !SHA256.test(item)) || renderer.invoked !== false || renderer.pixels !== false || materialization.changedLeafCount !== 2 || materialization.changedMotionRoot !== "behaviors" || typeof pkg.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(pkg.id) || typeof storyboard.id !== "string" || !/^checkpoint_storyboard_[a-f0-9]{32}$/u.test(storyboard.id) || !Number.isSafeInteger(storyboard.revision) || (storyboard.revision as number) < 1 || (storyboard.revision as number) > 1_000_000 || typeof preserved.sha256 !== "string" || !SHA256.test(preserved.sha256) || !Number.isSafeInteger(preserved.count) || (preserved.count as number) < 0 || (preserved.count as number) > 1024 || currentInventory.entryCount !== nonReceiptInventory.entryCount + 1 || currentInventory.leafCount !== nonReceiptInventory.leafCount + 1 || !Array.isArray(store.bindings) || store.bindings.length !== 1) bad(label);
  const behavior = validateMotionBehaviors({ schema: store.schema, bindings: store.bindings }, {
    // Journal audit has no live package authority, but it must still reject a malformed retained
    // behavior store with the same closed reader and numeric ceilings used at installation.
    durationMs: 3_600_000,
    layers: store.bindings.map((binding) => ({ id: typeof (binding as Record<string, unknown>).targetLayerId === "string" ? (binding as Record<string, unknown>).targetLayerId : "", type: "shape", transform: { x: 0, y: 0, rotation: 0, scale: 1 } })),
  });
  if (!behavior.ok || !behavior.store || behavior.store.bindings.length !== 1 || canonicalJsonSha256(behavior.store) !== store.sha256) bad(label);
  const installed = behavior.store.bindings[0]!;
  if (installed.kind !== "transform" || installed.squash !== undefined || !installed.motion || (installed.motion.kind !== "gravity" && installed.motion.kind !== "bounce")) bad(label);
  return Object.freeze(structuredClone(r)) as unknown as BehaviorOutputIdentity;
}
function containsForbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => /(?:path|workspace|approval|authority)/iu.test(key) || containsForbiddenField(child));
}
function pair<T>(value: unknown, label: string, parse: (item: unknown, childLabel: string) => T): Readonly<{ expected: T; reopened: T }> { const r = exact(value, ["expected", "reopened"], label); return Object.freeze({ expected: parse(r.expected, `${label} expected`), reopened: parse(r.reopened, `${label} reopened`) }); }
function readInventory(value: unknown, label: string): C6B2ExactBase["inventory"] { const r = exact(value, ["sha256", "entryCount", "leafCount"], `${label} inventory`); const sha256 = string(r, "sha256", label), entryCount = r.entryCount, leafCount = r.leafCount; if (!SHA256.test(sha256) || typeof entryCount !== "number" || typeof leafCount !== "number" || !Number.isSafeInteger(entryCount) || !Number.isSafeInteger(leafCount) || entryCount < 1 || entryCount > 2048 || leafCount < 1 || leafCount > 1024) bad(label); return Object.freeze({ sha256, entryCount, leafCount }); }
function readRef(value: unknown, label: string, prefix: string): Ref { const r = exact(value, ["id", "sha256"], label); const id = string(r, "id", label), sha256 = string(r, "sha256", label); if (!id.startsWith(prefix) || id !== `${prefix}${sha256.slice(0, 32)}` || !SHA256.test(sha256)) bad(label); return Object.freeze({ id, sha256 }); }
function string(record: Record<string, unknown>, key: string, label: string): string { const value = record[key]; if (typeof value !== "string") bad(label); return value; }
function bad(label: string): never { throw storeError("store_integrity_failed", `${label} is invalid.`); }
