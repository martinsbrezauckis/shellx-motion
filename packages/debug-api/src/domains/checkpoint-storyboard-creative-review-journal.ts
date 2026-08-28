/** Private root-scoped B1c roster reader: all historical association must validate together. */
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnits } from "@shellx-motion/core";
import { readBinding } from "./checkpoint-storyboard-creative-review-binding-read.js";
import { readCompletion, readIntent, readMember, readMemberHead } from "./checkpoint-storyboard-creative-review-journal-records.js";
import { BINDING_FILE, COMPLETE_FILE, INTENT_FILE, MAX_BINDING_BYTES, MAX_BINDINGS_PER_LINEAGE, MEMBER_FILE, type CreativeReviewCompletion, type CreativeReviewIntent, type CreativeReviewJournal, type CreativeReviewMember, type CreativeReviewMemberHead, type StoredBinding } from "./checkpoint-storyboard-creative-review-types.js";
import { findLineageCreativeReviewsDirectory } from "./checkpoint-storyboard-record-store-authority.js";
import { readSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import { sameIdentity, storeError, type AuthorityFacts, type CheckpointStoryboardRecordIdentity } from "./checkpoint-storyboard-record-store-types.js";

export async function readCreativeReviewJournal(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<CreativeReviewJournal> {
  const directory = await findLineageCreativeReviewsDirectory(facts, root.id);
  if (!directory) return Object.freeze({ bindings: Object.freeze([]), members: Object.freeze([]) });
  const bindingNames: string[] = [], intentNames: string[] = [], completionNames: string[] = [], memberNames: string[] = [];
  let hasHead = false;
  const reader = await opendir(directory.path);
  try {
    for await (const entry of reader) {
      if (!entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review journal contains an unsupported private entry.");
      const accept = (names: string[], limitMessage: string) => {
        if (names.length >= MAX_BINDINGS_PER_LINEAGE) throw storeError("store_integrity_failed", limitMessage);
        names.push(entry.name);
      };
      if (BINDING_FILE.test(entry.name)) accept(bindingNames, "Checkpoint storyboard creative-review roster exceeds its bounded association limit.");
      else if (INTENT_FILE.test(entry.name)) accept(intentNames, "Checkpoint storyboard creative-review intent roster exceeds its bounded limit.");
      else if (COMPLETE_FILE.test(entry.name)) accept(completionNames, "Checkpoint storyboard creative-review completion roster exceeds its bounded limit.");
      else if (MEMBER_FILE.test(entry.name)) accept(memberNames, "Checkpoint storyboard creative-review roster exceeds its bounded membership limit.");
      else if (entry.name === "head.json" && !hasHead) hasHead = true;
      else throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review journal has an unrecognized or duplicate private entry.");
    }
  } finally { await reader.close().catch(() => undefined); }
  const ordinals = memberNames.map((name) => Number(name.slice(0, -5))).sort((left, right) => left - right);
  if (ordinals.some((ordinal, index) => ordinal !== index + 1)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review membership journal has a missing ordinal.");
  if (bindingNames.length === 0 && intentNames.length === 0 && completionNames.length === 0 && ordinals.length === 0 && !hasHead) return Object.freeze({ bindings: Object.freeze([]), members: Object.freeze([]) });
  const bindings = await readBindings(facts, directory.path, root, bindingNames);
  const intents = await readIntents(facts, directory.path, root, intentNames);
  const members = await readMembers(facts, directory.path, root, ordinals, bindings, intents);
  const completions = await readCompletions(facts, directory.path, root, completionNames);
  const head = hasHead ? readMemberHead(await readSignedFile(join(directory.path, "head.json"), facts, MAX_BINDING_BYTES, "record_not_found")) : undefined;
  return finishJournal(root, bindings, intents, members, completions, head);
}

async function readBindings(facts: AuthorityFacts, directory: string, root: CheckpointStoryboardRecordIdentity, names: readonly string[]): Promise<Map<string, StoredBinding>> {
  const bindings = new Map<string, StoredBinding>(), identities = new Set<string>();
  for (const name of [...names].sort()) {
    const match = BINDING_FILE.exec(name);
    const binding = readBinding(await readSignedFile(join(directory, name), facts, MAX_BINDING_BYTES, "record_not_found"));
    if (!match || !sameIdentity(binding.root, root) || binding.identity.id !== match[1] || bindings.has(binding.id) || identities.has(binding.identity.id)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review final binding escaped or duplicated its root roster.");
    bindings.set(binding.id, binding); identities.add(binding.identity.id);
  }
  return bindings;
}

async function readIntents(facts: AuthorityFacts, directory: string, root: CheckpointStoryboardRecordIdentity, names: readonly string[]): Promise<Map<string, CreativeReviewIntent>> {
  const intents = new Map<string, CreativeReviewIntent>();
  for (const name of [...names].sort()) {
    const match = INTENT_FILE.exec(name);
    const intent = readIntent(await readSignedFile(join(directory, name), facts, MAX_BINDING_BYTES, "record_not_found"));
    if (!match || !sameIdentity(intent.root, root) || intent.identity.id !== match[1] || intents.has(intent.binding.id) || [...intents.values()].some((other) => sameIdentity(other.identity, intent.identity))) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review intent escaped or duplicated its root roster.");
    intents.set(intent.binding.id, intent);
  }
  return intents;
}

async function readMembers(facts: AuthorityFacts, directory: string, root: CheckpointStoryboardRecordIdentity, ordinals: readonly number[], bindings: ReadonlyMap<string, StoredBinding>, intents: ReadonlyMap<string, CreativeReviewIntent>): Promise<CreativeReviewMember[]> {
  const members: CreativeReviewMember[] = [];
  for (const ordinal of ordinals) {
    const member = readMember(await readSignedFile(join(directory, `${ordinal}.json`), facts, MAX_BINDING_BYTES, "record_not_found"));
    const binding = bindings.get(member.binding.id), intent = intents.get(member.binding.id), previous = members.at(-1);
    if (!sameIdentity(member.root, root) || member.ordinal !== ordinal || !intent || intent.binding.sha256 !== member.binding.sha256 || !sameIdentity(intent.identity, member.identity) || (binding && (binding.sha256 !== member.binding.sha256 || !sameIdentity(binding.identity, member.identity))) || (ordinal === 1 ? member.previous !== undefined : !member.previous || !previous || member.previous.id !== previous.id || member.previous.sha256 !== previous.sha256)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review membership chain is discontinuous.");
    members.push(member);
  }
  return members;
}

async function readCompletions(facts: AuthorityFacts, directory: string, root: CheckpointStoryboardRecordIdentity, names: readonly string[]): Promise<Map<string, CreativeReviewCompletion>> {
  const completions = new Map<string, CreativeReviewCompletion>();
  for (const name of [...names].sort()) {
    const match = COMPLETE_FILE.exec(name);
    const completion = readCompletion(await readSignedFile(join(directory, name), facts, MAX_BINDING_BYTES, "record_not_found"));
    if (!match || !sameIdentity(completion.root, root) || completion.identity.id !== match[1] || completions.has(completion.binding.id)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review completion escaped or duplicated its root roster.");
    completions.set(completion.binding.id, completion);
  }
  return completions;
}

function finishJournal(root: CheckpointStoryboardRecordIdentity, bindings: ReadonlyMap<string, StoredBinding>, intents: ReadonlyMap<string, CreativeReviewIntent>, members: readonly CreativeReviewMember[], completions: ReadonlyMap<string, CreativeReviewCompletion>, head: CreativeReviewMemberHead | undefined): CreativeReviewJournal {
  const memberByBinding = new Map(members.map((member) => [member.binding.id, member]));
  const pending = [...intents.values()].filter((intent) => !completions.has(intent.binding.id));
  if (pending.length > 1) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review roster has more than one unresolved publication.");
  for (const [bindingId, completion] of completions) {
    const intent = intents.get(bindingId), binding = bindings.get(bindingId), member = memberByBinding.get(bindingId);
    if (!intent || !binding || !member || !sameIdentity(completion.identity, intent.identity) || completion.binding.sha256 !== binding.sha256 || completion.member.id !== member.id || completion.member.sha256 !== member.sha256) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review completion does not bind its exact final and member.");
  }
  for (const [bindingId, binding] of bindings) {
    const intent = intents.get(bindingId), member = memberByBinding.get(bindingId);
    if (!intent || !member || !sameIdentity(intent.identity, binding.identity) || intent.binding.sha256 !== binding.sha256) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review final has no exact signed intent and member.");
  }
  for (const [bindingId] of memberByBinding) {
    if (!intents.has(bindingId)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review member has no exact signed intent.");
    if (completions.has(bindingId) && !bindings.has(bindingId)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review member completion is missing its final.");
  }
  const completedMembers = members.filter((member) => completions.has(member.binding.id));
  if (completedMembers.some((member, index) => member.ordinal !== index + 1)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review completed roster is not an immutable prefix.");
  const current = pending[0], pendingMember = current ? memberByBinding.get(current.binding.id) : undefined, pendingBinding = current ? bindings.get(current.binding.id) : undefined;
  if (pendingMember && pendingMember.ordinal !== members.length) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review unresolved publication is not the immutable roster tail.");
  if (pendingBinding && !pendingMember) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review final is missing its signed member.");
  const tail = members.at(-1);
  const headMatches = (value: CreativeReviewMemberHead | undefined, member: CreativeReviewMember | undefined, phase?: CreativeReviewMemberHead["phase"]) => !!value && !!member && sameIdentity(value.root, root) && value.ordinal === member.ordinal && value.member.id === member.id && value.member.sha256 === member.sha256 && (!phase || value.phase === phase);
  if (!current) {
    if (intents.size !== members.length || bindings.size !== members.length || completions.size !== members.length || (tail ? !headMatches(head, tail, "complete") : !!head)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review final, member roster, completion, and signed head are incomplete.");
  } else if (!pendingMember) {
    const previous = members.at(-1);
    if ((previous ? !headMatches(head, previous, "complete") : !!head) || pendingBinding) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review intent-only publication has inconsistent final or head evidence.");
  } else if (!pendingBinding) {
    const previous = members.at(-2);
    if (!((previous ? headMatches(head, previous, "complete") : !head) || headMatches(head, pendingMember, "preparing"))) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review member publication has a missing or rolled-back signed head.");
  } else if (!(headMatches(head, pendingMember, "preparing") || headMatches(head, pendingMember, "complete"))) {
    throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review final publication has a missing or rolled-back signed head.");
  }
  const publicBindings = Object.freeze([...bindings.values()].sort((left, right) => compareCodeUnits(left.identity.id, right.identity.id)));
  return current ? Object.freeze({ bindings: publicBindings, members: Object.freeze(members), pending: Object.freeze({ intent: current, ...(pendingMember ? { member: pendingMember } : {}), ...(pendingBinding ? { binding: pendingBinding } : {}), ...(head ? { head } : {}) }) }) : Object.freeze({ bindings: publicBindings, members: Object.freeze(members) });
}
