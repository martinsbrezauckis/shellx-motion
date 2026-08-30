import {
  bindStableReviewBundleReceiptEntries,
  writeReviewBundle,
  type OperationReceipt,
  type ReviewBundleResult,
  type WriteReviewBundleInput
} from "@shellx-motion/core";
import type { StableReceiptSnapshot } from "./receipt-store-stable-reader.js";

interface HostStableReceiptEntry {
  path: string;
  receipt: OperationReceipt;
  snapshot?: StableReceiptSnapshot;
}

/**
 * Keep the Debug receipt-store read and the Core review-bundle admission together: Core receives
 * the exact byte snapshot that is now on disk, including a successful raw-prompt purge rewrite.
 */
export async function writeReviewBundleFromStableReceipts(
  input: WriteReviewBundleInput,
  entries: readonly HostStableReceiptEntry[]
): Promise<ReviewBundleResult> {
  if (!input.receiptsRoot) return await writeReviewBundle(input);
  if (entries.some((entry) => !entry.snapshot)) {
    throw new Error("Stable review bundle receipt snapshot is unavailable.");
  }
  return await writeReviewBundle({
    ...input,
    receipts: await bindStableReviewBundleReceiptEntries(input.receiptsRoot, entries.map((entry) => ({
      path: entry.path,
      receipt: entry.receipt,
      snapshot: currentStableReceiptSnapshot(entry.snapshot!)
    })))
  });
}

function currentStableReceiptSnapshot(snapshot: StableReceiptSnapshot) {
  return snapshot.postPurge.state === "purged" ? snapshot.postPurge.snapshot : snapshot;
}
