/** Private C6C B1a append-only binding journal: sealed identities and opaque handles only; host
 * paths, approvals, caller bindings, and renderer settings never cross this boundary. */
import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { readSignedFile, replaceSignedFile, syncPrivateDirectory, writeExclusiveSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import { lineageMembersDirectory } from "./checkpoint-storyboard-record-store-authority.js";
import { readOptionalTargetFile } from "./checkpoint-storyboard-record-store-state.js";
import {
  MAX_STATE_BYTES, SHA256, exact, readIdentity, sameIdentity, storeError,
  type AuthorityFacts, type CheckpointStoryboardLineageMemberFile, type CheckpointStoryboardLineageMemberHeadFile,
  type CheckpointStoryboardMaterializationBindingFile, type CheckpointStoryboardMaterializationBindingState,
  type CheckpointStoryboardMaterializationAbandonFile, type CheckpointStoryboardMaterializationCowStartFile, type CheckpointStoryboardMaterializationDetachFile, type CheckpointStoryboardMaterializationIntentFile,
  type CheckpointStoryboardMaterializationStateHeadFile,
  type CheckpointStoryboardMaterializationOutputIdentity, type CheckpointStoryboardMaterializationPackageIdentity, type CheckpointStoryboardMaterializationPlanIdentity,
  type CheckpointStoryboardRecordIdentity,
} from "./checkpoint-storyboard-record-store-types.js";

const HANDLE = /^checkpoint_storyboard_output_[a-f0-9]{32}$/;
/** C6B permits 320 bounded changed-property paths; 128 KiB admits that full canonical binding. */
const MAX_MATERIALIZATION_JOURNAL_BYTES = 128 * 1024;
const PREFIX = {
  intent: "checkpoint_storyboard_materialization_intent_",
  binding: "checkpoint_storyboard_materialization_binding_",
  detach: "checkpoint_storyboard_materialization_detach_",
  cowStart: "checkpoint_storyboard_materialization_cow_start_",
  abandon: "checkpoint_storyboard_materialization_abandon_",
  member: "checkpoint_storyboard_lineage_member_",
} as const;

export function createMaterializationIntent(input: Omit<CheckpointStoryboardMaterializationIntentFile, "id" | "sha256" | "schema">): CheckpointStoryboardMaterializationIntentFile { return seal("intent", "shellx-motion/private-checkpoint-storyboard-materialization-intent@1", input); }
export function createMaterializationBinding(input: Omit<CheckpointStoryboardMaterializationBindingFile, "id" | "sha256" | "schema">): CheckpointStoryboardMaterializationBindingFile { return seal("binding", "shellx-motion/private-checkpoint-storyboard-materialization-binding@1", input); }
export function createMaterializationDetach(input: Omit<CheckpointStoryboardMaterializationDetachFile, "id" | "sha256" | "schema">): CheckpointStoryboardMaterializationDetachFile { return seal("detach", "shellx-motion/private-checkpoint-storyboard-materialization-detach@1", input); }
export function createMaterializationCowStart(input: Omit<CheckpointStoryboardMaterializationCowStartFile, "id" | "sha256" | "schema">): CheckpointStoryboardMaterializationCowStartFile { return seal("cowStart", "shellx-motion/private-checkpoint-storyboard-materialization-cow-start@1", input); }
export function createMaterializationAbandon(input: Omit<CheckpointStoryboardMaterializationAbandonFile, "id" | "sha256" | "schema">): CheckpointStoryboardMaterializationAbandonFile { return seal("abandon", "shellx-motion/private-checkpoint-storyboard-materialization-abandon@1", input); }
export function createLineageMember(root: CheckpointStoryboardRecordIdentity, identity: CheckpointStoryboardRecordIdentity, ordinal: number, previous?: { readonly id: string; readonly sha256: string }): CheckpointStoryboardLineageMemberFile { return seal("member", "shellx-motion/private-checkpoint-storyboard-lineage-member@1", { root, identity, ordinal, ...(previous ? { previous } : {}) }); }

export async function publishLineageMember(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, identity: CheckpointStoryboardRecordIdentity, allowInitialMissingHeadRecovery = false): Promise<void> {
  const directory = await lineageMembersDirectory(facts, root.id);
  const existing = await readLineageMemberJournal(facts, root, allowInitialMissingHeadRecovery, true);
  if (existing.length === 0 && !sameIdentity(identity, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage has no signed root member.");
  if (existing.some((member) => sameIdentity(member.identity, identity))) return;
  if (existing.length >= 128) throw storeError("lineage_limit_exceeded", "Checkpoint storyboard lineage cannot retain more than 128 signed members.");
  const prior = existing.at(-1);
  const member = createLineageMember(root, identity, existing.length + 1, prior ? { id: prior.id, sha256: prior.sha256 } : undefined);
  await publishExact(join(directory.path, `${member.ordinal}.json`), member, facts);
  await publishLineageMemberHead(facts, root, member);
}
/** Run under the lineage lock before a new immutable record is published. */
export async function preflightLineageMemberCapacity(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, identity: CheckpointStoryboardRecordIdentity): Promise<void> {
  const existing = await readLineageMemberJournal(facts, root);
  if (existing.length === 0 && !sameIdentity(identity, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage has no signed root member.");
  if (!existing.some((member) => sameIdentity(member.identity, identity)) && existing.length >= 128) {
    throw storeError("lineage_limit_exceeded", "Checkpoint storyboard lineage cannot retain more than 128 signed members.");
  }
}
export async function publishMaterializationIntent(facts: AuthorityFacts, intent: CheckpointStoryboardMaterializationIntentFile): Promise<void> {
  await publishExact(intentPath(facts, intent.identity), intent, facts);
}
export async function publishMaterializationBinding(facts: AuthorityFacts, binding: CheckpointStoryboardMaterializationBindingFile): Promise<void> {
  await publishExact(bindingPath(facts, binding.identity), binding, facts);
}
export async function publishMaterializationDetach(facts: AuthorityFacts, detach: CheckpointStoryboardMaterializationDetachFile): Promise<void> {
  await publishExact(detachPath(facts, detach.identity), detach, facts);
}
export async function publishMaterializationCowStart(facts: AuthorityFacts, start: CheckpointStoryboardMaterializationCowStartFile): Promise<void> { await publishExact(cowStartPath(facts, start.identity), start, facts); }
export async function publishMaterializationAbandon(facts: AuthorityFacts, abandon: CheckpointStoryboardMaterializationAbandonFile): Promise<void> { await publishExact(abandonPath(facts, abandon.identity), abandon, facts); }
export async function initializeMaterializationStateHead(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity): Promise<void> {
  const head: CheckpointStoryboardMaterializationStateHeadFile = Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-materialization-state@1", identity, root, state: "unbound", active: 0 as const });
  await publishExact(statePath(facts, identity), head, facts);
}
export async function publishMaterializationStateHead(facts: AuthorityFacts, value: CheckpointStoryboardMaterializationStateHeadFile, afterRename?: () => void | Promise<void>): Promise<void> { await replaceSignedFile(statePath(facts, value.identity), value, facts, MAX_STATE_BYTES, afterRename); }

export async function readMaterializationBindingState(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity, root: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardMaterializationBindingState> {
  const head = await optional(statePath(facts, identity), facts, readStateHead);
  if (!head || !sameIdentity(head.identity, identity) || !sameIdentity(head.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard record is missing its required signed materialization state head.");
  const intent = await optional(intentPath(facts, identity), facts, readIntent);
  const binding = await optional(bindingPath(facts, identity), facts, readBinding);
  const detach = await optional(detachPath(facts, identity), facts, readDetach);
  const start = await optional(cowStartPath(facts, identity), facts, readCowStart);
  const abandon = await optional(abandonPath(facts, identity), facts, readAbandon);
  if (!intent) {
    if (binding || detach || start || abandon) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization state has no immutable intent.");
    return await checkedHead(facts, head, Object.freeze({ state: "unbound", active: 0 as const }));
  }
  if (!sameIdentity(intent.identity, identity) || !sameIdentity(intent.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization intent does not bind this record lineage.");
  if (!binding) {
    if (detach) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization detach has no immutable binding.");
    if (start && (!sameIdentity(start.identity, identity) || !sameIdentity(start.root, root) || start.intent.id !== intent.id || start.intent.sha256 !== intent.sha256)) throw storeError("store_integrity_failed", "Checkpoint storyboard COW start does not bind its immutable intent.");
    if (abandon) {
      if (!sameIdentity(abandon.identity, identity) || !sameIdentity(abandon.root, root) || abandon.intent.id !== intent.id || abandon.intent.sha256 !== intent.sha256 || (abandon.reason === "no-cow-start" && start) || (abandon.reason === "proven-no-install" && !start)) throw storeError("store_integrity_failed", "Checkpoint storyboard abandonment does not bind its durable phase evidence.");
      return await checkedHead(facts, head, Object.freeze({ state: "abandoned", active: 0 as const, outputHandle: intent.outputHandle }), abandon, intent, undefined, undefined, start ?? undefined);
    }
    return await checkedHead(facts, head, Object.freeze({ state: "preparing", active: 0 as const, outputHandle: intent.outputHandle }), undefined, intent, undefined, undefined, start ?? undefined);
  }
  if (!start || !sameIdentity(start.identity, identity) || !sameIdentity(start.root, root) || start.intent.id !== intent.id || start.intent.sha256 !== intent.sha256 || abandon || !sameIdentity(binding.identity, identity) || !sameIdentity(binding.root, root) || binding.intent.id !== intent.id || binding.intent.sha256 !== intent.sha256 || binding.outputHandle !== intent.outputHandle) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard materialization binding does not bind its intent.");
  }
  if (!detach) return await checkedHead(facts, head, Object.freeze({ state: "bound", active: 1 as const, bindingId: binding.id, outputHandle: binding.outputHandle }), undefined, intent, binding, undefined, start);
  if (!sameIdentity(detach.identity, identity) || !sameIdentity(detach.root, root) || detach.binding.id !== binding.id || detach.binding.sha256 !== binding.sha256) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard materialization detach does not bind its immutable binding.");
  }
  return await checkedHead(facts, head, Object.freeze({ state: "detached", active: 0 as const, bindingId: binding.id, outputHandle: binding.outputHandle }), undefined, intent, binding, detach, start);
}
/** Archive scanners first use this signed state pointer to select the record's root without
 * reopening a potentially unrelated package or materialization journal. */
export async function readMaterializationStateHead(facts: AuthorityFacts, identityId: string): Promise<CheckpointStoryboardMaterializationStateHeadFile | null> {
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/u.test(identityId)) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization state filename identity is invalid.");
  return await optional(join(facts.bindings.path, `${identityId}.state.json`), facts, readStateHead);
}

export async function readMaterializationIntent(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardMaterializationIntentFile | null> {
  return await optional(intentPath(facts, identity), facts, readIntent);
}
export async function readMaterializationBinding(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardMaterializationBindingFile | null> {
  return await optional(bindingPath(facts, identity), facts, readBinding);
}
export async function readMaterializationCowStart(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardMaterializationCowStartFile | null> { return await optional(cowStartPath(facts, identity), facts, readCowStart); }
export async function readMaterializationAbandon(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardMaterializationAbandonFile | null> { return await optional(abandonPath(facts, identity), facts, readAbandon); }

/** B2 never owns or accepts a legacy B1 materialization journal, including an inert head. */
export async function assertNoLegacyMaterializationEvidence(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<void> {
  if (await readMaterializationStateHead(facts, identity.id) || await readMaterializationIntent(facts, identity) || await readMaterializationBinding(facts, identity) || await readMaterializationCowStart(facts, identity) || await readMaterializationAbandon(facts, identity) || await optional(detachPath(facts, identity), facts, readDetach)) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard behavior record has forbidden legacy B1 materialization evidence.");
  }
}

/** Every member is signed and must be checked before a destructive lineage transition. */
export async function assertLineageHasNoPreparingOrBoundMembers(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<void> {
  const members = await readLineageMemberJournal(facts, root);
  if (members.length === 0) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage has no signed membership records.");
  for (const member of members) {
    if (!sameIdentity(member.root, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage membership root changed.");
    const state = await readMaterializationBindingState(facts, member.identity, root);
    if (state.state === "preparing" || state.state === "bound") throw storeError("materialization_binding_conflict", "Checkpoint storyboard remove/archive requires every signed lineage member to be unbound or detached.");
  }
}
export async function readLineageMembers(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<readonly CheckpointStoryboardLineageMemberFile[]> {
  return await readLineageMemberJournal(facts, root);
}
/** Final lifecycle markers require an already durable roster; never mint one during replay. */
export async function assertLineageMembershipExists(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<void> {
  if ((await readLineageMemberJournal(facts, root)).length === 0) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard finalized lineage is missing its required signed membership journal.");
  }
}

/** Root-scoped append-only ordinal chain, read with a bounded directory stream. */
async function readLineageMemberJournal(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, allowInitialMissingHeadRecovery = false, allowLaggingHeadRecovery = false): Promise<readonly CheckpointStoryboardLineageMemberFile[]> {
  const directory = await lineageMembersDirectory(facts, root.id);
  const names: string[] = [];
  const reader = await opendir(directory.path);
  try {
    for await (const entry of reader) {
      if (!entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage membership contains an invalid entry.");
      if (entry.name === "head.json") continue;
      if (names.length >= 128 || !/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])\.json$/u.test(entry.name)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage membership contains an invalid entry.");
      names.push(entry.name);
    }
  } finally { await reader.close().catch(() => undefined); }
  const ordinals = names.map((name) => Number(name.slice(0, -5))).sort((left, right) => left - right);
  if (ordinals.some((ordinal, index) => ordinal !== index + 1)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage membership journal has a missing ordinal.");
  const members: CheckpointStoryboardLineageMemberFile[] = [];
  for (const ordinal of ordinals) {
    const member = readMember(await readSignedFile(join(directory.path, `${ordinal}.json`), facts, MAX_STATE_BYTES, "record_not_found"));
    if (!sameIdentity(member.root, root) || member.ordinal !== ordinal || (ordinal === 1 ? member.previous !== undefined || !sameIdentity(member.identity, root) : !member.previous || member.previous.id !== members.at(-1)!.id || member.previous.sha256 !== members.at(-1)!.sha256)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage membership chain is discontinuous.");
    members.push(member);
  }
  const head = await optional(join(directory.path, "head.json"), facts, readMemberHead);
  if (members.length === 0) {
    if (head) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage membership head exists without a signed first member.");
    return Object.freeze(members);
  }
  if (head && (!sameIdentity(head.root, root) || head.ordinal > members.length || head.member.id !== members[head.ordinal - 1]!.id || head.member.sha256 !== members[head.ordinal - 1]!.sha256)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage membership head is ahead of or conflicts with the signed ordinal journal.");
  // Only the first root member before a final lifecycle marker may have no signed head. Once a
  // lineage is established, head deletion is rollback evidence and must not hide descendants.
  if (!head) {
    if (!allowInitialMissingHeadRecovery || members.length !== 1 || !sameIdentity(members[0]!.identity, root) || await readOptionalTargetFile(facts, root)) {
      throw storeError("store_integrity_failed", "Checkpoint storyboard signed lineage membership head is missing.");
    }
    await publishLineageMemberHead(facts, root, members.at(-1)!);
  } else if (head.ordinal < members.length) {
    if (!allowLaggingHeadRecovery) throw storeError("store_integrity_failed", "Checkpoint storyboard signed lineage membership head is behind the immutable ordinal journal.");
    for (const member of members.slice(head.ordinal)) {
      if (await readOptionalTargetFile(facts, member.identity)) throw storeError("store_integrity_failed", "Checkpoint storyboard signed lineage membership head cannot skip a finalized member.");
    }
    await publishLineageMemberHead(facts, root, members.at(-1)!);
  }
  else {
    try { await syncPrivateDirectory(directory.path); }
    catch { throw storeError("record_commit_uncertain", "Checkpoint storyboard lineage membership head requires a durable directory resync before it can be accepted."); }
  }
  return Object.freeze(members);
}

async function publishLineageMemberHead(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity, member: CheckpointStoryboardLineageMemberFile): Promise<void> {
  const directory = await lineageMembersDirectory(facts, root.id);
  const prior = await optional(join(directory.path, "head.json"), facts, readMemberHead);
  if (member.ordinal === 1 ? prior !== null : prior && (!sameIdentity(prior.root, root) || prior.ordinal >= member.ordinal)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage member head cannot advance discontinuously.");
  const head: CheckpointStoryboardLineageMemberHeadFile = Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-lineage-member-head@1", root, ordinal: member.ordinal, member: Object.freeze({ id: member.id, sha256: member.sha256 }) });
  await replaceSignedFile(join(directory.path, "head.json"), head, facts, MAX_STATE_BYTES);
}

function intentPath(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): string { return join(facts.bindings.path, `${identity.id}.intent.json`); }
function statePath(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): string { return join(facts.bindings.path, `${identity.id}.state.json`); }
function bindingPath(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): string { return join(facts.bindings.path, `${identity.id}.binding.json`); }
function detachPath(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): string { return join(facts.bindings.path, `${identity.id}.detach.json`); }
function cowStartPath(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): string { return join(facts.bindings.path, `${identity.id}.cow-start.json`); }
function abandonPath(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): string { return join(facts.bindings.path, `${identity.id}.abandon.json`); }

async function optional<T>(path: string, facts: AuthorityFacts, parse: (value: unknown) => T): Promise<T | null> {
  try { return parse(await readSignedFile(path, facts, MAX_MATERIALIZATION_JOURNAL_BYTES, "record_not_found")); }
  catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "record_not_found") return null;
    throw error;
  }
}
async function publishExact(path: string, value: object, facts: AuthorityFacts): Promise<void> {
  try { await writeExclusiveSignedFile(path, value, facts, MAX_MATERIALIZATION_JOURNAL_BYTES); }
  catch (error) {
    if (!(error instanceof Error) || (error as { code?: string }).code !== "record_identity_conflict") throw error;
    const existing = await readSignedFile(path, facts, MAX_MATERIALIZATION_JOURNAL_BYTES, "record_not_found");
    if (canonicalJson(existing) !== canonicalJson(value)) throw storeError("materialization_binding_conflict", "Checkpoint storyboard immutable binding member is already occupied by different content.");
  }
}
function seal<K extends keyof typeof PREFIX, S extends string, T extends object>(kind: K, schema: S, payload: T): T & { readonly schema: S; readonly id: string; readonly sha256: string } {
  const hash = sha({ schema, ...payload });
  return Object.freeze({ schema, id: `${PREFIX[kind]}${hash.slice(0, 32)}`, sha256: hash, ...payload });
}
function sha(value: object): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function hash(record: Record<string, unknown>, label: string, prefix: string): { id: string; sha256: string } {
  const id = valueString(record, "id", label); const sha256 = valueString(record, "sha256", label);
  if (!id.startsWith(prefix) || id !== `${prefix}${sha256.slice(0, 32)}` || !SHA256.test(sha256)) throw storeError("store_integrity_failed", `${label} deterministic identity is invalid.`);
  const { id: _id, sha256: _sha, ...payload } = record;
  if (sha(payload) !== sha256) throw storeError("store_integrity_failed", `${label} deterministic hash is invalid.`);
  return { id, sha256 };
}
function readIntent(value: unknown): CheckpointStoryboardMaterializationIntentFile {
  const record = exact(value, ["schema", "id", "sha256", "identity", "root", "plan", "expectedBase", "outputHandle"], "Checkpoint storyboard materialization intent");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-materialization-intent@1") throw storeError("store_integrity_failed", "Checkpoint storyboard materialization intent schema is invalid.");
  const identity = readIdentity(record.identity, "Checkpoint storyboard materialization intent identity"); const root = readIdentity(record.root, "Checkpoint storyboard materialization intent root");
  const plan = readPlan(record.plan, "Checkpoint storyboard materialization intent plan"); const expectedBase = readPackage(record.expectedBase, "Checkpoint storyboard materialization intent expected base");
  const outputHandle = valueString(record, "outputHandle", "Checkpoint storyboard materialization intent"); if (!HANDLE.test(outputHandle)) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization output handle is invalid.");
  const deterministic = hash(record, "Checkpoint storyboard materialization intent", PREFIX.intent);
  return Object.freeze({ schema: record.schema, ...deterministic, identity, root, plan, expectedBase, outputHandle });
}
function readBinding(value: unknown): CheckpointStoryboardMaterializationBindingFile {
  const record = exact(value, ["schema", "id", "sha256", "identity", "root", "intent", "plan", "source", "output", "c6b1bReceiptFingerprint", "outputHandle"], "Checkpoint storyboard materialization binding");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-materialization-binding@1") throw storeError("store_integrity_failed", "Checkpoint storyboard materialization binding schema is invalid.");
  const identity = readIdentity(record.identity, "Checkpoint storyboard materialization binding identity"); const root = readIdentity(record.root, "Checkpoint storyboard materialization binding root");
  const intent = readReference(record.intent, "Checkpoint storyboard materialization binding intent", PREFIX.intent);
  const plan = readPlan(record.plan, "Checkpoint storyboard materialization binding plan");
  const source = readPair(record.source, "Checkpoint storyboard materialization binding source"); const output = readOutputPair(record.output, "Checkpoint storyboard materialization binding output");
  const c6b1bReceiptFingerprint = valueString(record, "c6b1bReceiptFingerprint", "Checkpoint storyboard materialization binding"); if (!SHA256.test(c6b1bReceiptFingerprint)) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization receipt fingerprint is invalid.");
  const outputHandle = valueString(record, "outputHandle", "Checkpoint storyboard materialization binding"); if (!HANDLE.test(outputHandle)) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization output handle is invalid.");
  const deterministic = hash(record, "Checkpoint storyboard materialization binding", PREFIX.binding);
  return Object.freeze({ schema: record.schema, ...deterministic, identity, root, intent, plan, source, output, c6b1bReceiptFingerprint, outputHandle });
}
function readDetach(value: unknown): CheckpointStoryboardMaterializationDetachFile {
  const record = exact(value, ["schema", "id", "sha256", "identity", "root", "binding"], "Checkpoint storyboard materialization detach");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-materialization-detach@1") throw storeError("store_integrity_failed", "Checkpoint storyboard materialization detach schema is invalid.");
  const identity = readIdentity(record.identity, "Checkpoint storyboard materialization detach identity"); const root = readIdentity(record.root, "Checkpoint storyboard materialization detach root");
  const binding = readReference(record.binding, "Checkpoint storyboard materialization detach binding", PREFIX.binding); const deterministic = hash(record, "Checkpoint storyboard materialization detach", PREFIX.detach);
  return Object.freeze({ schema: record.schema, ...deterministic, identity, root, binding });
}
function readCowStart(value: unknown): CheckpointStoryboardMaterializationCowStartFile {
  const record = exact(value, ["schema", "id", "sha256", "identity", "root", "intent"], "Checkpoint storyboard COW start"); if (record.schema !== "shellx-motion/private-checkpoint-storyboard-materialization-cow-start@1") throw storeError("store_integrity_failed", "Checkpoint storyboard COW start schema is invalid.");
  const identity = readIdentity(record.identity, "Checkpoint storyboard COW start identity"), root = readIdentity(record.root, "Checkpoint storyboard COW start root"), intent = readReference(record.intent, "Checkpoint storyboard COW start intent", PREFIX.intent), deterministic = hash(record, "Checkpoint storyboard COW start", PREFIX.cowStart);
  return Object.freeze({ schema: record.schema, ...deterministic, identity, root, intent });
}
function readAbandon(value: unknown): CheckpointStoryboardMaterializationAbandonFile {
  const record = exact(value, ["schema", "id", "sha256", "identity", "root", "intent", "reason"], "Checkpoint storyboard materialization abandonment"); if (record.schema !== "shellx-motion/private-checkpoint-storyboard-materialization-abandon@1") throw storeError("store_integrity_failed", "Checkpoint storyboard materialization abandonment schema is invalid.");
  const identity = readIdentity(record.identity, "Checkpoint storyboard materialization abandonment identity"), root = readIdentity(record.root, "Checkpoint storyboard materialization abandonment root"), intent = readReference(record.intent, "Checkpoint storyboard materialization abandonment intent", PREFIX.intent), reason = record.reason;
  if (reason !== "proven-no-install" && reason !== "no-cow-start") throw storeError("store_integrity_failed", "Checkpoint storyboard materialization abandonment reason is invalid.");
  const deterministic = hash(record, "Checkpoint storyboard materialization abandonment", PREFIX.abandon); return Object.freeze({ schema: record.schema, ...deterministic, identity, root, intent, reason });
}
function readStateHead(value: unknown): CheckpointStoryboardMaterializationStateHeadFile {
  const record = exact(value, ["schema", "identity", "root", "state", "active"], ["intent", "cowStart", "binding", "detach", "abandon"], "Checkpoint storyboard materialization state head");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-materialization-state@1" || (record.state !== "unbound" && record.state !== "preparing" && record.state !== "bound" && record.state !== "detached" && record.state !== "abandoned") || (record.active !== 0 && record.active !== 1)) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization state head is invalid.");
  const intent = Object.hasOwn(record, "intent") ? readReference(record.intent, "Checkpoint storyboard materialization state intent", PREFIX.intent) : undefined, cowStart = Object.hasOwn(record, "cowStart") ? readReference(record.cowStart, "Checkpoint storyboard materialization state COW start", PREFIX.cowStart) : undefined, binding = Object.hasOwn(record, "binding") ? readReference(record.binding, "Checkpoint storyboard materialization state binding", PREFIX.binding) : undefined, detach = Object.hasOwn(record, "detach") ? readReference(record.detach, "Checkpoint storyboard materialization state detach", PREFIX.detach) : undefined, abandon = Object.hasOwn(record, "abandon") ? readReference(record.abandon, "Checkpoint storyboard materialization state abandonment", PREFIX.abandon) : undefined;
  return Object.freeze({ schema: record.schema, identity: readIdentity(record.identity, "Checkpoint storyboard materialization state identity"), root: readIdentity(record.root, "Checkpoint storyboard materialization state root"), state: record.state, active: record.active, ...(intent ? { intent } : {}), ...(cowStart ? { cowStart } : {}), ...(binding ? { binding } : {}), ...(detach ? { detach } : {}), ...(abandon ? { abandon } : {}) });
}
async function checkedHead(facts: AuthorityFacts, head: CheckpointStoryboardMaterializationStateHeadFile, state: CheckpointStoryboardMaterializationBindingState, abandon?: CheckpointStoryboardMaterializationAbandonFile, intent?: CheckpointStoryboardMaterializationIntentFile, binding?: CheckpointStoryboardMaterializationBindingFile, detach?: CheckpointStoryboardMaterializationDetachFile, cowStart?: CheckpointStoryboardMaterializationCowStartFile): Promise<CheckpointStoryboardMaterializationBindingState> {
  const sameReference = (actual: { readonly id: string; readonly sha256: string } | undefined, expected: { readonly id: string; readonly sha256: string } | undefined) => expected ? !!actual && actual.id === expected.id && actual.sha256 === expected.sha256 : !actual;
  const headShapeIsLegal = (head.state === "unbound" && head.active === 0 && !head.intent && !head.cowStart && !head.binding && !head.detach && !head.abandon)
    || (head.state === "preparing" && head.active === 0 && !!head.intent && !head.binding && !head.detach && !head.abandon)
    || (head.state === "bound" && head.active === 1 && !!head.intent && !!head.cowStart && !!head.binding && !head.detach && !head.abandon)
    || (head.state === "detached" && head.active === 0 && !!head.intent && !!head.cowStart && !!head.binding && !!head.detach && !head.abandon)
    || (head.state === "abandoned" && head.active === 0 && !!head.intent && !!head.abandon && !head.binding && !head.detach);
  if (!headShapeIsLegal) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization state head has fields invalid for its durable phase.");
  const matches = head.state === state.state && head.active === state.active && sameReference(head.intent, intent) && sameReference(head.cowStart, cowStart) && sameReference(head.binding, binding) && sameReference(head.detach, detach) && sameReference(head.abandon, abandon);
  if (matches) { await syncBindingDirectory(facts); return state; }
  const priorIntentMatches = sameReference(head.intent, intent);
  const legalPromotion = (head.state === "unbound" && state.state === "preparing" && intent)
    || (head.state === "preparing" && state.state === "preparing" && intent && priorIntentMatches && !head.cowStart && !!cowStart)
    || (head.state === "preparing" && state.state === "bound" && intent && binding && cowStart && priorIntentMatches && sameReference(head.cowStart, cowStart))
    || (head.state === "preparing" && state.state === "abandoned" && intent && abandon && priorIntentMatches && sameReference(head.cowStart, cowStart))
    || (head.state === "bound" && state.state === "detached" && intent && binding && detach && cowStart && priorIntentMatches && sameReference(head.cowStart, cowStart));
  if (!legalPromotion) throw storeError("store_integrity_failed", "Checkpoint storyboard materialization state head does not bind its append-only evidence.");
  const next: CheckpointStoryboardMaterializationStateHeadFile = Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-materialization-state@1", identity: head.identity, root: head.root, state: state.state, active: state.active, ...(intent ? { intent: { id: intent.id, sha256: intent.sha256 } } : {}), ...(cowStart ? { cowStart: { id: cowStart.id, sha256: cowStart.sha256 } } : {}), ...(binding ? { binding: { id: binding.id, sha256: binding.sha256 } } : {}), ...(detach ? { detach: { id: detach.id, sha256: detach.sha256 } } : {}), ...(abandon ? { abandon: { id: abandon.id, sha256: abandon.sha256 } } : {}) });
  await publishMaterializationStateHead(facts, next);
  const reopened = await optional(statePath(facts, head.identity), facts, readStateHead);
  if (!reopened || canonicalJson(reopened) !== canonicalJson(next)) throw storeError("record_commit_uncertain", "Checkpoint storyboard materialization state head promotion could not be reopened exactly.");
  return state;
}
async function syncBindingDirectory(facts: AuthorityFacts): Promise<void> { try { await syncPrivateDirectory(facts.bindings.path); } catch { throw storeError("record_commit_uncertain", "Checkpoint storyboard materialization state head requires a durable bindings-directory resync before it can be accepted."); } }
function readMember(value: unknown): CheckpointStoryboardLineageMemberFile {
  const record = exact(value, ["schema", "id", "sha256", "root", "identity", "ordinal"], ["previous"], "Checkpoint storyboard lineage member");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-lineage-member@1") throw storeError("store_integrity_failed", "Checkpoint storyboard lineage member schema is invalid.");
  const root = readIdentity(record.root, "Checkpoint storyboard lineage member root"); const identity = readIdentity(record.identity, "Checkpoint storyboard lineage member identity"); const ordinal = number(record, "ordinal", "Checkpoint storyboard lineage member", 1, 128); const previous = Object.hasOwn(record, "previous") ? readReference(record.previous, "Checkpoint storyboard lineage member previous", PREFIX.member) : undefined; const deterministic = hash(record, "Checkpoint storyboard lineage member", PREFIX.member);
  return Object.freeze({ schema: record.schema, ...deterministic, root, identity, ordinal, ...(previous ? { previous } : {}) });
}
function readMemberHead(value: unknown): CheckpointStoryboardLineageMemberHeadFile {
  const record = exact(value, ["schema", "root", "ordinal", "member"], "Checkpoint storyboard lineage member head");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-lineage-member-head@1") throw storeError("store_integrity_failed", "Checkpoint storyboard lineage member head schema is invalid.");
  return Object.freeze({ schema: record.schema, root: readIdentity(record.root, "Checkpoint storyboard lineage member head root"), ordinal: number(record, "ordinal", "Checkpoint storyboard lineage member head", 1, 128), member: readReference(record.member, "Checkpoint storyboard lineage member head reference", PREFIX.member) });
}
function readPlan(value: unknown, label: string): CheckpointStoryboardMaterializationPlanIdentity {
  const record = exact(value, ["c6b1aPlanFingerprint", "c6b1aLowererProfileFingerprint", "c6b1bMaterializerProfileFingerprint", "c6b1bProjectionFingerprint"], label);
  const result = Object.fromEntries(Object.keys(record).map((key) => [key, valueString(record, key, label)]));
  if (Object.values(result).some((value) => !SHA256.test(value))) throw storeError("store_integrity_failed", `${label} is invalid.`);
  return Object.freeze(result) as CheckpointStoryboardMaterializationPlanIdentity;
}
function readPackage(value: unknown, label: string): CheckpointStoryboardMaterializationPackageIdentity {
  const record = exact(value, ["packageId", "manifestRawSha256", "motionRawSha256", "manifestCanonicalSha256", "motionCanonicalSha256", "inventory", "c6aPlanFingerprint", "c6b1bProfileFingerprint", "c6b1bProjectionFingerprint"], label);
  const packageId = valueString(record, "packageId", label); if (!/^[A-Za-z0-9._-]{1,128}$/.test(packageId)) throw storeError("store_integrity_failed", `${label} package identity is invalid.`);
  const result = { packageId, manifestRawSha256: valueString(record, "manifestRawSha256", label), motionRawSha256: valueString(record, "motionRawSha256", label), manifestCanonicalSha256: valueString(record, "manifestCanonicalSha256", label), motionCanonicalSha256: valueString(record, "motionCanonicalSha256", label), inventory: readInventory(record.inventory, `${label} inventory`), c6aPlanFingerprint: valueString(record, "c6aPlanFingerprint", label), c6b1bProfileFingerprint: valueString(record, "c6b1bProfileFingerprint", label), c6b1bProjectionFingerprint: valueString(record, "c6b1bProjectionFingerprint", label) };
  if ([result.manifestRawSha256, result.motionRawSha256, result.manifestCanonicalSha256, result.motionCanonicalSha256, result.c6aPlanFingerprint, result.c6b1bProfileFingerprint, result.c6b1bProjectionFingerprint].some((item) => !SHA256.test(item))) throw storeError("store_integrity_failed", `${label} hashes are invalid.`);
  return Object.freeze(result);
}
function readPair(value: unknown, label: string) { const record = exact(value, ["expected", "reopened"], label); return Object.freeze({ expected: readPackage(record.expected, `${label} expected`), reopened: readPackage(record.reopened, `${label} reopened`) }); }
function readOutputPair(value: unknown, label: string) { const record = exact(value, ["expected", "reopened"], label); return Object.freeze({ expected: readOutput(record.expected, `${label} expected`), reopened: readOutput(record.reopened, `${label} reopened`) }); }
function readOutput(value: unknown, label: string): CheckpointStoryboardMaterializationOutputIdentity {
  const record = exact(value, ["packageId", "manifestRawSha256", "motionRawSha256", "canonicalMotionSha256", "nonReceiptInventory", "preservedLeaves", "changed"], label);
  const packageId = valueString(record, "packageId", label); if (!/^[A-Za-z0-9._-]{1,128}$/.test(packageId)) throw storeError("store_integrity_failed", `${label} package identity is invalid.`);
  const manifestRawSha256 = valueString(record, "manifestRawSha256", label), motionRawSha256 = valueString(record, "motionRawSha256", label), canonicalMotionSha256 = valueString(record, "canonicalMotionSha256", label);
  if (![manifestRawSha256, motionRawSha256, canonicalMotionSha256].every((item) => SHA256.test(item))) throw storeError("store_integrity_failed", `${label} hash is invalid.`);
  const preserved = exact(record.preservedLeaves, ["sha256", "count"], `${label} preserved leaves`); const preservedLeaves = { sha256: valueString(preserved, "sha256", `${label} preserved leaves`), count: number(preserved, "count", `${label} preserved leaves`, 1, 1_024) }; if (!SHA256.test(preservedLeaves.sha256)) throw storeError("store_integrity_failed", `${label} preserved leaf hash is invalid.`);
  const changedRecord = exact(record.changed, ["paths", "count", "motionPropertyPaths", "motionPropertyPathCount"], `${label} changed`);
  const paths = strings(changedRecord.paths, `${label} changed paths`, 2); const motionPropertyPaths = strings(changedRecord.motionPropertyPaths, `${label} changed property paths`, 320);
  if (changedRecord.count !== 2 || changedRecord.motionPropertyPathCount !== motionPropertyPaths.length || paths.length !== 2 || motionPropertyPaths.length < 1) throw storeError("store_integrity_failed", `${label} changed identity is invalid.`);
  return Object.freeze({ packageId, manifestRawSha256, motionRawSha256, canonicalMotionSha256, nonReceiptInventory: readInventory(record.nonReceiptInventory, `${label} non-receipt inventory`), preservedLeaves: Object.freeze(preservedLeaves), changed: Object.freeze({ paths: Object.freeze(paths), count: 2 as const, motionPropertyPaths: Object.freeze(motionPropertyPaths), motionPropertyPathCount: motionPropertyPaths.length }) });
}
function readInventory(value: unknown, label: string) { const record = exact(value, ["sha256", "entryCount", "leafCount"], label); const sha256 = valueString(record, "sha256", label); const entryCount = number(record, "entryCount", label, 1, 2_048), leafCount = number(record, "leafCount", label, 1, 1_024); if (!SHA256.test(sha256)) throw storeError("store_integrity_failed", `${label} hash is invalid.`); return Object.freeze({ sha256, entryCount, leafCount }); }
function strings(value: unknown, label: string, maximum: number): string[] { if (!Array.isArray(value) || value.length < 1 || value.length > maximum || value.some((item) => typeof item !== "string") || value.some((item, index) => index > 0 && (value[index - 1] as string) >= item)) throw storeError("store_integrity_failed", `${label} is invalid.`); return [...value]; }
function number(record: Record<string, unknown>, key: string, label: string, min: number, max: number): number { const value = record[key]; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw storeError("store_integrity_failed", `${label}.${key} is invalid.`); return value; }
function readReference(value: unknown, label: string, prefix: string) { const record = exact(value, ["id", "sha256"], label); const id = valueString(record, "id", label); const sha256 = valueString(record, "sha256", label); if (!id.startsWith(prefix) || id !== `${prefix}${sha256.slice(0, 32)}` || !SHA256.test(sha256)) throw storeError("store_integrity_failed", `${label} is invalid.`); return Object.freeze({ id, sha256 }); }
function valueString(record: Record<string, unknown>, key: string, label: string): string { const value = record[key]; if (typeof value !== "string") throw storeError("store_integrity_failed", `${label}.${key} is invalid.`); return value; }
