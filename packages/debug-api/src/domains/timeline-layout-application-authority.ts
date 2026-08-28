/** Immutable host authority records for reversible timeline-layout applications. */
import {
  canonicalJson,
  canonicalJsonSha256,
  resolvePackageAsset,
  type MotionPackage,
  type OperationReceipt,
} from "@shellx-motion/core";
import {
  mintMotionLayoutRemovalAuthorization,
  type MotionLayoutRemovalAuthorization,
} from "@shellx-motion/core/internal/layout-removal-authority";
import { join, resolve } from "node:path";
import {
  assertCurrentAuthorityDirectory,
  readImmutableJsonPair,
  samePathIdentity,
  trustedAuthorityDirectory,
  abortPreparedImmutableJsonPair,
  finalizePreparedImmutableJsonPair,
  prepareImmutableJsonPair,
  writeImmutableJsonPair,
  type PreparedImmutableJsonPair,
  type TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";
import {
  assertSameAuthority,
  AUTHORITY_SCHEMA,
  LEGACY_AUTHORITY_SCHEMA,
  parseAuthority,
  parseRestoredGapAuthority,
  readApplyReceiptFacts,
  type LayoutApplicationAuthority,
  type PackageLineage,
} from "./timeline-layout-application-authority-records.js";
import {
  authorityKeyFor,
  readPackageLineage,
  samePackageLineage,
} from "./timeline-layout-application-authority-lineage.js";
import {
  readLegacyStaticAuthority,
  readLegacyStaticReceipt,
} from "./timeline-layout-application-authority-legacy.js";
import { authorizeRestoredGapAuthority } from "./timeline-layout-application-authority-restored.js";
import { MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES } from "./timeline-layout-authority-record-caps.js";

const MAX_STATIC_LAYOUT_AUTHORITY_RECORD_BYTES = 64 * 1024;
const MAX_LAYOUT_AUTHORITY_PAIR_RECORD_BYTES = Math.max(
  MAX_STATIC_LAYOUT_AUTHORITY_RECORD_BYTES,
  MAX_C2_LAYOUT_AUTHORITY_RECORD_BYTES,
);
const MAX_RECEIPT_BYTES = 256 * 1024;

export interface PersistLayoutApplicationAuthorityInput {
  receiptsRoot: string;
  packageRoot: string;
  manifestPath: string;
  motionPath: string;
  persistedMotionSha256: string;
  packageId: string;
  applicationId: string;
  applicationFingerprint: string;
  receipt: OperationReceipt;
}

export interface AuthorizeLayoutApplicationRemovalInput {
  receiptsRoot: string;
  pkg: MotionPackage;
  applicationId: string;
  applicationFingerprint: string;
}

interface PreparedLayoutApplicationAuthority {
  expected: PackageLineage;
}

const preparedLayoutApplicationAuthorities = new WeakMap<
  PreparedImmutableJsonPair,
  PreparedLayoutApplicationAuthority
>();

/** Deterministic host receipt identity. Other timeline commands retain their existing identities. */
export function layoutApplyHostReceiptId(packageId: string, applicationId: string): string {
  assertIdentifier(packageId, "package id");
  assertIdentifier(applicationId, "application id");
  return `timeline-layout-apply-${canonicalJsonSha256({ packageId, applicationId }).slice(0, 32)}`;
}

/** Writes a raw apply receipt and its lineage-bound pair authority. Same bytes are idempotent. */
export async function persistLayoutApplicationAuthority(
  input: PersistLayoutApplicationAuthorityInput,
): Promise<string> {
  const receiptId = layoutApplyHostReceiptId(input.packageId, input.applicationId);
  const receiptFacts = readApplyReceiptFacts(
    input.receipt,
    receiptId,
    input.packageId,
    input.applicationId,
    input.applicationFingerprint,
  );
  const [authorityDirectory, lineage] = await Promise.all([
    trustedAuthorityDirectory(input.receiptsRoot, true),
    readPackageLineage(input.packageRoot, input.manifestPath, input.motionPath, input.packageId),
  ]);
  if (lineage.motionCanonicalSha256 !== input.persistedMotionSha256) {
    throw new Error("Layout authority does not match the actual post-compositing Motion document.");
  }
  if (receiptFacts.outputMotionSha256 !== input.persistedMotionSha256) {
    throw new Error("Layout apply receipt does not bind the actual post-compositing Motion document.");
  }
  const authorityKey = authorityKeyFor(receiptId, lineage);
  const authority: LayoutApplicationAuthority = {
    schema: AUTHORITY_SCHEMA,
    authorityKey,
    receiptId,
    receiptSha256: canonicalJsonSha256(input.receipt),
    receiptsRoot: authorityDirectory.root,
    package: lineage,
    application: { id: input.applicationId, fingerprint: input.applicationFingerprint },
    receipt: receiptFacts,
  };
  await writeImmutableJsonPair(authorityDirectory, {
    key: authorityKey,
    recordKind: "layout-application",
    outputLineage: lineage,
    receipt: input.receipt,
    receiptMaximumBytes: MAX_RECEIPT_BYTES,
    authority,
    authorityMaximumBytes: MAX_STATIC_LAYOUT_AUTHORITY_RECORD_BYTES,
  });
  return join(authorityDirectory.path, `${authorityKey}.receipt.json`);
}

/** Prepare new static-layout authority before the COW output directory is renamed into place. */
export async function prepareLayoutApplicationAuthority(
  input: PersistLayoutApplicationAuthorityInput & {
    stagedPackageRoot: string;
    expectedPackageRoot: string;
    stagedManifestPath: string;
    stagedMotionPath: string;
  },
): Promise<PreparedImmutableJsonPair> {
  const receiptId = layoutApplyHostReceiptId(input.packageId, input.applicationId);
  const receiptFacts = readApplyReceiptFacts(
    input.receipt,
    receiptId,
    input.packageId,
    input.applicationId,
    input.applicationFingerprint,
  );
  const [authorityDirectory, staged] = await Promise.all([
    trustedAuthorityDirectory(input.receiptsRoot, true),
    readPackageLineage(
      input.stagedPackageRoot,
      input.stagedManifestPath,
      input.stagedMotionPath,
      input.packageId,
    ),
  ]);
  const expected = { ...staged, path: resolve(input.expectedPackageRoot) };
  if (staged.motionCanonicalSha256 !== input.persistedMotionSha256
    || receiptFacts.outputMotionSha256 !== input.persistedMotionSha256) {
    throw new Error("Layout authority preparation does not match the exact staged Motion document.");
  }
  const authorityKey = authorityKeyFor(receiptId, expected);
  const authority: LayoutApplicationAuthority = {
    schema: AUTHORITY_SCHEMA,
    authorityKey,
    receiptId,
    receiptSha256: canonicalJsonSha256(input.receipt),
    receiptsRoot: authorityDirectory.root,
    package: expected,
    application: { id: input.applicationId, fingerprint: input.applicationFingerprint },
    receipt: receiptFacts,
  };
  const prepared = await prepareImmutableJsonPair(authorityDirectory, {
    key: authorityKey,
    recordKind: "layout-application",
    outputLineage: expected,
    receipt: input.receipt,
    receiptMaximumBytes: MAX_RECEIPT_BYTES,
    authority,
    authorityMaximumBytes: MAX_STATIC_LAYOUT_AUTHORITY_RECORD_BYTES,
  });
  preparedLayoutApplicationAuthorities.set(prepared, { expected });
  return prepared;
}

/** Finalize a pre-install static pair only after the renamed output re-proves the staged lineage. */
export async function finalizePreparedLayoutApplicationAuthority(input: {
  prepared: PreparedImmutableJsonPair;
  commit: Pick<
    PersistLayoutApplicationAuthorityInput,
    "packageRoot" | "manifestPath" | "motionPath" | "persistedMotionSha256" | "packageId"
  >;
}): Promise<string> {
  const state = preparedLayoutApplicationAuthorities.get(input.prepared);
  if (!state) throw new Error("Layout authority prepared pair is not owned by the static layout host.");
  const actual = await readPackageLineage(
    input.commit.packageRoot,
    input.commit.manifestPath,
    input.commit.motionPath,
    input.commit.packageId,
  );
  if (!samePackageLineage(state.expected, actual)
    || actual.motionCanonicalSha256 !== input.commit.persistedMotionSha256) {
    throw new Error("Layout authority prepared pair does not match the installed COW output lineage.");
  }
  return await finalizePreparedImmutableJsonPair(input.prepared);
}

export async function abortPreparedLayoutApplicationAuthority(
  prepared: PreparedImmutableJsonPair,
): Promise<void> {
  await abortPreparedImmutableJsonPair(prepared);
  preparedLayoutApplicationAuthorities.delete(prepared);
}

/** Verifies host authority before minting Core's one-shot static layout-removal authorization. */
export async function authorizeLayoutApplicationRemoval(
  input: AuthorizeLayoutApplicationRemovalInput,
): Promise<MotionLayoutRemovalAuthorization> {
  const receiptId = layoutApplyHostReceiptId(input.pkg.manifest.id, input.applicationId);
  const [authorityDirectory, lineage] = await Promise.all([
    trustedAuthorityDirectory(input.receiptsRoot, false),
    readPackageLineage(
      input.pkg.root,
      join(input.pkg.root, "manifest.json"),
      resolvePackageAsset(input.pkg, input.pkg.manifest.motion),
      input.pkg.manifest.id,
    ),
  ]);
  const authorityKey = authorityKeyFor(receiptId, lineage);
  const pair = await readCurrentAuthorityPair(authorityDirectory, authorityKey, lineage);
  if (pair?.recordKind === "layout-gap-restored") {
    const restored = parseRestoredGapAuthority(pair.authority, authorityDirectory.root, authorityKey);
    if (!restored) throw new Error("Restored layout authority pair is malformed.");
    return authorizeRestoredGapAuthority(restored, lineage, input, pair.receipt);
  }

  const rawAuthority = pair?.authority
    ?? await readLegacyStaticAuthority(
      authorityDirectory,
      authorityKey,
      MAX_STATIC_LAYOUT_AUTHORITY_RECORD_BYTES,
    );
  const receipt = pair?.receipt
    ?? await readLegacyStaticReceipt(authorityDirectory, authorityKey, MAX_RECEIPT_BYTES);
  const authority = parseAuthority(
    rawAuthority,
    authorityDirectory.root,
    authorityKey,
    pair ? AUTHORITY_SCHEMA : LEGACY_AUTHORITY_SCHEMA,
  );
  if (!samePathIdentity(authority.receiptsRoot, authorityDirectory.root)
    || !samePackageLineage(authority.package, lineage)
    || authority.authorityKey !== authorityKey
    || authority.receiptId !== receiptId
    || authority.application.id !== input.applicationId
    || authority.application.fingerprint !== input.applicationFingerprint) {
    throw new Error("Layout removal authority does not match the current package lineage or application marker.");
  }
  if (canonicalJsonSha256(receipt) !== authority.receiptSha256) {
    throw new Error("Layout removal host receipt does not match its immutable authority record.");
  }
  const receiptFacts = readApplyReceiptFacts(
    receipt,
    receiptId,
    input.pkg.manifest.id,
    input.applicationId,
    input.applicationFingerprint,
  );
  assertSameAuthorityReceipt(authority, receiptFacts);
  return mint(input.pkg, input.applicationId, input.applicationFingerprint, receiptId);
}

async function readCurrentAuthorityPair(
  directory: TrustedAuthorityDirectory,
  authorityKey: string,
  lineage: PackageLineage,
): Promise<{ recordKind: "layout-application" | "layout-gap-restored"; receipt: unknown; authority: unknown } | null> {
  try {
    const pair = await readImmutableJsonPair(directory, {
      key: authorityKey,
      recordKinds: ["layout-application", "layout-gap-restored"],
      outputLineage: lineage,
      receiptMaximumBytes: MAX_RECEIPT_BYTES,
      authorityMaximumBytes: MAX_LAYOUT_AUTHORITY_PAIR_RECORD_BYTES,
    });
    if (pair.recordKind !== "layout-application" && pair.recordKind !== "layout-gap-restored") {
      throw new Error("Layout authority pair record kind is invalid.");
    }
    return { recordKind: pair.recordKind, receipt: pair.receipt, authority: pair.authority };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

function assertSameAuthorityReceipt(
  authority: LayoutApplicationAuthority,
  receipt: LayoutApplicationAuthority["receipt"],
): void {
  if (canonicalJson(receipt) !== canonicalJson(authority.receipt)) {
    throw new Error("Layout removal host receipt facts do not match its immutable authority record.");
  }
}

function mint(
  pkg: MotionPackage,
  applicationId: string,
  applicationFingerprint: string,
  receiptId: string,
): MotionLayoutRemovalAuthorization {
  return mintMotionLayoutRemovalAuthorization({
    packageId: pkg.manifest.id,
    applicationId,
    applicationFingerprint,
    receiptId,
  });
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 128) {
    throw new Error(`${label} is invalid.`);
  }
}
