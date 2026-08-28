/** Opaque host authority for one B7-only private GPU preview path. */
import {
  renderCheckpointStoryboardRetainedTracePreview,
} from "@shellx-motion/renderer-browser/internal/checkpoint-storyboard-retained-trace-preview";
import { assertAuthorityLive, checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import type { CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store-types.js";
import {
  assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore,
  checkedCheckpointStoryboardRetainedTraceResolutionAuthority,
  type CheckpointStoryboardRetainedTraceResolutionAuthority,
} from "./checkpoint-storyboard-retained-trace-resolution-authority.js";
import { storeError } from "./checkpoint-storyboard-record-store-types.js";

const authorityBrand: unique symbol = Symbol("checkpoint-storyboard-retained-trace-preview-authority");
const authorityFacts = new WeakMap<CheckpointStoryboardRetainedTracePreviewAuthority, RetainedTracePreviewAuthorityFacts>();

export interface CheckpointStoryboardRetainedTracePreviewAuthority {
  readonly [authorityBrand]: "host-configured-c6c-b7-retained-trace-preview";
}

export type CheckpointStoryboardRetainedTracePreviewRenderer = typeof renderCheckpointStoryboardRetainedTracePreview;

export interface RetainedTracePreviewAuthorityFacts {
  readonly store: CheckpointStoryboardRecordStoreAuthority;
  readonly resolution: CheckpointStoryboardRetainedTraceResolutionAuthority;
  readonly render: CheckpointStoryboardRetainedTracePreviewRenderer;
  /** Injected renderers can prove source behavior only; they can never become installed GPU proof. */
  readonly runtimeEvidence: "host-gpu" | "source-test";
}

export function configureCheckpointStoryboardRetainedTracePreviewAuthority(input: {
  readonly recordStore: CheckpointStoryboardRecordStoreAuthority;
  readonly retainedTraceResolutionAuthority: CheckpointStoryboardRetainedTraceResolutionAuthority;
  readonly testRender?: CheckpointStoryboardRetainedTracePreviewRenderer;
}): CheckpointStoryboardRetainedTracePreviewAuthority {
  if (!input?.recordStore || !input.retainedTraceResolutionAuthority) {
    throw new Error("Checkpoint storyboard retained-trace preview requires host-configured B7 record and resolution authority.");
  }
  checkedAuthority(input.recordStore);
  assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore(input.retainedTraceResolutionAuthority, input.recordStore);
  checkedCheckpointStoryboardRetainedTraceResolutionAuthority(input.retainedTraceResolutionAuthority);
  const authority = Object.freeze({ [authorityBrand]: "host-configured-c6c-b7-retained-trace-preview" as const });
  authorityFacts.set(authority, Object.freeze({
    store: input.recordStore,
    resolution: input.retainedTraceResolutionAuthority,
    render: input.testRender ?? renderCheckpointStoryboardRetainedTracePreview,
    runtimeEvidence: input.testRender ? "source-test" : "host-gpu",
  }));
  return authority;
}

export function checkedCheckpointStoryboardRetainedTracePreviewAuthority(authority: CheckpointStoryboardRetainedTracePreviewAuthority): RetainedTracePreviewAuthorityFacts {
  const facts = authorityFacts.get(authority);
  if (!facts || authority[authorityBrand] !== "host-configured-c6c-b7-retained-trace-preview") {
    throw storeError("preview_authority_refused", "Checkpoint storyboard retained-trace preview authority is not host-minted.");
  }
  return facts;
}

export function assertCheckpointStoryboardRetainedTracePreviewAuthorityStore(
  authority: CheckpointStoryboardRetainedTracePreviewAuthority,
  store: CheckpointStoryboardRecordStoreAuthority,
): void {
  if (checkedCheckpointStoryboardRetainedTracePreviewAuthority(authority).store !== store) {
    throw storeError("preview_authority_refused", "Checkpoint storyboard retained-trace preview authority is not bound to this record store.");
  }
}

export async function withCheckpointStoryboardRetainedTracePreviewAuthority<T>(
  authority: CheckpointStoryboardRetainedTracePreviewAuthority,
  run: (facts: RetainedTracePreviewAuthorityFacts) => Promise<T>,
): Promise<T> {
  const facts = checkedCheckpointStoryboardRetainedTracePreviewAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    assertCheckpointStoryboardRetainedTraceResolutionAuthorityStore(facts.resolution, facts.store);
  } catch (error) {
    if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
    throw storeError("preview_authority_refused", "Checkpoint storyboard retained-trace preview authority is no longer live.");
  }
  return await run(facts);
}

/** Keeps the renderer result type reachable without exporting the renderer from Debug. */
export type CheckpointStoryboardRetainedTracePreviewRendererResult = Awaited<ReturnType<CheckpointStoryboardRetainedTracePreviewRenderer>>;
