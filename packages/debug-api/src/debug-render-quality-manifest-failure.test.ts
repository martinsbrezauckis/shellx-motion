import { describe, expect, it } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import { debugRenderQualityManifestFailure } from "./debug-render-quality-manifest-failure.js";

describe("debug quality-manifest failure evidence", () => {
  it("redacts both final and nested frame receipts before returning the refusal", () => {
    const outputPath = "/governed/output/final.png";
    const hash = "a".repeat(64);
    const receipt = stillReceipt("final", outputPath, hash);
    const browserCompanionPath = "/governed/private-companions/browser-capture-html/capture.html";
    const browserCompanionHash = "b".repeat(64);
    const frameReceipt: OperationReceipt = {
      ...stillReceipt("frame", outputPath, hash), lane: "browser",
      inputHashes: { motion: "c".repeat(64), "browser-capture-html": browserCompanionHash },
      artifacts: [
        { role: "still_frame", path: outputPath, status: "available", mediaType: "image/png", primary: true },
        { role: "browser_capture_html", path: browserCompanionPath, status: "available", mediaType: "text/html", primary: true },
        { role: "quality_receipt", path: "/evidence/quality.receipt.json", status: "available", mediaType: "application/json" },
        { role: "render_receipt", path: "/evidence/render.receipt.json", status: "available", mediaType: "application/json" }
      ]
    };
    const result = debugRenderQualityManifestFailure({
      lane: "image", frameLane: "browser", preset: "png-frame", outputPath,
      receipt, frameReceipt, qualityManifestPath: "/governed/input/quality.json",
      qualityCheck: { ok: false, error: { code: "visual_quality_failed", message: "The still failed quality policy." }, warnings: [] }
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "visual_quality_failed", detail: { receipt: { output: { publication: "aborted" } }, frameReceipt: { output: { publication: "aborted" } } } }
    });
    if (result.ok) return;
    const detail = result.error.detail as Record<string, unknown>;
    expect(JSON.stringify(detail.receipt)).not.toContain(outputPath);
    expect(JSON.stringify(detail.frameReceipt)).not.toContain(outputPath);
    expect(JSON.stringify(detail.receipt)).not.toContain(hash);
    expect(JSON.stringify(detail.frameReceipt)).not.toContain(hash);
    expect(JSON.stringify(detail.frameReceipt)).not.toContain(browserCompanionPath);
    expect(JSON.stringify(detail.frameReceipt)).not.toContain(browserCompanionHash);
    expect(detail.frameReceipt).toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "quality_receipt", path: "/evidence/quality.receipt.json" }),
        expect.objectContaining({ role: "render_receipt", path: "/evidence/render.receipt.json" })
      ])
    });
    expect((detail.frameReceipt as OperationReceipt).artifacts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "still_frame" }),
      expect.objectContaining({ role: "browser_capture_html" })
    ]));
  });
});

function stillReceipt(id: string, path: string, hash: string): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id, operation: "render.final", status: "failed",
    packageId: "pkg", createdAt: "2026-08-27T00:00:00.000Z", lane: "image",
    inputHashes: { frame: hash }, output: { path, sha256: hash }, warnings: [],
    artifacts: [{ role: "still_frame", path, status: "available", mediaType: "image/png", primary: true }]
  };
}
