/** Host-only authority for C6C B1b Browser preview evidence. */
import type { MotionPackage } from "@shellx-motion/core";
import {
  createHostBoundBrowserRenderSessionFactory,
  type BrowserNetworkAccessOptions,
  type MotionBrowserRenderSession,
} from "@shellx-motion/renderer-browser";
import { assertAuthorityLive, checkedAuthority } from "./checkpoint-storyboard-record-store-authority.js";
import { storeError, type CheckpointStoryboardRecordStoreAuthority } from "./checkpoint-storyboard-record-store-types.js";
import {
  assertCheckpointStoryboardMaterializationAuthorityStore,
  checkedCheckpointStoryboardMaterializationAuthority,
  type CheckpointStoryboardMaterializationAuthority,
} from "./checkpoint-storyboard-materialization-authority.js";

const previewAuthorityBrand: unique symbol = Symbol("checkpoint-storyboard-preview-authority");
const previewFacts = new WeakMap<CheckpointStoryboardPreviewAuthority, PreviewAuthorityFacts>();
type PreviewFaultHooks = Readonly<{
  afterPreparing?: () => void | Promise<void>;
  afterReceiptPublished?: () => void | Promise<void>;
}>;
const previewFaultHooks = new WeakMap<CheckpointStoryboardPreviewAuthority, PreviewFaultHooks>();

export interface CheckpointStoryboardPreviewAuthority {
  readonly [previewAuthorityBrand]: "host-configured-c6c-b1b-preview";
}

export type CheckpointStoryboardPreviewSessionFactory = (
  pkg: MotionPackage,
  options: Readonly<{ networkAccess?: BrowserNetworkAccessOptions }>,
) => Promise<MotionBrowserRenderSession>;

interface PreviewAuthorityFacts {
  readonly store: CheckpointStoryboardRecordStoreAuthority;
  readonly materialization: CheckpointStoryboardMaterializationAuthority;
  readonly createSession: CheckpointStoryboardPreviewSessionFactory;
  /** An injected factory is test evidence only; it must never be represented as a host Browser run. */
  readonly runtimeEvidence: "host-browser" | "source-test";
}

/**
 * The host supplies only already-configured B1a authority.  The command never gets package paths,
 * renderer/session policy, a network exception, or a publication destination.
 */
export function configureCheckpointStoryboardPreviewAuthority(input: {
  readonly recordStore: CheckpointStoryboardRecordStoreAuthority;
  readonly materializationAuthority: CheckpointStoryboardMaterializationAuthority;
  /** Test-only seam. Supplying it forces the result/receipt to say `source-test`, never host proof. */
  readonly testCreateSession?: CheckpointStoryboardPreviewSessionFactory;
}): CheckpointStoryboardPreviewAuthority {
  if (!input || !input.recordStore || !input.materializationAuthority) {
    throw new Error("Checkpoint storyboard Browser preview requires host-configured B1a authority.");
  }
  checkedAuthority(input.recordStore);
  assertCheckpointStoryboardMaterializationAuthorityStore(input.materializationAuthority, input.recordStore);
  // Resolve the private facts now as a structural copied authority must not become preview-capable.
  checkedCheckpointStoryboardMaterializationAuthority(input.materializationAuthority);
  const authority = Object.freeze({ [previewAuthorityBrand]: "host-configured-c6c-b1b-preview" as const });
  previewFacts.set(authority, Object.freeze({
    store: input.recordStore,
    materialization: input.materializationAuthority,
    createSession: input.testCreateSession ?? createHostBoundBrowserRenderSessionFactory({}),
    runtimeEvidence: input.testCreateSession ? "source-test" : "host-browser",
  }));
  return authority;
}

export function checkedCheckpointStoryboardPreviewAuthority(authority: CheckpointStoryboardPreviewAuthority): PreviewAuthorityFacts {
  const facts = previewFacts.get(authority);
  if (!facts || authority[previewAuthorityBrand] !== "host-configured-c6c-b1b-preview") {
    throw storeError("preview_authority_refused", "Checkpoint storyboard Browser preview authority is not host-minted.");
  }
  return facts;
}
/** Lifecycle dispatch must name the same opaque record store as this preview authority. */
export function assertCheckpointStoryboardPreviewAuthorityStore(
  authority: CheckpointStoryboardPreviewAuthority,
  store: CheckpointStoryboardRecordStoreAuthority,
): void {
  if (checkedCheckpointStoryboardPreviewAuthority(authority).store !== store) {
    throw storeError("preview_authority_refused", "Checkpoint storyboard Browser preview authority is not bound to this lifecycle record store.");
  }
}
export function assertCheckpointStoryboardPreviewAuthorityMaterialization(authority: CheckpointStoryboardPreviewAuthority, materialization: CheckpointStoryboardMaterializationAuthority): void {
  if (checkedCheckpointStoryboardPreviewAuthority(authority).materialization !== materialization) throw storeError("preview_authority_refused", "Checkpoint storyboard Browser preview authority is not bound to this materialization authority.");
}

export async function withCheckpointStoryboardPreviewAuthority<T>(
  authority: CheckpointStoryboardPreviewAuthority,
  run: (facts: PreviewAuthorityFacts) => Promise<T>,
): Promise<T> {
  const facts = checkedCheckpointStoryboardPreviewAuthority(authority);
  try {
    await assertAuthorityLive(checkedAuthority(facts.store));
    assertCheckpointStoryboardMaterializationAuthorityStore(facts.materialization, facts.store);
  } catch (error) {
    if (error instanceof Error && error.name === "CheckpointStoryboardRecordStoreError") throw error;
    throw storeError("preview_authority_refused", "Checkpoint storyboard Browser preview authority is no longer live.");
  }
  return await run(facts);
}

/** Private test seam; hooks are keyed to one opaque host-minted authority and never exported publicly. */
export function setCheckpointStoryboardPreviewFaultHooksForTest(
  authority: CheckpointStoryboardPreviewAuthority,
  hooks: PreviewFaultHooks | undefined,
): void {
  checkedCheckpointStoryboardPreviewAuthority(authority);
  if (hooks) previewFaultHooks.set(authority, hooks);
  else previewFaultHooks.delete(authority);
}

export async function invokeCheckpointStoryboardPreviewFaultHookForTest(
  authority: CheckpointStoryboardPreviewAuthority,
  phase: keyof PreviewFaultHooks,
): Promise<void> {
  await previewFaultHooks.get(authority)?.[phase]?.();
}
