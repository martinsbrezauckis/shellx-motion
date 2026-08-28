/**
 * Ownership boundary for the receipt-derived (historical) render lifecycle.
 *
 * These receipts are shared host evidence, not a substitute for the live job
 * coordinator.  Their caller id is therefore host-derived data stamped at
 * persistence time; command arguments never select it.  Old receipts without
 * that datum are deliberately invisible to an embedded caller.  An operator
 * host that explicitly granted cross-caller scope is the sole compatibility
 * exception, matching the live `motion.job.*` model.
 */
import type { OperationReceipt } from "@shellx-motion/core";

const LIFECYCLE_OPERATIONS = new Set([
  "render.final",
  "render.batch",
  "render.cancel",
  "render.retry"
]);

export function renderLifecycleReceiptOwner(receipt: OperationReceipt): string | undefined {
  const output = receipt.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const callerId = (output as Record<string, unknown>).callerId;
  return typeof callerId === "string" && callerId.trim() ? callerId.trim() : undefined;
}

/** Stamp only lifecycle evidence; unrelated receipt output remains byte-compatible. */
export function applyRenderLifecycleOwner(receipt: OperationReceipt, callerId: string | undefined): OperationReceipt {
  const owner = callerId?.trim();
  if (!owner || !LIFECYCLE_OPERATIONS.has(receipt.operation)) return receipt;
  const output = receipt.output;
  // A cross-caller operator's annotation stays visible to the target owner.
  // Its transport actor still records who performed the operation; this value
  // is the receipt lifecycle resource owner, not an audit-author label.
  const retainedOwner = renderLifecycleReceiptOwner(receipt);
  receipt.output = {
    ...(output && typeof output === "object" && !Array.isArray(output) ? output as Record<string, unknown> : {}),
    callerId: retainedOwner ?? owner
  };
  return receipt;
}

export function renderLifecycleReceiptVisible(
  receipt: OperationReceipt,
  callerId: string | undefined,
  crossCallerScopeGranted: boolean
): boolean {
  // A host operator's explicit cross-caller grant is the only route that can
  // read old ownerless receipts.  Otherwise an absent owner never means "all".
  const caller = callerId?.trim();
  if (!caller) return false;
  if (crossCallerScopeGranted) return true;
  return renderLifecycleReceiptOwner(receipt) === caller;
}
