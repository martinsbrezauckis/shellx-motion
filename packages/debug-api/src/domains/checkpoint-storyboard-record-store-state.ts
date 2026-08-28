/** Immutable record/event codecs and derived target/lineage state. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import {
  admitCheckpointStoryboardC6CRecordProfile,
  admitCheckpointStoryboardScalarSpatialRecordProfile,
  readCheckpointStoryboard,
  type CheckpointStoryboard,
} from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import { readSignedFile, writeExclusiveSignedFile } from "./checkpoint-storyboard-record-store-signed-files.js";
import { assertAuthorityLive } from "./checkpoint-storyboard-record-store-authority.js";
import {
  MAX_LINEAGE_ANCESTRY_DEPTH, MAX_RECORD_BYTES, MAX_STATE_BYTES, SHA256, exact, isNotFound, readEvidence, readIdentity, sameEvidence, sameIdentity, storeError,
  type ArchiveFile, type AuthorityFacts, type CheckpointStoryboardRecordAdmission, type CheckpointStoryboardRecordIdentity, type CheckpointStoryboardRecordOperationEvidence, type CheckpointStoryboardRecordProfile, type CheckpointStoryboardRecordTargetState,
  type CheckpointStoryboardStoredRecord, type LineageFile, type OperationEvidenceFile, type StoredRecordFile, type TargetFile, type TombstoneFile,
} from "./checkpoint-storyboard-record-store-types.js";

export function identityFor(storyboard: CheckpointStoryboard): CheckpointStoryboardRecordIdentity { return Object.freeze({ id: storyboard.id, sha256: storyboard.sha256, revision: storyboard.revision }); }
export function activeTarget(identity: CheckpointStoryboardRecordIdentity, evidence: CheckpointStoryboardRecordOperationEvidence): TargetFile {
  return Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-record-target@1", identity, state: "active", activeMaterializationBindings: 0 as const, evidence });
}
export function storedFile(record: CheckpointStoryboardStoredRecord): StoredRecordFile { return Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-record@1", storyboard: record.storyboard, lineage: record.lineage, admission: record.admission }); }
export function recordPath(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): string { return join(facts.records.path, `${identity.id}.json`); }
function targetPath(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): string { return join(facts.targets.path, `${identity.id}.active.json`); }
function tombstonePath(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): string { return join(facts.targets.path, `${identity.id}.tombstone.json`); }
function lineagePath(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): string { return join(facts.lineages.path, `${root.id}.open.json`); }
function archivePath(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): string { return join(facts.lineages.path, `${root.id}.archive.json`); }
function operationEvidencePath(facts: AuthorityFacts, id: string): string { return join(facts.receipts.path, `${id}.json`); }

export async function readStoredRecordUnlocked(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardStoredRecord> {
  await assertAuthorityLive(facts);
  const file = await readRecordFile(facts, identity);
  await assertCompleteLineageAncestry(facts, file);
  const target = await readTargetFile(facts, identity);
  let lineage: LineageFile;
  try { lineage = await readLineageFile(facts, file.lineage.root); }
  catch (error) {
    if (isNotFound(error)) throw storeError("store_integrity_failed", "Checkpoint storyboard immutable record is missing its required lineage journal.");
    throw error;
  }
  if (!sameIdentity(lineage.root, file.lineage.root)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage root does not match its immutable record.");
  return materializeStored(file, target, lineage);
}
/** Archive-only bounded scanner entrypoint. The private filename is grammar-checked before any
 * record facts are reopened, so a global directory stream cannot escape its selected store. */
