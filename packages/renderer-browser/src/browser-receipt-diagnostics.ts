/**
 * Bounded browser diagnostics that can safely cross from an active page into receipts.
 *
 * Browser console text is page-controlled: it can contain credentials, URLs, customer data, or
 * arbitrary hostile bytes. Receipts retain only capped severity counts and a fixed reason; they
 * never retain a console body or body-derived equality value. Network-policy warnings come from
 * the same boundary so frame, workflow, and final-delivery receipts never need to reconstruct
 * raw browser observations.
 */
import type { BrowserFrameNetworkState } from "./browser-network-state";

const MAX_CONSOLE_MESSAGES_PER_SEVERITY = 16;
const CONSOLE_DIAGNOSTIC_REASON = "page_controlled_console_output";

export interface BrowserConsoleDiagnostics {
  schema: "shellx-motion/browser-console-diagnostics@1";
  reason: typeof CONSOLE_DIAGNOSTIC_REASON;
  warningCount: number;
  errorCount: number;
}

/** Accumulates only bounded severity counts; page-controlled bodies never enter this boundary. */
export class BrowserConsoleReceiptDiagnostics {
  private warningCount = 0;
  private errorCount = 0;

  observe(severity: "warning" | "error"): void {
    if (severity === "warning") {
      this.warningCount = Math.min(this.warningCount + 1, MAX_CONSOLE_MESSAGES_PER_SEVERITY);
    } else {
      this.errorCount = Math.min(this.errorCount + 1, MAX_CONSOLE_MESSAGES_PER_SEVERITY);
    }
  }

  evidence(): BrowserConsoleDiagnostics | undefined {
    const total = this.warningCount + this.errorCount;
    if (total === 0) return undefined;
    return {
      schema: "shellx-motion/browser-console-diagnostics@1",
      reason: CONSOLE_DIAGNOSTIC_REASON,
      warningCount: this.warningCount,
      errorCount: this.errorCount
    };
  }

  receiptWarning(): string | undefined {
    const evidence = this.evidence();
    if (!evidence) return undefined;
    return `Browser console diagnostics: reason=${evidence.reason}; warning=${evidence.warningCount}, error=${evidence.errorCount}.`;
  }
}

/** Append network-policy warnings from receipt-safe, already-normalized network evidence. */
export function appendBrowserNetworkReceiptWarnings(warnings: string[], networkState: BrowserFrameNetworkState): void {
  for (const origin of [...new Set(networkState.blockedRequests)]) {
    warnings.push(`Blocked undeclared browser request: ${origin}`);
  }
  for (const transition of [...new Set(networkState.blockedDowngradeRedirects)]) {
    warnings.push(`Blocked HTTPS-to-HTTP browser redirect downgrade: ${transition}`);
  }
  for (const authority of [...new Set(networkState.blockedWebSocketRequests)]) {
    warnings.push(`Blocked browser WebSocket request: ${authority}`);
  }
  for (const origin of [...new Set(networkState.blockedForeignPageRequests)]) {
    warnings.push(`Blocked browser request from a page other than the captured page: ${origin}`);
  }
  for (const kind of [...new Set([...(networkState.blockedSecondaryCodeRequests ?? []), ...(networkState.blockedApprovedEntryNavigations ?? [])])]) {
    warnings.push(`Blocked approved-agent-entry executable resource: ${kind}`);
  }
  for (const origin of [...new Set(networkState.blockedSecondaryPages)]) {
    warnings.push(`Blocked browser popup or secondary page: ${origin}`);
  }
  for (const reason of [...new Set(networkState.redirectGuardFailures)]) {
    warnings.push(`Browser redirect guard stopped enforcing mid-render: ${reason}`);
  }
  for (const reason of [...new Set(networkState.blockedResponsePolicies ?? [])]) {
    warnings.push(`Blocked host-approved browser response: ${reason}`);
  }
  if (networkState.blockedExternalFileRequest) {
    warnings.push("Blocked external browser file request.");
  }
}
