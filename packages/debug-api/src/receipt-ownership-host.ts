/** Host-context adapters for the generic receipt ownership boundary. */
import { applyReceiptActor, type OperationReceipt, type ReceiptActor } from "@shellx-motion/core";
import { writeContextReceipt, type DebugHostReceiptContext } from "./debug-host-receipt-writer.js";
import { receiptVisibleToCaller, stampReceiptOwner, type ReceiptAccessScope } from "./receipt-ownership.js";

export interface ReceiptOwnershipHostContext extends DebugHostReceiptContext {
  callerId?: string;
  crossCallerJobScope?: boolean;
  actor?: ReceiptActor;
}

export function receiptAccessScope(context: ReceiptOwnershipHostContext): ReceiptAccessScope {
  const callerId = context.callerId?.trim();
  return { ...(callerId ? { callerId } : {}), ...(context.crossCallerJobScope === true ? { crossCallerScopeGranted: true } : {}) };
}

export function receiptVisibleForHost(receipt: OperationReceipt, context: ReceiptOwnershipHostContext): boolean {
  return receiptVisibleToCaller(receipt, receiptAccessScope(context));
}

export function stampHostReceipt(
  context: ReceiptOwnershipHostContext,
  receipt: OperationReceipt,
  actor: ReceiptActor | undefined = context.actor
): OperationReceipt {
  return applyReceiptActor(stampReceiptOwner(receipt, context.callerId), actor);
}

export async function persistHostReceipt(
  context: ReceiptOwnershipHostContext,
  receiptsRoot: string,
  receipt: OperationReceipt,
  fallback: (receiptsRoot: string, receipt: OperationReceipt) => Promise<string>,
  actor: ReceiptActor | undefined = context.actor
): Promise<string> {
  return await writeContextReceipt(context, receiptsRoot, stampHostReceipt(context, receipt, actor), fallback);
}
