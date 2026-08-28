/** Host-only authority facade for B7 arbitrary-time review association. */
import { assertAuthorityLive, checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { assertCheckpointStoryboardRetainedTracePreviewAuthorityStore, type CheckpointStoryboardRetainedTracePreviewAuthority } from "./checkpoint-storyboard-retained-trace-preview-authority.js";
import { assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore, type CheckpointStoryboardRetainedTraceResolutionAuthority } from "./checkpoint-storyboard-retained-trace-resolution-authority.js";
import { readHostRetainedTraceReviewRegistration, type HostRetainedTraceReviewRegistration, type ResolvedHostRetainedTraceReview } from "./checkpoint-storyboard-retained-trace-review-host-registry.js";
import { storeError, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store-types.js";

const brand: unique symbol = Symbol("checkpoint-storyboard-retained-trace-review-authority");
const factsByAuthority = new WeakMap<CheckpointStoryboardRetainedTraceReviewAuthority, RetainedTraceReviewAuthorityFacts>();
const HANDLE = /^checkpoint_storyboard_retained_trace_review_handle_[a-f0-9]{32}$/u;
const MAX_HANDLES = 128;

export interface CheckpointStoryboardRetainedTraceReviewAuthority { readonly [brand]: "host-configured-c6c-b7-retained-trace-review"; }
export interface RetainedTraceReviewAuthorityFacts {
  readonly store: CheckpointStoryboardRecordStoreAuthority;
  readonly resolution: CheckpointStoryboardRetainedTraceResolutionAuthority;
  readonly preview: CheckpointStoryboardRetainedTracePreviewAuthority;
  readonly registry: ReadonlyMap<string, ResolvedHostRetainedTraceReview>;
}

export function configureCheckpointStoryboardRetainedTraceReviewAuthority(input: {
  readonly recordStore: CheckpointStoryboardRecordStoreAuthority;
  readonly retainedTraceResolutionAuthority: CheckpointStoryboardRetainedTraceResolutionAuthority;
  readonly retainedTracePreviewAuthority: CheckpointStoryboardRetainedTracePreviewAuthority;
  readonly reviewRegistry: ReadonlyMap<string, HostRetainedTraceReviewRegistration>;
  readonly allowPolicyActors?: boolean;
}): CheckpointStoryboardRetainedTraceReviewAuthority {
  const store = checkedAuthority(input.recordStore);
  assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore(input.retainedTraceResolutionAuthority, input.recordStore);
  assertCheckpointStoryboardRetainedTracePreviewAuthorityStore(input.retainedTracePreviewAuthority, input.recordStore);
  if (!(input.reviewRegistry instanceof Map) || input.reviewRegistry.size > MAX_HANDLES) throw new Error("Checkpoint storyboard retained-trace review registry must be a bounded host-owned Map.");
  const registry = new Map<string, ResolvedHostRetainedTraceReview>();
  for (const [handle, registration] of input.reviewRegistry) {
    if (!HANDLE.test(handle) || registry.has(handle)) throw new Error("Checkpoint storyboard retained-trace review handle is invalid or duplicated.");
    registry.set(handle, readHostRetainedTraceReviewRegistration(registration, handle, store.integrityKey, store.storeBinding, input.allowPolicyActors === true));
  }
  const authority = Object.freeze({ [brand]: "host-configured-c6c-b7-retained-trace-review" as const });
  factsByAuthority.set(authority, Object.freeze({ store: input.recordStore, resolution: input.retainedTraceResolutionAuthority, preview: input.retainedTracePreviewAuthority, registry }));
  return authority;
}

export function checkedCheckpointStoryboardRetainedTraceReviewAuthority(authority: CheckpointStoryboardRetainedTraceReviewAuthority): RetainedTraceReviewAuthorityFacts {
  const facts = factsByAuthority.get(authority);
  if (!facts || authority[brand] !== "host-configured-c6c-b7-retained-trace-review") throw storeError("retained_trace_review_authority_refused", "Checkpoint storyboard retained-trace review authority is not host-minted.");
  return facts;
}
export function assertCheckpointStoryboardRetainedTraceReviewAuthorityStore(authority: CheckpointStoryboardRetainedTraceReviewAuthority, store: CheckpointStoryboardRecordStoreAuthority): void {
  if (checkedCheckpointStoryboardRetainedTraceReviewAuthority(authority).store !== store) throw storeError("retained_trace_review_authority_refused", "Checkpoint storyboard retained-trace review authority is not bound to this record store.");
}
export function resolveCheckpointStoryboardRetainedTraceReviewHandle(facts: RetainedTraceReviewAuthorityFacts, handle: string): ResolvedHostRetainedTraceReview {
  if (!HANDLE.test(handle)) throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review handle is invalid.");
  const review = facts.registry.get(handle);
  if (!review) throw storeError("retained_trace_review_evidence_refused", "Checkpoint storyboard retained-trace review handle is not registered by this host.");
  return review;
}
export async function withCheckpointStoryboardRetainedTraceReviewAuthority<T>(authority: CheckpointStoryboardRetainedTraceReviewAuthority, run: (facts: RetainedTraceReviewAuthorityFacts) => Promise<T>): Promise<T> {
  const facts = checkedCheckpointStoryboardRetainedTraceReviewAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore(facts.resolution, facts.store);
    assertCheckpointStoryboardRetainedTracePreviewAuthorityStore(facts.preview, facts.store);
  } catch (error) {
    if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
    throw storeError("retained_trace_review_authority_refused", "Checkpoint storyboard retained-trace review authority is no longer live.");
  }
  return await run(facts);
}
