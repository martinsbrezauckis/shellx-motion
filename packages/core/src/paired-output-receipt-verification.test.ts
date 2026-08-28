import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OperationReceipt } from "./types";
import {
  assertPairedReceiptAcceptance,
  markPairedOutputReceipt,
  verifyPairedReceiptOutputIfMarked
} from "./paired-output-receipt-verification";

function receipt(output: Record<string, unknown>): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id: "receipt", operation: "render.final", status: "passed", packageId: "pkg",
    inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-21T00:00:00.000Z", lane: "ffmpeg", output, warnings: []
  };
}

describe("paired output receipt reader marker", () => {
  it("uses Core's identity-stable no-follow hasher for marked public artifacts", async () => {
    const verifierSource = await readFile(fileURLToPath(new URL("./paired-output-receipt-verification.ts", import.meta.url)), "utf8");
    const hasherSource = await readFile(fileURLToPath(new URL("./receipts.ts", import.meta.url)), "utf8");

    expect(verifierSource).toContain('import { hashFile } from "./receipts";');
    expect(verifierSource).toContain("return await hashFile(path);");
    expect(hasherSource).toContain("fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW");
    expect(hasherSource).toContain("Hash input changed while it was being read.");
  });

  it("keeps legacy receipts outside the paired verifier", async () => {
    await expect(verifyPairedReceiptOutputIfMarked("/public/legacy.receipt.json", receipt({ path: "/public/legacy.mp4" }))).resolves.toBeUndefined();
  });

  it("does not downgrade a malformed paired marker to legacy semantics", async () => {
    await expect(verifyPairedReceiptOutputIfMarked(
      "/public/paired.receipt.json",
      receipt({ path: "/public/paired.mp4", pairedOutputReceiptPublication: { schema: "shellx-motion/paired-output-receipt@1" } })
    )).rejects.toThrow(/exact supported version\/path binding/i);
  });

  it("accepts a still-frame primary role in the paired delivery contract", () => {
    const receiptPath = resolve("/public/still-render.receipt.json");
    const outputPath = resolve("/public/still.png");
    const value = receipt({ path: outputPath, sha256: "b".repeat(64) });
    value.artifacts = [
      { role: "still_frame", path: outputPath, status: "available", mediaType: "image/png", primary: true },
      { role: "render_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
    ];
    markPairedOutputReceipt(value, receiptPath);

    expect(assertPairedReceiptAcceptance(receiptPath, value)).toEqual({
      outputPath,
      sha256: "b".repeat(64),
      secondaryArtifactHashes: {}
    });
  });
});