export async function readImmutableRecordFromPrivateNameUnlocked(facts: AuthorityFacts, name: string): Promise<{ readonly identity: CheckpointStoryboardRecordIdentity; readonly file: StoredRecordFile }> {
  const match = /^(checkpoint_storyboard_[a-f0-9]{32})\.json$/u.exec(name);
  if (!match) throw storeError("store_integrity_failed", "Checkpoint storyboard immutable record directory contains an invalid entry.");
  const raw = await readSignedFile(join(facts.records.path, name), facts, MAX_RECORD_BYTES, "record_not_found");
  const record = exact(raw, ["schema", "storyboard", "lineage", "admission"], "Checkpoint storyboard immutable record");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-record@1") throw storeError("store_integrity_failed", "Checkpoint storyboard immutable record schema is invalid.");
  const admitted = readAdmittedRecordProfile(record.storyboard, record.admission);
  const storyboard = admitted.storyboard;
  const identity = identityFor(storyboard);
  if (identity.id !== match[1]) throw storeError("store_integrity_failed", "Checkpoint storyboard immutable record filename does not match its sealed identity.");
  const lineage = readLineageRecord(record.lineage, storyboard);
  return Object.freeze({ identity, file: Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-record@1", storyboard, lineage, admission: admitted.admission }) });
}
export async function readStoredRecordFromPrivateNameUnlocked(facts: AuthorityFacts, name: string): Promise<CheckpointStoryboardStoredRecord> {
  return await readStoredRecordUnlocked(facts, (await readImmutableRecordFromPrivateNameUnlocked(facts, name)).identity);
}
/** Immutable-only preflight: callers use it solely to locate a lineage lock before derived-state reads. */
export async function readImmutableRecordRoot(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<CheckpointStoryboardRecordIdentity> {
  await assertAuthorityLive(facts);
  return (await readRecordFile(facts, identity)).lineage.root;
}
/** Reopens immutable lineage journals without treating an interrupted active marker as a lost record. */
export async function readImmutableRecordLineage(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<LineageFile> {
  await assertAuthorityLive(facts);
  const record = await readRecordFile(facts, identity);
  await assertCompleteLineageAncestry(facts, record);
  let lineage: LineageFile;
  try { lineage = await readLineageFile(facts, record.lineage.root); }
  catch (error) {
    if (isNotFound(error)) throw storeError("store_integrity_failed", "Checkpoint storyboard immutable record is missing its required lineage journal.");
    throw error;
  }
  if (!sameIdentity(lineage.root, record.lineage.root)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage root does not match its immutable record.");
  return lineage;
}
export async function readOptionalRecordFile(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<StoredRecordFile | null> { try { return await readRecordFile(facts, identity); } catch (error) { return isNotFound(error) ? null : Promise.reject(error); } }
export async function readOptionalTargetFile(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<TargetFile | null> { try { return await readTargetFile(facts, identity); } catch (error) { return isNotFound(error) ? null : Promise.reject(error); } }
export async function hasTombstone(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<boolean> { return (await readOptionalTombstoneFile(facts, identity)) !== null; }
export async function ensureLineage(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<LineageFile> {
  try { return await readLineageFile(facts, root); }
  catch (error) {
    if (!isNotFound(error)) throw error;
    const candidate: LineageFile = Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-lineage@1", root, terminal: false });
    try { await writeExclusiveSignedFile(lineagePath(facts, root), candidate, facts, MAX_STATE_BYTES); return candidate; }
    catch (writeError) {
      if (!(writeError instanceof Error) || writeError.name !== "CheckpointStoryboardRecordStoreError" || (writeError as { code?: string }).code !== "record_identity_conflict") throw writeError;
      return await readLineageFile(facts, root);
    }
  }
}
export async function publishRecord(facts: AuthorityFacts, record: StoredRecordFile): Promise<void> { await writeExclusiveSignedFile(recordPath(facts, identityFor(record.storyboard)), record, facts, MAX_RECORD_BYTES); }
export async function publishFinalTarget(facts: AuthorityFacts, target: TargetFile): Promise<void> { await writeExclusiveSignedFile(targetPath(facts, target.identity), target, facts, MAX_STATE_BYTES); }
export async function publishFinalTombstone(facts: AuthorityFacts, tombstone: TombstoneFile): Promise<void> { await writeExclusiveSignedFile(tombstonePath(facts, tombstone.identity), tombstone, facts, MAX_STATE_BYTES); }
export async function publishFinalArchive(facts: AuthorityFacts, archive: ArchiveFile): Promise<void> { await writeExclusiveSignedFile(archivePath(facts, archive.root), archive, facts, MAX_STATE_BYTES); }
export async function prepareOperationEvidence(facts: AuthorityFacts, operation: CheckpointStoryboardRecordOperationEvidence["operation"], record: StoredRecordFile, targetState: CheckpointStoryboardRecordTargetState, lineageTerminal: boolean): Promise<CheckpointStoryboardRecordOperationEvidence> {
  const identity = identityFor(record.storyboard);
  const payload = { schema: "shellx-motion/private-checkpoint-storyboard-record-operation@1" as const, operation, identity, targetState, lineageTerminal, admission: record.admission };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  const evidence: OperationEvidenceFile = Object.freeze({ ...payload, id: `checkpoint_storyboard_operation_${sha256.slice(0, 32)}`, sha256 });
  try { await writeExclusiveSignedFile(operationEvidencePath(facts, evidence.id), evidence, facts, MAX_STATE_BYTES); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== "CheckpointStoryboardRecordStoreError" || (error as { code?: string }).code !== "record_identity_conflict") throw error;
    const existing = await readOperationEvidenceFile(facts, evidence.id);
    if (canonicalJson(existing) !== canonicalJson(evidence)) throw storeError("record_identity_conflict", "Checkpoint storyboard operation evidence identity is occupied by different content.");
  }
  return Object.freeze({ id: evidence.id, sha256: evidence.sha256, operation: evidence.operation });
}

async function readRecordFile(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<StoredRecordFile> {
  const raw = await readSignedFile(recordPath(facts, identity), facts, MAX_RECORD_BYTES, "record_not_found");
  const record = exact(raw, ["schema", "storyboard", "lineage", "admission"], "Checkpoint storyboard immutable record");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-record@1") throw storeError("store_integrity_failed", "Checkpoint storyboard immutable record schema is invalid.");
  const admitted = readAdmittedRecordProfile(record.storyboard, record.admission);
  const storyboard = admitted.storyboard;
  if (!sameIdentity(identityFor(storyboard), identity)) throw storeError("store_integrity_failed", "Checkpoint storyboard immutable record identity does not match its exact target.");
  const lineage = readLineageRecord(record.lineage, storyboard);
  return Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-record@1", storyboard, lineage, admission: admitted.admission });
}
/**
 * Reopen each immutable parent under the already-held lineage lock. The fixed cap prevents a
 * hostile but individually valid record chain from turning ordinary inspect/revise into unbounded
 * host work; a later batch can offer an explicit audited rebase when a lineage approaches it.
 */
async function assertCompleteLineageAncestry(facts: AuthorityFacts, leaf: StoredRecordFile): Promise<void> {
  const expectedRoot = leaf.lineage.root;
  let current = leaf;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_LINEAGE_ANCESTRY_DEPTH; depth += 1) {
    const identity = identityFor(current.storyboard);
    const key = `${identity.id}:${identity.sha256}:${identity.revision}`;
    if (seen.has(key) || !sameIdentity(current.lineage.root, expectedRoot)) throw storeError("store_integrity_failed", "Checkpoint storyboard immutable lineage is cyclic or changes root while reopening.");
    seen.add(key);
    const parent = current.lineage.parent;
    if (!parent) {
      if (!sameIdentity(identity, expectedRoot) || identity.revision !== 1 || expectedRoot.revision !== 1) throw storeError("store_integrity_failed", "Checkpoint storyboard immutable lineage root is not its exact initial revision.");
      return;
    }
    if (parent.revision !== identity.revision - 1) throw storeError("store_integrity_failed", "Checkpoint storyboard immutable lineage revision chain is not consecutive.");
    try { current = await readRecordFile(facts, parent); }
    catch (error) {
      if (isNotFound(error)) throw storeError("store_integrity_failed", "Checkpoint storyboard immutable lineage is missing a required parent record.");
      throw error;
    }
  }
  throw storeError("store_integrity_failed", `Checkpoint storyboard immutable lineage exceeds the ${MAX_LINEAGE_ANCESTRY_DEPTH}-member host reopening limit.`);
}
async function readTargetFile(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<TargetFile> {
  const active = readTargetRecord(await readSignedFile(targetPath(facts, identity), facts, MAX_STATE_BYTES, "record_not_found"), identity);
  const evidence = await readRequiredOperationEvidenceFile(facts, active.evidence.id, "active target");
  if (!sameEvidence(evidence, active.evidence) || !sameIdentity(evidence.identity, identity) || evidence.targetState !== "active" || evidence.lineageTerminal || (evidence.operation !== "timeline.checkpoint-storyboard.create" && evidence.operation !== "timeline.checkpoint-storyboard.revise")) throw storeError("store_integrity_failed", "Checkpoint storyboard active target does not bind its immutable create/revise evidence.");
  const tombstone = await readOptionalTombstoneFile(facts, identity);
  if (!tombstone) return active;
  const removal = await readRequiredOperationEvidenceFile(facts, tombstone.evidence.id, "tombstone");
  if (!sameEvidence(removal, tombstone.evidence) || removal.operation !== "timeline.checkpoint-storyboard.remove" || !sameIdentity(removal.identity, identity) || removal.targetState !== "tombstoned" || removal.lineageTerminal) throw storeError("store_integrity_failed", "Checkpoint storyboard tombstone does not bind its immutable operation evidence.");
  return Object.freeze({ ...active, state: "tombstoned" as const });
}
async function readLineageFile(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<LineageFile> {
  const open = readLineageFileRecord(await readSignedFile(lineagePath(facts, root), facts, MAX_STATE_BYTES, "record_not_found"), root);
  const archive = await readOptionalArchiveFile(facts, root);
  if (!archive) return open;
  const evidence = await readRequiredOperationEvidenceFile(facts, archive.evidence.id, "archive");
  const initiating = await readRecordFile(facts, evidence.identity);
  if (!sameEvidence(evidence, archive.evidence) || evidence.operation !== "timeline.checkpoint-storyboard.archive" || !sameIdentity(initiating.lineage.root, archive.root) || !evidence.lineageTerminal) throw storeError("store_integrity_failed", "Checkpoint storyboard archive does not bind its immutable operation evidence.");
  return Object.freeze({ ...open, terminal: true as const });
}
async function readOperationEvidenceFile(facts: AuthorityFacts, id: string): Promise<OperationEvidenceFile> {
  const record = exact(await readSignedFile(operationEvidencePath(facts, id), facts, MAX_STATE_BYTES, "record_not_found"), ["schema", "id", "sha256", "operation", "identity", "targetState", "lineageTerminal", "admission"], "Checkpoint storyboard operation evidence");
  if (record.schema !== "shellx-motion/private-checkpoint-storyboard-record-operation@1" || record.id !== id || typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || (record.operation !== "timeline.checkpoint-storyboard.create" && record.operation !== "timeline.checkpoint-storyboard.revise" && record.operation !== "timeline.checkpoint-storyboard.remove" && record.operation !== "timeline.checkpoint-storyboard.archive") || (record.targetState !== "active" && record.targetState !== "tombstoned") || typeof record.lineageTerminal !== "boolean") throw storeError("store_integrity_failed", "Checkpoint storyboard operation evidence is invalid.");
  const identity = readIdentity(record.identity, "Checkpoint storyboard operation identity");
  const admission = exact(record.admission, ["staticProfileAdmitted"], ["profile"], "Checkpoint storyboard operation admission");
  if (admission.staticProfileAdmitted !== true) throw storeError("store_integrity_failed", "Checkpoint storyboard operation evidence lacks static-profile admission.");
  if (admission.profile !== undefined && !isRecordProfile(admission.profile)) throw storeError("store_integrity_failed", "Checkpoint storyboard operation evidence profile partition is invalid.");
  const sealedAdmission: CheckpointStoryboardRecordAdmission = Object.freeze({ staticProfileAdmitted: true as const, ...(admission.profile ? { profile: admission.profile } : {}) });
  const payload = { schema: record.schema, operation: record.operation, identity, targetState: record.targetState, lineageTerminal: record.lineageTerminal, admission: sealedAdmission };
  const sha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (sha256 !== record.sha256 || id !== `checkpoint_storyboard_operation_${sha256.slice(0, 32)}`) throw storeError("store_integrity_failed", "Checkpoint storyboard operation evidence identity is stale.");
  return Object.freeze({ ...payload, id, sha256 }) as OperationEvidenceFile;
}
async function readRequiredOperationEvidenceFile(facts: AuthorityFacts, id: string, reference: string): Promise<OperationEvidenceFile> {
  try { return await readOperationEvidenceFile(facts, id); }
  catch (error) {
    if (isNotFound(error)) throw storeError("store_integrity_failed", `Checkpoint storyboard ${reference} is missing its required immutable operation evidence.`);
    throw error;
  }
}
async function readOptionalTombstoneFile(facts: AuthorityFacts, identity: CheckpointStoryboardRecordIdentity): Promise<TombstoneFile | null> {
  try {
    const record = exact(await readSignedFile(tombstonePath(facts, identity), facts, MAX_STATE_BYTES, "record_not_found"), ["schema", "identity", "evidence"], "Checkpoint storyboard tombstone");
    if (record.schema !== "shellx-motion/private-checkpoint-storyboard-record-tombstone@1") throw storeError("store_integrity_failed", "Checkpoint storyboard tombstone schema is invalid.");
    const found = readIdentity(record.identity, "Checkpoint storyboard tombstone identity");
    if (!sameIdentity(found, identity)) throw storeError("store_integrity_failed", "Checkpoint storyboard tombstone target identity is invalid.");
    return Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-record-tombstone@1", identity: found, evidence: readEvidence(record.evidence) });
  } catch (error) { return isNotFound(error) ? null : Promise.reject(error); }
}
async function readOptionalArchiveFile(facts: AuthorityFacts, root: CheckpointStoryboardRecordIdentity): Promise<ArchiveFile | null> {
  try {
    const record = exact(await readSignedFile(archivePath(facts, root), facts, MAX_STATE_BYTES, "record_not_found"), ["schema", "root", "evidence"], "Checkpoint storyboard archive");
    if (record.schema !== "shellx-motion/private-checkpoint-storyboard-lineage-archive@1") throw storeError("store_integrity_failed", "Checkpoint storyboard archive schema is invalid.");
    const found = readIdentity(record.root, "Checkpoint storyboard archive root");
    if (!sameIdentity(found, root)) throw storeError("store_integrity_failed", "Checkpoint storyboard archive root identity is invalid.");
    return Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-lineage-archive@1", root: found, evidence: readEvidence(record.evidence) });
  } catch (error) { return isNotFound(error) ? null : Promise.reject(error); }
}
function materializeStored(file: StoredRecordFile, target: TargetFile, lineage: LineageFile): CheckpointStoryboardStoredRecord { const identity = identityFor(file.storyboard); if (!sameIdentity(target.identity, identity)) throw storeError("store_integrity_failed", "Checkpoint storyboard target state does not match its immutable record."); return Object.freeze({ identity, storyboard: file.storyboard, lineage: file.lineage, target: Object.freeze({ state: target.state, activeMaterializationBindings: 0 as const }), archive: Object.freeze({ terminal: lineage.terminal }), admission: file.admission }); }
function readAdmittedRecordProfile(storyboardValue: unknown, admissionValue: unknown): { readonly storyboard: CheckpointStoryboard; readonly admission: CheckpointStoryboardRecordAdmission } {
  const raw = exact(admissionValue, ["staticProfileAdmitted"], ["profile"], "Checkpoint storyboard admission");
  if (raw.staticProfileAdmitted !== true) throw storeError("store_integrity_failed", "Checkpoint storyboard record lacks static-profile admission evidence.");
  const declared = raw.profile;
  let storyboard: CheckpointStoryboard;
  try {
    if (declared === undefined) storyboard = admitCheckpointStoryboardScalarSpatialRecordProfile(readCheckpointStoryboard(storyboardValue));
    else {
      if (!isRecordProfile(declared)) throw new Error("invalid profile");
      const reopened = admitCheckpointStoryboardC6CRecordProfile(readCheckpointStoryboard(storyboardValue));
      if (reopened.profile !== declared) throw new Error("sealed profile mismatch");
      storyboard = reopened.storyboard;
    }
  } catch { throw storeError("store_integrity_failed", "Checkpoint storyboard immutable record no longer passes its sealed C6 profile partition."); }
  return Object.freeze({ storyboard, admission: Object.freeze({ staticProfileAdmitted: true as const, ...(declared ? { profile: declared } : {}) }) });
}
function isRecordProfile(value: unknown): value is Exclude<CheckpointStoryboardRecordProfile, "c6b1-scalar-spatial@1"> {
  return value === "c6b2-behavior@1" || value === "c6b3-relation@1" || value === "c6b4-relation-action@1" || value === "c6b5-lifecycle@1" || value === "c6b6-geometry-morph@1" || value === "c6b7-retained-trace@1";
}
function readLineageRecord(value: unknown, storyboard: CheckpointStoryboard): StoredRecordFile["lineage"] { const raw = exact(value, ["root"], ["parent"], "Checkpoint storyboard record lineage"); const root = readIdentity(raw.root, "Checkpoint storyboard record lineage root"); const parent = Object.hasOwn(raw, "parent") ? readIdentity(raw.parent, "Checkpoint storyboard record lineage parent") : undefined; const declared = storyboard.parentRevision; if (declared ? !parent || parent.id !== declared.id || parent.sha256 !== declared.sha256 || parent.revision !== storyboard.revision - 1 : parent || !sameIdentity(root, identityFor(storyboard))) throw storeError("store_integrity_failed", "Checkpoint storyboard immutable lineage does not match its sealed parent revision."); return Object.freeze({ root, ...(parent ? { parent } : {}) }); }
function readTargetRecord(value: unknown, expected: CheckpointStoryboardRecordIdentity): TargetFile { const raw = exact(value, ["schema", "identity", "state", "activeMaterializationBindings", "evidence"], "Checkpoint storyboard target state"); if (raw.schema !== "shellx-motion/private-checkpoint-storyboard-record-target@1" || raw.state !== "active" || raw.activeMaterializationBindings !== 0) throw storeError("store_integrity_failed", "Checkpoint storyboard target state is invalid."); const identity = readIdentity(raw.identity, "Checkpoint storyboard target identity"); if (!sameIdentity(identity, expected)) throw storeError("store_integrity_failed", "Checkpoint storyboard target identity is invalid."); return Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-record-target@1", identity, state: "active", activeMaterializationBindings: 0 as const, evidence: readEvidence(raw.evidence) }); }
function readLineageFileRecord(value: unknown, expected: CheckpointStoryboardRecordIdentity): LineageFile { const raw = exact(value, ["schema", "root", "terminal"], "Checkpoint storyboard lineage state"); if (raw.schema !== "shellx-motion/private-checkpoint-storyboard-lineage@1" || raw.terminal !== false) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage open state is invalid."); const root = readIdentity(raw.root, "Checkpoint storyboard lineage root"); if (!sameIdentity(root, expected)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage state does not match its exact root."); return Object.freeze({ schema: "shellx-motion/private-checkpoint-storyboard-lineage@1", root, terminal: false }); }
