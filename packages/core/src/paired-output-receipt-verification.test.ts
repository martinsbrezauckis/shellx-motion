import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OperationReceipt } from "./types";
import { inspectStrictLinearSrgbSdrFinalReceipt } from "./strict-linear-srgb-sdr-receipt";
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

function strictRouteInputHashes() {
  return {
    motion: "a".repeat(64),
    "linear-srgb-sdr-route": "b".repeat(64),
    "linear-srgb-sdr-preparation": "c".repeat(64),
    "linear-srgb-sdr-ffmpeg-contract": "d".repeat(64),
    "linear-srgb-sdr-webgpu-producer": "e".repeat(64),
    "linear-srgb-sdr-producer-frame": "f".repeat(64),
    "linear-srgb-sdr-comparison-policy": "0".repeat(64),
    "linear-srgb-sdr-execution": "1".repeat(64),
  };
}

function strictSdrReceipt(receiptPath: string, outputPath: string): OperationReceipt {
  const sha256 = "b".repeat(64), byteLength = 17;
  const value = receipt({
    path: outputPath,
    sha256,
    byteLength,
    frameTransport: {
      schema: "shellx-motion/linear-srgb-sdr-final-transport@2",
      privateOutputAdoption: {
        schema: "shellx-motion/linear-srgb-sdr-final-private-output-adoption@1",
        verifiedOutput: { sha256, byteLength },
        privatePublicationStage: { sha256, byteLength },
      },
    },
  });
  value.inputHashes = strictRouteInputHashes();
  value.artifacts = [
    { role: "rendered_media", path: outputPath, status: "available", mediaType: "video/mp4", primary: true },
    { role: "render_receipt", path: receiptPath, status: "available", mediaType: "application/json" },
  ];
  markPairedOutputReceipt(value, receiptPath);
  return value;
}

describe("paired output receipt reader marker", () => {
  it("uses Core's identity-stable no-follow hasher for marked public artifacts", async () => {
    const verifierSource = await readFile(fileURLToPath(new URL("./paired-output-receipt-verification.ts", import.meta.url)), "utf8");
    const hasherSource = await readFile(fileURLToPath(new URL("./receipts.ts", import.meta.url)), "utf8");

    expect(verifierSource).toContain('import { hashFile } from "./receipts";');
    expect(verifierSource).toContain("const sha256 = await hashFile(path);");
    expect(verifierSource).toContain("output.byteLength !== byteLength");
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

  it("rejects malformed fresh strict SDR @2 adoption evidence and binds its public byte length", () => {
    const receiptPath = resolve("/public/strict.render.receipt.json");
    const outputPath = resolve("/public/strict.mp4");
    const accepted = strictSdrReceipt(receiptPath, outputPath);
    expect(assertPairedReceiptAcceptance(receiptPath, accepted)).toMatchObject({
      outputPath,
      sha256: "b".repeat(64),
      byteLength: 17,
    });

    const missingAdoption = strictSdrReceipt(receiptPath, outputPath);
    delete (missingAdoption.output as Record<string, any>).frameTransport.privateOutputAdoption;
    expect(() => assertPairedReceiptAcceptance(receiptPath, missingAdoption)).toThrow(/@2 receipt adoption is invalid/i);

    const wrongByteLength = strictSdrReceipt(receiptPath, outputPath);
    (wrongByteLength.output as Record<string, any>).byteLength = 18;
    expect(() => assertPairedReceiptAcceptance(receiptPath, wrongByteLength)).toThrow(/must equal the verified private-output adoption identity/i);

    const wrongSchema = strictSdrReceipt(receiptPath, outputPath);
    (wrongSchema.output as Record<string, any>).frameTransport.privateOutputAdoption.schema = "shellx-motion/linear-srgb-sdr-final-private-output-adoption@2";
    expect(() => assertPairedReceiptAcceptance(receiptPath, wrongSchema)).toThrow(/must equal shellx-motion\/linear-srgb-sdr-final-private-output-adoption@1/i);

    const wrongTransport = strictSdrReceipt(receiptPath, outputPath);
    (wrongTransport.output as Record<string, any>).frameTransport.schema = "shellx-motion/linear-srgb-sdr-final-transport@3";
    expect(() => assertPairedReceiptAcceptance(receiptPath, wrongTransport)).toThrow(/require shellx-motion\/linear-srgb-sdr-final-transport@2/i);
  });

  it("classifies historical strict SDR @1 as readable but non-qualifying", () => {
    const receiptPath = resolve("/public/historical.render.receipt.json");
    const outputPath = resolve("/public/historical.mp4");
    const historical = receipt({
      path: outputPath,
      sha256: "b".repeat(64),
      frameTransport: { schema: "shellx-motion/linear-srgb-sdr-final-transport@1" },
    });
    historical.artifacts = [
      { role: "rendered_media", path: outputPath, status: "available", mediaType: "video/mp4", primary: true },
      { role: "render_receipt", path: receiptPath, status: "available", mediaType: "application/json" },
    ];
    markPairedOutputReceipt(historical, receiptPath);

    expect(inspectStrictLinearSrgbSdrFinalReceipt(historical.output)).toEqual({ kind: "historical-v1" });
    expect(assertPairedReceiptAcceptance(receiptPath, historical)).toMatchObject({ outputPath, sha256: "b".repeat(64) });
    expect(assertPairedReceiptAcceptance(receiptPath, historical)).not.toHaveProperty("byteLength");
  });

  it.each([
    ["is deleted", (value: OperationReceipt) => { delete (value.output as Record<string, any>).frameTransport; }],
    ["uses a foreign schema", (value: OperationReceipt) => { (value.output as Record<string, any>).frameTransport = { schema: "shellx-motion/other-stream@1" }; }],
    ["uses a strict lookalike schema", (value: OperationReceipt) => { (value.output as Record<string, any>).frameTransport = { schema: "shellx-motion/linear-srgb-sdr-final-transport@1-downgrade" }; }],
  ])("refuses a route-identified strict paired receipt when its transport %s", (_label, mutate) => {
    const receiptPath = resolve("/public/strict.render.receipt.json");
    const outputPath = resolve("/public/strict.mp4");
    const candidate = strictSdrReceipt(receiptPath, outputPath);
    mutate(candidate);
    expect(() => assertPairedReceiptAcceptance(receiptPath, candidate)).toThrow(/complete strict route input hashes require .*transport@2/i);
  });
});
