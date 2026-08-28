/** Host-only C2 continuation and teardown authority lifecycle. */
import {
  canonicalJson,
  resolvePackageAsset,
  type MotionPackage,
  type OperationReceipt,
} from "@shellx-motion/core";
import { join, resolve } from "node:path";
import {
  authorizeLayoutApplicationRemoval,
  layoutApplyHostReceiptId,
} from "./timeline-layout-application-authority.js";
import {
  sameIdentity,
  sameLineage,
  activeKey,
  ordinaryAuthorityKey,
  readPackageLineage,
  readPersistedMotion,
  receiptFacts,
  staticEvidence,
  storePresent,
} from "./timeline-layout-gap-animation-authority-evidence.js";
import {
  ACTIVE_SCHEMA,
  MAX_RECEIPT_BYTES,
  optionalActiveAuthority,
  verifyActiveReceipt,
} from "./timeline-layout-gap-animation-authority-records.js";
import { MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES } from "./timeline-layout-authority-record-caps.js";
import type {
  LayoutGapAnimationContinuation,
} from "./timeline-layout-gap-animation-authority-types.js";
import {
  trustedAuthorityDirectory,
  abortPreparedImmutableJsonPair,
  finalizePreparedImmutableJsonPair,
  prepareImmutableJsonPair,
  type ImmutableJsonPairCommitHooks,
  type PreparedImmutableJsonPair,
  type TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";
import type { MotionDocumentHostReceiptCommit } from "./package-edit-transaction.js";
export {
  persistLayoutGapAnimationContinuation,
  restoreLayoutRemovalAuthorityAfterGapTeardown,
} from "./timeline-layout-gap-animation-authority-immediate.js";

const RESTORED_SCHEMA = "shellx-motion/timeline-layout-gap-animation-restored-authority@1" as const;

interface PreparedGapAuthority {
  continuation: LayoutGapAnimationContinuation;
  expected: import("./timeline-layout-gap-animation-authority-types.js").PackageLineage;
  phase: "continuation" | "teardown";
}

const preparedGapAuthorities = new WeakMap<PreparedImmutableJsonPair, PreparedGapAuthority>();

export type { LayoutGapAnimationContinuation } from "./timeline-layout-gap-animation-authority-types.js";

/**
 * Proves either original static apply authority or the immediate preceding C2 authority chain.
 * The returned opaque context is consumed only by the transaction host-receipt callback.
 */
export async function prepareLayoutGapAnimationContinuation(input: {
  receiptsRoot: string;
  pkg: MotionPackage;
  applicationId: string;
  applicationFingerprint: string;
}): Promise<LayoutGapAnimationContinuation> {
  const [directory, source] = await Promise.all([
    trustedAuthorityDirectory(input.receiptsRoot, false),
    readPackageLineage(
      input.pkg.root,
      join(input.pkg.root, "manifest.json"),
      resolvePackageAsset(input.pkg, input.pkg.manifest.motion),
      input.pkg.manifest.id,
    ),
  ]);
  const active = await optionalActiveAuthority(
    directory,
    activeKey(source, input.applicationId),
    source,
  );
  if (active) {
    if (!sameIdentity(active.receiptsRoot, directory.root)
      || !sameLineage(active.package, source)
      || active.application.id !== input.applicationId
      || active.application.fingerprint !== input.applicationFingerprint) {
      throw new Error(
        "Layout gap continuation authority does not match the source package lineage or application marker.",
      );
    }
    const current = staticEvidence(
      input.pkg.motion,
      input.applicationId,
      input.applicationFingerprint,
    );
    if (canonicalJson(current) !== canonicalJson(active.static)) {
      throw new Error("Layout gap continuation source no longer preserves the attached static layout state.");
    }
    await verifyActiveReceipt(directory, active, source);
    return freeze({
      authorityKey: active.authorityKey,
      receiptsRoot: directory.root,
      source,
      application: active.application,
      static: active.static,
    });
  }

  // First attachment proves the static host receipt; a document marker alone is insufficient.
  await authorizeLayoutApplicationRemoval({
    receiptsRoot: input.receiptsRoot,
    pkg: input.pkg,
    applicationId: input.applicationId,
    applicationFingerprint: input.applicationFingerprint,
  });
  return freeze({
    authorityKey: layoutApplyHostReceiptId(input.pkg.manifest.id, input.applicationId),
    receiptsRoot: directory.root,
    source,
    application: { id: input.applicationId, fingerprint: input.applicationFingerprint },
    static: staticEvidence(input.pkg.motion, input.applicationId, input.applicationFingerprint),
  });
}

/** Prepare a C2 continuation pair from the staged package before its same-filesystem rename. */
export async function prepareLayoutGapAnimationContinuationPair(input: {
  continuation: LayoutGapAnimationContinuation;
  stagedPackageRoot: string;
  expectedPackageRoot: string;
  stagedManifestPath: string;
  stagedMotionPath: string;
  persistedMotionSha256: string;
  receiptsRoot: string;
  packageId: string;
  receipt: OperationReceipt;
  pairHooks?: ImmutableJsonPairCommitHooks;
}): Promise<PreparedImmutableJsonPair> {
  const directory = await trustedAuthorityDirectory(input.receiptsRoot, true);
  assertContinuationRoot(input.continuation, directory);
  const stagedOutput = await readPersistedMotion(input.stagedPackageRoot, input.stagedMotionPath);
  assertStaticOutput(input.continuation, stagedOutput, "continuation");
  if (!storePresent(stagedOutput)) {
    throw new Error("Layout gap continuation staged output is missing its active layout gap track root.");
  }
  const staged = await readPackageLineage(
    input.stagedPackageRoot,
    input.stagedManifestPath,
    input.stagedMotionPath,
    input.packageId,
  );
  const expected = { ...staged, path: resolve(input.expectedPackageRoot) };
  if (expected.motionCanonicalSha256 !== input.persistedMotionSha256) {
    throw new Error("Layout gap continuation staged Motion identity does not match the transaction.");
  }
  const authorityKey = activeKey(expected, input.continuation.application.id);
  const authority = {
    schema: ACTIVE_SCHEMA,
    authorityKey,
    receiptsRoot: directory.root,
    package: expected,
    application: { ...input.continuation.application },
    static: input.continuation.static,
    previousAuthorityKey: input.continuation.authorityKey,
    receipt: receiptFacts(input.receipt, input.packageId, input.persistedMotionSha256),
  };
  const prepared = await prepareImmutableJsonPair(directory, {
    key: authorityKey,
    recordKind: "layout-gap-continuation",
    outputLineage: expected,
    receipt: input.receipt,
    receiptMaximumBytes: MAX_RECEIPT_BYTES,
    authority,
    authorityMaximumBytes: MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES,
    ...(input.pairHooks ? { hooks: input.pairHooks } : {}),
  });
  preparedGapAuthorities.set(prepared, {
    continuation: input.continuation,
    expected,
    phase: "continuation",
  });
  return prepared;
}

/** Prepare a final C2 teardown restoration pair before the COW package is published. */
export async function prepareLayoutGapTeardownRestorationPair(input: {
  continuation: LayoutGapAnimationContinuation;
  stagedPackageRoot: string;
  expectedPackageRoot: string;
  stagedManifestPath: string;
  stagedMotionPath: string;
  persistedMotionSha256: string;
  receiptsRoot: string;
  packageId: string;
  receipt: OperationReceipt;
  pairHooks?: ImmutableJsonPairCommitHooks;
}): Promise<PreparedImmutableJsonPair> {
  const directory = await trustedAuthorityDirectory(input.receiptsRoot, true);
  assertContinuationRoot(input.continuation, directory);
  const stagedOutput = await readPersistedMotion(input.stagedPackageRoot, input.stagedMotionPath);
  assertStaticOutput(input.continuation, stagedOutput, "teardown");
  if (storePresent(stagedOutput)) {
    throw new Error("Layout gap teardown staged output did not remove the persisted layout gap root.");
  }
  const staged = await readPackageLineage(
    input.stagedPackageRoot,
    input.stagedManifestPath,
    input.stagedMotionPath,
    input.packageId,
  );
  const expected = { ...staged, path: resolve(input.expectedPackageRoot) };
  if (expected.motionCanonicalSha256 !== input.persistedMotionSha256) {
    throw new Error("Layout gap teardown staged Motion identity does not match the transaction.");
  }
  const receipt = receiptFacts(input.receipt, input.packageId, input.persistedMotionSha256);
  if (receipt.operation !== "timeline.layout-gap-animation.track.remove") {
    throw new Error("Only final layout gap track removal may restore ordinary layout removal authority.");
  }
  const authorityKey = ordinaryAuthorityKey(
    layoutApplyHostReceiptId(input.packageId, input.continuation.application.id),
    expected,
  );
  const authority = {
    schema: RESTORED_SCHEMA,
    authorityKey,
    receiptsRoot: directory.root,
    package: expected,
    application: { ...input.continuation.application },
    sourceAuthorityKey: input.continuation.authorityKey,
    static: input.continuation.static,
    teardown: {
      receiptId: receipt.id,
      receiptSha256: receipt.sha256,
      operation: "timeline.layout-gap-animation.track.remove" as const,
      status: receipt.status,
      packageId: receipt.packageId,
      outputMotionSha256: receipt.outputMotionSha256,
    },
  };
  const prepared = await prepareImmutableJsonPair(directory, {
    key: authorityKey,
    recordKind: "layout-gap-restored",
    outputLineage: expected,
    receipt: input.receipt,
    receiptMaximumBytes: MAX_RECEIPT_BYTES,
    authority,
    authorityMaximumBytes: MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES,
    ...(input.pairHooks ? { hooks: input.pairHooks } : {}),
  });
  preparedGapAuthorities.set(prepared, {
    continuation: input.continuation,
    expected,
    phase: "teardown",
  });
  return prepared;
}

/** Finalize a prepared C2 pair only when the installed post-rename output exactly matches it. */
export async function finalizePreparedLayoutGapAuthorityPair(input: {
  prepared: PreparedImmutableJsonPair;
  commit: MotionDocumentHostReceiptCommit;
  packageId: string;
}): Promise<string> {
  const state = preparedGapAuthorities.get(input.prepared);
  if (!state) throw new Error("Layout gap prepared pair is not owned by the C2 authority host.");
  const output = await readPersistedMotion(input.commit.packageRoot, input.commit.motionPath);
  assertStaticOutput(state.continuation, output, state.phase);
  if ((state.phase === "continuation" && !storePresent(output))
    || (state.phase === "teardown" && storePresent(output))) {
    throw new Error("Layout gap prepared pair does not match the installed active-root state.");
  }
  const actual = await committedLineage({ commit: input.commit, packageId: input.packageId });
  if (!sameLineage(state.expected, actual)) {
    throw new Error("Layout gap prepared pair does not match the installed COW output lineage.");
  }
  return await finalizePreparedImmutableJsonPair(input.prepared);
}

export async function abortPreparedLayoutGapAuthorityPair(
  prepared: PreparedImmutableJsonPair,
): Promise<void> {
  await abortPreparedImmutableJsonPair(prepared);
  preparedGapAuthorities.delete(prepared);
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
    const label = phase === "continuation"
      ? "Layout gap continuation output changed static layout applications, direct child transforms, or inverse patches."
      : "Layout gap teardown changed layoutApplications, static child transforms, or inverse patches.";
    throw new Error(label);
  }
}

async function committedLineage(input: {
  commit: MotionDocumentHostReceiptCommit;
  packageId: string;
}) {
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

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
