/** Shared value types for workspace-domain ports. */
import type { OperationReceipt } from "@shellx-motion/core";

export interface WorkspaceReceiptEntry {
  path: string;
  receipt: OperationReceipt;
}

export interface WorkspacePlatformReceiptEntry {
  path: string;
  receipt: Record<string, unknown>;
}
