/** B7 retained-trace preview private-directory and publication authority. */
import { opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { assertAuthorityLive, mkdirIfAbsent, stableDirectory } from "./checkpoint-storyboard-record-store-authority.js";
import { code, type AuthorityFacts, type StableDirectory, storeError } from "./checkpoint-storyboard-record-store-types.js";

const UUID_SUFFIX = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RETAINED_TRACE_PREVIEW_STATE_TEMP = new RegExp(`^checkpoint_storyboard_retained_trace_preview_[a-f0-9]{32}\\.state\\.json\\.${UUID_SUFFIX}\\.tmp$`, "u");
type RecoverDirectory = (directory: StableDirectory, temp: RegExp) => Promise<void>;

/** Root-scoped B7 GPU-preview evidence; it is intentionally separate from B1 Browser previews. */
export async function lineageRetainedTracePreviewsDirectory(facts: AuthorityFacts, rootId: string): Promise<StableDirectory> {
  await assertAuthorityLive(facts);
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview lineage identity is invalid.");
  const path = join(facts.retainedTracePreviews.path, rootId);
  await mkdirIfAbsent(path);
  const directory = await stableDirectory(path, "checkpoint storyboard retained-trace preview lineage directory", facts.ownerUid);
  if (dirname(directory.path) !== facts.retainedTracePreviews.path) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview lineage directory escaped its private store.");
  return directory;
}

/** Read-only B7 preview lookup. Destructive lifecycle scans must not mint an evidence directory. */
export async function findLineageRetainedTracePreviewsDirectory(facts: AuthorityFacts, rootId: string): Promise<StableDirectory | undefined> {
  await assertAuthorityLive(facts);
  if (!/^checkpoint_storyboard_[a-f0-9]{32}$/.test(rootId)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview lineage identity is invalid.");
  const path = join(facts.retainedTracePreviews.path, rootId);
  try {
    const directory = await stableDirectory(path, "checkpoint storyboard retained-trace preview lineage directory", facts.ownerUid);
    if (dirname(directory.path) !== facts.retainedTracePreviews.path) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview lineage directory escaped its private store.");
    return directory;
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
    throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview lineage directory could not be reopened safely.");
  }
}

/** Scope B7 renderer publication to the distinct host-private retained-trace preview root. */
export async function withCheckpointStoryboardRetainedTracePreviewPublicationAuthority<T>(facts: AuthorityFacts, run: () => Promise<T>): Promise<T> {
  try {
    await assertAuthorityLive(facts);
    await assertTrustedWorkspaceAnchorPath(facts.retainedTracePreviewWorkspaceAuthority, facts.retainedTracePreviews.path);
  } catch {
    throw storeError("preview_authority_refused", "Checkpoint storyboard retained-trace preview publication authority is no longer live.");
  }
  return await withTrustedWorkspaceAnchor(facts.retainedTracePreviewWorkspaceAuthority, run);
}

/** Quiescent recovery is the only path that may reopen all B7 preview roots. */
export async function recoverCheckpointStoryboardRetainedTracePreviewsForQuiescentHost(facts: AuthorityFacts, recoverDirectory: RecoverDirectory): Promise<void> {
  const retainedTracePreviewRoots = await opendir(facts.retainedTracePreviews.path);
  try {
    const { recoverCheckpointStoryboardRetainedTracePreparingPreviewsForQuiescentHost } = await import("./checkpoint-storyboard-retained-trace-preview-state.js");
    for await (const entry of retainedTracePreviewRoots) {
      if (!entry.isDirectory() || !/^checkpoint_storyboard_[a-f0-9]{32}$/u.test(entry.name)) throw storeError("store_integrity_failed", "Checkpoint storyboard retained-trace preview recovery directory is invalid.");
      await recoverDirectory(await lineageRetainedTracePreviewsDirectory(facts, entry.name), RETAINED_TRACE_PREVIEW_STATE_TEMP);
      await recoverCheckpointStoryboardRetainedTracePreparingPreviewsForQuiescentHost(facts, entry.name);
    }
  } finally { await retainedTracePreviewRoots.close().catch(() => undefined); }
}
