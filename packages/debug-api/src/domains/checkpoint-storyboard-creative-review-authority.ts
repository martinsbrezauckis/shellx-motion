/** Host-only authority facade for C6C B1c creative-review association. */
import {
  assertAuthorityLive,
  checkedAuthority,
} from "./checkpoint-storyboard-record-store-authority.js";
import {
  assertCheckpointStoryboardMaterializationAuthorityStore,
  checkedCheckpointStoryboardMaterializationAuthority,
  type CheckpointStoryboardMaterializationAuthority,
} from "./checkpoint-storyboard-materialization-authority.js";
import {
  assertCheckpointStoryboardPreviewAuthorityMaterialization,
  assertCheckpointStoryboardPreviewAuthorityStore,
  checkedCheckpointStoryboardPreviewAuthority,
  type CheckpointStoryboardPreviewAuthority,
} from "./checkpoint-storyboard-preview-authority.js";
import {
  storeError,
  type CheckpointStoryboardRecordIdentity,
  type CheckpointStoryboardRecordStoreAuthority,
} from "./checkpoint-storyboard-record-store-types.js";
import {
  readHostCreativeReviewRegistration,
  type HostCreativeReviewRegistration,
  type ResolvedHostCreativeReview,
} from "./checkpoint-storyboard-creative-review-host-registry.js";

const creativeReviewAuthorityBrand: unique symbol = Symbol(
  "checkpoint-storyboard-creative-review-authority",
);
const creativeReviewFacts = new WeakMap<
  CheckpointStoryboardCreativeReviewAuthority,
  CreativeReviewAuthorityFacts
>();
const CREATIVE_REVIEW_HANDLE =
  /^checkpoint_storyboard_creative_review_handle_[a-f0-9]{32}$/u;
const MAX_HOST_CREATIVE_REVIEW_HANDLES = 128;

export interface CheckpointStoryboardCreativeReviewAuthority {
  readonly [creativeReviewAuthorityBrand]: "host-configured-c6c-b1c-creative-review";
}
interface CreativeReviewAuthorityFacts {
  readonly store: CheckpointStoryboardRecordStoreAuthority;
  readonly materialization: CheckpointStoryboardMaterializationAuthority;
  readonly preview: CheckpointStoryboardPreviewAuthority;
  /** Snapshot-only registry: no command path can populate, enumerate, or inspect it. */
  readonly creativeReviewRegistry: ReadonlyMap<string, ResolvedHostCreativeReview>;
}

/**
 * Host integration supplies a bounded registry of raw sealed creative records and its own role
 * attestations. Configuration validates and reduces them to a private summary before commands run.
 */
