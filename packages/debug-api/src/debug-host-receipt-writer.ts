/** Host-only receipt persistence override; command arguments never configure this capability. */
import type { OperationReceipt } from "@shellx-motion/core";

export interface DebugHostReceiptContext {
  /** A transport with retained output authority may replace Debug's generic receipt helper. */
  hostReceiptWriter?: (receiptsRoot: string, receipt: OperationReceipt) => Promise<string>;
}

export async function writeContextReceipt(
  context: DebugHostReceiptContext,
  receiptsRoot: string,
  receipt: OperationReceipt,
  fallback: (receiptsRoot: string, receipt: OperationReceipt) => Promise<string>,
): Promise<string> {
  return await (context.hostReceiptWriter ?? fallback)(receiptsRoot, receipt);
}
