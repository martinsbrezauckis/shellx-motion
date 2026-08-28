import { describe, expect, it } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import { enrichCanvasPackageReceipt } from "./package-writer-receipt-evidence";

describe("Canvas package receipt evidence", () => {
  it.each(["/host-approved/canvas/frame-selection.json", "C:\\host-approved\\canvas\\frame-selection.json"])(
    "replaces an approved host selection locator with a logical package locator: %s",
    (selectionPath) => {
      const receipt = enrichCanvasPackageReceipt(receiptFor(selectionPath), packageEvidence());

      expect(receipt.inputHashes).toEqual({ "input/canvas-selection.json": "a".repeat(64) });
      expect(receipt.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "motion_package", path: ".", primary: true }),
        expect.objectContaining({ role: "canvas_frame_selection", path: "input/canvas-selection.json" })
      ]));
      expect(receipt.artifacts).toHaveLength(2);
      expect(JSON.stringify(receipt)).not.toContain(selectionPath);
      expect(JSON.stringify(receipt)).not.toContain("host-approved");
    }
  );

  it("preserves existing package-relative Canvas selection evidence", () => {
    const receipt = enrichCanvasPackageReceipt(receiptFor("input/canvas-selection.json"), packageEvidence());

    expect(receipt.inputHashes).toEqual({ "input/canvas-selection.json": "a".repeat(64) });
    expect(receipt.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "canvas_frame_selection", path: "input/canvas-selection.json" })
    ]));
  });
});

function receiptFor(selectionPath: string): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: "canvas-export-test",
    operation: "export.final",
    status: "passed",
    packageId: "pkg_test",
    inputHashes: { [selectionPath]: "a".repeat(64) },
    createdAt: "2026-08-22T00:00:00.000Z",
    lane: "browser",
    output: { packageDir: "/caller/private/package" },
    artifacts: [
      { role: "canvas_frame_selection", path: selectionPath, status: "available" },
      { role: "upstream_host_evidence", path: "/host-approved/upstream.json", status: "available" }
    ],
    warnings: []
  };
}

function packageEvidence() {
  return {
    manifestRef: "manifest.json",
    motionRef: "motion.json",
    receiptRef: "receipts/canvas-export.receipt.json",
    resourceCatalogRef: "resource-catalog.json",
    packageContentHashes: {
      "manifest.json": { sha256: "b".repeat(64), byteLength: 1 },
      "motion.json": { sha256: "c".repeat(64), byteLength: 1 },
      "resource-catalog.json": { sha256: "d".repeat(64), byteLength: 1 }
    },
    assetRefs: [],
    copiedAssetRefs: [],
    missingAssetRefs: [],
    assetEvidence: []
  };
}