export function configureCheckpointStoryboardCreativeReviewAuthority(input: {
  readonly recordStore: CheckpointStoryboardRecordStoreAuthority;
  readonly materializationAuthority: CheckpointStoryboardMaterializationAuthority;
  readonly previewAuthority: CheckpointStoryboardPreviewAuthority;
  readonly creativeReviewRegistry: ReadonlyMap<string, HostCreativeReviewRegistration>;
  /** Policy attestations are opt-in and are never treated as human review evidence. */
  readonly allowPolicyActors?: boolean;
}): CheckpointStoryboardCreativeReviewAuthority {
  if (
    !input?.recordStore ||
    !input.materializationAuthority ||
    !input.previewAuthority ||
    !input.creativeReviewRegistry ||
    typeof input.creativeReviewRegistry.entries !== "function"
  )
    throw new Error(
      "Checkpoint storyboard creative review requires host-configured C6, B1a, B1b, and a bounded sealed-review registry.",
    );
  const storeFacts = checkedAuthority(input.recordStore);
  checkedCheckpointStoryboardMaterializationAuthority(
    input.materializationAuthority,
  );
  checkedCheckpointStoryboardPreviewAuthority(input.previewAuthority);
  assertCheckpointStoryboardMaterializationAuthorityStore(
    input.materializationAuthority,
    input.recordStore,
  );
  assertCheckpointStoryboardPreviewAuthorityStore(
    input.previewAuthority,
    input.recordStore,
  );
  assertCheckpointStoryboardPreviewAuthorityMaterialization(
    input.previewAuthority,
    input.materializationAuthority,
  );
  const registry = new Map<string, ResolvedHostCreativeReview>();
  try {
    for (const [handle, registration] of input.creativeReviewRegistry.entries()) {
      if (registry.size >= MAX_HOST_CREATIVE_REVIEW_HANDLES)
        throw new Error("Checkpoint storyboard creative-review host registry exceeds its bounded handle limit.");
      if (
        typeof handle !== "string" ||
        !CREATIVE_REVIEW_HANDLE.test(handle) ||
        registry.has(handle)
      )
        throw new Error("Checkpoint storyboard creative-review host handle is invalid.");
      registry.set(
        handle,
        readHostCreativeReviewRegistration(
          registration,
          handle,
          storeFacts.integrityKey,
          storeFacts.storeBinding,
          input.allowPolicyActors === true,
        ),
      );
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Checkpoint storyboard creative-review host registry could not be read.");
  }
  const authority = Object.freeze({
    [creativeReviewAuthorityBrand]:
      "host-configured-c6c-b1c-creative-review" as const,
  });
  creativeReviewFacts.set(
    authority,
    Object.freeze({
      store: input.recordStore,
      materialization: input.materializationAuthority,
      preview: input.previewAuthority,
      creativeReviewRegistry: registry,
    }),
  );
  return authority;
}

export function checkedCheckpointStoryboardCreativeReviewAuthority(
  authority: CheckpointStoryboardCreativeReviewAuthority,
): CreativeReviewAuthorityFacts {
  const facts = creativeReviewFacts.get(authority);
  if (
    !facts ||
    authority[creativeReviewAuthorityBrand] !==
      "host-configured-c6c-b1c-creative-review"
  )
    throw storeError(
      "creative_review_authority_refused",
      "Checkpoint storyboard creative-review authority is not host-minted.",
    );
  return facts;
}

export function assertCheckpointStoryboardCreativeReviewAuthorityStore(
  authority: CheckpointStoryboardCreativeReviewAuthority,
  store: CheckpointStoryboardRecordStoreAuthority,
): void {
  if (
    checkedCheckpointStoryboardCreativeReviewAuthority(authority).store !==
    store
  )
    throw storeError(
      "creative_review_authority_refused",
      "Checkpoint storyboard creative-review authority is not bound to this lifecycle record store.",
    );
}

/** Resolve exactly one opaque caller handle; neither the key nor the host raw records escape. */
export function resolveCheckpointStoryboardCreativeReviewHandle(
  facts: CreativeReviewAuthorityFacts,
  handle: string,
): ResolvedHostCreativeReview {
  if (!CREATIVE_REVIEW_HANDLE.test(handle))
    throw storeError(
      "creative_review_evidence_refused",
      "Checkpoint storyboard creative review requires one exact opaque host review handle.",
    );
  const resolution = facts.creativeReviewRegistry.get(handle);
  if (!resolution)
    throw storeError(
      "creative_review_evidence_refused",
      "Checkpoint storyboard creative review handle is unknown, stale, or not host-minted.",
    );
  return resolution;
}

export async function withCheckpointStoryboardCreativeReviewAuthority<T>(
  authority: CheckpointStoryboardCreativeReviewAuthority,
  run: (facts: CreativeReviewAuthorityFacts) => Promise<T>,
): Promise<T> {
  const facts = checkedCheckpointStoryboardCreativeReviewAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    assertCheckpointStoryboardMaterializationAuthorityStore(
      facts.materialization,
      facts.store,
    );
    assertCheckpointStoryboardPreviewAuthorityStore(facts.preview, facts.store);
    assertCheckpointStoryboardPreviewAuthorityMaterialization(
      facts.preview,
      facts.materialization,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "CheckpointStoryboardRecordStoreError"
    )
      throw error;
    throw storeError(
      "creative_review_authority_refused",
      "Checkpoint storyboard creative-review authority is no longer live.",
    );
  }
  return await run(facts);
}

export type { CreativeReviewAuthorityFacts, ResolvedHostCreativeReview };
