/**
 * Enforce the raw-prompt deletion deadline a receipt promised, at the moment it is read.
 *
 * `retainRawRequest` lets a user keep the literal prompt text in a receipt and records a
 * `deleteAfter` timestamp. Nothing ever consumed that timestamp, so the software stated a deletion
 * deadline and then kept the prompt indefinitely — a false guarantee. Enforcement lives at the read
 * choke point because that is what makes the promise true for every caller at once:
 * `motion.receipts.read`, list, transcript and the prompt queue all arrive through the two receipt
 * readers in `index.ts`. The redacted read is what a caller sees; the persist-back is the purge.
 *
 * WHAT GETS WRITTEN BACK, AND WHY IT IS THE PARSED ORIGINAL. The first version of this persisted
 * `readOperationReceipt`'s PROJECTION — a normalized view carrying only the fields the debug API
 * consumes. A `read_motion` READ therefore destroyed every field the normalizer does not model
 * (a detached `signature`, `parentReceiptId`, any vendor extension) and INVENTED one, because the
 * normalizer merges `output.artifacts` into a top-level `artifacts` array for its callers. A purge
 * is a deletion of one key; anything else is the read path quietly rewriting other people's
 * evidence. Prompt/render controls bind their input hash to the stable reader's admitted byte
 * snapshot, so a lossy rewrite would also make their receipt evidence impossible to explain.
 *
 * So the transform runs TWICE over one instant: once on the projection (that is what the caller
 * receives) and once on the parsed original (that is what lands on disk). `redactExpiredRawPrompt`
 * is structural — it deletes `output.rawRequest`, rewrites `promptRetention` within its declared
 * union, appends a warning, and spreads everything else through — so applying it to the original
 * preserves fields nothing in this repository models. `now` is computed once and passed to both,
 * because the expiry warning embeds the redaction instant and two wall-clock reads would disagree.
 *
 * FAILURE POSTURE, all four deliberate:
 *   - the temp file holds REDACTED content, so a crash between write and rename cannot leak;
 *   - a failed rename leaves the original in place and the temp file is removed;
 *   - a failed persist (read-only store, disk full) is swallowed and the READ IS STILL REDACTED —
 *     being unable to purge is a reason to keep the bytes, never a reason to hand back the prompt;
 *   - a malformed retention record fails closed: the raw content goes, the record stays as evidence.
 *
 * CONCURRENCY, stated rather than claimed. The reader verifies the file by inode; the rename targets
 * the path by NAME. `verifyBeforeRename` re-checks dev/ino immediately before the rename so a
 * receipt rewritten under the same id since the read is not clobbered by a purge of the previous
 * one. That narrows the window, it does not close it — portable Node has no `renameat2(EXCHANGE)`
 * and no way to rename onto a verified inode. When the check fails the purge is SKIPPED, which is
 * the same swallowed-failure posture as above: the read stays redacted and the next read retries.
 *
 * Primary caller: `index.ts` (`readReceiptFile`, `readReceiptEntryInsideRoot`).
 */
import { randomUUID } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { hashBuffer, type OperationReceipt } from "@shellx-motion/core";
import { verifyPairedReceiptOutputIfMarked } from "@shellx-motion/core/internal/paired-output-receipt-verification";
import { redactExpiredRawPrompt } from "@shellx-motion/prompt";
import type { StableReceiptEnforcement, StableReceiptLocation, StableReceiptPostPurge } from "./receipt-store-stable-reader.js";

/** Identity of the file the reader actually read, so the purge cannot land on a different one. */
export interface VerifiedReceiptFile {
  dev: number;
  ino: number;
}

/** The minimum shape `redactExpiredRawPrompt` operates on, as a parsed receipt file presents it. */
type EnforceableRecord = Record<string, unknown> & { operation: string; output: unknown; warnings: string[] };

/**
 * Redact an expired raw prompt for the caller, and purge it from the stored file.
 *
 * @param path the receipt file, already verified by the caller's hardened reader.
 * @param receipt the normalized projection the caller will receive, or null when the file was not a
 *   valid receipt (in which case there is nothing to enforce).
 * @param original the same file's PARSED JSON, unnormalized. What gets written back.
 * @param verifiedFile dev/ino of the file the reader read; re-checked before the rename.
 * @returns the projection plus whether a safe, exact post-read purge was persisted.
 */
