/**
 * Ownership boundary for persisted Debug API receipts.
 *
 * Receipt stores are shared host evidence.  A receipt therefore carries the
 * authenticated host principal that caused it to be persisted, rather than a
 * caller-provided label.  Reads are own-principal by default.  The one
 * compatibility route is a host operator that explicitly grants
 * `crossCallerJobScope`; it can also inspect ownerless legacy evidence.
 */
import type { OperationReceipt } from "@shellx-motion/core";

export interface ReceiptAccessScope {
  callerId?: string;
  crossCallerScopeGranted?: boolean;
}

/** Read the persisted owner without treating an absent field as shared access. */
export function receiptOwner(receipt: OperationReceipt): string | undefined {
  const output = receipt.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const callerId = (output as Record<string, unknown>).callerId;
  return typeof callerId === "string" && callerId.trim() ? callerId.trim() : undefined;
}

/**
 * Stamp a receipt immediately before persistence.  A lifecycle control that
 * targets a visible foreign receipt retains that target's owner, so a
 * cross-caller operator cannot relabel another caller's historical work.
 */
export function stampReceiptOwner(receipt: OperationReceipt, callerId: string | undefined): OperationReceipt {
  const owner = callerId?.trim();
  if (!owner) return receipt;
  receipt.output = {
    ...(receipt.output && typeof receipt.output === "object" && !Array.isArray(receipt.output)
      ? receipt.output as Record<string, unknown>
      : {}),
    callerId: receiptOwner(receipt) ?? owner
  };
  return receipt;
}

/** Ownerless legacy receipts and missing principals are invisible by default. */
export function receiptVisibleToCaller(receipt: OperationReceipt, scope: ReceiptAccessScope): boolean {
  const caller = scope.callerId?.trim();
  if (!caller) return false;
  if (scope.crossCallerScopeGranted === true) return true;
  return receiptOwner(receipt) === caller;
}

/** Apply the same visibility decision before any caller-visible projection. */
export function visibleReceiptEntries<T extends { receipt: OperationReceipt }>(
  entries: readonly T[],
  scope: ReceiptAccessScope
): T[] {
  return entries.filter((entry) => receiptVisibleToCaller(entry.receipt, scope));
}
