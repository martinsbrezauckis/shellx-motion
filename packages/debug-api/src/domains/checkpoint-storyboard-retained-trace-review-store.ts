/** Root-scoped private storage for B7 arbitrary-time review associations. */
import { opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertAuthorityLive, mkdirIfAbsent, stableDirectory } from "./checkpoint-storyboard-record-store-authority.js";
import { code, storeError, type AuthorityFacts, type StableDirectory } from "./checkpoint-storyboard-record-store-types.js";

const ROOT_ID = /^checkpoint_storyboard_[a-f0-9]{32}$/u;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TEMP = new RegExp(`^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}\\.review(?:\\.(?:intent|complete))?\\.json\\.${UUID}\\.tmp$`, "u");
type RecoverDirectory = (directory: StableDirectory, temporary: RegExp) => Promise<void>;

export async function lineageRetainedTraceReviewsDirectory(facts: AuthorityFacts, rootId: string): Promise<StableDirectory> {
  await assertAuthorityLive(facts);
  if (!ROOT_ID.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review lineage identity is invalid.");
  const path = join(facts.retainedTraceReviews.path, rootId);
  await mkdirIfAbsent(path);
  const directory = await stableDirectory(path, "checkpoint storyboard retained-trace review lineage directory", facts.ownerUid);
  if (dirname(directory.path) !== facts.retainedTraceReviews.path) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review lineage directory escaped its private store.");
  return directory;
}

export async function findLineageRetainedTraceReviewsDirectory(facts: AuthorityFacts, rootId: string): Promise<StableDirectory | undefined> {
  await assertAuthorityLive(facts);
  if (!ROOT_ID.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review lineage identity is invalid.");
  try {
    const directory = await stableDirectory(join(facts.retainedTraceReviews.path, rootId), "checkpoint storyboard retained-trace review lineage directory", facts.ownerUid);
    if (dirname(directory.path) !== facts.retainedTraceReviews.path) throw new Error("escaped review directory");
    return directory;
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
    throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review lineage directory could not be reopened safely.");
  }
}

export async function recoverCheckpointStoryboardRetainedTraceReviewsForQuiescentHost(facts: AuthorityFacts, recover: RecoverDirectory): Promise<void> {
  const roots = await opendir(facts.retainedTraceReviews.path);
  try {
    for await (const entry of roots) {
      if (!entry.isDirectory() || !ROOT_ID.test(entry.name)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace review recovery directory is invalid.");
      await recover(await lineageRetainedTraceReviewsDirectory(facts, entry.name), TEMP);
    }
  } finally { await roots.close().catch(() => undefined); }
}