export async function enforceRawPromptExpiry(
  path: string,
  receipt: OperationReceipt | null,
  original: unknown,
  verifiedFile?: VerifiedReceiptFile,
  location?: StableReceiptLocation
): Promise<StableReceiptEnforcement<OperationReceipt>> {
  if (!receipt) return { receipt: null };
  const now = new Date().toISOString();
  const enforced = redactExpiredRawPrompt(receipt, now);
  if (!enforced.redacted) return { receipt: enforced.receipt };
  const purged = purgedOriginal(original, now);
  // No usable original means no faithful purge is possible. Returning the redacted projection while
  // leaving the file alone is the same posture as a failed write: never rewrite what cannot be
  // rewritten losslessly, never hand back the prompt.
  // A direct, unrooted receipt read is still redacted for the caller but never mutates a pathname.
  // Only the stable receipt-store reader provides a retained parent capability and current-chain
  // proof sufficient to make the on-disk purge safe.
  const postPurge = purged !== null && location
    ? await persistPurgedReceipt(location.capabilityPath, purged, verifiedFile, location)
    : { state: "not_persisted" } satisfies StableReceiptPostPurge;
  return { receipt: enforced.receipt, postPurge };
}

/**
 * Apply every receipt-read acceptance rule at the reader boundary.  Legacy receipts preserve the
 * raw-prompt-only behavior; a versioned paired-delivery marker additionally proves that the
 * receipt still names its public regular artifact(s) through Core's identity-stable file hash.
 */
export async function enforceReceiptReadAcceptance(
  path: string,
  receipt: OperationReceipt | null,
  original: unknown,
  verifiedFile?: VerifiedReceiptFile,
  location?: StableReceiptLocation
): Promise<StableReceiptEnforcement<OperationReceipt>> {
  const enforced = await enforceRawPromptExpiry(path, receipt, original, verifiedFile, location);
  if (enforced.receipt) await verifyPairedReceiptOutputIfMarked(path, enforced.receipt);
  return enforced;
}

/**
 * Apply the redaction transform to the parsed original, preserving every unmodeled field.
 *
 * @returns the purged original, or null when the parsed value is not a receipt-shaped object the
 *   transform can operate on (non-object, non-string `operation`, non-string-array `warnings`).
 */
function purgedOriginal(original: unknown, now: string): EnforceableRecord | null {
  if (typeof original !== "object" || original === null || Array.isArray(original)) return null;
  const record = original as Record<string, unknown>;
  if (typeof record.operation !== "string") return null;
  if (!Array.isArray(record.warnings) || !record.warnings.every((entry) => typeof entry === "string")) return null;
  return redactExpiredRawPrompt(record as EnforceableRecord, now).receipt;
}

/** Same-directory temp write, inode re-check, then rename. See the module comment on concurrency. */
async function persistPurgedReceipt(
  path: string,
  purged: EnforceableRecord,
  verifiedFile: VerifiedReceiptFile | undefined,
  location: StableReceiptLocation
): Promise<StableReceiptPostPurge> {
  const pendingPath = `${path}.redacting-${randomUUID()}`;
  try {
    if (!await location.isCurrent()) return { state: "not_persisted" };
    const content = `${JSON.stringify(purged, null, 2)}\n`;
    await writeFile(pendingPath, content, "utf8");
    const staged = await lstat(pendingPath);
    if (!await location.isCurrent() || (verifiedFile && !await stillTheVerifiedFile(path, verifiedFile))) {
      await rm(pendingPath, { force: true });
      return { state: "not_persisted" };
    }
    // A reader arriving mid-write sees either the old receipt or the purged one, never a truncated
    // file: the bytes are complete before the name is swapped.
    await rename(pendingPath, path);
    return {
      state: "purged",
      snapshot: {
        sha256: hashBuffer(Buffer.from(content, "utf8")),
        byteLength: Buffer.byteLength(content, "utf8"),
        identity: { dev: staged.dev, ino: staged.ino }
      }
    };
  } catch {
    // Intentionally swallowed; see the module comment on failure posture. The temp file is removed
    // so a store that cannot be rewritten does not accumulate one orphan per read.
    await rm(pendingPath, { force: true }).catch(() => {});
    return { state: "not_persisted" };
  }
}

async function stillTheVerifiedFile(path: string, verifiedFile: VerifiedReceiptFile): Promise<boolean> {
  try {
    const current = await lstat(path);
    return current.isFile()
      && !current.isSymbolicLink()
      && current.dev === verifiedFile.dev
      && current.ino === verifiedFile.ino;
  } catch {
    return false;
  }
}
