import { receiptStatusForWarnings, type ReceiptWarningStatus } from "@shellx-motion/core";

export type ConnectorArtifactStatus = "available" | "planned" | "not_required" | "failed";

export interface ConnectorArtifact {
  role: string;
  path: string;
  status: ConnectorArtifactStatus;
  label?: string;
  mediaType?: string;
  primary?: boolean;
  sha256?: string;
  byteLength?: number;
}

/**
 * The status a connector receipt can carry. Structurally identical to {@link ReceiptWarningStatus} —
 * aliased rather than restated so the Cut-facing vocabulary and the engine's rule cannot diverge.
 */
export type ConnectorReceiptStatus = ReceiptWarningStatus;

/**
 * Status for a connector receipt, under the shared engine rule.
 *
 * The rule itself lives in `@shellx-motion/core` (`receiptStatusForWarnings`) and is the same one
 * the preview lanes and the final render lane now use: failed wins, any warning that is not FFmpeg's
 * own component chatter escalates, otherwise `passed`. This connector surface authored that rule
 * first; it now imports it so a render receipt and the connector receipt aggregating it can no
 * longer disagree about the same warning.
 */
export function connectorReceiptStatus(input: { failed: boolean; warnings?: string[] }): ConnectorReceiptStatus {
  return receiptStatusForWarnings({ failed: input.failed, warnings: input.warnings ?? [] });
}
