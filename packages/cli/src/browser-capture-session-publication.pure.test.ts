import { describe, expect, it } from "vitest";
import { publishAfterBrowserCaptureSessionClose, redactedBrowserCaptureFailureBundle } from "./browser-capture-recording.js";

describe("browser capture terminal-session publication boundary", () => {
  it("closes the terminal browser session before publishing a capture bundle", async () => {
    const events: string[] = [];
    await expect(publishAfterBrowserCaptureSessionClose(
      async () => { events.push("close"); },
      async () => { events.push("publish"); return "published"; }
    )).resolves.toBe("published");
    expect(events).toEqual(["close", "publish"]);
  });

  it("does not publish a capture bundle when terminal session cleanup fails", async () => {
    const events: string[] = [];
    await expect(publishAfterBrowserCaptureSessionClose(
      async () => { events.push("close"); throw new Error("close failed"); },
      async () => { events.push("publish"); }
    )).rejects.toThrow("close failed");
    expect(events).toEqual(["close"]);
  });

  it("gives replay and drift failures a trace-and-receipt-only inventory without renderer HTML", () => {
    const plan = redactedBrowserCaptureFailureBundle({
      publication: { outputPath: "/governed/capture" } as never,
      pkg: { manifest: { id: "pkg_capture" } } as never,
      trace: { workflowHash: "a".repeat(64) },
      workflowTracePath: "/governed/capture/pkg_capture-browser-workflow.trace.json",
      receipt: {
        schema: "shellx-motion/receipt@1",
        id: "failed-capture",
        operation: "browser.workflow.capture",
        status: "failed",
        packageId: "pkg_capture",
        inputHashes: { workflow: "a".repeat(64), "browser-capture-html": "b".repeat(64), "capture-artifact:browser-capture-html/a.html": "c".repeat(64) },
        createdAt: "2026-08-21T00:00:00.000Z",
        lane: "browser",
        output: {
          path: "/governed/capture/pkg_capture-browser-0.png",
          captureArtifactHashes: { "/governed/capture/browser-capture-html/a.html": "c".repeat(64) },
          workflowTracePath: "/governed/capture/pkg_capture-browser-workflow.trace.json",
          workflowDrift: { status: "changed" }
        },
        artifacts: [{ role: "browser_capture_html", path: "/governed/capture/browser-capture-html/a.html", status: "available" }],
        warnings: []
      }
    });

    expect(plan.inventory).toEqual(["pkg_capture-browser-workflow.trace.json", "pkg_capture-browser-capture.receipt.json"]);
    expect(plan.artifacts.map((artifact) => artifact.role)).toEqual(["browser_workflow_trace", "preview_receipt"]);
    expect(plan.receipt.inputHashes).toEqual({ workflow: "a".repeat(64) });
    expect(plan.receipt.output).toEqual({
      workflowTracePath: "/governed/capture/pkg_capture-browser-workflow.trace.json",
      workflowDrift: { status: "changed" }
    });
    expect(JSON.stringify(plan.receipt)).not.toContain("browser-capture-html");
  });
});
