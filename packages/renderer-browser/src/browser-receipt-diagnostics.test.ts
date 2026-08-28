import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blockedWebSocketAuthority, type BrowserFrameNetworkState } from "./browser-network-state";
import { appendBrowserNetworkReceiptWarnings, BrowserConsoleReceiptDiagnostics } from "./browser-receipt-diagnostics";

function networkState(webSocketAuthority: string): BrowserFrameNetworkState {
  return {
    blockedRequests: [],
    blockedWebSocketRequests: [webSocketAuthority],
    blockedExternalFileRequest: false,
    blockedDowngradeRedirects: [],
    blockedSecondaryPages: [],
    blockedForeignPageRequests: [],
    redirectGuardFailures: []
  };
}

describe("browser receipt diagnostics boundary", () => {
  it("keeps a low-entropy PIN and every body-derived equality value out of frame, workflow, and final receipt shapes", () => {
    const lowEntropyPin = "0000";
    const pinDigest = createHash("sha256").update(lowEntropyPin).digest("hex");
    const webSocketSecret = "WEBSOCKET-SECRET-0a041aee";
    const diagnostics = new BrowserConsoleReceiptDiagnostics();
    // Runtime callers cannot make a body part of diagnostics even if they still pass the old
    // second argument. The typed surface accepts only severity.
    Reflect.apply(diagnostics.observe, diagnostics, ["warning", `font warning pin=${lowEntropyPin}`]);
    Reflect.apply(diagnostics.observe, diagnostics, ["error", `render error pin=${lowEntropyPin}`]);
    const evidence = diagnostics.evidence();
    const warning = diagnostics.receiptWarning();
    const socketAuthority = blockedWebSocketAuthority(`wss://user:${webSocketSecret}@socket.example:9443/path?token=${webSocketSecret}#fragment`);
    const warnings = [warning ?? ""];
    appendBrowserNetworkReceiptWarnings(warnings, networkState(socketAuthority));

    expect(evidence).toEqual({
      schema: "shellx-motion/browser-console-diagnostics@1",
      reason: "page_controlled_console_output",
      warningCount: 1,
      errorCount: 1
    });
    expect(socketAuthority).toBe("wss://socket.example:9443");
    expect(warnings).toContain("Blocked browser WebSocket request: wss://socket.example:9443");

    const frameReceipt = { operation: "preview.frame", output: { consoleDiagnostics: evidence }, warnings };
    const workflowReceipt = {
      operation: "browser.workflow.capture",
      output: { workflowTrace: { schema: "shellx-motion/browser-workflow-trace@1", steps: [] }, consoleDiagnostics: evidence },
      warnings
    };
    const finalReceipt = { operation: "render.final", output: { consoleDiagnostics: evidence }, warnings };
    for (const receipt of [frameReceipt, workflowReceipt, finalReceipt]) {
      const serialized = JSON.stringify(receipt);
      expect(serialized).not.toContain(lowEntropyPin);
      expect(serialized).not.toContain(pinDigest);
      expect(serialized).not.toMatch(/[a-f0-9]{64}/);
      expect(serialized).not.toContain(webSocketSecret);
      expect(serialized).not.toContain("user:");
      expect(serialized).not.toContain("/path");
      expect(serialized).not.toContain("#fragment");
    }
  });

  it("caps severity counts without retaining console-body evidence", () => {
    const diagnostics = new BrowserConsoleReceiptDiagnostics();
    for (let index = 0; index < 20; index += 1) {
      diagnostics.observe(index % 2 === 0 ? "warning" : "error");
    }

    expect(diagnostics.evidence()).toEqual({
      schema: "shellx-motion/browser-console-diagnostics@1",
      reason: "page_controlled_console_output",
      warningCount: 10,
      errorCount: 10
    });

    const capped = new BrowserConsoleReceiptDiagnostics();
    for (let index = 0; index < 20; index += 1) capped.observe("warning");
    expect(capped.evidence()).toMatchObject({ warningCount: 16, errorCount: 0 });
  });
});
