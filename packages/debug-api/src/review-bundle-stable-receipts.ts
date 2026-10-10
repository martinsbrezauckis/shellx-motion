import {
  bindStableReviewBundleReceiptEntries,
  readReviewBundleReceiptEntries,
  writeReviewBundle,
  type OperationReceipt,
  type ReviewBundleResult,
  type WriteReviewBundleInput
} from "@shellx-motion/core";
import type { StableReceiptSnapshot } from "./receipt-store-stable-reader.js";
import { hasStableReceiptStoreCapability } from "./receipt-store-stable-reader.js";
import { visibleReceiptEntries } from "./receipt-ownership.js";
import { receiptAccessScope, type ReceiptOwnershipHostContext } from "./receipt-ownership-host.js";

interface HostStableReceiptEntry {
  path: string;
  receipt: OperationReceipt;
  snapshot?: StableReceiptSnapshot;
}

/** Select the receipt reader at the host boundary, retaining caller scope on portable hosts. */
export async function writeReviewBundleWithHostReceipts(
  input: WriteReviewBundleInput,
  context: ReceiptOwnershipHostContext & {
    stableReceiptStorePlatform?: NodeJS.Platform;
    stableReceiptStoreProcSelfFdUsable?: () => boolean;
  },
  listStableEntries: (root: string) => Promise<readonly HostStableReceiptEntry[]>
): Promise<ReviewBundleResult> {
  if (!input.receiptsRoot) return await writeReviewBundle(input);
  if (hasStableReceiptStoreCapability(context.stableReceiptStorePlatform, context.stableReceiptStoreProcSelfFdUsable)) {
    return await writeReviewBundleFromStableReceipts(input, await listStableEntries(input.receiptsRoot));
  }
  // Core binds the approved root and exact leaves before any visible receipt enters the bundle.
  const entries = await readReviewBundleReceiptEntries(input.receiptsRoot, input.receiptsRootAuthority);
  return await writeReviewBundle({ ...input, receipts: visibleReceiptEntries(entries, receiptAccessScope(context)) });
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
    })), input.receiptsRootAuthority)
  });
}

function currentStableReceiptSnapshot(snapshot: StableReceiptSnapshot) {
  return snapshot.postPurge.state === "purged" ? snapshot.postPurge.snapshot : snapshot;
}
