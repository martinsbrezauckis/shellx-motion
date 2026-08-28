/** Immediate post-install C2 authority writers retained for legacy host receipt callers. */
import { canonicalJson, type OperationReceipt } from "@shellx-motion/core";
import { layoutApplyHostReceiptId } from "./timeline-layout-application-authority.js";
import {
  activeKey,
  ordinaryAuthorityKey,
  readPackageLineage,
  readPersistedMotion,
  receiptFacts,
  sameIdentity,
  staticEvidence,
  storePresent,
} from "./timeline-layout-gap-animation-authority-evidence.js";
import {
  ACTIVE_SCHEMA,
  MAX_RECEIPT_BYTES,
} from "./timeline-layout-gap-animation-authority-records.js";
import { MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES } from "./timeline-layout-authority-record-caps.js";
import type { LayoutGapAnimationContinuation } from "./timeline-layout-gap-animation-authority-types.js";
import {
  trustedAuthorityDirectory,
  writeImmutableJsonPair,
  type ImmutableJsonPairCommitHooks,
  type TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";
import type { MotionDocumentHostReceiptCommit } from "./package-edit-transaction.js";

const RESTORED_SCHEMA = "shellx-motion/timeline-layout-gap-animation-restored-authority@1" as const;

/** Writes the immutable successor pair for a C2 edit that has already installed its output. */
export async function persistLayoutGapAnimationContinuation(input: {
  continuation: LayoutGapAnimationContinuation;
  commit: MotionDocumentHostReceiptCommit;
  packageId: string;
  receipt: OperationReceipt;
  pairHooks?: ImmutableJsonPairCommitHooks;
}): Promise<string> {
  const directory = await trustedAuthorityDirectory(input.commit.receiptsRoot, true);
  assertContinuationRoot(input.continuation, directory);
  const output = await readPersistedMotion(
    input.commit.packageRoot,
    input.commit.motionPath,
  );
  assertStaticOutput(input.continuation, output, "continuation");
  if (!storePresent(output)) throw new Error("Layout gap continuation output is missing its active layout gap track root.");
  const lineage = await committedLineage(input);
  const authorityKey = activeKey(
    lineage,
    input.continuation.application.id,
  );
  const authority = {
    schema: ACTIVE_SCHEMA,
    authorityKey,
    receiptsRoot: directory.root,
    package: lineage,
    application: { ...input.continuation.application }, static: input.continuation.static,
    previousAuthorityKey: input.continuation.authorityKey,
    receipt: receiptFacts(
      input.receipt,
      input.packageId,
      input.commit.persistedMotionSha256,
    ),
  };
  return await writeImmutableJsonPair(directory, {
    key: authorityKey,
    recordKind: "layout-gap-continuation",
    outputLineage: lineage,
    receipt: input.receipt,
    receiptMaximumBytes: MAX_RECEIPT_BYTES,
    authority,
    authorityMaximumBytes: MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES,
    ...(input.pairHooks ? { hooks: input.pairHooks } : {}),
  });
}

/** Restores static-layout removal authority only after final teardown proves exact static evidence. */
export async function restoreLayoutRemovalAuthorityAfterGapTeardown(input: {
  continuation: LayoutGapAnimationContinuation;
  commit: MotionDocumentHostReceiptCommit;
  packageId: string;
  receipt: OperationReceipt;
  pairHooks?: ImmutableJsonPairCommitHooks;
}): Promise<string> {
  const directory = await trustedAuthorityDirectory(input.commit.receiptsRoot, true);
  assertContinuationRoot(input.continuation, directory);
  const output = await readPersistedMotion(
    input.commit.packageRoot,
    input.commit.motionPath,
  );
  assertStaticOutput(input.continuation, output, "teardown");
  if (storePresent(output)) throw new Error("Layout gap teardown did not remove the persisted layout gap root.");
  const lineage = await committedLineage(input);
  const receipt = receiptFacts(
    input.receipt,
    input.packageId,
    input.commit.persistedMotionSha256,
  );
  if (receipt.operation !== "timeline.layout-gap-animation.track.remove") {
    throw new Error("Only final layout gap track removal may restore ordinary layout removal authority.");
  }
  const authorityKey = ordinaryAuthorityKey(
    layoutApplyHostReceiptId(input.packageId, input.continuation.application.id),
    lineage,
  );
  const authority = {
    schema: RESTORED_SCHEMA,
    authorityKey,
    receiptsRoot: directory.root,
    package: lineage,
    application: { ...input.continuation.application },
    sourceAuthorityKey: input.continuation.authorityKey,
    static: input.continuation.static,
    teardown: {
      receiptId: receipt.id,
      receiptSha256: receipt.sha256,
      operation: "timeline.layout-gap-animation.track.remove" as const, status: receipt.status,
      packageId: receipt.packageId,
      outputMotionSha256: receipt.outputMotionSha256,
    },
  };
  return await writeImmutableJsonPair(directory, {
    key: authorityKey,
    recordKind: "layout-gap-restored",
    outputLineage: lineage,
    receipt: input.receipt,
    receiptMaximumBytes: MAX_RECEIPT_BYTES,
    authority,
    authorityMaximumBytes: MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES,
    ...(input.pairHooks ? { hooks: input.pairHooks } : {}),
  });
}

function assertContinuationRoot(
  continuation: LayoutGapAnimationContinuation,
  directory: TrustedAuthorityDirectory,
): void {
  if (!sameIdentity(continuation.receiptsRoot, directory.root)) {
    throw new Error("Layout gap continuation authority receiptsRoot changed before output commit.");
  }
}

function assertStaticOutput(
  continuation: LayoutGapAnimationContinuation,
  output: Parameters<typeof staticEvidence>[0],
  phase: "continuation" | "teardown",
): void {
  const actual = staticEvidence(
    output,
    continuation.application.id,
    continuation.application.fingerprint,
  );
  if (canonicalJson(actual) !== canonicalJson(continuation.static)) {
    throw new Error(phase === "continuation"
      ? "Layout gap continuation output changed static layout applications, direct child transforms, or inverse patches."
      : "Layout gap teardown changed layoutApplications, static child transforms, or inverse patches.");
  }
}

async function committedLineage(input: { commit: MotionDocumentHostReceiptCommit; packageId: string }) {
  const lineage = await readPackageLineage(
    input.commit.packageRoot,
    input.commit.manifestPath,
    input.commit.motionPath,
    input.packageId,
  );
  if (lineage.motionCanonicalSha256 !== input.commit.persistedMotionSha256) {
    throw new Error("Layout gap continuation output Motion identity does not match the transaction commit.");
  }
  return lineage;
}
