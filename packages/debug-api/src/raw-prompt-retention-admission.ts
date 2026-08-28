/**
 * Host admission for the raw-prompt retention lifecycle.
 *
 * A raw request is safe to create only when the host can later re-open its governed receipt
 * through the descriptor-relative reader and replace the exact receipt bytes at expiry. This
 * remains host-owned: command arguments can ask to retain a prompt, but cannot claim either
 * capability or a receipt writer.
 */
import type { PromptRetentionInput } from "@shellx-motion/prompt";

export interface RawPromptRetentionAdmissionServices {
  receiptsRoot?: string;
  receiptPersistenceAvailable: boolean;
  hasStableReceiptPurgeCapability: () => boolean;
}

export interface RawPromptRetentionAdmissionError {
  code: "capability_unavailable";
  message: string;
  suggestedAction: string;
}

export function rawPromptRetentionAdmissionError(
  retention: PromptRetentionInput,
  services: RawPromptRetentionAdmissionServices
): RawPromptRetentionAdmissionError | null {
  if (retention.mode !== "raw_request") return null;
  if (!services.hasStableReceiptPurgeCapability()) {
    return {
      code: "capability_unavailable",
      message: "Raw prompt retention requires the host's stable receipt read-and-purge capability.",
      suggestedAction: "Configure the required host capability and retry."
    };
  }
  if (!services.receiptsRoot || !services.receiptPersistenceAvailable) {
    return {
      code: "capability_unavailable",
      message: "Raw prompt retention requires a host-configured receipt root with receipt persistence.",
      suggestedAction: "Configure the required host capability and retry."
    };
  }
  return null;
}
