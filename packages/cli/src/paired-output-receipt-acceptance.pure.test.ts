import { describe, expect, it } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import { assertPairedReceiptAcceptance } from "./paired-output-receipt-publication.js";

const sha256 = "a".repeat(64);

describe("paired output receipt acceptance", () => {
  it("rejects a receipt-only success shape when its required primary artifact is absent", () => {
    const value: OperationReceipt = {
      schema: "shellx-motion/receipt@1", id: "receipt-only", operation: "preview.frame", status: "passed",
      packageId: "pkg", inputHashes: { motion: sha256 }, createdAt: "2026-08-21T00:00:00.000Z", lane: "browser",
      output: { path: "/public/output", sha256 },
      artifacts: [{ role: "preview_receipt", path: "/public/receipt", status: "available" }],
      warnings: []
    };
    expect(() => assertPairedReceiptAcceptance("/public/receipt", value)).toThrow(/paired CLI delivery|output artifact/i);
  });
});
