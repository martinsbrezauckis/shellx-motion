/** Host configuration, directory authority, locking, and quiescent recovery. */
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, opendir, rmdir, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { assertTrustedWorkspaceAnchorPath, createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import {
  STORE_CHILDREN,
  STORE_DIRECTORY,
  authorityBrand,
  code,
  type AuthorityFacts,
  type CheckpointStoryboardRecordStoreAuthority,
  type StableDirectory,
  storeError,
} from "./checkpoint-storyboard-record-store-types.js";
import { syncPrivateDirectory } from "./checkpoint-storyboard-record-store-signed-files.js";

const authorityFacts = new WeakMap<CheckpointStoryboardRecordStoreAuthority, AuthorityFacts>();
const quiescentAdmissions = new WeakMap<CheckpointStoryboardRecordStoreQuiescentAdmission, AuthorityFacts>();
const quiescentBrand: unique symbol = Symbol("checkpoint-storyboard-record-store-quiescent-admission");
const UUID_SUFFIX = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RECORD_TEMP = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const TARGET_TEMP = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.(?:active|tombstone)\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const LINEAGE_TEMP = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.(?:open|archive)\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const RECEIPT_TEMP = new RegExp(`^checkpoint_storyboard_operation_[a-f0-9]{32}\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const BINDING_TEMP = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.(?:state|intent|binding|cow-start|detach|abandon)\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const MEMBER_TEMP = new RegExp(`^(?:head|(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8]))\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
/* Preview state uses the same signed private-file primitive as C6 records. PNG/receipt stages and
 * their Core reservation locks are intentionally not deleted by quiescent recovery: those are
 * preservation evidence unless a signed B1b state record can reopen the exact pair. */
const PREVIEW_STATE_TEMP = new RegExp(`^checkpoint_storyboard_preview_[a-f0-9]{32}\\.state\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
/* B1c has only immutable final/member stages plus its signed mutable head.  Recovery clears
 * selected or unselected private temp names only; it never repairs a final/member/head gap. */
const CREATIVE_REVIEW_TEMP = new RegExp(`^(?:checkpoint_storyboard_[a-f0-9]{32}\\.creative-review(?:\\.(?:intent|complete))?|head|(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8]))\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const QUALITY_REVIEW_TEMP = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.quality-review(?:\\.intent)?\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const BEHAVIOR_RESOLUTION_TEMP = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.(?:state|intent|binding|cow-start|detach|abandon)\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const RELATION_RESOLUTION_TEMP = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.(?:state|intent|binding|cow-start|detach|abandon)\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const RELATION_ACTION_RESOLUTION_TEMP = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.(?:state|intent|binding|cow-start|detach|abandon)\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const LIFECYCLE_RESOLUTION_TEMP = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.(?:state|intent|binding|cow-start|detach|abandon)\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const GEOMETRY_MORPH_RESOLUTION_TEMP = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.(?:state|intent|binding|cow-start|detach|abandon)\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
const RETAINED_TRACE_RESOLUTION_TEMP = new RegExp(`^checkpoint_storyboard_[a-f0-9]{32}\\.(?:state|intent|binding|cow-start|detach|abandon)\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
/** A supervisor-minted, process-local admission; filesystem age is never unlock authority. */
export interface CheckpointStoryboardRecordStoreQuiescentAdmission {
  readonly [quiescentBrand]: "host-supervisor-quiescent-c6c-record-store";
}

/** Host integration only; command data, records, and results contain neither root nor authority. */
export async function configureCheckpointStoryboardRecordStore(input: {
  readonly root: string;
  readonly integrityKey: Uint8Array;
  readonly ownerUid?: number;
}): Promise<CheckpointStoryboardRecordStoreAuthority> {
  if (typeof input.root !== "string" || !input.root) throw new Error("Checkpoint storyboard store requires a configured host root.");
  if (!(input.integrityKey instanceof Uint8Array) || input.integrityKey.byteLength < 32) throw new Error("Checkpoint storyboard store requires a host-private integrity key of at least 32 bytes.");
  const configuredOwnerUid = input.ownerUid ?? process.getuid?.();
  if (typeof configuredOwnerUid !== "number" || !Number.isSafeInteger(configuredOwnerUid) || configuredOwnerUid < 0) throw new Error("Checkpoint storyboard store requires a POSIX host owner identity.");
  const ownerUid: number = configuredOwnerUid;
  const configuredRoot = await stableDirectory(resolve(input.root), "configured checkpoint storyboard store root", ownerUid);
  const storePath = join(configuredRoot.path, STORE_DIRECTORY);
  await mkdirIfAbsent(storePath);
  const store = await stableDirectory(storePath, "checkpoint storyboard private store", ownerUid);
  if (dirname(store.path) !== configuredRoot.path) throw new Error("Checkpoint storyboard private store escaped its configured root.");
  const directories = await Promise.all(STORE_CHILDREN.map(async (name) => {
    const path = join(store.path, name);
    await mkdirIfAbsent(path);
    const directory = await stableDirectory(path, `checkpoint storyboard ${name} directory`, ownerUid);
    if (dirname(directory.path) !== store.path) throw new Error("Checkpoint storyboard private store child escaped its root.");
    return directory;
  }));
  // Preview evidence uses distinct opaque anchors; neither root is package output authority.
  const previewWorkspaceAuthority = await createTrustedWorkspaceAnchor(directories[7]!.path); const retainedTracePreviewWorkspaceAuthority = await createTrustedWorkspaceAnchor(directories[16]!.path);
  const authority = Object.freeze({ [authorityBrand]: "host-configured-c6c-record-store" as const });
  authorityFacts.set(authority, Object.freeze({
    configuredRoot, store, records: directories[0]!, targets: directories[1]!, lineages: directories[2]!, locks: directories[3]!, receipts: directories[4]!, bindings: directories[5]!, members: directories[6]!, previews: directories[7]!, creativeReviews: directories[8]!, qualityReviews: directories[9]!, behaviorResolutions: directories[10]!, relationResolutions: directories[11]!, relationActionResolutions: directories[12]!, lifecycleResolutions: directories[13]!, geometryMorphResolutions: directories[14]!, retainedTraceResolutions: directories[15]!, retainedTracePreviews: directories[16]!, retainedTraceReviews: directories[17]!,
    // Bind both inode and configured absolute authority root: a copied or same-filesystem moved
    // tree must not validate merely because a host mistakenly reused its integrity key.
    previewWorkspaceAuthority, retainedTracePreviewWorkspaceAuthority, integrityKey: Buffer.from(input.integrityKey), ownerUid, storeBinding: `${configuredRoot.path}\u0000${store.dev}:${store.ino}`,
  }));
  return authority;
}

export function checkedAuthority(authority: CheckpointStoryboardRecordStoreAuthority): AuthorityFacts {
  const facts = authorityFacts.get(authority);
  if (!facts || authority[authorityBrand] !== "host-configured-c6c-record-store") throw storeError("store_authority_refused", "Checkpoint storyboard store authority is not host-minted.");
  return facts;
}
/** Hosts call this only after their own writer supervisor has quiesced all processes. */
export function issueCheckpointStoryboardRecordStoreQuiescentAdmission(authority: CheckpointStoryboardRecordStoreAuthority): CheckpointStoryboardRecordStoreQuiescentAdmission {
  const facts = checkedAuthority(authority);
  const admission = Object.freeze({ [quiescentBrand]: "host-supervisor-quiescent-c6c-record-store" as const });
  quiescentAdmissions.set(admission, facts);
  return admission;
}
export async function withLineageLock<T>(facts: AuthorityFacts, rootId: string, run: () => Promise<T>): Promise<T> {
  await assertAuthorityLive(facts);
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage lock identity is invalid.");
  const path = join(facts.locks.path, `${rootId}.lock`);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    if (code(error) === "EEXIST") throw storeError("store_busy", "Checkpoint storyboard lineage is busy; retry the exact request.");
    throw storeError("store_integrity_failed", "Checkpoint storyboard lineage lock could not be acquired.");
  }
  let lock: StableDirectory;
  try {
    lock = await stableDirectory(path, "checkpoint storyboard lineage lock", facts.ownerUid);
  } catch { throw storeError("store_integrity_failed", "Checkpoint storyboard lineage lock could not be opened safely."); }
  try {
    if (dirname(lock.path) !== facts.locks.path) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage lock escaped its private store.");
    return await run();
  } finally {
    try { await rmdir(path); } catch { /* Preserve a conservative busy state if cleanup fails. */ }
  }
}
/** Obtain one root-scoped, no-follow membership directory; callers never scan global membership. */
export async function lineageMembersDirectory(facts: AuthorityFacts, rootId: string): Promise<StableDirectory> {
  await assertAuthorityLive(facts);
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage member identity is invalid.");
  const path = join(facts.members.path, rootId);
  await mkdirIfAbsent(path);
  const directory = await stableDirectory(path, "checkpoint storyboard lineage members directory", facts.ownerUid);
  if (dirname(directory.path) !== facts.members.path) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage members directory escaped its private store.");
  return directory;
}
/** Root-scoped B1b evidence directory. Independent preview attempts are never globally scanned. */
export async function lineagePreviewsDirectory(facts: AuthorityFacts, rootId: string): Promise<StableDirectory> {
  await assertAuthorityLive(facts);
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard preview lineage identity is invalid.");
  const path = join(facts.previews.path, rootId);
  await mkdirIfAbsent(path);
  const directory = await stableDirectory(path, "checkpoint storyboard lineage previews directory", facts.ownerUid);
  if (dirname(directory.path) !== facts.previews.path) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage previews directory escaped its private store.");
  return directory;
}
/** Read-only lookup for historical associations; it must not mint a missing B1b evidence root. */
export async function findLineagePreviewsDirectory(facts: AuthorityFacts, rootId: string): Promise<StableDirectory | undefined> {
  await assertAuthorityLive(facts);
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard preview lineage identity is invalid.");
  const path = join(facts.previews.path, rootId);
  try {
    const directory = await stableDirectory(path, "checkpoint storyboard lineage previews directory", facts.ownerUid);
    if (dirname(directory.path) !== facts.previews.path) throw storeError("store_integrity_failed", "Checkpoint storyboard lineage previews directory escaped its private store.");
    return directory;
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
    throw storeError("store_integrity_failed", "Checkpoint storyboard preview lineage directory could not be reopened safely.");
  }
}
export async function lineageCreativeReviewsDirectory(facts: AuthorityFacts, rootId: string): Promise<StableDirectory> {
  await assertAuthorityLive(facts);
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review lineage identity is invalid.");
  const path = join(facts.creativeReviews.path, rootId);
  await mkdirIfAbsent(path);
  const directory = await stableDirectory(path, "checkpoint storyboard creative-review lineage directory", facts.ownerUid);
  if (dirname(directory.path) !== facts.creativeReviews.path) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review lineage directory escaped its private store.");
  return directory;
}
/** Read-only lookup: inspect must not create an empty creative-review journal directory. */
export async function findLineageCreativeReviewsDirectory(facts: AuthorityFacts, rootId: string): Promise<StableDirectory | undefined> {
  await assertAuthorityLive(facts);
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review lineage identity is invalid.");
  const path = join(facts.creativeReviews.path, rootId);
  try {
    const directory = await stableDirectory(path, "checkpoint storyboard creative-review lineage directory", facts.ownerUid);
    if (dirname(directory.path) !== facts.creativeReviews.path) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review lineage directory escaped its private store.");
    return directory;
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
    throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review lineage directory could not be reopened safely.");
  }
}
/** Root-scoped B1e quality journal. It is distinct from B1c so end-exclusive B1c stays immutable. */
export async function lineageQualityReviewsDirectory(facts: AuthorityFacts, rootId: string): Promise<StableDirectory> {
  await assertAuthorityLive(facts);
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review lineage identity is invalid.");
  const path = join(facts.qualityReviews.path, rootId);
  await mkdirIfAbsent(path);
  const directory = await stableDirectory(path, "checkpoint storyboard quality-review lineage directory", facts.ownerUid);
  if (dirname(directory.path) !== facts.qualityReviews.path) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review lineage directory escaped its private store.");
  return directory;
}
export async function findLineageQualityReviewsDirectory(facts: AuthorityFacts, rootId: string): Promise<StableDirectory | undefined> {
  await assertAuthorityLive(facts);
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review lineage identity is invalid.");
  const path = join(facts.qualityReviews.path, rootId);
  try {
    const directory = await stableDirectory(path, "checkpoint storyboard quality-review lineage directory", facts.ownerUid);
    if (dirname(directory.path) !== facts.qualityReviews.path) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review lineage directory escaped its private store.");
    return directory;
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
    throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review lineage directory could not be reopened safely.");
  }
}
/** Scope only B1b's host-private Core publication beneath the separately minted previews root. */
export async function withCheckpointStoryboardPreviewPublicationAuthority<T>(facts: AuthorityFacts, run: () => Promise<T>): Promise<T> {
  try {
    await assertAuthorityLive(facts);
    await assertTrustedWorkspaceAnchorPath(facts.previewWorkspaceAuthority, facts.previews.path);
  } catch {
    throw storeError("preview_authority_refused", "Checkpoint storyboard Browser preview publication authority is no longer live.");
  }
  return await withTrustedWorkspaceAnchor(facts.previewWorkspaceAuthority, run);
}
export async function assertAuthorityLive(facts: AuthorityFacts): Promise<void> {
  try {
    const current = await Promise.all([
      stableDirectory(facts.configuredRoot.path, "configured checkpoint storyboard store root", facts.ownerUid),
      stableDirectory(facts.store.path, "checkpoint storyboard private store", facts.ownerUid),
      stableDirectory(facts.records.path, "checkpoint storyboard records directory", facts.ownerUid),
      stableDirectory(facts.targets.path, "checkpoint storyboard targets directory", facts.ownerUid),
      stableDirectory(facts.lineages.path, "checkpoint storyboard lineages directory", facts.ownerUid),
      stableDirectory(facts.locks.path, "checkpoint storyboard locks directory", facts.ownerUid),
      stableDirectory(facts.receipts.path, "checkpoint storyboard receipts directory", facts.ownerUid),
      stableDirectory(facts.bindings.path, "checkpoint storyboard bindings directory", facts.ownerUid),
      stableDirectory(facts.members.path, "checkpoint storyboard members directory", facts.ownerUid),
      stableDirectory(facts.previews.path, "checkpoint storyboard previews directory", facts.ownerUid),
      stableDirectory(facts.creativeReviews.path, "checkpoint storyboard creative reviews directory", facts.ownerUid),
      stableDirectory(facts.qualityReviews.path, "checkpoint storyboard quality reviews directory", facts.ownerUid),
      stableDirectory(facts.behaviorResolutions.path, "checkpoint storyboard behavior resolutions directory", facts.ownerUid),
      stableDirectory(facts.relationResolutions.path, "checkpoint storyboard relation resolutions directory", facts.ownerUid),
      stableDirectory(facts.relationActionResolutions.path, "checkpoint storyboard relation-action resolutions directory", facts.ownerUid),
      stableDirectory(facts.lifecycleResolutions.path, "checkpoint storyboard lifecycle resolutions directory", facts.ownerUid),
      stableDirectory(facts.geometryMorphResolutions.path, "checkpoint storyboard geometry-morph resolutions directory", facts.ownerUid),
      stableDirectory(facts.retainedTraceResolutions.path, "checkpoint storyboard retained-trace resolutions directory", facts.ownerUid), stableDirectory(facts.retainedTracePreviews.path, "checkpoint storyboard retained-trace previews directory", facts.ownerUid), stableDirectory(facts.retainedTraceReviews.path, "checkpoint storyboard retained-trace reviews directory", facts.ownerUid),
    ]);
    await assertTrustedWorkspaceAnchorPath(facts.previewWorkspaceAuthority, facts.previews.path); await assertTrustedWorkspaceAnchorPath(facts.retainedTracePreviewWorkspaceAuthority, facts.retainedTracePreviews.path);
    if (!sameDirectory(current[0]!, facts.configuredRoot) || !sameDirectory(current[1]!, facts.store) || !sameDirectory(current[2]!, facts.records) || !sameDirectory(current[3]!, facts.targets) || !sameDirectory(current[4]!, facts.lineages) || !sameDirectory(current[5]!, facts.locks) || !sameDirectory(current[6]!, facts.receipts) || !sameDirectory(current[7]!, facts.bindings) || !sameDirectory(current[8]!, facts.members) || !sameDirectory(current[9]!, facts.previews) || !sameDirectory(current[10]!, facts.creativeReviews) || !sameDirectory(current[11]!, facts.qualityReviews) || !sameDirectory(current[12]!, facts.behaviorResolutions) || !sameDirectory(current[13]!, facts.relationResolutions) || !sameDirectory(current[14]!, facts.relationActionResolutions) || !sameDirectory(current[15]!, facts.lifecycleResolutions) || !sameDirectory(current[16]!, facts.geometryMorphResolutions) || !sameDirectory(current[17]!, facts.retainedTraceResolutions) || !sameDirectory(current[18]!, facts.retainedTracePreviews) || !sameDirectory(current[19]!, facts.retainedTraceReviews)) throw new Error("identity changed");
  } catch { throw storeError("store_authority_refused", "Checkpoint storyboard store authority or directory identity changed."); }
}

/** A host can recover staging only with an explicit supervisor-issued quiescent admission. */
export async function recoverCheckpointStoryboardRecordStoreForQuiescentHost(authority: CheckpointStoryboardRecordStoreAuthority, admission: CheckpointStoryboardRecordStoreQuiescentAdmission): Promise<{ readonly removedTemporaryFiles: number; readonly removedStaleLocks: number }> {
  const facts = checkedAuthority(authority);
  if (!admission || quiescentAdmissions.get(admission) !== facts || admission[quiescentBrand] !== "host-supervisor-quiescent-c6c-record-store") {
    throw storeError("store_authority_refused", "Checkpoint storyboard recovery requires an opaque supervisor-issued quiescent admission.");
  }
  await assertAuthorityLive(facts);
  let removedStaleLocks = 0;
  const locks = await opendir(facts.locks.path);
  try { for await (const entry of locks) {
    if (!entry.isDirectory() || !/^checkpoint_storyboard_[a-f0-9]{32}\.lock$/u.test(entry.name)) throw storeError("store_integrity_failed", "Checkpoint storyboard lock name is not grammar-valid for supervisor recovery.");
    const path = join(facts.locks.path, entry.name);
    try { const lock = await stableDirectory(path, "checkpoint storyboard stale lineage lock", facts.ownerUid); if (dirname(lock.path) !== facts.locks.path) throw new Error("escaped"); await rmdir(path); await syncPrivateDirectory(facts.locks.path); removedStaleLocks += 1; }
    catch (error) { if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error; throw storeError("record_commit_uncertain", "Checkpoint storyboard stale lock recovery could not be durably completed."); }
  } } finally { await locks.close().catch(() => undefined); }
  let removedTemporaryFiles = 0;
  const recoverDirectory = async (directory: StableDirectory, temp: RegExp) => {
    let synchronized = false;
    const entries = await opendir(directory.path);
    try { for await (const entry of entries) {
      if (!temp.test(entry.name)) continue;
      if (!entry.isFile()) throw storeError("store_integrity_failed", "Checkpoint storyboard temporary staging file is not private and recoverable.");
      if (!synchronized) { try { await syncPrivateDirectory(directory.path); synchronized = true; } catch { throw storeError("record_commit_uncertain", "Checkpoint storyboard recovery could not establish private directory durability before cleanup."); } }
      const name = entry.name;
      const candidate = join(directory.path, name);
      const recovery = await recoverableTemporary(directory.path, name, facts.ownerUid);
      if (!recovery) throw storeError("store_integrity_failed", "Checkpoint storyboard temporary staging file is not private and recoverable.");
      try {
        // A selected hard-link pair means link(2) won but the writer could not establish directory
        // durability or unlink its staging name. Re-establish final-name durability before touching
        // the paired temp, then durably record cleanup; never report recovery success in between.
        if (recovery === "selected") await syncPrivateDirectory(directory.path);
        if (await recoverableTemporary(directory.path, name, facts.ownerUid) !== recovery) throw storeError("store_integrity_failed", "Checkpoint storyboard temporary staging state changed during recovery.");
        await unlink(candidate);
        await syncPrivateDirectory(directory.path);
      } catch (error) {
        if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
        throw storeError("record_commit_uncertain", "Checkpoint storyboard recovery could not durably establish selected publication or staging cleanup.");
      }
      removedTemporaryFiles += 1;
    } } finally { await entries.close().catch(() => undefined); }
  };
  await recoverDirectory(facts.records, RECORD_TEMP); await recoverDirectory(facts.targets, TARGET_TEMP); await recoverDirectory(facts.lineages, LINEAGE_TEMP); await recoverDirectory(facts.receipts, RECEIPT_TEMP); await recoverDirectory(facts.bindings, BINDING_TEMP); await recoverDirectory(facts.behaviorResolutions, BEHAVIOR_RESOLUTION_TEMP); await recoverDirectory(facts.relationResolutions, RELATION_RESOLUTION_TEMP); await recoverDirectory(facts.relationActionResolutions, RELATION_ACTION_RESOLUTION_TEMP); await recoverDirectory(facts.lifecycleResolutions, LIFECYCLE_RESOLUTION_TEMP); await recoverDirectory(facts.geometryMorphResolutions, GEOMETRY_MORPH_RESOLUTION_TEMP); await recoverDirectory(facts.retainedTraceResolutions, RETAINED_TRACE_RESOLUTION_TEMP);
  // Membership is root-scoped.  Recover every bounded child directory, never treating a stale
  // lock or a global scan as evidence that a live lineage has gone away.
  // Independent roots are unbounded. Stream one grammar-checked private child at a time instead
  // of retaining/capping a global directory listing; each lineage journal has its own 128 limit.
  const memberRoots = await opendir(facts.members.path);
  try {
    for await (const entry of memberRoots) {
      if (!entry.isDirectory() || !/^checkpoint_storyboard_[a-f0-9]{32}$/u.test(entry.name)) throw storeError("store_integrity_failed", "Checkpoint storyboard membership recovery directory is invalid.");
      await recoverDirectory(await lineageMembersDirectory(facts, entry.name), MEMBER_TEMP);
    }
  } finally { await memberRoots.close().catch(() => undefined); }
  const previewRoots = await opendir(facts.previews.path);
  try {
    const { recoverCheckpointStoryboardPreparingPreviewsForQuiescentHost } = await import("./checkpoint-storyboard-preview-state.js");
    for await (const entry of previewRoots) {
      if (!entry.isDirectory() || !/^checkpoint_storyboard_[a-f0-9]{32}$/u.test(entry.name)) throw storeError("store_integrity_failed", "Checkpoint storyboard preview recovery directory is invalid.");
      await recoverDirectory(await lineagePreviewsDirectory(facts, entry.name), PREVIEW_STATE_TEMP);
      // Only a supervisor-issued quiescent recovery reaches this point. A normal B1b retry must
      // refuse the same preparing journal instead of treating it as authority to clean it up.
      await recoverCheckpointStoryboardPreparingPreviewsForQuiescentHost(facts, entry.name);
    }
  } finally { await previewRoots.close().catch(() => undefined); }
  await (await import("./checkpoint-storyboard-retained-trace-preview-store.js")).recoverCheckpointStoryboardRetainedTracePreviewsForQuiescentHost(facts, recoverDirectory);
  await (await import("./checkpoint-storyboard-retained-trace-review-store.js")).recoverCheckpointStoryboardRetainedTraceReviewsForQuiescentHost(facts, recoverDirectory);
  const creativeReviewRoots = await opendir(facts.creativeReviews.path);
  try { for await (const entry of creativeReviewRoots) {
    if (!entry.isDirectory() || !/^checkpoint_storyboard_[a-f0-9]{32}$/u.test(entry.name)) throw storeError("store_integrity_failed", "Checkpoint storyboard creative-review recovery directory is invalid.");
    await recoverDirectory(await lineageCreativeReviewsDirectory(facts, entry.name), CREATIVE_REVIEW_TEMP);
  } } finally { await creativeReviewRoots.close().catch(() => undefined); }
  const qualityReviewRoots = await opendir(facts.qualityReviews.path);
  try { for await (const entry of qualityReviewRoots) {
    if (!entry.isDirectory() || !/^checkpoint_storyboard_[a-f0-9]{32}$/u.test(entry.name)) throw storeError("store_integrity_failed", "Checkpoint storyboard quality-review recovery directory is invalid.");
    await recoverDirectory(await lineageQualityReviewsDirectory(facts, entry.name), QUALITY_REVIEW_TEMP);
  } } finally { await qualityReviewRoots.close().catch(() => undefined); }
  return Object.freeze({ removedTemporaryFiles, removedStaleLocks });
}

export async function stableDirectory(path: string, label: string, ownerUid: number): Promise<StableDirectory> {
  await assertNoSymlinkComponents(path);
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory.`);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | noFollowFlag());
  try {
    const opened = await handle.stat();
    const after = await lstat(path);
    if (!opened.isDirectory() || after.isSymbolicLink() || opened.dev !== after.dev || opened.ino !== after.ino || opened.uid !== ownerUid || after.uid !== ownerUid || (opened.mode & 0o022) !== 0 || (after.mode & 0o022) !== 0) throw new Error(`${label} changed while opening.`);
    return Object.freeze({ path, dev: opened.dev, ino: opened.ino });
  } finally { await handle.close(); }
}
async function assertNoSymlinkComponents(path: string): Promise<void> {
  const resolved = resolve(path);
  const parsed = parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split("/").filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Checkpoint storyboard private store path contains a symlink component.");
  }
}
async function recoverableTemporary(directory: string, name: string, ownerUid: number): Promise<"unselected" | "selected" | null> {
  const temp = await lstat(join(directory, name));
  if (!temp.isFile() || temp.isSymbolicLink() || temp.uid !== ownerUid || (temp.mode & 0o077) !== 0) return null;
  if (temp.nlink === 1) return "unselected";
  const match = new RegExp(`^(.*)\\.${UUID_SUFFIX}\\.tmp$`, "u").exec(name);
  if (!match || temp.nlink !== 2) return null;
  try {
    const final = await lstat(join(directory, match[1]!));
    return final.isFile() && !final.isSymbolicLink() && final.nlink === 2 && final.uid === ownerUid && (final.mode & 0o077) === 0 && final.dev === temp.dev && final.ino === temp.ino ? "selected" : null;
  } catch { return null; }
}
export async function mkdirIfAbsent(path: string): Promise<void> { try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw error; } }
function sameDirectory(left: StableDirectory, right: StableDirectory): boolean { return left.path === right.path && left.dev === right.dev && left.ino === right.ino; }
function noFollowFlag(): number { if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Checkpoint storyboard store requires O_NOFOLLOW support."); return fsConstants.O_NOFOLLOW; }
