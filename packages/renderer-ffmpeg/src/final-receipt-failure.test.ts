import { describe, expect, it } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import { redactAbortedFinalOutputEvidence } from "./final-receipt-failure";

describe("aborted final receipt evidence", () => {
  it("removes primary and browser companion identity while retaining quality and receipt evidence", () => {
    const outputPath = "/governed/final.png";
    const receipt = {
      schema: "shellx-motion/receipt@1",
      id: "still-quality-failure",
      operation: "render.final",
      status: "failed",
      createdAt: "2026-08-27T00:00:00.000Z",
      lane: "image",
      inputHashes: {
        frame: "a".repeat(64),
        "browser-capture-html": "d".repeat(64),
        qualityManifest: "b".repeat(64),
        qualityInputs: "c".repeat(64)
      },
      output: { path: outputPath, sha256: "a".repeat(64), qualityCheck: { status: "failed" } },
      warnings: ["quality warning"],
      artifacts: [
        { role: "still_frame", path: "/governed/alternate-still.png", status: "available", mediaType: "image/png", primary: true },
        { role: "rendered_media", path: "/governed/final.mp4", status: "available", mediaType: "video/mp4", primary: true },
        { role: "browser_capture_html", path: "/private/companions/browser-capture-html/capture.html", status: "available", mediaType: "text/html", primary: true },
        { role: "quality_receipt", path: "/evidence/quality.receipt.json", status: "available", mediaType: "application/json" },
        { role: "render_receipt", path: "/evidence/render.receipt.json", status: "available", mediaType: "application/json" }
      ]
    } as unknown as OperationReceipt;

    redactAbortedFinalOutputEvidence(receipt, { code: "visual_quality_failed", message: "The quality sample regressed." });

    expect(receipt).toMatchObject({
      status: "failed",
      output: { publication: "aborted", failure: { code: "visual_quality_failed", message: "The quality sample regressed." } },
      inputHashes: { qualityManifest: "b".repeat(64), qualityInputs: "c".repeat(64) },
      warnings: ["quality warning"],
      artifacts: [expect.objectContaining({ role: "quality_receipt" }), expect.objectContaining({ role: "render_receipt" })]
    });
    expect(receipt.inputHashes.frame).toBeUndefined();
    expect(receipt.inputHashes["browser-capture-html"]).toBeUndefined();
    expect(receipt.artifacts?.some((artifact) => artifact.role === "still_frame" || artifact.role === "rendered_media" || artifact.role === "browser_capture_html" || artifact.path === outputPath)).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("a".repeat(64));
    expect(JSON.stringify(receipt)).not.toContain("d".repeat(64));
  });
});
