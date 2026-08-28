/** Final-journal reader shared by pair authoring, recovery, and paged maintenance. */
import { canonicalJsonSha256 } from "@shellx-motion/core";
import {
  assertCurrentAuthorityDirectory,
  readImmutableJson,
  type TrustedAuthorityDirectory,
} from "./timeline-layout-application-authority-store.js";
import {
  assertPairKey,
  LEGACY_PAIR_SCHEMA,
  MAX_PAIR_JOURNAL_BYTES,
  pairPaths,
  parseJournal,
  PAIR_SCHEMA,
} from "./timeline-layout-authority-pair-records.js";
import type {
  ImmutableJsonPair,
  ImmutableJsonPairReadDescriptor,
} from "./timeline-layout-authority-pair-types.js";

/** Read only final journals that bind exact root, lineage, basename, kind, and member hashes. */
export async function readImmutableJsonPair(
  directory: TrustedAuthorityDirectory,
  input: ImmutableJsonPairReadDescriptor,
): Promise<ImmutableJsonPair> {
  assertPairKey(input.key);
  const paths = pairPaths(directory, input.key);
  await assertCurrentAuthorityDirectory(directory);
  const journalValue = await readImmutableJson(paths.journalPath, MAX_PAIR_JOURNAL_BYTES);
  const journal = parseJournal(
    journalValue,
    directory.root,
    input,
    paths,
    journalValue && typeof journalValue === "object"
      && !Array.isArray(journalValue)
      && (journalValue as Record<string, unknown>).schema === LEGACY_PAIR_SCHEMA
      ? LEGACY_PAIR_SCHEMA
      : PAIR_SCHEMA,
  );
  const [receipt, authority] = await Promise.all([
    readImmutableJson(paths.receiptPath, input.receiptMaximumBytes),
    readImmutableJson(paths.authorityPath, input.authorityMaximumBytes),
  ]);
  if (canonicalJsonSha256(receipt) !== journal.receipt.sha256
    || canonicalJsonSha256(authority) !== journal.authority.sha256) {
    throw new Error("Layout authority pair members do not match their immutable journal.");
  }
  await assertCurrentAuthorityDirectory(directory);
  return { recordKind: journal.recordKind, receipt, authority, journalPath: paths.journalPath };
}
